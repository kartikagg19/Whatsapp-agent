// ================================================================
//  src/analyzer.js — Campaign Intelligence Layer 1 (rule checks)
// ----------------------------------------------------------------
//  Called fire-and-forget from the orchestrator after every send.
//  Runs deterministic checks against KB-extracted ground truth and
//  writes a conversation_analysis row. The Layer 2 LLM evaluator
//  picks up rows where eval_status='pending' on its own schedule
//  (see analyzerWorker.js).
//
//  This file MUST never throw out of analyzeExchange() — the caller
//  is fire-and-forget and will swallow nothing useful. Every error
//  path returns silently after logging.
// ================================================================

const { createClient } = require('@supabase/supabase-js');
const { getKnowledgeBase } = require('./database');

// ── Supabase client (cached) ───────────────────────────────────────
let _db = null;
function db() {
  if (!_db) {
    _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _db;
}

// ── Tunables ───────────────────────────────────────────────────────
const TOO_SHORT_CHARS = 30;       // bot replies under this are non-answers
const TOO_LONG_CHARS  = 800;      // bot replies over this are monologues
const KB_CACHE_MS     = 60_000;   // refresh ground-truth facts every 60s
const SAMPLE_RATE     = 5;        // 1-in-N clean exchanges get LLM-eval'd

// ── Forbidden claims (regex list — case-insensitive) ──────────────
//  These are legal/compliance risks for an Indian real-estate bot.
//  Hitting any of these = immediate flag, regardless of context.
const FORBIDDEN_PATTERNS = [
  { name: 'guaranteed_returns', re: /\b(guaranteed?|assured)\s+(returns?|profit|appreciation|rental)/i },
  { name: 'safe_investment',    re: /\b(100\s*%?\s*safe|risk[-\s]?free|no\s+risk)\b/i },
  { name: 'best_price_claim',   re: /\b(best\s+price\s+in\s+the\s+market|lowest\s+price\s+guaranteed|cheapest\s+in)/i },
  { name: 'promise_language',   re: /\b(i\s+promise|we\s+promise|hum\s+guarantee\s+dete|main\s+guarantee\s+deti)/i },
  { name: 'illegal_tax_advice', re: /\b(tax\s+free|black\s+money|cash\s+only\s+deal)/i }
];

// ── CTA detection (Hindi/Hinglish + English) ───────────────────────
//  A reply with NO forward action is flagged no_cta.
//  We look for any of: site visit offer, callback offer, document send,
//  a question to the user, or scheduling intent.
const CTA_PATTERNS = [
  /site\s*visit/i,
  /\bvisit\b/i,
  /\b(brochure|cost\s*sheet|sale\s*plan|floor\s*plan|layout)/i,
  /\b(call|callback|baat\s+kar)/i,
  /\b(saturday|sunday|weekday|weekend|kab|when|kaunsa|kis\s+time)/i,
  /\bschedule\b/i,
  /\?$/m,                                                   // ends with a question
  /\?\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]?\s*$/mu,    // question with optional emoji
  /(batayein|bataiye|batao|chahiye|kya\s+aap)/i
];

// ── Ground-truth fact cache (extracted from knowledge_base table) ──
let _factsCache = { facts: null, loadedAt: 0 };

/**
 * Extract verifiable facts from the knowledge base. Pulls:
 *   - prices (₹X Lakh / ₹X Crore / X L / X Cr)
 *   - possession dates (Month YYYY)
 *   - RERA numbers (alphanumeric tokens prefixed by RERA/MahaRERA)
 *
 * Returns { prices:Set, possessionDates:Set, reraNumbers:Set, projectNames:Set }.
 * Used by the hallucination checker: any bot claim of a price/date/RERA
 * not in these sets gets flagged.
 *
 * Cached for 60s so we don't hammer Supabase on every message.
 */
async function loadGroundTruth() {
  const now = Date.now();
  if (_factsCache.facts && now - _factsCache.loadedAt < KB_CACHE_MS) {
    return _factsCache.facts;
  }
  try {
    const docs = await getKnowledgeBase();
    const corpus = docs.map(d => `${d.name || ''}\n${d.content || ''}`).join('\n\n');
    const facts = extractFacts(corpus);
    _factsCache = { facts, loadedAt: now };
    return facts;
  } catch (e) {
    console.warn('⚠️  analyzer: KB load failed, hallucination check skipped this turn:', e.message);
    // Fall back to whatever's cached even if stale; otherwise empty (won't flag).
    return _factsCache.facts || { prices: new Set(), possessionDates: new Set(), reraNumbers: new Set(), projectNames: new Set() };
  }
}

/** Extract facts from a free-text KB corpus. Pure function — testable. */
function extractFacts(text) {
  const prices = new Set();
  const dates  = new Set();
  const reras  = new Set();
  const names  = new Set();

  if (!text) return { prices, possessionDates: dates, reraNumbers: reras, projectNames: names };

  // Prices: ₹68 lakh, ₹1.21 Crore, 76L, 1.5 Cr, etc.
  const priceRe = /(?:₹\s*)?(\d+(?:[.,]\d+)?)\s*(lakh|lac|l\b|crore|cr\b)/gi;
  let m;
  while ((m = priceRe.exec(text)) !== null) {
    prices.add(normalizePrice(m[1], m[2]));
  }

  // Possession dates: "December 2026", "Dec 2026", "12/2026", "Q4 2026"
  const dateRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(20\d{2})\b/gi;
  while ((m = dateRe.exec(text)) !== null) {
    dates.add(normalizeMonth(m[1]) + '-' + m[2]);
  }
  const quarterRe = /\bq([1-4])\s+(20\d{2})\b/gi;
  while ((m = quarterRe.exec(text)) !== null) {
    dates.add('Q' + m[1] + '-' + m[2]);
  }

  // RERA numbers — appears after "RERA" / "MahaRERA" prefix.
  const reraRe = /(?:maha)?rera\s*(?:no\.?|number|reg\.?|registration)?\s*[:\-]?\s*([A-Z]\d{5,}[A-Z0-9\/\-]*)/gi;
  while ((m = reraRe.exec(text)) !== null) {
    reras.add(m[1].toUpperCase());
  }
  // Loose pattern: P5xxxxxxxx (Maharashtra format)
  const reraLoose = /\bP\d{8,}\b/g;
  while ((m = reraLoose.exec(text)) !== null) {
    reras.add(m[0].toUpperCase());
  }

  // Project names — anything after "## PROJECT:" in our KB format.
  const projRe = /## PROJECT:\s*([^\n]+)/gi;
  while ((m = projRe.exec(text)) !== null) {
    names.add(m[1].trim().toLowerCase());
  }

  return { prices, possessionDates: dates, reraNumbers: reras, projectNames: names };
}

function normalizePrice(numStr, unitStr) {
  const num  = parseFloat(numStr.replace(',', '.'));
  const unit = unitStr.toLowerCase();
  // Normalize everything to lakhs for comparison.
  const lakhs = /cr/.test(unit) ? num * 100 : num;
  return Math.round(lakhs * 10) / 10; // 1-decimal precision
}

function normalizeMonth(monStr) {
  const map = { jan:'Jan', feb:'Feb', mar:'Mar', apr:'Apr', may:'May', jun:'Jun',
                jul:'Jul', aug:'Aug', sep:'Sep', sept:'Sep', oct:'Oct', nov:'Nov', dec:'Dec' };
  return map[monStr.toLowerCase().slice(0,3)] || monStr;
}

// ── Rule checks (pure functions, return list of flag objects) ─────

function checkHallucinations(botText, gt) {
  const flags = [];
  const detail = [];

  // Find every price the bot stated. Anything not in gt.prices is suspect.
  const priceRe = /(?:₹\s*)?(\d+(?:[.,]\d+)?)\s*(lakh|lac|l\b|crore|cr\b)/gi;
  let m;
  while ((m = priceRe.exec(botText)) !== null) {
    const val = normalizePrice(m[1], m[2]);
    if (!gt.prices.has(val) && gt.prices.size > 0) {
      // Allow ±2 lakh fuzzy match to absorb rounding ("68L" vs "68 lakh").
      let close = false;
      for (const p of gt.prices) if (Math.abs(p - val) <= 2) { close = true; break; }
      if (!close) {
        detail.push({ kind: 'price', claim: m[0], normalized: val });
      }
    }
  }

  // Possession dates.
  const dateRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(20\d{2})\b/gi;
  while ((m = dateRe.exec(botText)) !== null) {
    const key = normalizeMonth(m[1]) + '-' + m[2];
    if (gt.possessionDates.size > 0 && !gt.possessionDates.has(key)) {
      // Tolerate same-year mismatch on month? No — possession date is precise.
      detail.push({ kind: 'date', claim: m[0], normalized: key });
    }
  }

  // RERA numbers — these MUST match exactly.
  const reraLoose = /\bP\d{8,}\b/g;
  while ((m = reraLoose.exec(botText)) !== null) {
    if (gt.reraNumbers.size > 0 && !gt.reraNumbers.has(m[0].toUpperCase())) {
      detail.push({ kind: 'rera', claim: m[0] });
    }
  }

  if (detail.length) {
    flags.push('hallucination');
  }
  return { flags, detail: detail.length ? { items: detail } : null };
}

function checkForbidden(botText) {
  const flags = [];
  for (const p of FORBIDDEN_PATTERNS) {
    if (p.re.test(botText)) {
      flags.push('forbidden_claim');
      return flags; // one is enough
    }
  }
  return flags;
}

function checkCTA(botText) {
  for (const re of CTA_PATTERNS) {
    if (re.test(botText)) return [];
  }
  return ['no_cta'];
}

function checkLength(botText) {
  const flags = [];
  const len = (botText || '').length;
  if (len < TOO_SHORT_CHARS) flags.push('too_short');
  if (len > TOO_LONG_CHARS)  flags.push('too_long');
  return flags;
}

// ── Sampling gate ──────────────────────────────────────────────────
// LLM evaluation runs on:
//   - every exchange that hit a rule flag (we want context for failures)
//   - 1-in-N clean exchanges (the SAMPLE_RATE constant)
// Other clean exchanges get eval_status='skipped' so they're never
// picked up by the worker — keeps cost predictable.
function shouldEvaluate(ruleFlags) {
  if (ruleFlags.length > 0) return true;
  return Math.floor(Math.random() * SAMPLE_RATE) === 0;
}

// ── Phrase signature (first ~6 normalized words) ───────────────────
// Used to group "the same kind of reply" together for the Recurring
// Patterns panel. Strips punctuation, lowercases, removes emoji,
// collapses whitespace, then takes the first 6 tokens. Deterministic
// — same input always produces same signature.
const PHRASE_WORD_COUNT = 6;
function phraseSignature(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text
    .toLowerCase()
    // strip emoji + most symbols, keep letters, digits, spaces, common Indic ranges
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  const words = normalized.split(' ').slice(0, PHRASE_WORD_COUNT);
  if (words.length < 2) return null; // single word isn't a useful signature
  return words.join(' ');
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Run rule checks and persist a conversation_analysis row.
 * Fire-and-forget — never throws to the caller.
 *
 * @param {object} args
 * @param {string} args.phone
 * @param {string} args.userMessage   merged inbound text
 * @param {string} args.botMessage    full reply_message before chunking
 */
async function analyzeExchange({ phone, userMessage, botMessage }) {
  if (!phone || !botMessage) return;

  try {
    const gt = await loadGroundTruth();

    const flags = [];
    const hallu = checkHallucinations(botMessage, gt);
    flags.push(...hallu.flags);
    flags.push(...checkForbidden(botMessage));
    flags.push(...checkCTA(botMessage));
    flags.push(...checkLength(botMessage));

    const evalStatus = shouldEvaluate(flags) ? 'pending' : 'skipped';

    const row = {
      phone,
      user_message:         userMessage || null,
      bot_message:          botMessage,
      rule_flags:           flags,
      hallucination_detail: hallu.detail,
      bot_message_length:   botMessage.length,
      bot_phrase:           phraseSignature(botMessage),
      user_phrase:          phraseSignature(userMessage),
      eval_status:          evalStatus
    };

    const { error } = await db().from('conversation_analysis').insert(row);
    if (error) {
      // The most common error here is "relation does not exist" if the
      // SQL migration hasn't been run yet. Surface it loudly ONCE.
      if (/does not exist/i.test(error.message) && !_loggedSchemaWarn) {
        console.error('❌ analyzer: conversation_analysis table missing.');
        console.error('   Run backend/sql/conversation_analysis.sql in Supabase SQL Editor.');
        _loggedSchemaWarn = true;
      } else if (!/does not exist/i.test(error.message)) {
        console.warn('⚠️  analyzer insert failed:', error.message);
      }
    }
  } catch (e) {
    console.warn('⚠️  analyzer: unexpected error (swallowed):', e.message);
  }
}

let _loggedSchemaWarn = false;

// Exposed for unit tests + the worker.
module.exports = {
  analyzeExchange,
  // internal — exported for tests / worker reuse
  _internal: {
    extractFacts, checkHallucinations, checkForbidden, checkCTA, checkLength,
    shouldEvaluate, loadGroundTruth, normalizePrice, phraseSignature
  }
};
