// ================================================================
//  src/routes/webhook.js — Receives all WhatsApp messages
// ----------------------------------------------------------------
//  This route is intentionally THIN. It:
//    1. ACKs Meta fast (so retries don't pile up)
//    2. Parses + dedupes the inbound message
//    3. Persists the user message immediately (dashboard/CRM stay live)
//    4. Hands off to the orchestrator, which owns:
//         - debounce/buffering of rapid inbound bursts
//         - cancellation of stale generations
//         - AI inference
//         - chunked outbound delivery
//         - lead upsert + HOT alert + outbound CRM sync
//  See src/orchestrator.js for that pipeline.
// ================================================================
const express = require('express');
const router  = express.Router();
const { sendText, markRead, parseMessage } = require('../whatsapp');
const { syncTimeline } = require('../crmClient');
const { enqueueInbound } = require('../orchestrator');
const db = require('../database');

const processing = new Set(); // prevents duplicate replies on Meta retries

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

  // Handle opt-out / opt-in — these bypass the orchestrator entirely.
  if (/^stop$/i.test(text.trim())) {
    return sendText(phone, "You've been unsubscribed. Reply START anytime to connect again. 🙏").catch(() => {});
  }
  if (/^start$/i.test(text.trim())) {
    return sendText(phone, "Welcome back! 😊 How can I help you find your dream home today?").catch(() => {});
  }

  // Mark read immediately — must not be debounced or the user sees no blue ticks.
  markRead(messageId).catch(e => console.warn('⚠️ markRead failed:', e.message));

  // Persist the inbound message immediately so dashboard + CRM stay live
  // even if the AI reply ends up debounced/aborted later.
  db.saveMessage({ phone, role: 'user', message: text })
    .catch(e => console.warn('⚠️ saveMessage failed:', e.message));
  syncTimeline({ phone, direction: 'inbound', message: text, call_id: `wa-in-${messageId}` })
    .catch(() => {});

  // Hand off to the orchestrator (buffering + cancellation + chunked send).
  try {
    enqueueInbound({ phone, name, text, messageId });
  } catch (err) {
    console.error('❌ enqueueInbound failed:', err.message);
  }
});

module.exports = router;
