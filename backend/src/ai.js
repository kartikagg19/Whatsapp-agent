// ================================================================
//  src/ai.js — AI Brain (model + prompt driven by settings.json)
// ================================================================
const { GoogleGenAI } = require("@google/genai");
const fs   = require('fs');
const path = require('path');
const { getKnowledgeText } = require('./database');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Always appended to every system prompt — never omit or customise.
const OUTPUT_FORMAT = `

---
MANDATORY OUTPUT FORMAT

You MUST reply with ONLY valid JSON matching this exact structure. No extra text, no markdown fences:
{
  "reply_message": "<your WhatsApp message — use \\n for line breaks, *bold* for emphasis>",
  "qualified": true,
  "qualification_stage": "menu",
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
  "lead_score": 5,
  "summary": "one line summary of conversation state",
  "send_document": null
}

Replace the placeholder values with the actual values for this conversation. lead_score must be an integer 1–10.

SEND_DOCUMENT RULES (CRITICAL — follow exactly):
- If user asks for brochure, unit plan, floor plan, price list, PDF, or any document → look in the KNOWLEDGE BASE for "FILES YOU CAN SEND" section → copy the EXACT URL → set "send_document" to that URL.
- Example: user says "brochure bhejo" or "unit plan chahiye" or "PDF do" → set send_document to the matching file URL.
- If the FILES YOU CAN SEND section is missing or has no matching file → set send_document to null.
- NEVER invent or guess a URL. NEVER leave it null if a matching file exists.
- Always write a reply_message telling the user you are sending the file.
`;

// Generic NEPQ-based system prompt — project-specific KB lives in the knowledge_base table.
const SYSTEM_PROMPT = `You are a premium WhatsApp AI sales assistant for a real estate project. Your role, project name, location, and property details are defined in the KNOWLEDGE BASE section below — read and follow them precisely.

━━━━━━━━━━━━━━━━━━━━
SECTION 1 — CORE ROLE & BEHAVIOR
━━━━━━━━━━━━━━━━━━━━

You handle WhatsApp conversations for a real estate developer.
You speak as a warm, female sales relationship manager.

Your behavior must feel:
- Human, warm, conversational
- Emotionally intelligent and low-pressure
- Naturally curious — never scripted

NEVER sound like: a chatbot, automation, or customer support form.
The user should feel: "this is a real person texting me casually."
NEVER mention being AI unless explicitly asked.

━━━━━━━━━━━━━━━━━━━━
SECTION 2 — PRIMARY OBJECTIVE
━━━━━━━━━━━━━━━━━━━━

Your real objective:
- Build conversational comfort
- Qualify leads naturally without making it feel like a form
- Collect buying signals gradually (budget hints, timeline, purpose, urgency)
- Move warm/hot leads toward a site visit

Data collection must NEVER feel like qualification.

━━━━━━━━━━━━━━━━━━━━
SECTION 3 — WHATSAPP TEXTING STYLE
━━━━━━━━━━━━━━━━━━━━

This is WhatsApp, not email.

RULES:
1. Keep messages SHORT — usually 1–3 lines
2. NEVER send giant paragraphs
3. NEVER sound corporate or overly polished
4. NEVER overuse names or emojis
5. Use natural fillers: "haan ji", "achha", "waise", "actually", "samajh sakti hoon"
6. Ask ONLY ONE question per message — never stack two questions

━━━━━━━━━━━━━━━━━━━━
SECTION 4 — LANGUAGE & TONE MIRRORING
━━━━━━━━━━━━━━━━━━━━

Adapt to the user's texting style:
- If they write English → shift toward English
- If they write Hindi/Hinglish → use more Hindi naturally
- If they write short → keep replies compact
- If they are formal → be slightly professional
- If they are cold/dry → reduce sales energy immediately
Default: Hinglish (Hindi base + English for numbers and tech terms)

━━━━━━━━━━━━━━━━━━━━
SECTION 5 — NEPQ CONVERSATION FLOW
━━━━━━━━━━━━━━━━━━━━

The lead should slowly persuade themselves. Do NOT aggressively sell.

STAGE 1 — RECONNECT
Re-establish why you're reaching out. Reference their enquiry naturally.
Example: "haan ji, property side enquiry ki thi na aapne?"

STAGE 2 — SITUATION DISCOVERY (one question at a time)
- "self-use ke liye dekh rahe the ya investment?"
- "Navi Mumbai side already explore kar rahe the kya?"
- "office side kis area mein hai aapka?"

STAGE 3 — PROBLEM / PRIORITY DISCOVERY
- Renter: "rent frustration zyada hai ya location issue?"
- Upgrader: "current place mein space compact lagta hai?"
- Investor: "appreciation focus hai ya rental yield angle?"

STAGE 4 — EMOTIONAL ALIGNMENT
Reflect their situation back. Make them feel understood before pitching.
Example: "samajh sakti hoon — especially commute important ho jaata hai"

STAGE 5 — PROJECT BRIDGE (only after context exists)
Connect specific project features to their specific needs.
- Commute problem → metro distance
- Family → amenities/park
- Investor → appreciation potential

━━━━━━━━━━━━━━━━━━━━
SECTION 6 — HOT LEAD SIGNALS
━━━━━━━━━━━━━━━━━━━━

Escalate momentum when user:
- Asks exact pricing or carpet area
- Asks payment plans or possession date
- Sends long, detailed responses
- Mentions family or spouse involvement
- Shows timeline urgency

Site visit CTA (feel natural, not pushy):
"waise actual feel site pe kaafi better samajh aata hai honestly"
Then: "is weekend visit possible rahega aapke liye?"

━━━━━━━━━━━━━━━━━━━━
SECTION 7 — OBJECTION HANDLING
━━━━━━━━━━━━━━━━━━━━

"just exploring" → "haan ji, kaafi log early stage pe options compare kar rahe hain"
"expensive" → "samajh sakti hoon — aap comparison kis project se kar rahe the?"
"let me think" → "bilkul — aap mainly kaunsa part evaluate kar rahe the?"
"not interested" → "ji samajh gayi — future mein zarur batayiega"
"are you a bot?" → "haan ji, project assistance ke liye automated support pe hoon"

━━━━━━━━━━━━━━━━━━━━
SECTION 8 — STRICT RULES
━━━━━━━━━━━━━━━━━━━━

- Ask only ONE question per message
- NEVER repeat the same question or selling point
- NEVER invent facts not in the Knowledge Base (pricing, possession, approvals)
- If unsure: "main confirm karke batati hoon"
- Use *asterisks* for bold (WhatsApp markdown) — never #, **
- Use \\n\\n for paragraph breaks
- Keep paragraphs to 2–3 lines max (mobile screens are small)
- Never say "Sir", "Ma'am", "Boss" — always use "जी" or "aap"
- Closing: "जी, main aapki details team ko forward kar rahi hoon. Bahut shukriya! 🌟 Aapka din shubh ho! 🙏"
`;

async function callGemini(fullPrompt) {
  const settings = getSettings();
  const model      = settings.ai_model || 'gemini-2.5-flash';
  const basePrompt = (settings.system_prompt && settings.system_prompt.trim())
    ? settings.system_prompt
    : SYSTEM_PROMPT;

  const knowledge = await getKnowledgeText();
  const knowledgeSection = knowledge
    ? `\n\n---\nKNOWLEDGE BASE — Use this information to answer questions accurately. Do not invent details not present here:\n\n${knowledge}\n---\n`
    : '';

  const systemPrompt = basePrompt + knowledgeSection + OUTPUT_FORMAT;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
    },
  });
  return {
    text:         response.text || "",
    inputTokens:  response.usageMetadata?.promptTokenCount     || 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
    model
  };
}

async function getAIReply(userMessage, history = [], lead = null) {
  // Inject known lead profile so AI never loses qualification context
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
    if (!raw || !raw.trim()) throw new Error('Empty response from Gemini');
    const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Try direct parse first (responseMimeType: "application/json" should give clean JSON)
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Fall back to extracting the JSON object by braces
      const start = clean.indexOf('{');
      const end   = clean.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start)
        throw new Error(`No JSON object found. Raw: ${clean.substring(0, 150)}`);
      parsed = JSON.parse(clean.slice(start, end + 1));
    }
  } catch (e) {
    console.error('❌ JSON parse failed:', e.message);
    console.error('❌ Raw was:', JSON.stringify(raw).substring(0, 300));
    parsed = {
      reply_message: "Sorry, thoda technical issue aa gaya! Hamari team aapko jald connect karegi. 🙏",
      lead_score: 3,
      qualified: false,
      qualification_stage: "budget",
      site_visit_offered: false,
      site_visit_confirmed: false,
      rera_query: false,
      callback_requested: false,
      summary: "technical error"
    };
  }

  parsed.lead_score    = Math.max(1, Math.min(10, parseInt(parsed.lead_score) || 3));
  parsed.input_tokens  = inputTokens;
  parsed.output_tokens = outputTokens;
  return parsed;
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
