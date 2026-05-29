// ================================================================
//  src/routes/admin.js — Dashboard API endpoints
// ================================================================
const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const db       = require('../database');
const { sendText, sendTemplate } = require('../whatsapp');
const { syncTimeline } = require('../crmClient');

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename:    (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 250 * 1024 * 1024 } });

const SETTINGS_FILE = path.join(__dirname, '../../../settings.json');

// ────────────────────────────────────────────────────────────────
// In-memory dedupe for POST /api/send (call_id idempotency)
// Keyed on `${phone}:${callId}` because the CRM's bulk-send flow
// reuses one call_id across multiple recipients in the same batch.
// Keying on call_id alone would silently drop everyone after the
// first in such a batch.
// ────────────────────────────────────────────────────────────────
const dedupeMap = new Map();
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkAndRecordCallId(phone, callId) {
  if (!callId || !phone) return false; // no call_id = not deduped
  const key = `${phone}:${callId}`;
  const now = Date.now();
  const lastSent = dedupeMap.get(key);
  if (lastSent && now - lastSent < DEDUPE_TTL_MS) {
    return true; // duplicate within 24h
  }
  dedupeMap.set(key, now);
  // Prune old entries when the map grows to prevent memory leak
  if (dedupeMap.size > 1000) {
    for (const [k, timestamp] of dedupeMap) {
      if (now - timestamp >= DEDUPE_TTL_MS) {
        dedupeMap.delete(k);
      }
    }
  }
  return false; // first send
}

const DEFAULT_SETTINGS = {
  bot_name: 'Niharika',
  business_name: 'Krishna Group',
  project_name: 'Krishna Aura',
  location: 'Kharghar, Navi Mumbai',
  language: 'hinglish',
  tone: 'friendly',
  ai_model: 'gemini-2.5-flash',
  system_prompt: '',
  sales_phone: process.env.SALES_PHONE_NUMBER || '',
  welcome_message: '',
  reply_delay: 0,
  hot_score: 8,
  warm_score: 5,
  office_hours_on: false,
  office_start: '09:00',
  office_end: '21:00',
  properties: [
    { name: '2 BHK Cat 1', size: '1075 sq ft', price: '₹1.21 Crore' },
    { name: '2 BHK Cat 2', size: '1275 sq ft', price: '₹1.42 Crore' },
    { name: '3 BHK',       size: '1850 sq ft', price: '₹2.02 Crore' },
  ],
  followup_enabled:     false,
  followup_hot_hours:   24,
  followup_warm_hours:  48,
  followup_cold_hours:  72,
  followup_check_hours: 6,
  // Default template for first-contact (new numbers from CRM)
  default_template_name:     '',   // e.g. "dreamhome_intro"
  default_template_language: 'en', // "en", "en_US", "hi"
  default_template_params:   ''    // comma-separated, e.g. "Niharika,Krishna Group"
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

// ── DURABLE SETTINGS: hydrate from Supabase at boot ──────────────
// Fly.io / container filesystems are ephemeral — settings.json is
// wiped on every redeploy. Supabase is the source of truth.
//
// Strategy: write-through to BOTH Supabase and settings.json. All
// existing call sites (ai.js, orchestrator.js, etc.) keep reading
// settings.json synchronously and pick up the hydrated values without
// changes. On first save from a fresh container, we ALSO push to
// Supabase so the next redeploy boots with the same config.
function writeSettingsFile(settingsObj) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsObj, null, 2));
  } catch (e) {
    console.warn(`⚠️  Could not write settings.json cache: ${e.message}`);
  }
}

async function hydrateSettingsFromDB() {
  try {
    const remote = await db.getAppSettings();
    if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
      writeSettingsFile({ ...DEFAULT_SETTINGS, ...remote });
      console.log(`✅ Settings hydrated from Supabase (${Object.keys(remote).length} keys)`);
    } else if (fs.existsSync(SETTINGS_FILE)) {
      // Local has data, Supabase doesn't — back-fill Supabase.
      const local = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      await db.saveAppSettings(local);
      console.log(`⬆️  Settings back-filled to Supabase from local cache`);
    } else {
      console.log(`ℹ️  No persisted settings — using DEFAULT_SETTINGS until first save`);
    }
  } catch (e) {
    console.warn(`⚠️  Settings hydration skipped (${e.message}) — falling back to settings.json / defaults. Make sure backend/sql/app_settings.sql has been run.`);
  }
}

// Run once on module load. Awaiting at top level not available in CJS;
// fire-and-forget is fine because /api/send's auto-template path that
// depends on this is the only critical reader, and a CRM trigger that
// races boot will just miss the fallback once (the same as today).
hydrateSettingsFromDB();

// ── AUTH ─────────────────────────────────────────────────────────

function getToken() {
  const pass = process.env.ADMIN_PASSWORD || 'propello2025';
  return Buffer.from(`propello-dashboard:${pass}`).toString('base64');
}

function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/whatsapp-test' || req.path === '/ai-test' || req.path === '/send' || req.path === '/kb-debug' || req.path === '/export/csv') return next();
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token || token !== getToken()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAuth);

// POST /api/login
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const adminEmail = process.env.ADMIN_EMAIL    || 'admin@propello.ai';
  const adminPass  = process.env.ADMIN_PASSWORD || 'propello2025';
  if (email === adminEmail && password === adminPass) {
    return res.json({ success: true, token: getToken() });
  }
  res.status(401).json({ error: 'Invalid email or password' });
});

// GET /api/kb-debug — show what AI sees in knowledge base (file_url check)
router.get('/kb-debug', async (req, res) => {
  try {
    const docs = await db.getKnowledgeBase();
    const { getKnowledgeText } = require('../database');
    res.json({
      total: docs.length,
      docs: docs.map(d => ({
        id: d.id, name: d.name, file_type: d.file_type,
        has_content: !!d.content, content_length: d.content?.length || 0,
        has_file_url: !!d.file_url, file_url: d.file_url || null
      })),
      sendable_count: docs.filter(d => d.file_url).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai-test — verify Gemini API key works
router.get('/ai-test', async (req, res) => {
  try {
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'Reply with just the word: OK' }] }],
    });
    res.json({ ok: true, reply: response.text, key_set: !!process.env.GEMINI_API_KEY });
  } catch (err) {
    res.json({ ok: false, error: err.message, key_set: !!process.env.GEMINI_API_KEY });
  }
});

// GET /api/whatsapp-test — verify token + phone number ID are working
router.get('/whatsapp-test', async (req, res) => {
  const axios = require('axios');
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return res.json({ ok: false, error: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set in env' });
  try {
    const r = await axios.get(`https://graph.facebook.com/v20.0/${phoneId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({ ok: true, phone_number: r.data.display_phone_number, verified_name: r.data.verified_name, quality: r.data.quality_rating });
  } catch (err) {
    const meta = err.response?.data?.error;
    res.json({ ok: false, error: meta?.message || err.message, code: meta?.code });
  }
});

// GET /api — API root status
router.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'DreamHome Bot API',
    version: '1.0',
    endpoints: [
      'GET /api/stats',
      'GET /api/leads',
      'GET /api/leads/:phone',
      'GET /api/agent-settings',
      'POST /api/agent-settings',
      'POST /api/send',
      'POST /api/broadcast',
      'GET /api/knowledge',
      'POST /api/knowledge/upload',
      'DELETE /api/knowledge/:id'
    ]
  });
});

// GET /api/agent-settings
router.get('/agent-settings', (req, res) => {
  res.json({ success: true, data: loadSettings() });
});

// POST /api/agent-settings
// Write-through: persist to Supabase (source of truth, survives Fly.io
// redeploys) AND to settings.json on disk (so the other modules that
// still read the file synchronously pick up the change immediately).
router.post('/agent-settings', async (req, res) => {
  try {
    const current  = loadSettings();
    const updated  = { ...current, ...req.body };
    writeSettingsFile(updated);
    try {
      await db.saveAppSettings(updated);
    } catch (e) {
      // Don't fail the request if Supabase is down — local write succeeded.
      // Surface a warning so the user knows persistence isn't durable yet.
      console.warn(`⚠️  Settings saved locally but Supabase persistence failed: ${e.message}`);
      return res.json({ success: true, persisted_to_db: false, warning: e.message });
    }
    res.json({ success: true, persisted_to_db: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/costs — token usage and cost analytics
router.get('/costs', async (req, res) => {
  try { res.json({ success: true, data: await db.getCostStats() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stats — counts of total, hot, warm, cold
router.get('/stats', async (req, res) => {
  try { res.json({ success: true, data: await db.getStats() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leads — all leads
router.get('/leads', async (req, res) => {
  try {
    let leads = await db.getAllLeads();
    if (req.query.label) leads = leads.filter(l => l.label === req.query.label.toUpperCase());
    res.json({ success: true, count: leads.length, data: leads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/export/full — all leads + all conversations for Excel export
router.get('/export/full', async (req, res) => {
  try {
    const leads = await db.getAllLeads(2000);
    const results = [];
    const batchSize = 10;
    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);
      const convoBatch = await Promise.all(
        batch.map(l => db.getConversations(l.phone).catch(() => []))
      );
      batch.forEach((lead, idx) => {
        const convos = convoBatch[idx];
        if (convos.length === 0) {
          results.push({ lead, role: '', message: '', msg_time: '' });
        } else {
          convos.forEach(c => {
            results.push({
              lead,
              role:     c.role === 'assistant' ? 'Bot' : 'User',
              message:  c.message || '',
              msg_time: c.created_at || ''
            });
          });
        }
      });
    }
    res.json({ success: true, data: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/export/csv — downloads CSV directly from server (one row per user, each message in its own column)
router.get('/export/csv', async (req, res) => {
  try {
    const leads = await db.getAllLeads(2000);

    // Fetch all conversations
    const grouped = {};
    const batchSize = 10;
    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);
      const convoBatch = await Promise.all(
        batch.map(l => db.getConversations(l.phone).catch(() => []))
      );
      batch.forEach((lead, idx) => {
        const phone = lead.phone;
        if (!grouped[phone]) grouped[phone] = { lead, messages: [] };
        convoBatch[idx].forEach(c => {
          const sender = c.role === 'assistant' ? 'Bot' : 'User';
          grouped[phone].messages.push(`[${sender}] ${c.message || ''}`);
        });
      });
    }

    const userList = Object.values(grouped);
    const maxMsgs = Math.max(...userList.map(u => u.messages.length), 0);

    // CSV helper
    const esc = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/\r?\n/g, ' ');
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmtDate = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '';

    const baseHeaders = ['Name','Phone','Score','Status','Intent','Total Messages','Budget','Location','Timeline','Purpose','Site Visit','First Seen','Last Active'];
    const msgHeaders  = Array.from({ length: maxMsgs }, (_, i) => `Message ${i + 1}`);
    const header = [...baseHeaders, ...msgHeaders].map(esc).join(',');

    const rows = userList.map(({ lead: l, messages }) => {
      const base = [
        l.name || 'Unknown', l.phone || '', l.score || 0, l.label || 'COLD',
        (l.intent || 'general').replace('_', ' '), l.message_count || 0,
        l.budget_range || '', l.location_preference || '', l.timeline || '', l.purpose || '',
        l.site_visit_offered ? 'Yes' : 'No', fmtDate(l.created_at), fmtDate(l.last_message)
      ];
      const msgs = Array.from({ length: maxMsgs }, (_, i) => messages[i] || '');
      return [...base, ...msgs].map(esc).join(',');
    });

    const date = new Date().toISOString().slice(0, 10);
    const csv  = '﻿' + [header, ...rows].join('\r\n'); // BOM for Excel UTF-8

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${date}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leads/:phone — single lead + full chat
router.get('/leads/:phone', async (req, res) => {
  try {
    const [lead, conversations] = await Promise.all([
      db.getLeadByPhone(req.params.phone),
      db.getConversations(req.params.phone)
    ]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, data: { ...lead, conversations } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/send — trigger a WhatsApp message (CRM or dashboard)
// ────────────────────────────────────────────────────────────────
// CRM FLOW:
//   Header: X-Webhook-Secret = CRM_WEBHOOK_SECRET  (optional but recommended)
//   Body: {
//     phone: "91xxxxxxxxxx",
//     message: "Hello...",          ← used for free-form (existing contacts)
//     call_id: "unique-id",         ← optional, prevents duplicate sends
//     template_name: "dreamhome_intro",  ← NEW: use this for NEW numbers (first contact)
//     template_params: ["Rahul"],        ← NEW: values for {{1}}, {{2}} etc.
//     template_language: "en",           ← NEW: optional, defaults to "en"
//   }
//
// HOW TO CHOOSE:
//   - New number (never messaged you) → send template_name + template_params
//   - Existing contact (messaged within 24h) → send message (free-form)
//   - Both provided → template takes priority for safety
// ────────────────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  try {
    const {
      phone, message, call_id, template,
      template_name, template_params, template_language,
      // Accept name from CRM under any of these aliases — used to set lead.name
      // and as a last-resort fallback for {{1}} when CRM forgets template_params.
      name: bodyName, lead_name: bodyLeadName, contact_name: bodyContactName,
      // Aliases for params/language in case CRM uses unprefixed names.
      params: bodyParams, language: bodyLanguage
    } = req.body;
    const headerSecret = req.headers['x-webhook-secret'];
    const crmSecret = process.env.CRM_WEBHOOK_SECRET || '';
    const isCrmTrigger = !!headerSecret;
    const timestamp = new Date().toISOString();

    // Normalize aliases — template_* wins, unprefixed is fallback
    const incomingTemplateParams = (template_params !== undefined && template_params !== null)
      ? template_params
      : bodyParams;
    const incomingTemplateLang = template_language || bodyLanguage;
    const crmLeadName = (bodyName || bodyLeadName || bodyContactName || '').toString().trim();

    const isTemplateMode = !!template_name;

    // Log incoming request — dump full body for CRM triggers so we can diagnose
    // field-name / payload-shape mismatches from a single failing request.
    console.log(`\n📨 ╔═══════════════════════════════════════════`);
    console.log(`   ║ ${isCrmTrigger ? 'CRM' : 'DASHBOARD'} TRIGGER`);
    console.log(`   ║ Time: ${timestamp}`);
    console.log(`   ║ Phone: ${phone}`);
    console.log(`   ║ Call ID: ${call_id || 'none'}`);
    if (isTemplateMode) {
      const logParams = Array.isArray(incomingTemplateParams)
        ? incomingTemplateParams
        : (incomingTemplateParams ? [incomingTemplateParams] : []);
      console.log(`   ║ Template: ${template_name}`);
      console.log(`   ║ Params: ${logParams.join(', ')}`);
      console.log(`   ║ Language: ${incomingTemplateLang || 'en (default)'}`);
    } else if (message) {
      console.log(`   ║ Message: ${String(message).substring(0, 50)}...`);
    }
    if (crmLeadName) console.log(`   ║ Lead Name: ${crmLeadName}`);
    if (isCrmTrigger) {
      const safeBody = { ...req.body };
      if (typeof safeBody.message === 'string' && safeBody.message.length > 200)
        safeBody.message = safeBody.message.slice(0, 200) + '…';
      console.log(`   ║ Raw body: ${JSON.stringify(safeBody)}`);
    }
    console.log(`   ╚═══════════════════════════════════════════\n`);

    // Validate auth
    if (headerSecret && headerSecret !== crmSecret) {
      console.error(`❌ CRM Auth Failed: Invalid X-Webhook-Secret for phone ${phone}`);
      return res.status(403).json({ error: 'Invalid X-Webhook-Secret' });
    }

    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    // Normalize phone
    const cleanPhone = phone.replace(/[\s\-\+]/g, '');
    const normalizedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    if (normalizedPhone !== phone) console.log(`📞 Phone normalized: ${phone} → ${normalizedPhone}`);

    // Dedupe check — keyed on (phone, call_id) so bulk runs with
    // shared call_ids don't block all recipients after the first.
    const isDuplicate = checkAndRecordCallId(normalizedPhone, call_id);
    if (isDuplicate) {
      console.log(`⏭️  DEDUPE: phone=${normalizedPhone} call_id=${call_id} already sent within 24h → skipping`);
      return res.status(200).json({ success: true, deduped: true });
    }

    // ── AUTO-TEMPLATE: if no template given, check if this is a new number ──
    // If it is, auto-use the default_template_name from settings
    let resolvedTemplateName = template_name?.trim() || '';
    let resolvedTemplateParams = Array.isArray(incomingTemplateParams)
      ? incomingTemplateParams.filter(p => p !== undefined && p !== null).map(p => String(p))
      : (incomingTemplateParams ? [String(incomingTemplateParams)] : []);
    let resolvedTemplateLang = incomingTemplateLang || 'en';
    let existingLead;

    // If CRM forgot template_params but did pass a name, use it for {{1}}.
    if (resolvedTemplateName && resolvedTemplateParams.length === 0 && crmLeadName) {
      resolvedTemplateParams = [crmLeadName];
      console.log(`🔄 Using lead name "${crmLeadName}" as template param {{1}}`);
    }

    if (!resolvedTemplateName) {
      existingLead = await db.getLeadByPhone(normalizedPhone).catch(() => null);
      const isNewContact = !existingLead || !existingLead.message_count || existingLead.message_count === 0;
      if (isNewContact) {
        const s = loadSettings();
        if (s.default_template_name && s.default_template_name.trim()) {
          resolvedTemplateName = s.default_template_name.trim();
          resolvedTemplateLang = s.default_template_language || 'en';
          const rawParams = (s.default_template_params || '').split(',').map(p => p.trim()).filter(Boolean);
          // Prefer CRM-supplied name as {{1}} over the static settings default
          if (crmLeadName && rawParams.length > 0) {
            resolvedTemplateParams = [crmLeadName, ...rawParams.slice(1)];
          } else {
            resolvedTemplateParams = rawParams.length ? rawParams : resolvedTemplateParams;
          }
          console.log(`🔄 AUTO-TEMPLATE: new contact detected → using default template "${resolvedTemplateName}" with params [${resolvedTemplateParams.join(', ')}]`);
        } else {
          console.warn(`⚠️  NEW CONTACT with no template_name and no default_template_name configured — Meta will reject free-form text (24h rule).`);
        }
      }
    }

    const useTemplate = !!resolvedTemplateName;

    if (!message && !useTemplate) {
      console.warn(`⚠️  Missing required fields: phone=${phone}, message=${message}, template_name=${template_name}`);
      return res.status(400).json({ error: 'phone and (message or template_name) required' });
    }

    const msgPrefix = call_id ? `[CRM ${call_id}]` : '[MANUAL]';
    const templateParamText = resolvedTemplateParams.join(', ');
    const templateSummary = `${msgPrefix} [TEMPLATE:${resolvedTemplateName}] ${templateParamText}`.trim();
    const messageSummary = template ? `${msgPrefix} [${template}] ${message}` : `${msgPrefix} ${message}`;
    const sentContent = useTemplate ? templateSummary : messageSummary;

    // ── SEND ──────────────────────────────────────────────────────
    let sendError = null;
    let metaErrorDetail = null;
    let metaSuccess = false;
    const sentVia = useTemplate ? 'template' : 'message';

    try {
      if (useTemplate) {
        await sendTemplate(normalizedPhone, resolvedTemplateName, resolvedTemplateLang, resolvedTemplateParams);
        metaSuccess = true;
        console.log(`✅ Template "${resolvedTemplateName}" sent to ${normalizedPhone}`);
      } else {
        await sendText(normalizedPhone, message);
        metaSuccess = true;
        console.log(`✅ Message sent to ${normalizedPhone} via Meta WhatsApp`);
      }
    } catch (err) {
      const metaErr = err.response?.data?.error;
      metaErrorDetail = metaErr ? {
        code: metaErr.code,
        type: metaErr.type,
        message: metaErr.message,
        error_subcode: metaErr.error_subcode,
        error_data: metaErr.error_data,
        fbtrace_id: metaErr.fbtrace_id
      } : null;
      sendError = metaErr
        ? `Meta error ${metaErr.code}: ${metaErr.message}`
        : (err.message || 'Meta API error');
      console.error(`❌ SEND FAILED (${sentVia}) to ${normalizedPhone}: ${sendError}`);
      if (metaErrorDetail) {
        console.error(`   Full Meta error: ${JSON.stringify(metaErrorDetail)}`);
      }
      if (!useTemplate && (String(metaErr?.code) === '131047' || (sendError || '').includes('outside'))) {
        console.warn(`💡 HINT: Free-form text rejected by Meta — recipient hasn't messaged in 24h. CRM should send template_name for new numbers.`);
        sendError += ' — Use template_name for first-contact (new numbers).';
      }
    }

    // Determine the best name to attach to this lead.
    // Priority: explicit name field from CRM > first template param > existing name > 'Unknown'
    const bestName = crmLeadName || resolvedTemplateParams?.[0] || '';

    if (metaSuccess) {
      await db.saveMessage({ phone: normalizedPhone, role: 'assistant', message: sentContent });
      if (existingLead === undefined) {
        existingLead = await db.getLeadByPhone(normalizedPhone).catch(() => null);
      }

      // Only upsert when we actually need to:
      //   - new lead → create with bestName (or 'Unknown' as last resort)
      //   - existing lead whose name is missing/'Unknown' and we now have a real name → update
      // Avoids bumping message_count on every outbound send.
      const existingNameIsPlaceholder = existingLead && (!existingLead.name || existingLead.name === 'Unknown');
      const shouldUpsert = !existingLead || (existingNameIsPlaceholder && bestName);

      if (shouldUpsert) {
        const upsertName = bestName || (existingLead?.name) || 'Unknown';
        await db.upsertLead({
          phone: normalizedPhone,
          name: upsertName,
          score: existingLead?.score ?? 3,
          label: existingLead?.label || 'COLD',
          intent: existingLead?.intent || 'general'
        }).catch((e) => console.warn(`upsertLead skipped: ${e.message}`));
        console.log(`💾 Lead upserted for ${normalizedPhone} (name="${upsertName}")`);
      }
      console.log(`💾 ${sentVia[0].toUpperCase()}${sentVia.slice(1)} saved to database for ${normalizedPhone}`);
    }

    // ──────────────────────────────────────────────────────────────
    // Sync back to CRM timeline ALWAYS (fire-and-forget)
    // Even if Meta fails, CRM needs to know we received + processed the request
    // ──────────────────────────────────────────────────────────────
    if (isCrmTrigger) {
      syncTimeline({
        phone: normalizedPhone,
        direction: 'outbound',
        message: sentContent || message,
        call_id,
        template
      }).catch(() => {});
      console.log(`✨ CRM Trigger synced to timeline for ${phone}`);
    }

    if (sendError) {
      // Return 502 Bad Gateway — Meta refused the send. CRM must NOT treat this
      // as success. Old behaviour returned 200 which masked failures and led to
      // CRM showing "sent" while no message reached the user.
      return res.status(502).json({
        success: false,
        whatsapp_delivered: false,
        error: sendError,
        meta_error: metaErrorDetail
      });
    }

    res.json({ success: true, whatsapp_delivered: true });
  } catch (e) {
    console.error('💥 SEND Unexpected error:', e.message);
    res.status(500).json({ success: false, whatsapp_delivered: false, error: e.message });
  }
});

// POST /api/broadcast — send to all leads in a tier
// Body: { label: "WARM", message: "Hi everyone..." }
router.post('/broadcast', async (req, res) => {
  try {
    const { label, message } = req.body;
    if (!label || !message) return res.status(400).json({ error: 'label and message required' });
    const leads = (await db.getAllLeads()).filter(l => l.label === label.toUpperCase());
    let sent = 0, failed = 0;
    for (const lead of leads) {
      try {
        await sendText(lead.phone, message);
        await db.saveMessage({ phone: lead.phone, role: 'assistant', message: `[BROADCAST] ${message}` });
        sent++;
        await new Promise(r => setTimeout(r, 300)); // rate limit
      } catch { failed++; }
    }
    res.json({ success: true, total: leads.length, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/broadcast-template — send approved template to NEW numbers (first contact)
// Body: { phones: ["919876543210",...], template_name: "dreamhome_intro", language: "en", params: ["Rahul"] }
// OR:   { phones: [...], template_name: "...", language: "en", params_map: {"919876543210": ["Rahul"], ...} }
router.post('/broadcast-template', async (req, res) => {
  try {
    const { phones, template_name, language = 'en', params = [], params_map = {} } = req.body;
    if (!phones || !Array.isArray(phones) || phones.length === 0)
      return res.status(400).json({ error: 'phones array required' });
    if (!template_name)
      return res.status(400).json({ error: 'template_name required' });

    let sent = 0, failed = 0, errors = [];
    for (const rawPhone of phones) {
      const phone = String(rawPhone).replace(/\D/g, '');
      if (!phone) { failed++; continue; }
      // Per-number params override global params
      const p = params_map[phone] || params_map[rawPhone] || params;
      try {
        await sendTemplate(phone, template_name, language, p);
        await db.saveMessage({ phone, role: 'assistant', message: `[TEMPLATE:${template_name}] ${p.join(', ')}` });
        await db.upsertLead({ phone, name: p[0] || 'Unknown', score: 3, label: 'COLD', intent: 'general' });
        sent++;
        await new Promise(r => setTimeout(r, 350)); // stay under rate limit
      } catch (e) {
        failed++;
        errors.push({ phone, error: e.response?.data?.error?.message || e.message });
      }
    }
    res.json({ success: true, total: phones.length, sent, failed, errors: errors.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/templates — list approved WhatsApp templates from Meta
router.get('/templates', async (req, res) => {
  try {
    const axios = require('axios');
    const wabaId = process.env.WABA_ID || '';
    if (!wabaId) return res.json({ success: true, data: [] });
    const r = await axios.get(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      params: { fields: 'name,status,language,components', limit: 50 }
    });
    const approved = (r.data.data || []).filter(t => t.status === 'APPROVED');
    res.json({ success: true, data: approved });
  } catch (e) {
    res.json({ success: true, data: [] }); // non-fatal
  }
});

// ── KNOWLEDGE BASE ────────────────────────────────────────────────

// GET /api/knowledge
router.get('/knowledge', async (req, res) => {
  try {
    const docs = await db.getKnowledgeBase();
    res.json({ success: true, data: docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/knowledge/upload — PDF, TXT, or raw text body
router.post('/knowledge/upload', upload.single('file'), async (req, res) => {
  let tempPath = null;
  try {
    let content  = '';
    let fileType = 'manual';
    let name     = req.body.name || 'Untitled';
    let file_url = null;

    if (req.file) {
      tempPath = req.file.path;
      name     = req.file.originalname;
      fileType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'text';
      const fileBuffer = fs.readFileSync(tempPath);

      if (fileType === 'pdf') {
        const parsed = await pdfParse(fileBuffer);
        content = parsed.text;
        // Also upload original PDF to Supabase Storage so it can be sent to users
        try {
          file_url = await db.uploadToStorage(name, fileBuffer, 'application/pdf');
          console.log(`📤 PDF uploaded to storage: ${file_url}`);
        } catch (storageErr) {
          console.warn('⚠️  Storage upload failed (text still saved):', storageErr.message);
        }
      } else {
        content = fileBuffer.toString('utf8');
      }
    } else if (req.body.content) {
      content = req.body.content;
    }

    if (!content.trim()) return res.status(400).json({ error: 'No content found in file' });

    const doc = await db.addKnowledge({
      name,
      content: content.trim(),
      file_type: fileType,
      size_chars: content.length,
      file_url
    });
    res.json({ success: true, data: doc });
  } catch (e) {
    console.error('Knowledge upload error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
  }
});

// POST /api/knowledge/project — upload multiple files (JSON + PDFs) under one project group
router.post('/knowledge/project', upload.array('files', 50), async (req, res) => {
  const { project_group } = req.body;
  if (!project_group || !project_group.trim())
    return res.status(400).json({ error: 'project_group (project name) is required' });

  const results = [], errors = [];

  for (const file of (req.files || [])) {
    const tempPath = file.path;
    try {
      const fileBuffer = fs.readFileSync(tempPath);
      const name      = file.originalname;
      const isJson    = name.toLowerCase().endsWith('.json') || file.mimetype === 'application/json';
      const isPdf     = file.mimetype === 'application/pdf'  || name.toLowerCase().endsWith('.pdf');

      let content = '', file_url = null, fileType = 'text';

      if (isJson) {
        content  = fileBuffer.toString('utf8');
        fileType = 'json';
        try { JSON.parse(content); } catch {
          errors.push({ name, error: 'Invalid JSON — skipped' }); continue;
        }
      } else if (isPdf) {
        const parsed = await pdfParse(fileBuffer);
        content  = parsed.text;
        fileType = 'pdf';
        try {
          file_url = await db.uploadToStorage(`${project_group}/${name}`, fileBuffer, 'application/pdf');
        } catch (e) { console.warn('Storage upload failed:', e.message); }
      } else {
        content  = fileBuffer.toString('utf8');
        fileType = 'text';
      }

      if (!content.trim()) { errors.push({ name, error: 'Empty content — skipped' }); continue; }

      const doc = await db.addKnowledge({
        name, content: content.trim(), file_type: fileType,
        size_chars: content.length, file_url, project_group: project_group.trim()
      });
      results.push(doc);
    } catch (e) {
      errors.push({ name: file.originalname, error: e.message });
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  console.log(`📁 Project "${project_group}": ${results.length} uploaded, ${errors.length} errors`);
  res.json({ success: true, uploaded: results.length, errors, data: results });
});

// DELETE /api/knowledge/:id
router.delete('/knowledge/:id', async (req, res) => {
  try {
    await db.deleteKnowledge(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
