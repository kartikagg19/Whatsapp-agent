// ================================================================
//  src/analyzerWorker.js — Campaign Intelligence Layer 2 (LLM eval)
// ----------------------------------------------------------------
//  Background worker. Every WORKER_INTERVAL_MS it pulls up to
//  BATCH_SIZE rows from conversation_analysis where eval_status =
//  'pending', sends them to Gemini in ONE call for evaluation, then
//  writes the classifications back per-row.
//
//  Batching matters at scale: at 1k–1.5k outbound numbers/day this
//  table can fill with thousands of rows. One Gemini call evaluating
//  30 exchanges is ~10x cheaper than 30 separate calls.
//
//  Designed to be safe to crash and restart — eval_status='pending'
//  rows stay pending and get picked up next tick. Rows that fail twice
//  go to eval_status='error' to avoid infinite retries.
// ================================================================

const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');
function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

const WORKER_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const BATCH_SIZE         = 30;              // exchanges per Gemini call
const MAX_ATTEMPTS       = 2;               // give up after 2 failures

let _ai = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _ai;
}

let _db = null;
function db() {
  if (!_db) _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  return _db;
}

// ── Prompt for the evaluator ───────────────────────────────────────
// Designed to return a JSON array, one object per exchange, in the
// same order it received them. Keeps the schema flat and predictable.
const EVAL_PROMPT = `You are an analytics evaluator for a WhatsApp sales bot working in the Indian real-estate domain. The bot replies in Hinglish (Hindi + English mix). For each exchange below, classify these fields:

- sales_stage: one of awareness | interest | qualification | objection | closing | dead
- sentiment: one of positive | neutral | negative | hostile  (customer's tone toward the bot)
- objection_type: one of price | location | timing | trust | competitor | none  (if the customer pushed back, what about?)
- response_quality_score: integer 1-10 — how well did the bot's reply move the conversation forward?
- handled: true | false — did the bot's reply actually address what the user asked / move past the objection?
- issues: array of short tags from this list ONLY: ["robotic","missed_lead_signal","ignored_question","off_topic","over_promised","weak_close","good_handling","strong_close"]
- improvement_suggestion: one short sentence — what could the bot have said better? Empty string if the reply was good.

Return ONLY a JSON array, one element per exchange, in the same order as input. No prose, no markdown fences.

EXCHANGES:
`;

function buildPrompt(rows) {
  const block = rows.map((r, i) =>
    `[${i + 1}]\nUser: ${r.user_message || '(no user text)'}\nBot: ${r.bot_message}`
  ).join('\n\n');
  return EVAL_PROMPT + block;
}

async function evaluateBatch(rows) {
  const settings = getSettings();
  const model = settings.eval_model || 'gemini-2.5-flash';

  const resp = await ai().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: buildPrompt(rows) }] }],
    config: {
      systemInstruction: 'You output only valid JSON arrays. Never wrap in markdown fences. Never add prose.',
      responseMimeType: 'application/json'
    }
  });
  const raw = (resp.text || '').trim();
  if (!raw) throw new Error('empty eval response');

  // Strip markdown fences defensively (responseMimeType usually prevents these).
  const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error(`eval JSON parse failed: ${clean.slice(0, 200)}`);
    parsed = JSON.parse(clean.slice(start, end + 1));
  }
  if (!Array.isArray(parsed)) throw new Error('eval response was not an array');
  if (parsed.length !== rows.length) {
    console.warn(`⚠️  worker: got ${parsed.length} evals for ${rows.length} rows — truncating to min`);
  }
  return parsed;
}

const ALLOWED_STAGE = new Set(['awareness','interest','qualification','objection','closing','dead']);
const ALLOWED_SENT  = new Set(['positive','neutral','negative','hostile']);
const ALLOWED_OBJ   = new Set(['price','location','timing','trust','competitor','none']);

function sanitize(e) {
  if (!e || typeof e !== 'object') return null;
  const stage = ALLOWED_STAGE.has(e.sales_stage) ? e.sales_stage : null;
  const sent  = ALLOWED_SENT.has(e.sentiment) ? e.sentiment : null;
  const obj   = ALLOWED_OBJ.has(e.objection_type) ? e.objection_type : null;
  let q = parseInt(e.response_quality_score);
  if (!Number.isFinite(q)) q = null;
  else q = Math.max(1, Math.min(10, q));
  const issues = Array.isArray(e.issues) ? e.issues.filter(s => typeof s === 'string').slice(0, 6) : [];
  const handled = typeof e.handled === 'boolean' ? e.handled : null;
  const sug = typeof e.improvement_suggestion === 'string'
    ? e.improvement_suggestion.slice(0, 300)
    : null;
  return {
    sales_stage:            stage,
    sentiment:              sent,
    objection_type:         obj,
    response_quality_score: q,
    issues,
    handled,
    improvement_suggestion: sug
  };
}

async function runTick() {
  let rows;
  try {
    const { data, error } = await db()
      .from('conversation_analysis')
      .select('id, user_message, bot_message, eval_attempts')
      .eq('eval_status', 'pending')
      .lt('eval_attempts', MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (error) {
      if (/does not exist/i.test(error.message)) {
        // table missing — analyzer.js already logged a clear warning. Stay quiet here.
        return;
      }
      console.warn('⚠️  worker: fetch failed:', error.message);
      return;
    }
    rows = data || [];
  } catch (e) {
    console.warn('⚠️  worker: fetch threw:', e.message);
    return;
  }

  if (!rows.length) return;

  let evals;
  try {
    evals = await evaluateBatch(rows);
  } catch (e) {
    console.warn('⚠️  worker: eval batch failed:', e.message);
    // Bump attempt counter; rows past MAX_ATTEMPTS won't be re-selected.
    await Promise.all(rows.map(r =>
      db().from('conversation_analysis')
        .update({ eval_attempts: (r.eval_attempts || 0) + 1, eval_error: e.message?.slice(0, 200) })
        .eq('id', r.id)
        .then(({ error }) => { if (error) console.warn('⚠️  worker: attempt bump failed:', error.message); })
    ));
    // Mark rows that hit max attempts as 'error' so they don't sit pending forever.
    await db().from('conversation_analysis')
      .update({ eval_status: 'error' })
      .gte('eval_attempts', MAX_ATTEMPTS)
      .eq('eval_status', 'pending');
    return;
  }

  // Write evaluations back. Use Promise.all for parallel updates.
  const writes = rows.map((row, i) => {
    const clean = sanitize(evals[i]);
    if (!clean) {
      return db().from('conversation_analysis')
        .update({ eval_status: 'error', eval_attempts: (row.eval_attempts || 0) + 1, eval_error: 'sanitize-rejected' })
        .eq('id', row.id);
    }
    return db().from('conversation_analysis')
      .update({
        ...clean,
        eval_status: 'done',
        evaluated_at: new Date().toISOString()
      })
      .eq('id', row.id);
  });
  const results = await Promise.all(writes);
  const failed = results.filter(r => r.error).length;
  console.log(`📊 worker: evaluated ${rows.length} exchanges${failed ? ` (${failed} write failures)` : ''}`);
}

let _started = false;
function startAnalyzerWorker() {
  if (_started) return;
  _started = true;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  worker: GEMINI_API_KEY not set — Layer 2 evaluation disabled');
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.warn('⚠️  worker: SUPABASE creds missing — Layer 2 evaluation disabled');
    return;
  }
  console.log(`📊 analyzer worker started (every ${WORKER_INTERVAL_MS / 1000}s, batch ${BATCH_SIZE})`);
  // Run one immediate tick (after a small delay) so dev cycles are fast,
  // then the interval keeps it going.
  setTimeout(() => runTick().catch(e => console.warn('⚠️  worker tick crashed:', e.message)), 15_000).unref();
  setInterval(() => runTick().catch(e => console.warn('⚠️  worker tick crashed:', e.message)), WORKER_INTERVAL_MS).unref();
}

module.exports = { startAnalyzerWorker, _internal: { sanitize, evaluateBatch, runTick } };
