-- ================================================================
--  Campaign Intelligence — conversation_analysis table + views
-- ----------------------------------------------------------------
--  Run this ONCE in Supabase SQL Editor:
--    Supabase Dashboard → SQL Editor → New Query → paste this whole
--    file → Run. Safe to re-run (idempotent).
--
--  Creates:
--    - conversation_analysis (main table, one row per bot exchange)
--    - 5 read-only views the dashboard reads from
--    - indexes for the query patterns the dashboard uses
-- ================================================================

-- ── Main table ─────────────────────────────────────────────────────
create table if not exists conversation_analysis (
  id                      bigserial primary key,
  created_at              timestamptz not null default now(),

  -- Links back to your existing data
  phone                   text        not null,
  conversation_id         text,                -- optional grouping ID
  user_message            text,                -- merged inbound text
  bot_message             text        not null,

  -- Layer 1 — rule-based (always populated, runs synchronously)
  rule_flags              text[]      not null default '{}',
  hallucination_detail    jsonb,               -- { claim, expected, kind }
  bot_message_length      integer,

  -- Layer 2 — LLM evaluation (populated by background worker, nullable)
  evaluated_at            timestamptz,
  sales_stage             text,                -- awareness/interest/qualification/objection/closing/dead
  sentiment               text,                -- positive/neutral/negative/hostile
  objection_type          text,                -- price/location/timing/trust/competitor/none
  response_quality_score  integer,             -- 1-10
  issues                  text[]      default '{}',
  handled                 boolean,             -- did the bot move convo forward?
  improvement_suggestion  text,

  -- Sampling bookkeeping
  eval_status             text not null default 'pending'
                          check (eval_status in ('pending','skipped','done','error')),
  eval_attempts           integer not null default 0,
  eval_error              text,

  -- Layer 4 — human review
  human_reviewed          boolean     not null default false,
  human_verdict           text                 -- confirmed_bad/false_alarm/hallucination_confirmed/null
                          check (human_verdict is null or human_verdict in
                                 ('confirmed_bad','false_alarm','hallucination_confirmed')),
  human_note              text,
  human_reviewed_at       timestamptz
);

-- ── Customer-side analysis columns + phrase signatures (idempotent) ─
--  These are added in a second pass so re-running the file on an
--  existing table just adds the new columns without touching data.
alter table conversation_analysis add column if not exists customer_intent          text;
alter table conversation_analysis add column if not exists customer_buying_signals  text[] default '{}';
alter table conversation_analysis add column if not exists customer_concerns        text[] default '{}';
alter table conversation_analysis add column if not exists missed_signal            boolean;
alter table conversation_analysis add column if not exists bot_phrase               text;   -- first ~6 words, normalized
alter table conversation_analysis add column if not exists user_phrase              text;   -- first ~6 words, normalized

-- ── Indexes (idempotent) ───────────────────────────────────────────
create index if not exists ca_created_at_idx   on conversation_analysis(created_at desc);
create index if not exists ca_phone_idx        on conversation_analysis(phone);
create index if not exists ca_eval_status_idx  on conversation_analysis(eval_status) where eval_status = 'pending';
create index if not exists ca_review_idx       on conversation_analysis(human_reviewed, created_at desc);
create index if not exists ca_rule_flags_idx   on conversation_analysis using gin (rule_flags);
create index if not exists ca_bot_phrase_idx   on conversation_analysis(bot_phrase) where bot_phrase is not null;
create index if not exists ca_user_phrase_idx  on conversation_analysis(user_phrase) where user_phrase is not null;
create index if not exists ca_intent_idx       on conversation_analysis(customer_intent) where customer_intent is not null;

-- ── View 1: daily_campaign_metrics ────────────────────────────────
-- Drives the Overview panel. One row per day for the last 30 days.
create or replace view daily_campaign_metrics with (security_invoker = on) as
select
  date_trunc('day', created_at)::date           as day,
  count(*)                                       as total_exchanges,
  count(*) filter (where 'hallucination' = any(rule_flags))            as hallucinations,
  count(*) filter (where 'forbidden_claim' = any(rule_flags))          as forbidden_claims,
  count(*) filter (where 'no_cta' = any(rule_flags))                   as no_cta_count,
  count(*) filter (where 'too_long' = any(rule_flags))                 as too_long_count,
  count(*) filter (where 'too_short' = any(rule_flags))                as too_short_count,
  count(*) filter (where sentiment = 'hostile')                        as hostile_count,
  count(*) filter (where sales_stage = 'closing')                      as at_closing_count,
  count(*) filter (where sales_stage = 'dead')                         as dead_count,
  count(*) filter (where handled = true)                               as handled_count,
  count(*) filter (where handled is not null)                          as evaluated_count,
  avg(response_quality_score) filter (where response_quality_score is not null)
                                                                       as avg_quality
from conversation_analysis
where created_at > now() - interval '30 days'
group by 1
order by 1 desc;

-- ── View 2: sales_funnel ──────────────────────────────────────────
-- Drives the Funnel panel. Unique customers per stage, last 7 days.
create or replace view sales_funnel with (security_invoker = on) as
with latest_per_phone as (
  select distinct on (phone)
    phone, sales_stage, response_quality_score, created_at
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and sales_stage is not null
  order by phone, created_at desc
)
select
  sales_stage,
  count(*)                                       as unique_customers,
  avg(response_quality_score)                    as avg_quality
from latest_per_phone
group by sales_stage
order by case sales_stage
  when 'awareness'     then 1
  when 'interest'      then 2
  when 'qualification' then 3
  when 'objection'     then 4
  when 'closing'       then 5
  when 'dead'          then 6
  else 7
end;

-- ── View 3: issue_frequency ───────────────────────────────────────
-- Drives the Issues panel. % of last-7-day exchanges that hit each issue.
create or replace view issue_frequency with (security_invoker = on) as
with totals as (
  select count(*)::numeric as total
  from conversation_analysis
  where created_at > now() - interval '7 days'
),
rule_issues as (
  select unnest(rule_flags) as issue, count(*) as cnt
  from conversation_analysis
  where created_at > now() - interval '7 days'
  group by 1
),
llm_issues as (
  select unnest(issues) as issue, count(*) as cnt
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and issues is not null
  group by 1
),
combined as (
  select issue, sum(cnt) as cnt from (
    select * from rule_issues
    union all
    select * from llm_issues
  ) u
  group by issue
)
select
  c.issue,
  c.cnt                                          as occurrences,
  round((c.cnt / nullif(t.total, 0)) * 100, 1)   as pct_of_exchanges,
  case
    when (c.cnt / nullif(t.total, 0)) * 100 >= 10 then 'red'
    when (c.cnt / nullif(t.total, 0)) * 100 >= 5  then 'amber'
    else 'green'
  end                                            as severity
from combined c, totals t
order by c.cnt desc;

-- ── View 4: hallucination_log ─────────────────────────────────────
-- Drives the Hallucinations panel. All flagged claims, newest first.
create or replace view hallucination_log with (security_invoker = on) as
select
  id,
  created_at,
  phone,
  user_message,
  bot_message,
  hallucination_detail,
  human_reviewed,
  human_verdict
from conversation_analysis
where 'hallucination' = any(rule_flags)
   or 'forbidden_claim' = any(rule_flags)
order by created_at desc
limit 500;

-- ── View 5: objection_breakdown ───────────────────────────────────
-- Drives the Objections panel. Type / count / handle rate.
create or replace view objection_breakdown with (security_invoker = on) as
select
  objection_type,
  count(*)                                       as occurrences,
  count(*) filter (where handled = true)         as handled_count,
  round(
    100.0 * count(*) filter (where handled = true) / nullif(count(*), 0),
    1
  )                                              as handle_rate_pct,
  avg(response_quality_score)                    as avg_quality
from conversation_analysis
where created_at > now() - interval '7 days'
  and objection_type is not null
  and objection_type <> 'none'
group by objection_type
order by occurrences desc;

-- ── View 6: bot_recurring_patterns ────────────────────────────────
-- "These are the bot phrases that keep showing up." Grouped by the
-- first-N-words signature stored in bot_phrase. Each group also tags
-- which rule_flags / issues most commonly co-occur with that phrase,
-- so a phrase that always fires no_cta jumps out.
create or replace view bot_recurring_patterns with (security_invoker = on) as
with totals as (
  select count(*)::numeric as total
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and bot_phrase is not null
)
select
  bot_phrase,
  count(*)                                                            as occurrences,
  round((count(*) / nullif((select total from totals), 0)) * 100, 1)  as pct_of_exchanges,
  count(*) filter (where 'no_cta' = any(rule_flags))                  as no_cta_count,
  count(*) filter (where 'too_long' = any(rule_flags))                as too_long_count,
  count(*) filter (where 'hallucination' = any(rule_flags))           as hallucination_count,
  count(*) filter (where 'robotic' = any(issues))                     as robotic_count,
  avg(response_quality_score)
    filter (where response_quality_score is not null)                 as avg_quality,
  -- Sample one exchange ID per phrase so the UI can deep-link to a real example.
  (array_agg(id order by created_at desc))[1]                         as sample_id
from conversation_analysis
where created_at > now() - interval '7 days'
  and bot_phrase is not null
group by bot_phrase
having count(*) >= 3       -- ignore one-off phrases
order by count(*) desc
limit 50;

-- ── View 7: user_recurring_patterns ───────────────────────────────
-- "These are the things customers keep asking." Same shape as bot
-- patterns. Especially useful for finding intents the prompt doesn't
-- handle well: if "loan kaise milega" appears 200 times and the bot's
-- handle rate on those is 40%, that's a specific prompt gap.
create or replace view user_recurring_patterns with (security_invoker = on) as
with totals as (
  select count(*)::numeric as total
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and user_phrase is not null
)
select
  user_phrase,
  count(*)                                                            as occurrences,
  round((count(*) / nullif((select total from totals), 0)) * 100, 1)  as pct_of_exchanges,
  count(*) filter (where handled = true)                              as handled_count,
  round(
    100.0 * count(*) filter (where handled = true) / nullif(count(*) filter (where handled is not null), 0),
    1
  )                                                                   as handle_rate_pct,
  avg(response_quality_score)
    filter (where response_quality_score is not null)                 as avg_quality,
  (array_agg(id order by created_at desc))[1]                         as sample_id
from conversation_analysis
where created_at > now() - interval '7 days'
  and user_phrase is not null
group by user_phrase
having count(*) >= 3
order by count(*) desc
limit 50;

-- ── View 8: customer_behavior ─────────────────────────────────────
-- Aggregated view of WHO the customers are, not just what the bot did.
--   - intent breakdown (browsing / researching / comparing / ready / etc.)
--   - top buying signals across the campaign
--   - top concerns
--   - missed-signal rate (how often did the customer drop a buying
--     signal the bot ignored — high value, low effort to fix)
create or replace view customer_behavior with (security_invoker = on) as
with t as (
  select count(*)::numeric as total
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and customer_intent is not null
),
intents as (
  select customer_intent as label, count(*) as cnt, 'intent' as kind
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and customer_intent is not null
  group by customer_intent
),
signals as (
  select unnest(customer_buying_signals) as label, count(*) as cnt, 'signal' as kind
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and customer_buying_signals is not null
  group by 1
),
concerns as (
  select unnest(customer_concerns) as label, count(*) as cnt, 'concern' as kind
  from conversation_analysis
  where created_at > now() - interval '7 days'
    and customer_concerns is not null
  group by 1
)
select
  kind,
  label,
  cnt                                                  as occurrences,
  round((cnt / nullif((select total from t), 0)) * 100, 1) as pct_of_exchanges
from (
  select * from intents
  union all
  select * from signals
  union all
  select * from concerns
) all_signals
order by kind, cnt desc;

-- ── View 9: missed_signals_summary ────────────────────────────────
-- Single number: % of evaluated exchanges where the customer dropped
-- a buying signal the bot ignored. If this is >15%, the prompt isn't
-- catching intent cues — high-impact place to focus.
create or replace view missed_signals_summary with (security_invoker = on) as
select
  count(*) filter (where missed_signal = true)                                          as missed_count,
  count(*) filter (where missed_signal is not null)                                     as evaluated_count,
  round(
    100.0 * count(*) filter (where missed_signal = true) / nullif(count(*) filter (where missed_signal is not null), 0),
    1
  )                                                                                    as missed_rate_pct
from conversation_analysis
where created_at > now() - interval '7 days';

-- ── Done ──────────────────────────────────────────────────────────
-- After running this, the analyzer in the backend will start writing
-- rows automatically. You don't need to touch SQL again.
--
-- Safe to re-run after edits — all ALTER/CREATE statements are guarded.
