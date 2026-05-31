// ================================================================
//  src/ai.js — AI Brain (model + prompt driven by settings.json)
// ----------------------------------------------------------------
//  Output contract v2.7:
//    The model emits free-form WhatsApp text, followed by a fenced
//    LEAD_STATE JSON block:
//
//        <reply text — what the user sees>
//        ---LEAD_STATE---
//        { ...json with documents_to_attach, images_to_attach, etc... }
//        ---END_LEAD_STATE---
//
//  This file parses both halves and normalises them into the legacy
//  `parsed` shape the orchestrator + database expect (reply_message,
//  lead_score 1–10, qualified, etc.), while ALSO exposing the new
//  v2.7 fields (documents_to_attach, images_to_attach, lead_type,
//  conversation_state, ...).
//
//  The hard-coded SYSTEM_PROMPT here is a tiny bootstrap fallback.
//  The real prompt lives in Supabase app_settings (loaded into
//  settings.json on boot, picked up by getSettings().system_prompt).
//  Push prompt updates with:  node backend/scripts/push_prompt.js
// ================================================================
const { GoogleGenAI } = require("@google/genai");
const fs   = require('fs');
const path = require('path');
const { getKnowledgeText, getKnowledgeBase } = require('./database');
const { resolveTypeToRows, inferRowType } = require('./mediaTypes');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── OUTPUT FORMAT (appended to every system prompt, including the
//    one loaded from the dashboard). Re-asserts the v2.7 contract so
//    even an outdated dashboard-saved prompt still produces parseable
//    output and routes media via documents_to_attach/images_to_attach.
//    Also requires a couple of legacy fields the rest of the backend
//    still reads (lead_score 1–10, send_document fallback).
// ─────────────────────────────────────────────────────────────────
const OUTPUT_FORMAT = `

━━━━━━━━━━━━━━━━━━━━
MANDATORY OUTPUT FORMAT — v2.7 (read every word)
━━━━━━━━━━━━━━━━━━━━

Your reply MUST be structured as TWO parts in this exact order:

PART 1 — The visible WhatsApp message (plain natural text).
- No URLs. No bracket tags like [ATTACH_DOC:...], [FILE:...], [DOC:...].
- No file paths. No doc_type or image_type strings in the user-visible text.
- 1–4 lines, WhatsApp-style.

PART 2 — A fenced LEAD_STATE block. Backend strips this before sending.

Exact format:

---LEAD_STATE---
{
  "reply_message": "<copy the PART 1 text here EXACTLY — backend uses this as the source of truth>",
  "documents_to_attach": [],
  "images_to_attach": [],
  "project_in_scope": "<the project_group name being discussed, exactly as it appears in the KNOWLEDGE BASE>",
  "lead_score_label": "hot",
  "lead_score": 7,
  "qualified": true,
  "qualification_stage": "engaged",
  "conversation_state": "ENGAGED",
  "lead_type": "direct",
  "budget_range": null,
  "location_preference": null,
  "timeline": null,
  "purpose": null,
  "site_visit_offered": false,
  "site_visit_confirmed": false,
  "preferred_visit_time": null,
  "rera_query": false,
  "callback_requested": false,
  "callback_time": null,
  "objections_raised": [],
  "handoff_required": false,
  "summary": "<one-line conversation summary>"
}
---END_LEAD_STATE---

FIELD RULES — non-negotiable:

reply_message
  Plain WhatsApp text. Must equal PART 1 word-for-word.
  No URLs, no tags, no doc_type strings.

documents_to_attach
  Array of doc_type STRINGS from the project's pdf_document_database.
  Allowed values ONLY: "brochure" | "floor_plan" | "price_sheet" |
  "payment_plan" | "rera_certificate" | "location_map" | "cp_kit" |
  "site_visit_guide".
  Only include a type if the project's pdf_document_database actually
  contains a row with that doc_type. NEVER invent a type.

images_to_attach
  Array of image_type STRINGS from the project's image_database.
  Allowed values ONLY: "site_photo" | "interior" | "amenity" |
  "elevation" | "render" | "location_map_image" | "floor_plan_image" |
  "cp_kit_image".
  Only include a type if the project's image_database actually contains
  a row with that image_type. NEVER invent a type.

project_in_scope
  REQUIRED whenever documents_to_attach or images_to_attach is non-empty.
  Must equal the project_name from the chosen project's
  project_knowledge_base block (e.g. "Krishna Vista", "Krishna Aura NX").
  This is how the backend knows which project's URLs to look up.

lead_score      Integer 1–10. (10 = hottest.)
lead_score_label  "hot" | "warm" | "cold" | "not_interested".

INTENT → MEDIA MAPPING (apply silently when picking attachment types):
  user says "brochure" / "details" / "project info"           → documents_to_attach += ["brochure"]
  user says "floor plan" / "layout" / "unit plan" / "naksha"  → documents_to_attach += ["floor_plan"]  AND images_to_attach += ["floor_plan_image"] if available
  user says "price" / "cost sheet" / "rate card"              → documents_to_attach += ["price_sheet"]
  user says "payment plan" / "EMI" / "schedule"               → documents_to_attach += ["payment_plan"]
  user says "RERA"                                            → documents_to_attach += ["rera_certificate"]
  user says "image" / "photo" / "picture" / "render" /
            "elevation" / "building photo" / "dikhao"         → images_to_attach += ["elevation", "render"] (whichever exists)
  user says "interior" / "andar" / "inside"                   → images_to_attach += ["interior"]
  user says "amenities" / "clubhouse" / "pool" / "gym"        → images_to_attach += ["amenity"]
  user says "site photo" / "construction" / "ground"          → images_to_attach += ["site_photo"]
  user says "sab bhejo" / "all docs" / "everything"           → documents_to_attach += ["brochure"], images_to_attach += ["elevation"] (if available)

REFUSAL BAN — read carefully:
You CAN send PDFs AND images (JPEG/PNG/WEBP) over WhatsApp. The backend handles both.
NEVER say "main image bhej nahi sakti", "sirf PDF bhej sakti hoon", "WhatsApp pe image share nahi hota", or
anything equivalent. That is FALSE. If the project's image_database contains the requested image_type,
put it in images_to_attach. If it does NOT contain it, say "yeh photos abhi available nahi hain — confirm
karke bhejti hoon" — but NEVER claim you lack the capability.

PROJECT MATCHING (use the DISTINCTIVE word, not "Krishna"):
  "vista" → Krishna Vista. "aurum" → Krishna Aurum. "aura" → Krishna Aura NX.
  "dharni" → Krishna Dharni / Krishna Dharni A1. "iris" → Krishna Iris.
  "greens" → Krishna Greens. "veer" → Krishna Veer. "park" → Krishna Park View.
  "elite" → Krishna Elite. "imperial" → Krishna Imperial. "orus" → Krishna Orus.
  "siddhivinayak" → Siddhivinayak Krishna.
If the user does NOT name a project, use the one being discussed in the recent conversation. NEVER guess
a project that has not appeared in the conversation.

CONSISTENCY GUARD:
If reply_message says you are sending/sharing a file ("bhej rahi hoon", "share kar rahi", "yeh lo",
"aa raha hai", "sending"), then documents_to_attach OR images_to_attach MUST be non-empty AND
project_in_scope MUST be set. Never claim to send without actually emitting the type strings.

NEVER output anything after ---END_LEAD_STATE---. NEVER output extra text before PART 1.
NEVER wrap the LEAD_STATE block in markdown fences (no \`\`\`json).
`;

// ── Bootstrap fallback prompt ─────────────────────────────────────
// Used only on first boot before settings.json / app_settings has the
// real v2.7 prompt loaded. Keeps the bot answering reasonably while
// admin pushes the full prompt via the dashboard or push_prompt.js.
const SYSTEM_PROMPT = `You are Niharika from Krishna Group, a warm female WhatsApp sales relationship manager.
Speak in Roman-script Hinglish (or English if the user does). Never use Devanagari.
Be conversational, low-pressure, max 2–3 short lines per message.

Your knowledge of projects lives in the KNOWLEDGE BASE below. Never invent project facts —
if a fact isn't in the KB, say "yeh main confirm karke batati hoon".

This is a bootstrap fallback prompt. The full v2.7 prompt should be loaded from the dashboard
(Agent Settings → System Prompt). If you see this message, push the real prompt with:
  node backend/scripts/push_prompt.js "C:/Users/Lenovo/Desktop/Whatsapp-agent/waprompt v2.7.txt"
`;

async function callGemini(fullPrompt) {
  const settings   = getSettings();
  const model      = settings.ai_model || 'gemini-2.5-flash';
  const basePrompt = (settings.system_prompt && settings.system_prompt.trim())
    ? settings.system_prompt
    : SYSTEM_PROMPT;

  const knowledge = await getKnowledgeText();
  const knowledgeSection = knowledge
    ? `\n\n━━━━━━━━━━━━━━━━━━━━\nKNOWLEDGE BASE (project facts + media databases)\n━━━━━━━━━━━━━━━━━━━━\n${knowledge}\n━━━━━━━━━━━━━━━━━━━━\n`
    : '';

  const systemPrompt = basePrompt + knowledgeSection + OUTPUT_FORMAT;

  // NOTE: no responseMimeType — v2.7 emits text + fenced JSON, not pure JSON.
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    config: { systemInstruction: systemPrompt },
  });
  return {
    text:         response.text || "",
    inputTokens:  response.usageMetadata?.promptTokenCount     || 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
    model
  };
}

// Parse the model's raw output. Handles three shapes:
//   1. v2.7 — "<text>\n---LEAD_STATE---\n{...}\n---END_LEAD_STATE---"
//   2. legacy — pure JSON object with reply_message + send_document
//   3. mixed  — text + bare {...} block at the end
// Returns the LEAD_STATE JSON as an object, with `reply_message` set
// to the visible text portion when the JSON's own reply_message is
// missing or doesn't match.
function parseModelOutput(raw) {
  if (!raw || !raw.trim()) throw new Error('Empty response from Gemini');
  const text = raw.trim();

  // Shape 1: explicit LEAD_STATE fence.
  const fenceRe = /---LEAD_STATE---\s*([\s\S]*?)\s*---END_LEAD_STATE---/i;
  const m = text.match(fenceRe);
  if (m) {
    const visible = text.slice(0, m.index).trim();
    let jsonStr = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Some models still wrap the JSON in extra braces or commentary;
    // take the first {...} block inside the fence.
    const s = jsonStr.indexOf('{');
    const e = jsonStr.lastIndexOf('}');
    if (s !== -1 && e > s) jsonStr = jsonStr.slice(s, e + 1);
    let obj;
    try { obj = JSON.parse(jsonStr); }
    catch (err) {
      throw new Error(`LEAD_STATE JSON parse failed: ${err.message}. Snippet: ${jsonStr.slice(0, 200)}`);
    }
    if (!obj.reply_message || !obj.reply_message.trim()) obj.reply_message = visible;
    return obj;
  }

  // Shape 2/3: try JSON object directly (legacy responseMimeType path or
  // when the model omits the fence).
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s !== -1 && e > s) {
    const visible = clean.slice(0, s).trim();
    try {
      const obj = JSON.parse(clean.slice(s, e + 1));
      if (!obj.reply_message && visible) obj.reply_message = visible;
      return obj;
    } catch {}
  }

  // Last resort: treat the whole thing as a reply with no structured state.
  return { reply_message: text };
}

// ── v2.7 → legacy field mapping ───────────────────────────────────
// Several downstream files (database.js, orchestrator.js) read fields
// in the old shape (numeric lead_score 1–10, qualification_stage,
// send_document URL). v2.7 emits some of those as different names or
// types, so normalise here in one place.
function normaliseParsed(parsed, history) {
  // lead_score → integer 1–10
  let score = parsed.lead_score;
  if (typeof score === 'string') {
    const label = score.toLowerCase();
    if (label === 'hot' || label === 'hot_lead') score = 9;
    else if (label === 'warm') score = 6;
    else if (label === 'cold') score = 3;
    else if (label === 'not_interested') score = 1;
    else score = parseInt(score) || 3;
  }
  if (typeof score !== 'number' || !isFinite(score)) score = 3;
  parsed.lead_score = Math.max(1, Math.min(10, Math.round(score)));

  // conversation_state → qualification_stage fallback
  if (!parsed.qualification_stage && parsed.conversation_state) {
    parsed.qualification_stage = String(parsed.conversation_state).toLowerCase();
  }
  if (!parsed.qualification_stage) parsed.qualification_stage = 'general';

  // Arrays default to empty (so orchestrator can iterate safely).
  if (!Array.isArray(parsed.documents_to_attach)) parsed.documents_to_attach = [];
  if (!Array.isArray(parsed.images_to_attach))    parsed.images_to_attach    = [];

  // Old single-URL field — preserved as a fallback path for orchestrator.
  parsed.send_document = parsed.send_document || null;

  return parsed;
}

async function getAIReply(userMessage, history = [], lead = null) {
  // ── Inject known lead profile (CALL SESSION) ────────────────────
  let sessionBlock = '';
  if (lead) {
    const known = [];
    if (lead.budget_range)        known.push(`Budget: ${lead.budget_range}`);
    if (lead.location_preference) known.push(`Location preference: ${lead.location_preference}`);
    if (lead.timeline)            known.push(`Timeline: ${lead.timeline}`);
    if (lead.purpose)             known.push(`Purpose: ${lead.purpose}`);

    sessionBlock =
      '\n\n[CALL SESSION — what we already know about this lead]\n' +
      `Name: ${lead.name || 'Unknown'}\n` +
      `Lead score: ${lead.score || 0}/100\n` +
      `Stage: ${lead.label || 'COLD'}\n` +
      `Intent: ${(lead.intent || 'general').replace('_', ' ')}\n` +
      `Total messages exchanged: ${lead.message_count || 0}\n` +
      (known.length ? `Already extracted:\n${known.map(k => `  - ${k}`).join('\n')}\n` : '') +
      (lead.site_visit_offered ? `Site visit calendar: already sent — do NOT re-send\n` : '') +
      '[END CALL SESSION — do NOT re-ask any question whose answer is already listed above]\n';
  }

  let contextBlock = '';
  if (history.length > 0) {
    contextBlock = '\n\n[RECENT CONVERSATION]\n' +
      history.map(m => `${m.role === 'assistant' ? 'Agent' : 'User'}: ${m.content}`).join('\n') +
      '\n[END CONVERSATION]\n';
  }

  const fullPrompt = sessionBlock + contextBlock + '\nUser: ' + userMessage;

  let raw = '';
  let inputTokens = 0, outputTokens = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const result = await callGemini(fullPrompt);
      raw = result.text;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      break;
    } catch (err) {
      const is503 = err.message && err.message.includes('503');
      const is429 = err.message && err.message.includes('429');
      if ((is503 || is429) && attempt < 4) {
        const delay = attempt * 3000;
        console.warn(`⚠️  Gemini ${is503 ? '503' : '429'} — retry ${attempt}/3 in ${delay/1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error("❌ AI Error:", err.message);
      throw err;
    }
  }

  let parsed;
  try {
    parsed = parseModelOutput(raw);
  } catch (e) {
    console.error('❌ Parse failed:', e.message);
    console.error('❌ Raw was:', JSON.stringify(raw).substring(0, 300));
    parsed = {
      reply_message: "Sorry, thoda technical issue aa gaya! Hamari team aapko jald connect karegi. 🙏",
      lead_score: 3,
      qualified: false,
      qualification_stage: 'general',
      summary: 'parse error',
      documents_to_attach: [],
      images_to_attach: [],
    };
  }

  parsed.input_tokens  = inputTokens;
  parsed.output_tokens = outputTokens;
  normaliseParsed(parsed, history);

  // ── SAFETY NET ───────────────────────────────────────────────────
  // Two failure modes to rescue from:
  //   (a) Model said it's sending a file but emitted empty
  //       documents_to_attach/images_to_attach (forgot the LEAD_STATE
  //       half, hallucinated the type, or set send_document instead).
  //   (b) Model refused ("nahi bhej sakti", "sirf PDF") while a
  //       matching file actually exists in the KB.
  // The rescue infers project + intent from user message + history,
  // then picks the right file type(s) from the KB.
  //
  // Falls back GRACEFULLY: if it can't identify the project with high
  // confidence it does NOTHING (better to send no file than the wrong
  // file from a different project).
  try {
    await applySafetyNet(parsed, userMessage, history);
  } catch (e) {
    console.warn('⚠️ Safety net error:', e.message);
  }

  return parsed;
}

async function applySafetyNet(parsed, userMessage, history) {
  const hasAttachments =
    (parsed.documents_to_attach && parsed.documents_to_attach.length > 0) ||
    (parsed.images_to_attach    && parsed.images_to_attach.length > 0)    ||
    parsed.send_document;
  if (hasAttachments) return;

  const reply    = (parsed.reply_message || '').toLowerCase();
  const userText = (userMessage || '').toLowerCase();
  const histBlob = (history || []).map(h => (h.content || '').toLowerCase()).join('\n');

  const sayingSending = /bhej\s*rahi|bhej\s*raha|share\s*kar\s*r|sending|sharing|yeh\s*lo|dekh\s*lo|attach|file\s*bhej|brochure\s*bhej|pdf\s*bhej|document\s*bhej|aa\s*raha\s*hai|aa\s*rahi\s*hai/i;
  // CAPABILITY refusals only — the AI claims it CAN'T (a falsehood we
  // want to rescue). "X available nahi hai" is NOT a capability refusal,
  // it's an honest answer; we never want to override it.
  const capabilityRefusal = /(image\s*bhej\s*nahi|photo\s*bhej\s*nahi|sirf\s*pdf|only\s*pdf|share\s*nahi\s*kar\s*sakt|whatsapp\s*pe.*nahi|cannot\s*send|can't\s*send|unable\s*to\s*send)/i;

  const shouldRescue = sayingSending.test(reply) || capabilityRefusal.test(reply);
  if (!shouldRescue) return;

  // Skip if the AI honestly told the user the requested thing isn't
  // available. Pattern matches "X abhi available nahi" / "X hamare paas
  // nahi" / "X nahi hai" near a file-shaped noun — phrases the AI uses
  // when it correctly couldn't find a matching file in the KB.
  const honestNotAvailable = /(available\s*nahi|hamare\s*paas\s*nahi|paas\s*nahi\s*hai|nahi\s*hai\s+abhi|confirm\s*karke\s*(?:batati|bhejti|bata\s*dungi))/i;
  if (honestNotAvailable.test(reply) && !sayingSending.test(reply)) {
    console.log('🔧 Safety net: AI gave honest "not available" — trusting it, no rescue');
    return;
  }

  const rows = await getKnowledgeBase();
  const filesWithUrl = rows.filter(r => r.file_url);
  if (!filesWithUrl.length) return;

  // 1. Score projects by distinctive-token matches.
  const STOP = new Set(['krishna','group','the','and','a1','nx']);
  const scoreByProject = new Map();
  for (const r of filesWithUrl) {
    const pg = (r.project_group || '').toLowerCase().trim();
    if (!pg || scoreByProject.has(pg)) continue;
    const tokens = pg.split(/[\s\-]+/).filter(t => t.length > 2 && !STOP.has(t));
    let s = 0;
    for (const tok of tokens) {
      if (userText.includes(tok)) s += 10;
      else if (reply.includes(tok)) s += 5;
      else if (histBlob.includes(tok)) s += 1;
    }
    // If the AI told us the project in scope, that beats everything.
    if (parsed.project_in_scope &&
        parsed.project_in_scope.toLowerCase().trim() === pg) s += 100;
    scoreByProject.set(pg, s);
  }
  let bestProject = null, bestScore = 0;
  for (const [pg, sc] of scoreByProject.entries()) {
    if (sc > bestScore) { bestScore = sc; bestProject = pg; }
  }
  if (!bestProject) {
    console.log('🔧 Safety net: no project mentioned in context — skipping');
    return;
  }

  // 2. Detect intent — image vs PDF vs specific category.
  const wantsImage    = /\b(image|photo|picture|render|elevation|jpeg|jpg|png|tasveer|tasvir|dikhao)\b/i.test(userText);
  const wantsBrochure = /\bbrochure\b/i.test(userText);
  const wantsCost     = /\b(cost|price|rate|pricing|sale\s*chart)\b/i.test(userText);
  const wantsFloor    = /\b(floor|unit\s*plan|layout|naksha)\b/i.test(userText);
  const wantsPayment  = /\b(payment|schedule|emi|installment)\b/i.test(userText);

  const projectRows = filesWithUrl.filter(
    r => (r.project_group || '').toLowerCase().trim() === bestProject
  );

  // 3. Pick best type(s) for that intent — fall back through priority.
  const pickedDocs   = new Set();
  const pickedImages = new Set();

  const matchType = (kind, type) => {
    for (const r of projectRows) {
      const t = inferRowType(r);
      if (t && t.kind === kind && t.type === type) return type;
    }
    return null;
  };

  if (wantsImage) {
    const e = matchType('image', 'elevation');
    const r = matchType('image', 'render');
    if (e) pickedImages.add(e);
    if (r) pickedImages.add(r);
  }
  if (wantsBrochure) {
    const b = matchType('pdf', 'brochure');
    if (b) pickedDocs.add(b);
  }
  if (wantsCost) {
    const c = matchType('pdf', 'price_sheet');
    if (c) pickedDocs.add(c);
  }
  if (wantsFloor) {
    const fp  = matchType('pdf', 'floor_plan');
    const fpi = matchType('image', 'floor_plan_image');
    if (fp)  pickedDocs.add(fp);
    if (fpi) pickedImages.add(fpi);
  }
  if (wantsPayment) {
    const p = matchType('pdf', 'payment_plan');
    if (p) pickedDocs.add(p);
  }

  const hadSpecificIntent = wantsImage || wantsBrochure || wantsCost || wantsFloor || wantsPayment;

  // Generic priority fallback runs ONLY if the user didn't express a
  // specific intent (e.g. "sab bhejo", or AI said "bhej rahi" without
  // user asking for anything specific). Avoids the failure mode where
  // user asked for "brochure" Vista doesn't have → we'd dump a random
  // sale chart + render at them.
  if (!hadSpecificIntent && pickedDocs.size === 0 && pickedImages.size === 0) {
    const priorityPdf   = ['brochure','price_sheet','floor_plan','payment_plan','site_visit_guide'];
    const priorityImage = ['elevation','render','site_photo'];
    for (const p of priorityPdf)   { const t = matchType('pdf', p);   if (t) { pickedDocs.add(t);   break; } }
    for (const p of priorityImage) { const t = matchType('image', p); if (t) { pickedImages.add(t); break; } }
  }

  if (pickedDocs.size === 0 && pickedImages.size === 0) {
    console.log(`🔧 Safety net: no matching files for project="${bestProject}" intent — staying quiet`);
    return;
  }

  parsed.documents_to_attach = [...pickedDocs];
  parsed.images_to_attach    = [...pickedImages];
  parsed.project_in_scope    = bestProject;
  console.log(
    `🔧 Safety net: project="${bestProject}" → docs=[${parsed.documents_to_attach.join(',')}] ` +
    `images=[${parsed.images_to_attach.join(',')}]`
  );
}

function getLeadLabel(lead_score) {
  const s = getSettings();
  const hotThreshold  = s.hot_score  || 8;
  const warmThreshold = s.warm_score || 5;
  if (lead_score >= hotThreshold)  return "HOT";
  if (lead_score >= warmThreshold) return "WARM";
  return "COLD";
}

module.exports = { getAIReply, getLeadLabel };
