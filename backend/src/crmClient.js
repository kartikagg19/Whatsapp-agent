// ================================================================
//  src/crmClient.js — PropelloCRM Integration Client
//
//  Fire-and-forget HTTPS calls to PropelloCRM's /api/whatsapp/*
//  endpoints. Failures are logged but never block the bot.
// ================================================================

const axios = require('axios');

// Config read once on module load
let config = null;

function initConfig() {
  if (config) return;

  config = {
    baseUrl: process.env.CRM_BASE_URL || '',
    secret: process.env.CRM_WEBHOOK_SECRET || '',
    timeoutMs: parseInt(process.env.CRM_TIMEOUT_MS || '10000')
  };
}

/**
 * Sync a conversation event (inbound user message or outbound AI reply) to CRM timeline.
 * This is fire-and-forget — failures are logged but never throw.
 *
 * @param {Object} payload - Event data matching CRM's /api/whatsapp/timeline contract
 *   Required: phone, direction, message
 *   Optional: call_id, occurred_at, ai_score, intent, qualified, summary, profile_patch, escalate
 *
 * Contract: CRM is idempotent on (phone, call_id, direction)
 */
async function syncTimeline(payload) {
  initConfig();

  if (!config.baseUrl || !config.secret) {
    // CRM integration not configured — silently return. Bot continues normally.
    return;
  }

  try {
    const url = `${config.baseUrl}/api/whatsapp/timeline`;
    const headers = { 'X-Webhook-Secret': config.secret, 'Content-Type': 'application/json' };

    await axios.post(url, payload, {
      headers,
      timeout: config.timeoutMs
    });

    console.log(`[CRM] ✓ Timeline sync: ${payload.direction} | ${payload.phone} | call_id=${payload.call_id || 'N/A'}`);
  } catch (error) {
    // Log the failure but never throw — bot continues replying
    console.error(`[CRM timeline sync failed] ${payload.phone} | ${error.code || error.message}`);
  }
}

/**
 * Fetch lead context (profile + recent activities) from CRM before calling AI.
 * This is optional and may be deferred to v2 (§6.5 of PRD).
 * Used to inject CRM data into the system prompt for better AI quality.
 *
 * @param {string} phone - Buyer's phone number
 * @param {string} callId - (optional) Unique call/message ID for idempotency
 *
 * @returns {Object|null} CRM's view of the lead, or null if not found / request failed
 */
async function fetchContext(phone, callId) {
  initConfig();

  if (!config.baseUrl || !config.secret) {
    return null;
  }

  try {
    const url = new URL(`${config.baseUrl}/api/whatsapp/context`);
    url.searchParams.set('phone', phone);
    if (callId) url.searchParams.set('call_id', callId);

    const headers = { 'X-Webhook-Secret': config.secret };

    const response = await axios.get(url.toString(), {
      headers,
      timeout: config.timeoutMs
    });

    if (response.data?.found === false) {
      console.log(`[CRM] Lead not found in CRM: ${phone}`);
      return null;
    }

    console.log(`[CRM] ✓ Context fetched: ${phone}`);
    return response.data || null;
  } catch (error) {
    // Log the failure — bot continues without CRM context
    console.warn(`[CRM context fetch failed] ${phone} | ${error.code || error.message}`);
    return null;
  }
}

module.exports = { syncTimeline, fetchContext };
