// ================================================================
//  src/routes/webhook.js — Receives all WhatsApp messages
// ================================================================
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { getAIReply, getLeadLabel } = require('../ai');
const { sendText, sendDocument, sendButtons, markRead, alertSales, parseMessage } = require('../whatsapp');
const { syncTimeline } = require('../crmClient');
const db = require('../database');

const SETTINGS_FILE = path.join(__dirname, '../../../settings.json');
function getReplyDelay() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return parseInt(s.reply_delay) || 0;
  } catch { return 0; }
}

const processing = new Set(); // prevents duplicate replies

// Meta sends GET to verify webhook
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta sends POST when buyer messages your WhatsApp
router.post('/', async (req, res) => {
  res.sendStatus(200); // respond fast — Meta retries if slow

  let body;
  try { body = JSON.parse(req.body.toString()); } catch { return; }
  if (body.object !== 'whatsapp_business_account') return;

  const msg = parseMessage(body);
  if (!msg || !msg.text || processing.has(msg.messageId)) return;
  processing.add(msg.messageId);
  setTimeout(() => processing.delete(msg.messageId), 30000);

  const { messageId, phone, name, text } = msg;
  console.log(`\n📩 ${name} (${phone}): "${text}"`);

  // Handle opt-out
  if (/^stop$/i.test(text.trim())) {
    return sendText(phone, "You've been unsubscribed. Reply START anytime to connect again. 🙏");
  }
  if (/^start$/i.test(text.trim())) {
    return sendText(phone, "Welcome back! 😊 How can I help you find your dream home today?");
  }

  try {
    // Step 1: mark read (non-critical — don't let it block)
    markRead(messageId).catch(e => console.warn('⚠️ markRead failed:', e.message));

    // Step 2: load history + lead from DB
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

    // Step 3: save incoming message (non-critical)
    db.saveMessage({ phone, role: 'user', message: text }).catch(e => console.warn('⚠️ saveMessage failed:', e.message));

    // Step 4: get AI reply
    let ai;
    try {
      ai = await getAIReply(text, history, existingLead);
    } catch (e) {
      console.error('❌ AI failed:', e.message);
      await sendText(phone, 'Ek second ji, thoda busy hoon. Aap dobara message karein please 🙏').catch(() => {});
      return;
    }

    const label = getLeadLabel(ai.lead_score);
    console.log(`🤖 Reply (${label} ${ai.lead_score}/10): "${ai.reply_message}"`);

    // Step 5: save reply + upsert lead (non-critical — don't block sending)
    db.saveMessage({ phone, role: 'assistant', message: ai.reply_message, score: ai.lead_score, input_tokens: ai.input_tokens, output_tokens: ai.output_tokens })
      .catch(e => console.warn('⚠️ save reply failed:', e.message));
    db.upsertLead({
      phone, name, score: ai.lead_score, label, intent: ai.qualification_stage || 'general',
      budget_range:        ai.budget_range        || undefined,
      location_preference: ai.location_preference || undefined,
      timeline:            ai.timeline            || undefined,
      purpose:             ai.purpose             || undefined
    }).catch(e => console.warn('⚠️ upsertLead failed:', e.message));

    // Step 6: apply reply delay
    const delay = getReplyDelay();
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    // Step 7: send document if AI flagged one
    if (ai.send_document) {
      const docName = decodeURIComponent(ai.send_document.split('/').pop()) || 'document.pdf';
      try {
        await sendDocument(phone, ai.send_document, docName, '');
        console.log(`📎 Document sent: ${docName}`);
      } catch (e) {
        console.warn('⚠️ Document send failed, sending link as text:', e.message);
        // Fallback: send the URL as plain text so user can still download
        await sendText(phone, `📎 ${docName}\n\nYahan se download karein:\n${ai.send_document}`).catch(() => {});
      }
    }

    // Step 8: send reply
    try {
      if (ai.site_visit_offered || ai.site_visit_confirmed) {
        await sendText(phone, ai.reply_message);
        await sendButtons(phone, '📅 Site visit ke liye time choose karein:', [
          { id: 'saturday', title: 'Saturday' },
          { id: 'sunday',   title: 'Sunday'   },
          { id: 'weekday',  title: 'Weekday'  }
        ]);
      } else {
        await sendText(phone, ai.reply_message);
      }
    } catch (e) {
      console.error('❌ sendText failed:', e.response?.data || e.message);
    }

    // Step 9: sales alert for HOT leads
    if (label === 'HOT' && process.env.SALES_PHONE_NUMBER) {
      alertSales(process.env.SALES_PHONE_NUMBER, { phone, name, score: ai.lead_score * 10, intent: ai.qualification_stage || 'general' })
        .catch(e => console.warn('⚠️ Sales alert failed:', e.message));
    }

    // Step 10: CRM sync (fire-and-forget)
    syncTimeline({ phone, direction: 'inbound', message: text, call_id: `wa-in-${messageId}`, occurred_at: new Date().toISOString() }).catch(() => {});
    syncTimeline({
      phone, direction: 'outbound', message: ai.reply_message, call_id: `wa-out-${messageId}`,
      ai_score: (typeof ai.lead_score === 'number' && isFinite(ai.lead_score)) ? Math.round(ai.lead_score * 10) : null,
      intent: ai.qualification_stage, qualified: !!ai.qualified, summary: ai.summary,
      profile_patch: { budget_range: ai.budget_range }, occurred_at: new Date().toISOString()
    }).catch(() => {});

  } catch (err) {
    console.error('❌ Unexpected error:', err.message);
  }
});

module.exports = router;
