// ================================================================
//  src/orchestrator.js — Message Buffering + Cancellation Layer
// ----------------------------------------------------------------
//  Wraps the AI-reply pipeline with three orchestration improvements:
//    1. Per-session buffering: rapid-fire inbound messages are merged
//       into a single AI inference (debounce 2.5s base, 6s hard cap).
//    2. Stale-generation cancellation: a new inbound during inflight
//       AI/send aborts the prior pipeline before delivery.
//    3. Chunked delivery: AI replies are split into 1–3 conversational
//       sends with a small typing pause between them.
//
//  IMPORTANT — DEPLOYMENT ASSUMPTION:
//    This module holds state in-process Maps. It is correct ONLY for
//    single-process deployment (current setup: `node src/index.js`).
//    If you ever move to PM2 cluster mode or multiple containers,
//    move `buffers` and `inflight` into Redis (or pin sessions to a
//    worker via sticky routing). Otherwise users on different workers
//    will get split buffers and duplicate replies.
//
//  This file deliberately does NOT touch:
//    - the AI prompt / Gemini call (ai.js)
//    - DB schema or CRM payloads (database.js, crmClient.js)
//    - the follow-up scheduler
//    - the dashboard admin routes
//  All it does is reorder and gate the existing pipeline.
// ================================================================

const fs   = require('fs');
const path = require('path');
const { getAIReply, getLeadLabel } = require('./ai');
const { sendText, sendImage, sendDocument, sendButtons, alertSales, isImageUrl } = require('./whatsapp');
const { syncTimeline } = require('./crmClient');
const { splitReply } = require('./chunker');
const { analyzeExchange } = require('./analyzer');
const { resolveTypeToRows } = require('./mediaTypes');
const db = require('./database');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');
function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

// ── Tunables (overridable via settings.json) ───────────────────────
const DEFAULTS = {
  buffer_base_ms:    5000,   // wait this long after first message
  buffer_extend_ms:  1500,   // bump timer by this on each new message
  buffer_max_ms:     6000,   // hard cap from firstAt — never wait longer
  chunk_delay_min:   800,    // pause between chunked sends (ms)
  chunk_delay_max:   1400,
  reply_delay_ms:    0       // legacy "reply_delay" honoured for compat
};
function tunables() {
  const s = getSettings();
  return {
    buffer_base_ms:   parseInt(s.buffer_base_ms)   || DEFAULTS.buffer_base_ms,
    buffer_extend_ms: parseInt(s.buffer_extend_ms) || DEFAULTS.buffer_extend_ms,
    buffer_max_ms:    parseInt(s.buffer_max_ms)    || DEFAULTS.buffer_max_ms,
    chunk_delay_min:  parseInt(s.chunk_delay_min)  || DEFAULTS.chunk_delay_min,
    chunk_delay_max:  parseInt(s.chunk_delay_max)  || DEFAULTS.chunk_delay_max,
    reply_delay_ms:   parseInt(s.reply_delay)      || DEFAULTS.reply_delay_ms
  };
}

// ── State ──────────────────────────────────────────────────────────
// buffers: phone -> {
//   messages: [{ text, messageId, name, receivedAt }],
//   firstAt, timer, name, latestMessageId
// }
// inflight: phone -> { controller: AbortController, startedAt }
const buffers  = new Map();
const inflight = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const aborted = (sig) => !!(sig && sig.aborted);
const rand = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min));

// Defensive sweeper: purge stuck entries every 30s.
// In practice `finally` blocks clean up, but a crashing handler or
// rogue timer should never leak memory in a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [phone, buf] of buffers.entries()) {
    if (now - buf.firstAt > 60_000) {
      try { clearTimeout(buf.timer); } catch {}
      buffers.delete(phone);
      console.warn(`⚠️  orchestrator: swept stale buffer for ${phone}`);
    }
  }
  for (const [phone, inf] of inflight.entries()) {
    if (now - inf.startedAt > 120_000) {
      try { inf.controller.abort(); } catch {}
      inflight.delete(phone);
      console.warn(`⚠️  orchestrator: swept stuck inflight for ${phone}`);
    }
  }
}, 30_000).unref();

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Called by the webhook for every inbound user message.
 * Schedules a debounced AI reply; merges with any pending buffer.
 * Also aborts any inflight generation for this user — the latest
 * inbound invalidates whatever the model was about to say.
 */
function enqueueInbound({ phone, name, text, messageId }) {
  if (!phone || !text) return;

  // 1. Abort any inflight pipeline for this user. The new message
  //    means the old reply is stale by definition.
  const inf = inflight.get(phone);
  if (inf) {
    try { inf.controller.abort(); } catch {}
    inflight.delete(phone);
    console.log(`⏸  orchestrator: aborted stale generation for ${phone}`);
  }

  // 2. Append to (or create) the buffer for this user.
  const T = tunables();
  const now = Date.now();
  let buf = buffers.get(phone);
  if (!buf) {
    buf = {
      messages: [],
      firstAt: now,
      timer: null,
      name,
      latestMessageId: messageId
    };
    buffers.set(phone, buf);
  } else {
    if (name) buf.name = name;
    buf.latestMessageId = messageId;
  }
  buf.messages.push({ text, messageId, name, receivedAt: now });

  // 3. (Re)arm the debounce timer.
  //    Extended delay on each new message, but never past buffer_max_ms
  //    from the *first* message in this window.
  if (buf.timer) clearTimeout(buf.timer);
  const elapsedFromFirst = now - buf.firstAt;
  const remainingBudget  = Math.max(0, T.buffer_max_ms - elapsedFromFirst);
  const desiredWait      = buf.messages.length === 1
    ? T.buffer_base_ms
    : T.buffer_extend_ms;
  const wait = Math.min(desiredWait, remainingBudget);

  buf.timer = setTimeout(() => {
    // Detach the buffer atomically before running the pipeline so
    // any messages arriving during AI/send go into a fresh buffer
    // (and abort this one via inflight cancellation).
    const detached = buffers.get(phone);
    buffers.delete(phone);
    if (!detached) return;
    runPipeline(phone, detached).catch(err => {
      console.error(`❌ orchestrator pipeline crashed for ${phone}:`, err.message);
    });
  }, wait);
  buf.timer.unref?.();
}

// ────────────────────────────────────────────────────────────────────
// Pipeline (formerly the back half of webhook.js)
// ────────────────────────────────────────────────────────────────────

async function runPipeline(phone, buf) {
  const T = tunables();
  // Join with newlines so the AI sees each rapid message on its own
  // line — preserves "these were separate thoughts" signal. Space-join
  // collapsed short fragments like "3bhk vista" + "price" + "2bhk pie"
  // into ambiguous run-on text that Gemini misread.
  const mergedText = buf.messages.map(m => m.text).join('\n').trim();
  const lastMessageId = buf.latestMessageId || buf.messages[buf.messages.length - 1]?.messageId;
  const name = buf.name || 'Unknown';

  if (!mergedText) return;
  if (buf.messages.length > 1) {
    console.log(`🧩 orchestrator: merged ${buf.messages.length} msgs for ${phone} → "${mergedText.slice(0, 120)}${mergedText.length > 120 ? '…' : ''}"`);
  }

  // Snapshot lead at flush-time (not enqueue-time) so calendar-button
  // dedupe and HOT-alert dedupe reflect the latest DB state.
  let history = [], existingLead = null;
  try {
    [history, existingLead] = await Promise.all([
      db.getHistory(phone, 20),
      db.getLeadByPhone(phone)
    ]);
  } catch (e) {
    console.error('❌ DB read failed:', e.message);
  }
  console.log(`📚 History: ${history.length} msgs | Lead: ${existingLead ? existingLead.label : 'NEW'}`);

  // Register inflight + abort controller for stale-generation cancellation.
  const controller = new AbortController();
  inflight.set(phone, { controller, startedAt: Date.now() });
  const signal = controller.signal;

  try {
    // ── AI inference ────────────────────────────────────────────────
    let ai;
    try {
      ai = await getAIReply(mergedText, history, existingLead);
    } catch (e) {
      console.error('❌ AI failed:', e.message);
      if (!aborted(signal)) {
        await sendText(phone, 'Ek second ji, thoda busy hoon. Aap dobara message karein please 🙏').catch(() => {});
      }
      return;
    }
    if (aborted(signal)) {
      console.log(`⏹  orchestrator: dropping stale AI reply for ${phone}`);
      return;
    }

    const label = getLeadLabel(ai.lead_score);
    console.log(`🤖 Reply (${label} ${ai.lead_score}/10): "${ai.reply_message}"`);

    // ── Persist reply + upsert lead (fire-and-forget, like before) ──
    const siteVisitNow = !!(ai.site_visit_offered || ai.site_visit_confirmed);
    db.saveMessage({
      phone, role: 'assistant', message: ai.reply_message,
      score: ai.lead_score,
      input_tokens: ai.input_tokens, output_tokens: ai.output_tokens
    }).catch(e => console.warn('⚠️ save reply failed:', e.message));
    db.upsertLead({
      phone, name, score: ai.lead_score, label, intent: ai.qualification_stage || 'general',
      budget_range:        ai.budget_range        || undefined,
      location_preference: ai.location_preference || undefined,
      timeline:            ai.timeline            || undefined,
      purpose:             ai.purpose             || undefined,
      site_visit_offered:  siteVisitNow           || undefined
    }).catch(e => console.warn('⚠️ upsertLead failed:', e.message));

    // ── Legacy reply_delay (kept for backward compat with admin UI) ─
    if (T.reply_delay_ms > 0) {
      await sleep(T.reply_delay_ms);
      if (aborted(signal)) {
        console.log(`⏹  orchestrator: aborted before send (post-delay) for ${phone}`);
        return;
      }
    }

    // ── Resolve attachments (v2.7 contract + legacy fallback) ──────
    // Returns an ordered list of { kind, url, filename } to send AFTER
    // the text chunks. Dedupes URLs so the same file isn't sent twice.
    const attachments = await resolveAttachments(ai);
    if (attachments.length > 0) {
      console.log(`📎 ${attachments.length} attachment(s) queued for ${phone}: ` +
        attachments.map(a => `${a.kind}:${a.filename}`).join(', '));
    }

    // ── Chunked send ────────────────────────────────────────────────
    const chunks = splitReply(ai.reply_message);
    const alreadySentCalendar = existingLead?.site_visit_offered === true;
    const attachButtonsToLast = siteVisitNow && !alreadySentCalendar;

    // Files go AFTER text chunks but BEFORE the calendar prompt,
    // matching the prior single-message flow.
    for (let i = 0; i < chunks.length; i++) {
      if (aborted(signal)) {
        console.log(`⏹  orchestrator: abort mid-chunk for ${phone} (chunk ${i + 1}/${chunks.length})`);
        return;
      }
      const isLast = i === chunks.length - 1;
      try {
        await sendText(phone, chunks[i]);
        if (!isLast) {
          await sleep(rand(T.chunk_delay_min, T.chunk_delay_max));
        }
      } catch (e) {
        console.error('❌ sendText failed:', e.response?.data || e.message);
        return;
      }
    }

    // Send each attachment as native WhatsApp media (image / document).
    for (const a of attachments) {
      if (aborted(signal)) {
        console.log(`⏹  orchestrator: abort before attachment ${a.filename}`);
        return;
      }
      await sendAttachment(phone, a);
    }

    if (attachButtonsToLast && !aborted(signal)) {
      await sendButtons(phone, '📅 Site visit ke liye time choose karein:', [
        { id: 'saturday', title: 'Saturday' },
        { id: 'sunday',   title: 'Sunday'   },
        { id: 'weekday',  title: 'Weekday'  }
      ]).catch(e => console.warn('⚠️ Calendar buttons failed:', e.message));
      console.log(`📅 Calendar buttons sent to ${phone}`);
    }

    // ── HOT lead alert (fires ONCE — preserved from webhook.js) ─────
    const wasHotBefore = existingLead?.label === 'HOT';
    if (label === 'HOT' && !wasHotBefore && process.env.SALES_PHONE_NUMBER) {
      console.log(`🔥 NEW HOT lead — alerting sales: ${phone}`);
      const salesNumbers = process.env.SALES_PHONE_NUMBER.split(',').map(n => n.trim()).filter(Boolean);
      salesNumbers.forEach(salesNum => {
        alertSales(salesNum, {
          phone, name, score: ai.lead_score * 10, intent: ai.qualification_stage || 'general'
        }).catch(e => console.warn('⚠️ Sales alert failed:', e.message));
      });
    }

    // ── CRM sync OUTBOUND only (inbound is synced from webhook.js) ──
    syncTimeline({
      phone, direction: 'outbound', message: ai.reply_message,
      call_id: `wa-out-${lastMessageId}`,
      ai_score: (typeof ai.lead_score === 'number' && isFinite(ai.lead_score)) ? Math.round(ai.lead_score * 10) : null,
      intent: ai.qualification_stage, qualified: !!ai.qualified, summary: ai.summary,
      profile_patch: { budget_range: ai.budget_range }
    }).catch(() => {});

    // ── Campaign Intelligence — fire-and-forget Layer 1 analysis ────
    // Never throws (analyzer swallows internally). Never delays user reply.
    analyzeExchange({
      phone,
      userMessage: mergedText,
      botMessage:  ai.reply_message
    }).catch(() => {});

  } finally {
    // Only clear inflight if it still points to OUR controller.
    // A newer enqueueInbound may have already replaced it.
    const cur = inflight.get(phone);
    if (cur && cur.controller === controller) inflight.delete(phone);
  }
}

// Resolve documents_to_attach + images_to_attach (v2.7) into a flat,
// deduped, ordered list of attachments ready to send. Falls back to
// the legacy single `send_document` URL if the new fields are empty.
//
// Returns: [{ kind: 'image'|'document', url, filename }]
async function resolveAttachments(ai) {
  const out = [];
  const seenUrls = new Set();
  const push = (kind, url, filename) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    out.push({ kind, url, filename: filename || decodeURIComponent(url.split('/').pop() || 'file') });
  };

  const docTypes = Array.isArray(ai.documents_to_attach) ? ai.documents_to_attach : [];
  const imgTypes = Array.isArray(ai.images_to_attach)    ? ai.images_to_attach    : [];

  if (docTypes.length || imgTypes.length) {
    let kbRows = [];
    try { kbRows = await db.getKnowledgeBase(); }
    catch (e) { console.warn('⚠️ resolveAttachments: KB fetch failed:', e.message); return out; }

    const projectHint = ai.project_in_scope || '';

    for (const t of docTypes) {
      const rows = resolveTypeToRows(kbRows, 'pdf', t, projectHint);
      if (rows.length === 0) {
        console.warn(`⚠️ resolveAttachments: no PDF rows for doc_type="${t}" project="${projectHint}"`);
        continue;
      }
      for (const r of rows) push('document', r.file_url, r.name);
    }
    for (const t of imgTypes) {
      const rows = resolveTypeToRows(kbRows, 'image', t, projectHint);
      if (rows.length === 0) {
        console.warn(`⚠️ resolveAttachments: no image rows for image_type="${t}" project="${projectHint}"`);
        continue;
      }
      for (const r of rows) push('image', r.file_url, r.name);
    }
  }

  // Legacy single-URL fallback (still used if the AI emits the old shape).
  if (out.length === 0 && ai.send_document) {
    const kind = isImageUrl(ai.send_document) ? 'image' : 'document';
    push(kind, ai.send_document);
  }
  return out;
}

// Send one attachment via WhatsApp. Tries the right native type first
// (image | document), with a "send as document" fallback if Meta
// rejects an image (oversized, wrong mime sniff, etc), and a final
// text-link fallback so the user at least gets the URL.
async function sendAttachment(phone, attachment) {
  const { kind, url, filename } = attachment;
  const docName = filename || decodeURIComponent(url.split('/').pop() || 'file');
  console.log(`📤 Sending ${kind}: ${docName}`);

  if (kind === 'image') {
    try {
      await sendImage(phone, url, '');
      console.log(`🖼️ Image sent OK: ${docName}`);
      return;
    } catch (e) {
      const err = e.response?.data?.error?.message || e.message || '';
      console.warn(`⚠️ Image send failed (${err}) — retrying as document`);
    }
    try {
      await sendDocument(phone, url, docName, '');
      console.log(`📎 Image sent as document: ${docName}`);
      return;
    } catch (e) {
      const err = e.response?.data?.error?.message || e.message || '';
      console.error(`❌ Image-as-document fallback failed: ${err}`);
      await sendText(phone, `📸 ${docName.replace(/\.(jpe?g|png|gif|webp)$/i,'')}\n\nYahan se dekh sakte hain:\n${url}`).catch(() => {});
      return;
    }
  }

  // Document (PDF or other)
  try {
    await sendDocument(phone, url, docName, '');
    console.log(`📎 Document sent OK: ${docName}`);
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message || '';
    console.error(`❌ Document send failed: ${errMsg}`);
    await sendText(phone, `📄 *${docName.replace(/\.pdf$/i,'')}*\n\nYahan se download karein:\n${url}`).catch(() => {});
  }
}

module.exports = { enqueueInbound };
