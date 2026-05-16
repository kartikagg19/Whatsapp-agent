// ================================================================
//  src/routes/webhook.js — Receives all WhatsApp messages
// ================================================================
const express = require('express');
const router  = express.Router();
const { getAIReply, getLeadLabel } = require('../ai');
const { sendText, sendButtons, markRead, alertSales, parseMessage } = require('../whatsapp');
const db = require('../database');

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
    await markRead(messageId);

    const history = await db.getHistory(phone, 10);
    console.log(`📚 History loaded: ${history.length} messages`);
    await db.saveMessage({ phone, role: 'user', message: text });

    const ai    = await getAIReply(text, history);
    const label = getLeadLabel(ai.lead_score);

    await db.saveMessage({ phone, role: 'assistant', message: ai.reply_message, score: ai.lead_score });
    await db.upsertLead({ phone, name, score: ai.lead_score, label, intent: ai.qualification_stage || 'general' });

    console.log(`🤖 Reply (${label} ${ai.lead_score}/10): "${ai.reply_message}"`);

    // Send reply — with visit buttons if site visit was offered
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

    // Alert sales for HOT leads
    if (label === 'HOT' && process.env.SALES_PHONE_NUMBER) {
      alertSales(process.env.SALES_PHONE_NUMBER, { phone, name, score: ai.lead_score * 10, intent: ai.qualification_stage || 'general' })
        .catch(e => console.warn('⚠️  Sales alert failed:', e.message));
    }

  } catch (err) {
    console.error('❌ Processing error:', err.message);
    sendText(phone, "I'm having a small issue. Our team will reach you very soon! 🙏").catch(() => {});
  }
});

module.exports = router;
