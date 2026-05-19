// ================================================================
//  src/routes/admin.js — Dashboard API endpoints
// ================================================================
const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const db       = require('../database');
const { sendText } = require('../whatsapp');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const SETTINGS_FILE = path.join(__dirname, '../../../settings.json');

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
  ]
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

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

// POST /api/send — manual message to one lead
// Body: { phone: "91xxxxxxxxxx", message: "Hello..." }
router.post('/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    await sendText(phone, message);
    await db.saveMessage({ phone, role: 'assistant', message: `[MANUAL] ${message}` });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  try {
    let content  = '';
    let fileType = 'manual';
    let name     = req.body.name || 'Untitled';

    if (req.file) {
      name     = req.file.originalname;
      fileType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'text';
      if (fileType === 'pdf') {
        const parsed = await pdfParse(req.file.buffer);
        content = parsed.text;
      } else {
        content = req.file.buffer.toString('utf8');
      }
    } else if (req.body.content) {
      content = req.body.content;
    }

    if (!content.trim()) return res.status(400).json({ error: 'No content found in file' });

    const doc = await db.addKnowledge({
      name,
      content: content.trim(),
      file_type: fileType,
      size_chars: content.length
    });
    res.json({ success: true, data: doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/knowledge/:id
router.delete('/knowledge/:id', async (req, res) => {
  try {
    await db.deleteKnowledge(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
