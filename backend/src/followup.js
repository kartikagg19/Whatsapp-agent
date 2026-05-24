// ================================================================
//  src/followup.js — Automated Follow-Up Scheduler
// ================================================================
const fs   = require('fs');
const path = require('path');
const db   = require('./database');
const { sendText } = require('./whatsapp');

const SETTINGS_FILE = path.join(__dirname, '../../settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

const FOLLOWUP_MESSAGES = {
  HOT: [
    "Ji namaste! Site visit ke baare mein baat karni thi — aapka schedule kab suit karta hai? 😊",
    "Haan ji! Krishna Aura mein ek acha unit available hai aapke budget mein. Ek baar personally dekhenge kya?",
    "Ji, bas ek quick call leni thi — aapki property requirement confirm karni thi. Convenient time batayein? 🙏"
  ],
  WARM: [
    "Haan ji, kaafi time ho gaya! Property explore karna continue hai ya kuch change hua plan mein?",
    "Ji namaste! Krishna Aura mein naye offers aa gaye hain — aapko update karna tha. 😊",
    "Waise ji, possession timeline ke baare mein kuch details share karni thi. Aap available hain kya?"
  ],
  COLD: [
    "Ji namaste! Pehle property ke baare mein enquiry ki thi — abhi bhi explore kar rahe hain kya?",
    "Haan ji! Krishna Aura, Kharghar mein kuch interesting units available hain. Details chahiye kya?",
    "Ji, bas check karna tha — real estate planning abhi bhi on your mind hai? 😊"
  ]
};

function pickMessage(label) {
  const msgs = FOLLOWUP_MESSAGES[label] || FOLLOWUP_MESSAGES.COLD;
  return msgs[Math.floor(Math.random() * msgs.length)];
}

async function runFollowUps() {
  const s = getSettings();
  if (!s.followup_enabled) return;

  const hotHours  = parseInt(s.followup_hot_hours)  || 24;
  const warmHours = parseInt(s.followup_warm_hours) || 48;
  const coldHours = parseInt(s.followup_cold_hours) || 72;

  let leads = [];
  try {
    leads = await db.getLeadsForFollowUp({ coldHours, warmHours, hotHours });
  } catch (err) {
    console.error('⚠️  Follow-up fetch failed:', err.message);
    return;
  }

  if (leads.length) console.log(`📬 Follow-up: ${leads.length} lead(s) to contact`);

  for (const lead of leads) {
    try {
      const message = pickMessage(lead.label);
      await sendText(lead.phone, message);
      await db.saveMessage({ phone: lead.phone, role: 'assistant', message: `[FOLLOWUP] ${message}` });
      await db.markFollowUpSent(lead.phone);
      console.log(`✅ Follow-up sent to ${lead.name || lead.phone} (${lead.label})`);
      await new Promise(r => setTimeout(r, 500)); // rate limit between sends
    } catch (err) {
      console.warn(`⚠️  Follow-up failed for ${lead.phone}:`, err.message);
    }
  }
}

function startFollowUpScheduler() {
  const s = getSettings();
  const intervalHours = parseInt(s.followup_check_hours) || 6;
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  console.log(`⏰ Follow-up scheduler started (checks every ${intervalHours}h)`);
  // Run once on startup (after 1 min delay to let server settle), then on interval
  setTimeout(runFollowUps, 60 * 1000);
  setInterval(runFollowUps, intervalMs);
}

module.exports = { startFollowUpScheduler, runFollowUps };
