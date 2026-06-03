// ================================================================
//  src/routes/salesforce.js — Salesforce → WhatsApp trigger
//
//  Salesforce Flow / Process Builder calls POST /api/salesforce/trigger
//  whenever a Lead needs a WhatsApp outreach. This endpoint validates
//  the secret, decides template vs free-form, sends the message, and
//  upserts the Lead in our Supabase + Salesforce.
// ================================================================

const express      = require('express');
const router       = express.Router();
const { sendText, sendTemplate } = require('../whatsapp');
const { upsertLead, authenticate, isSalesforceConfigured } = require('../salesforce');
const db           = require('../database');
const path         = require('path');
const fs           = require('fs');

const SETTINGS_FILE = path.join(__dirname, '../../../settings.json');
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

// ── GET /api/salesforce/status ─────────────────────────────────
// Health check — tells you if SF credentials are wired up.

router.get('/status', async (req, res) => {
  const configured = isSalesforceConfigured();
  let authOk = false;
  let instanceUrl = null;
  if (configured) {
    try {
      const auth = await authenticate();
      authOk = true;
      instanceUrl = auth.instanceUrl;
    } catch {}
  }
  res.json({
    salesforce_configured: configured,
    salesforce_auth_ok:    authOk,
    instance_url:          instanceUrl,
    webhook_secret_set:    !!process.env.SF_WEBHOOK_SECRET
  });
});

// ── POST /api/salesforce/trigger ───────────────────────────────
//
// Called by Salesforce Flow when a Lead should receive a WhatsApp.
//
// Required body fields:
//   phone          — e.g. "919876543210" or "9876543210"
//   sf_secret      — must match SF_WEBHOOK_SECRET env var (if set)
//
// Optional body fields:
//   name           — Lead's name (used as template param {{1}})
//   message        — Free-form message (existing contacts only)
//   template_name  — Approved WA template name (for new numbers)
//   template_params — Array of template placeholder values
//   language       — Template language code (default "en")

router.post('/trigger', async (req, res) => {
  const {
    phone,
    name,
    message,
    template_name,
    template_params,
    language = 'en',
    sf_secret
  } = req.body;

  // ── Auth check ────────────────────────────────────────────────
  const expectedSecret = process.env.SF_WEBHOOK_SECRET || '';
  if (expectedSecret && sf_secret !== expectedSecret) {
    console.warn(`[SF trigger] ❌ Invalid sf_secret from Salesforce`);
    return res.status(403).json({ error: 'Invalid sf_secret' });
  }

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' });
  }

  // ── Normalize phone ───────────────────────────────────────────
  const cleanPhone      = String(phone).replace(/[\s\-\+]/g, '');
  const normalizedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

  console.log(`\n🔵 [SF trigger] ${name || 'Unknown'} (${normalizedPhone})`);

  try {
    // ── Decide template vs free-form ──────────────────────────────
    const existingLead = await db.getLeadByPhone(normalizedPhone).catch(() => null);
    const isNew        = !existingLead || !existingLead.message_count;

    let sentVia = 'message';
    let sentContent = message || '';

    if (template_name || isNew) {
      // Use provided template, or fall back to default from settings
      const s         = loadSettings();
      const tmplName  = template_name || s.default_template_name || '';

      if (!tmplName) {
        return res.status(400).json({
          error: 'New contact requires template_name. Set one in the request or configure default_template_name in Agent Settings.'
        });
      }

      const params = Array.isArray(template_params)
        ? template_params
        : (template_params ? [String(template_params)] : (name ? [name] : []));

      await sendTemplate(normalizedPhone, tmplName, language, params);
      sentVia     = 'template';
      sentContent = `[SF][TEMPLATE:${tmplName}] ${params.join(', ')}`;
      console.log(`[SF trigger] ✅ Template "${tmplName}" sent to ${normalizedPhone}`);
    } else {
      if (!message) {
        return res.status(400).json({ error: 'message is required for existing contacts' });
      }
      await sendText(normalizedPhone, message);
      sentContent = `[SF] ${message}`;
      console.log(`[SF trigger] ✅ Message sent to ${normalizedPhone}`);
    }

    // ── Persist to Supabase ───────────────────────────────────────
    await db.saveMessage({ phone: normalizedPhone, role: 'assistant', message: sentContent })
      .catch(e => console.warn('[SF trigger] saveMessage skipped:', e.message));

    // ── Upsert lead in Supabase ───────────────────────────────────
    if (!existingLead) {
      await db.upsertLead({
        phone: normalizedPhone,
        name:  name || 'Unknown',
        score: 3,
        label: 'COLD',
        intent: 'general'
      }).catch(e => console.warn('[SF trigger] upsertLead skipped:', e.message));
    }

    // ── Upsert lead in Salesforce (fire-and-forget) ───────────────
    upsertLead({
      phone: normalizedPhone,
      name:  name || existingLead?.name || 'Unknown',
      score: existingLead?.score ?? 3,
      label: existingLead?.label || 'COLD',
      intent: 'general'
    }).catch(() => {});

    return res.json({ success: true, phone: normalizedPhone, sent_via: sentVia });

  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[SF trigger] ❌ Failed for ${normalizedPhone}: ${detail}`);
    return res.status(502).json({ success: false, error: detail });
  }
});

module.exports = router;
