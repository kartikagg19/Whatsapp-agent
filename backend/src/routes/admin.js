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

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename:    (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 250 * 1024 * 1024 } });

const SETTINGS_FILE = path.join(__dirname, '../../../settings.json');

// ────────────────────────────────────────────────────────────────
// In-memory dedupe for POST /api/send (call_id idempotency)
// Maps call_id → timestamp. Entries older than 24h are pruned.
// ────────────────────────────────────────────────────────────────
const dedupeMap = new Map();
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkAndRecordCallId(callId) {
  if (!callId) return false; // no call_id = not deduped
  const now = Date.now();
  const lastSent = dedupeMap.get(callId);
  if (lastSent && now - lastSent < DEDUPE_TTL_MS) {
    return true; // duplicate within 24h
  }
  dedupeMap.set(callId, now);
  // Prune old entries every 100 calls to prevent memory leak
  if (dedupeMap.size > 1000) {
    for (const [key, timestamp] of dedupeMap) {
      if (now - timestamp >= DEDUPE_TTL_MS) {
        dedupeMap.delete(key);
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

// ── AUTH ─────────────────────────────────────────────────────────

function getToken() {
  const pass = process.env.ADMIN_PASSWORD || 'propello2025';
  return Buffer.from(`propello-dashboard:${pass}`).toString('base64');
}

function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/whatsapp-test' || req.path === '/ai-test' || req.path === '/send' || req.path === '/kb-debug') return next();
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
router.post('/agent-settings', (req, res) => {
  try {
    const current  = loadSettings();
    const updated  = { ...current, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    res.json({ success: true });
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
    const { phone, message, call_id, template,
            template_name, template_params, template_language } = req.body;
    const headerSecret = req.headers['x-webhook-secret'];
    const crmSecret = process.env.CRM_WEBHOOK_SECRET || '';
    const isCrmTrigger = !!headerSecret;
    const timestamp = new Date().toISOString();
    const useTemplate = !!(template_name && template_name.trim());

    // Log incoming request
    console.log(`\n📨 ╔═══════════════════════════════════════════`);
    console.log(`   ║ ${isCrmTrigger ? 'CRM' : 'DASHBOARD'} TRIGGER`);
    console.log(`   ║ Time: ${timestamp}`);
    console.log(`   ║ Phone: ${phone}`);
    console.log(`   ║ Call ID: ${call_id || 'none'}`);
    console.log(`   ║ Mode: ${useTemplate ? `TEMPLATE (${template_name})` : 'FREE-FORM'}`);
    console.log(`   ╚═══════════════════════════════════════════\n`);

    // Validate auth
    if (headerSecret && headerSecret !== crmSecret) {
      console.error(`❌ CRM Auth Failed: Invalid X-Webhook-Secret for phone ${phone}`);
      return res.status(403).json({ error: 'Invalid X-Webhook-Secret' });
    }

    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }
    if (!useTemplate && !message) {
      return res.status(400).json({ error: 'Either message (free-form) or template_name (new contact) is required' });
    }

    // Normalize phone
    const cleanPhone = phone.replace(/[\s\-\+]/g, '');
    const normalizedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    if (normalizedPhone !== phone) console.log(`📞 Phone normalized: ${phone} → ${normalizedPhone}`);

    // Dedupe check
    const isDuplicate = checkAndRecordCallId(call_id);
    if (isDuplicate) {
      console.log(`⏭️  DEDUPE: call_id=${call_id} already sent within 24h → skipping`);
      return res.status(200).json({ success: true, deduped: true });
    }

    // ── AUTO-TEMPLATE: if no template given, check if this is a new number ──
    // If it is, auto-use the default_template_name from settings
    let resolvedTemplateName = template_name?.trim() || '';
    let resolvedTemplateParams = Array.isArray(template_params)
      ? template_params
      : (template_params ? [template_params] : []);
    let resolvedTemplateLang = template_language || 'en';

    if (!resolvedTemplateName) {
      const existingLead = await db.getLeadByPhone(normalizedPhone).catch(() => null);
      const isNewContact = !existingLead || !existingLead.message_count || existingLead.message_count === 0;
      if (isNewContact) {
        const s = loadSettings();
        if (s.default_template_name && s.default_template_name.trim()) {
          resolvedTemplateName = s.default_template_name.trim();
          resolvedTemplateLang = s.default_template_language || 'en';
          // Parse comma-separated default params, substitute {name} placeholder
          const rawParams = (s.default_template_params || '').split(',').map(p => p.trim()).filter(Boolean);
          resolvedTemplateParams = rawParams.length ? rawParams : resolvedTemplateParams;
          console.log(`🔄 AUTO-TEMPLATE: new contact detected → using default template "${resolvedTemplateName}"`);
        }
      }
    }

    const useTemplate = !!resolvedTemplateName;

    // ── SEND ──────────────────────────────────────────────────────
    let sendError = null;
    let metaSuccess = false;
    let sentContent = '';

    if (useTemplate) {
      // Template message — works for NEW numbers (first contact)
      try {
        await sendTemplate(normalizedPhone, resolvedTemplateName, resolvedTemplateLang, resolvedTemplateParams);
        metaSuccess = true;
        sentContent = `[TEMPLATE:${resolvedTemplateName}] ${resolvedTemplateParams.join(', ')}`;
        console.log(`✅ Template "${resolvedTemplateName}" sent to ${normalizedPhone}`);
      } catch (err) {
        const metaErr = err.response?.data?.error;
        sendError = metaErr
          ? `Meta error ${metaErr.code}: ${metaErr.message}`
          : (err.message || 'Meta API error');
        console.error(`❌ TEMPLATE SEND FAILED to ${normalizedPhone}:`, sendError);
      }
    } else {
      // Free-form message — only works if user messaged within last 24h
      try {
        await sendText(normalizedPhone, message);
        metaSuccess = true;
        const msgPrefix = call_id ? `[CRM ${call_id}]` : '[MANUAL]';
        sentContent = template ? `${msgPrefix} [${template}] ${message}` : `${msgPrefix} ${message}`;
        console.log(`✅ Message sent to ${normalizedPhone} via Meta WhatsApp`);
      } catch (err) {
        const metaErr = err.response?.data?.error;
        sendError = metaErr
          ? `Meta error ${metaErr.code}: ${metaErr.message}`
          : (err.message || 'Meta API error');
        console.error(`❌ SEND FAILED to ${normalizedPhone}:`, sendError);
        // Hint if it looks like a 24h window error
        if (sendError.includes('131047') || sendError.includes('outside')) {
          console.warn(`💡 HINT: This number may not have messaged in 24h. Use template_name instead of message.`);
          sendError += ' — Use template_name for first-contact (new numbers).';
        }
      }
    }

    if (metaSuccess) {
      await db.saveMessage({ phone: normalizedPhone, role: 'assistant', message: sentContent });
      // Create/update lead record so this contact appears in dashboard
      await db.upsertLead({ phone: normalizedPhone, name: (template_params?.[0]) || 'Unknown', score: 3, label: 'COLD', intent: 'general' }).catch(()=>{});
    }

    if (sendError) {
      return res.status(200).json({ success: false, error: sendError });
    }

    if (isCrmTrigger) console.log(`✨ CRM Trigger completed successfully for ${phone}\n`);
    res.json({ success: true });
  } catch (e) {
    console.error('💥 SEND Unexpected error:', e.message);
    res.status(200).json({ success: false, error: e.message });
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
