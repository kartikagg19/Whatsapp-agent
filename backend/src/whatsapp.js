// ================================================================
//  src/whatsapp.js — Send & Receive WhatsApp Messages
// ================================================================
const axios  = require('axios');
const API    = 'https://graph.facebook.com/v22.0';
const PHONE  = () => process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN  = () => process.env.WHATSAPP_TOKEN;
const HEADER = () => ({ Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' });

// Send plain text message
async function sendText(to, text) {
  try {
    const res = await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp',
      to, type: 'text',
      text: { body: text, preview_url: false }
    }, { headers: HEADER() });
    console.log(`✅ Sent to ${to}`);
    return res.data;
  } catch (err) {
    console.error(`❌ Send failed to ${to}:`, err.response?.data || err.message);
    throw err;
  }
}

// Send message with buttons (max 3 buttons)
async function sendButtons(to, body, buttons) {
  try {
    await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button', body: { text: body },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
      }
    }, { headers: HEADER() });
  } catch {
    await sendText(to, body); // fallback to plain text
  }
}

// Mark message as read (blue ticks)
async function markRead(messageId) {
  try {
    await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId
    }, { headers: HEADER() });
  } catch { /* non-critical */ }
}

// Mark as read AND show the typing indicator. Bubble shows for up to
// 25s OR until the next outbound message — whichever comes first.
// Falls back silently to a plain read-receipt if the API rejects the
// typing field (older WABA tier, etc).
async function markReadWithTyping(messageId) {
  try {
    await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' }
    }, { headers: HEADER() });
  } catch {
    // Typing not supported — fall back to plain read receipt.
    markRead(messageId).catch(() => {});
  }
}

// Alert sales team about HOT lead
async function alertSales(salesPhone, lead) {
  const msg = `🔥 *HOT LEAD!*\n\n👤 ${lead.name || 'Unknown'}\n📱 ${lead.phone}\n📊 Score: ${lead.score}/100\n💬 Interest: ${lead.intent}\n⏰ ${new Date().toLocaleTimeString('en-IN')}\n\nCall them NOW! ⚡`;
  return sendText(salesPhone, msg);
}

// Parse incoming WhatsApp webhook message
function parseMessage(body) {
  try {
    const msg     = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    if (!msg) return null;

    let text = '';
    if (msg.type === 'text')        text = msg.text?.body || '';
    else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title || '';
    else text = '[non-text message]';

    return {
      messageId: msg.id,
      phone:     msg.from,
      name:      contact?.profile?.name || 'Unknown',
      text:      text.trim(),
      type:      msg.type
    };
  } catch { return null; }
}

// Send a document (PDF/file) from a public URL
async function sendDocument(to, fileUrl, filename, caption) {
  try {
    await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp', to, type: 'document',
      document: { link: fileUrl, filename: filename || 'document.pdf', caption: caption || '' }
    }, { headers: HEADER() });
    console.log(`📎 Document sent to ${to}: ${filename}`);
  } catch (err) {
    console.error(`❌ Document send failed to ${to}:`, err.response?.data || err.message);
    throw err;
  }
}

// ── TEMPLATE MESSAGE (for first-contact / new numbers) ──────────
// Use this when user has NEVER messaged you — free text won't deliver.
// templateName: approved template name (e.g. "dreamhome_intro")
// languageCode: "en" or "en_US" or "hi"
// params: array of strings for {{1}}, {{2}} etc. in the template body
async function sendTemplate(to, templateName, languageCode = 'en', params = []) {
  const components = [];
  if (params.length > 0) {
    components.push({
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p) }))
    });
  }
  try {
    const res = await axios.post(`${API}/${PHONE()}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {})
      }
    }, { headers: HEADER() });
    console.log(`📨 Template "${templateName}" sent to ${to}`);
    return res.data;
  } catch (err) {
    console.error(`❌ Template send failed to ${to}:`, err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendText, sendDocument, sendButtons, markRead, markReadWithTyping, alertSales, parseMessage, sendTemplate };
