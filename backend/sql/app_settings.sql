-- ================================================================
--  app_settings — Single-row settings store backed by Supabase
-- ----------------------------------------------------------------
--  Run this ONCE in Supabase SQL Editor:
--    Supabase Dashboard → SQL Editor → New Query → paste this whole
--    file → Run. Safe to re-run (idempotent).
--
--  Why:
--    Fly.io's container filesystem is ephemeral — settings.json gets
--    wiped on every redeploy. This table is the durable source of
--    truth. The backend caches it to settings.json on boot so existing
--    sync callers (ai.js, orchestrator.js, etc.) keep working unchanged.
-- ================================================================

create table if not exists app_settings (
  id          smallint     primary key default 1,
  data        jsonb        not null    default '{}'::jsonb,
  updated_at  timestamptz  not null    default now(),
  -- Lock to a single row. Any insert with id != 1 is rejected.
  constraint app_settings_single_row check (id = 1)
);

-- Seed the row if it doesn't exist. Safe to re-run.
insert into app_settings (id, data) values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- RLS: required by Supabase Security Advisor.
-- service_role key (used by backend) bypasses RLS — no behaviour change.
alter table public.app_settings enable row level security;
create policy if not exists "backend_service_role_access" on public.app_settings
  for all to service_role using (true) with check (true);
