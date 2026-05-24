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
const { sendText } = require('../whatsapp');

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
  followup_check_hours: 6
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
  if (req.path === '/login' || req.path === '/whatsapp-test' || req.path === '/ai-test') return next();
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

// GET /api/ai-test — verify Gemini API key works
router.get('/ai-test', async (req, res) => {
  try {
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await client.models.generateContent({
      model: 'gemini-2.0-flash',
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
// CRM FLOW (PropelloCRM integration):
//   Header: X-Webhook-Secret = CRM_WEBHOOK_SECRET
//   Body: {
//     phone: "91xxxxxxxxxx",
//     message: "Hello...",
//     call_id: "unique-id-for-idempotency",     (optional, CRM uses for dedupe)
//     template: "campaign_name"                 (optional, for analytics)
//   }
//
// DASHBOARD FLOW (legacy):
//   No auth header (dashboard will be updated to send one, or see §7 risk)
//   Body: { phone: "91xxxxxxxxxx", message: "Hello..." }
//
// Behavior:
//   - Reject if X-Webhook-Secret provided but doesn't match CRM_WEBHOOK_SECRET
//   - If call_id seen in last 24h, return 200 { success: true, deduped: true }
//   - On Meta failure, return 200 { success: false, error: "..." }
// ────────────────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  try {
    const { phone, message, call_id, template } = req.body;
    const headerSecret = req.headers['x-webhook-secret'];
    const crmSecret = process.env.CRM_WEBHOOK_SECRET || '';
    const isCrmTrigger = !!headerSecret;
    const timestamp = new Date().toISOString();

    // Log incoming request
    if (isCrmTrigger) {
      console.log(`\n📨 ╔═══════════════════════════════════════════`);
      console.log(`   ║ CRM TRIGGER RECEIVED`);
      console.log(`   ║ Time: ${timestamp}`);
      console.log(`   ║ Phone: ${phone}`);
      console.log(`   ║ Call ID: ${call_id || 'none'}`);
      console.log(`   ║ Template: ${template || 'none'}`);
      console.log(`   ╚═══════════════════════════════════════════\n`);
    }

    // ──────────────────────────────────────────────────────────────
    // AC1: Validate secret if provided (CRM flow) or if CRM is enabled
    // ──────────────────────────────────────────────────────────────
    if (headerSecret && headerSecret !== crmSecret) {
      console.error(`❌ CRM Auth Failed: Invalid X-Webhook-Secret for phone ${phone}`);
      return res.status(403).json({ error: 'Invalid X-Webhook-Secret' });
    }

    // For backward compatibility during transition: if headerSecret is provided,
    // we know it's CRM. If not, assume it's dashboard (legacy). Once all clients
    // send the header, we can enforce it for all calls.

    if (!phone || !message) {
      console.warn(`⚠️  Missing required fields: phone=${phone}, message=${message}`);
      return res.status(400).json({ error: 'phone and message required' });
    }

    // Normalize phone: strip spaces, dashes, +; add 91 if 10-digit India number
    const cleanPhone = phone.replace(/[\s\-\+]/g, '');
    const normalizedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    if (normalizedPhone !== phone) console.log(`📞 Phone normalized: ${phone} → ${normalizedPhone}`);

    // ──────────────────────────────────────────────────────────────
    // AC2 & AC3: Check dedupe (if call_id provided, honor 24h window)
    // ──────────────────────────────────────────────────────────────
    const isDuplicate = checkAndRecordCallId(call_id);
    if (isDuplicate) {
      console.log(`⏭️  DEDUPE: call_id=${call_id} already sent within 24h → skipping`);
      return res.status(200).json({ success: true, deduped: true });
    }

    // ──────────────────────────────────────────────────────────────
    // Send to Meta and save locally
    // ──────────────────────────────────────────────────────────────
    let sendError = null;
    let metaSuccess = false;
    try {
      await sendText(normalizedPhone, message);
      metaSuccess = true;
      console.log(`✅ Message sent to ${normalizedPhone} via Meta WhatsApp`);
    } catch (err) {
      // Extract the real Meta error message for the dashboard
      const metaErr = err.response?.data?.error;
      sendError = metaErr
        ? `Meta error ${metaErr.code}: ${metaErr.message}`
        : (err.message || 'Meta API error');
      console.error(`❌ SEND FAILED to ${normalizedPhone}:`, sendError);
    }

    // Save locally only if actually sent — avoid showing failed messages as sent
    if (metaSuccess) {
      const msgPrefix = call_id ? `[CRM ${call_id}]` : '[MANUAL]';
      const msgWithTemplate = template ? `${msgPrefix} [${template}] ${message}` : `${msgPrefix} ${message}`;
      await db.saveMessage({ phone: normalizedPhone, role: 'assistant', message: msgWithTemplate });
      console.log(`💾 Message saved to database for ${normalizedPhone}`);
    }
    console.log(`💾 Message saved to database for ${phone}`);

    // ──────────────────────────────────────────────────────────────
    // AC4: Always return 200 even on Meta failure (CRM treats 2xx as delivered)
    // ──────────────────────────────────────────────────────────────
    if (sendError) {
      console.warn(`⚠️  CRM Request processed but Meta failed: ${sendError}`);
      return res.status(200).json({ success: false, error: sendError });
    }

    if (isCrmTrigger) {
      console.log(`✨ CRM Trigger completed successfully for ${phone}\n`);
    }
    res.json({ success: true });
  } catch (e) {
    // Unexpected error — log but still return 200 if CRM is involved
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

// DELETE /api/knowledge/:id
router.delete('/knowledge/:id', async (req, res) => {
  try {
    await db.deleteKnowledge(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
