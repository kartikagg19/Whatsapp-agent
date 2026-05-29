// ================================================================
//  src/routes/analytics.js — Campaign Intelligence read-only API
// ----------------------------------------------------------------
//  All endpoints query the conversation_analysis table + its views.
//  Read-only except POST /queue/:id/verdict which records the human
//  reviewer's call on a flagged exchange.
//
//  All endpoints return JSON and degrade gracefully if the table
//  doesn't exist yet (returns empty data, not an error).
// ================================================================
const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

let _db = null;
function db() {
  if (!_db) _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  return _db;
}

// If the schema doesn't exist yet, log once and return empty payloads.
let _schemaWarned = false;
function isSchemaMissing(err) {
  return err && /does not exist/i.test(err.message || '');
}
function handleSchemaMissing(res, fallback) {
  if (!_schemaWarned) {
    console.warn('⚠️  analytics: conversation_analysis schema not yet created — returning empty data');
    console.warn('   Run backend/sql/conversation_analysis.sql in Supabase SQL Editor.');
    _schemaWarned = true;
  }
  res.json(fallback);
}

// ── GET /api/analytics/overview ────────────────────────────────────
// Returns the 7 headline metric cards for the Overview panel.
router.get('/overview', async (req, res) => {
  try {
    const { data, error } = await db()
      .from('daily_campaign_metrics')
      .select('*')
      .limit(30);
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { last7: emptyOverview(), trendDaily: [] });
      return res.status(500).json({ error: error.message });
    }
    const days = (data || []).slice(0, 7); // last 7 days
    const totals = days.reduce((acc, d) => {
      acc.total_exchanges  += +d.total_exchanges  || 0;
      acc.hallucinations   += +d.hallucinations   || 0;
      acc.forbidden_claims += +d.forbidden_claims || 0;
      acc.no_cta_count     += +d.no_cta_count     || 0;
      acc.hostile_count    += +d.hostile_count    || 0;
      acc.at_closing_count += +d.at_closing_count || 0;
      acc.dead_count       += +d.dead_count       || 0;
      acc.handled_count    += +d.handled_count    || 0;
      acc.evaluated_count  += +d.evaluated_count  || 0;
      if (d.avg_quality != null) {
        acc._qSum += +d.avg_quality * (+d.evaluated_count || 0);
        acc._qN   += +d.evaluated_count || 0;
      }
      return acc;
    }, emptyOverview());

    const avg_quality = totals._qN > 0 ? +(totals._qSum / totals._qN).toFixed(2) : null;
    const handle_rate_pct = totals.evaluated_count > 0
      ? +((totals.handled_count / totals.evaluated_count) * 100).toFixed(1)
      : null;

    delete totals._qSum; delete totals._qN;
    res.json({
      last7: { ...totals, avg_quality, handle_rate_pct },
      trendDaily: (data || []).slice().reverse()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function emptyOverview() {
  return {
    total_exchanges: 0, hallucinations: 0, forbidden_claims: 0, no_cta_count: 0,
    hostile_count: 0, at_closing_count: 0, dead_count: 0,
    handled_count: 0, evaluated_count: 0, _qSum: 0, _qN: 0
  };
}

// ── GET /api/analytics/funnel ──────────────────────────────────────
router.get('/funnel', async (req, res) => {
  try {
    const { data, error } = await db().from('sales_funnel').select('*');
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { funnel: [] });
      return res.status(500).json({ error: error.message });
    }
    res.json({ funnel: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/issues ──────────────────────────────────────
router.get('/issues', async (req, res) => {
  try {
    const { data, error } = await db().from('issue_frequency').select('*').limit(40);
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { issues: [] });
      return res.status(500).json({ error: error.message });
    }
    res.json({ issues: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/hallucinations ──────────────────────────────
router.get('/hallucinations', async (req, res) => {
  try {
    const { data, error } = await db().from('hallucination_log').select('*').limit(100);
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { items: [] });
      return res.status(500).json({ error: error.message });
    }
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/objections ──────────────────────────────────
router.get('/objections', async (req, res) => {
  try {
    const { data, error } = await db().from('objection_breakdown').select('*');
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { breakdown: [], samples: [] });
      return res.status(500).json({ error: error.message });
    }
    // Also fetch 2 sample exchanges per objection type for the panel.
    const { data: samples } = await db()
      .from('conversation_analysis')
      .select('id, created_at, phone, user_message, bot_message, objection_type, handled, response_quality_score')
      .not('objection_type', 'is', null)
      .neq('objection_type', 'none')
      .order('created_at', { ascending: false })
      .limit(30);
    res.json({ breakdown: data || [], samples: samples || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/analytics/queue ───────────────────────────────────────
// Items needing human review: rule-flagged OR low quality OR hostile.
router.get('/queue', async (req, res) => {
  try {
    const reviewed = req.query.reviewed === '1';
    let q = db()
      .from('conversation_analysis')
      .select('id, created_at, phone, user_message, bot_message, rule_flags, hallucination_detail, sales_stage, sentiment, objection_type, response_quality_score, issues, handled, improvement_suggestion, human_reviewed, human_verdict, human_note')
      .order('created_at', { ascending: false })
      .limit(200);

    q = reviewed
      ? q.eq('human_reviewed', true)
      : q.eq('human_reviewed', false);

    const { data, error } = await q;
    if (error) {
      if (isSchemaMissing(error)) return handleSchemaMissing(res, { items: [] });
      return res.status(500).json({ error: error.message });
    }

    // Filter: only show "interesting" rows in the unreviewed queue.
    // Reviewed view shows everything that's been touched.
    const filtered = reviewed
      ? (data || [])
      : (data || []).filter(r =>
          (r.rule_flags && r.rule_flags.length > 0) ||
          (r.response_quality_score != null && r.response_quality_score <= 4) ||
          r.sentiment === 'hostile'
        );

    res.json({ items: filtered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/analytics/queue/:id/verdict ──────────────────────────
// Reviewer marks a queue item as confirmed_bad / false_alarm / hallucination_confirmed.
router.post('/queue/:id/verdict', express.json(), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const { verdict, note } = req.body || {};
  const allowed = ['confirmed_bad', 'false_alarm', 'hallucination_confirmed'];
  if (!allowed.includes(verdict)) return res.status(400).json({ error: 'bad verdict' });

  try {
    const { error } = await db()
      .from('conversation_analysis')
      .update({
        human_reviewed:    true,
        human_verdict:     verdict,
        human_note:        typeof note === 'string' ? note.slice(0, 500) : null,
        human_reviewed_at: new Date().toISOString()
      })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
