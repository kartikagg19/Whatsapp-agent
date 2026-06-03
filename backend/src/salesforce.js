// ================================================================
//  src/salesforce.js — Salesforce REST API Integration
//
//  Two directions:
//    1. WhatsApp → SF  : upsertLead() + logTask() called after every
//       inbound/outbound message to keep SF Leads + Activities in sync.
//    2. SF → WhatsApp  : routes/salesforce.js handles the inbound
//       webhook from Salesforce Flow / Process Builder.
//
//  Auth: username-password OAuth2 flow (no browser redirect needed).
//  Token is cached in-process and auto-refreshed on 401.
// ================================================================

const axios = require('axios');

let tokenCache = null;

// ── Auth ────────────────────────────────────────────────────────

async function authenticate() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache;
  }

  const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const params = new URLSearchParams({
    grant_type:    'password',
    client_id:     process.env.SF_CONSUMER_KEY     || '',
    client_secret: process.env.SF_CONSUMER_SECRET  || '',
    username:      process.env.SF_USERNAME          || '',
    password:      (process.env.SF_PASSWORD || '') + (process.env.SF_SECURITY_TOKEN || '')
  });

  const res = await axios.post(
    `${loginUrl}/services/oauth2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  tokenCache = {
    accessToken: res.data.access_token,
    instanceUrl: res.data.instance_url,
    expiresAt:   Date.now() + 2 * 60 * 60 * 1000  // 2-hour safety window
  };

  console.log(`[SF] ✅ Authenticated → ${tokenCache.instanceUrl}`);
  return tokenCache;
}

// ── Generic API call with one auto-retry on token expiry ────────

async function apiCall(method, path, data = null) {
  let auth;
  try {
    auth = await authenticate();
  } catch (e) {
    throw new Error(`[SF] Auth failed: ${e.response?.data?.error_description || e.message}`);
  }

  const makeRequest = (token, baseUrl) =>
    axios({
      method,
      url:     `${baseUrl}/services/data/v57.0${path}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data
    });

  try {
    const res = await makeRequest(auth.accessToken, auth.instanceUrl);
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      tokenCache = null;
      auth = await authenticate();
      const res2 = await makeRequest(auth.accessToken, auth.instanceUrl);
      return res2.data;
    }
    throw err;
  }
}

// ── SOQL helper ─────────────────────────────────────────────────

async function query(soql) {
  const res = await apiCall('GET', `/query?q=${encodeURIComponent(soql)}`);
  return res.records || [];
}

// ── Find lead by phone ──────────────────────────────────────────

async function findLeadByPhone(phone) {
  const soql = `SELECT Id, FirstName, LastName, Phone, Rating, Status
                FROM Lead
                WHERE Phone = '${phone}' OR MobilePhone = '${phone}'
                LIMIT 1`;
  const rows = await query(soql);
  return rows[0] || null;
}

// ── Upsert Lead ─────────────────────────────────────────────────
//
// Maps our internal label (HOT/WARM/COLD) → SF Rating (Hot/Warm/Cold)
// and syncs score + intent to the Description field.
// Creates the Lead if not found; updates it if found.
//
// Returns the Salesforce Lead Id, or null on failure.

async function upsertLead({ phone, name, score, label, intent, site_visit }) {
  if (!isSalesforceConfigured()) return null;

  const nameParts  = (name || 'Unknown').trim().split(/\s+/);
  const lastName   = nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0];
  const firstName  = nameParts.length > 1 ? nameParts[0] : '';

  const ratingMap  = { HOT: 'Hot', WARM: 'Warm', COLD: 'Cold' };
  const statusMap  = { HOT: 'Working - Contacted', WARM: 'Working - Contacted', COLD: 'Open - Not Contacted' };
  const rating     = ratingMap[label]  || 'Cold';
  const status     = statusMap[label]  || 'Open - Not Contacted';

  const leadData = {
    LastName:    lastName   || 'Lead',
    FirstName:   firstName  || '',
    Phone:       phone,
    MobilePhone: phone,
    LeadSource:  'WhatsApp',
    Rating:      rating,
    Status:      status,
    Company:     'WhatsApp Lead',
    Description: `WhatsApp AI Score: ${score ?? '?'}/10 | Intent: ${intent || 'general'} | Site Visit: ${site_visit || 'not_discussed'}`
  };

  try {
    const existing = await findLeadByPhone(phone);
    if (existing) {
      await apiCall('PATCH', `/sobjects/Lead/${existing.Id}`, leadData);
      console.log(`[SF] ✅ Lead updated: ${phone} → ${rating}`);
      return existing.Id;
    } else {
      const res = await apiCall('POST', '/sobjects/Lead/', leadData);
      console.log(`[SF] ✅ Lead created: ${phone} → id=${res.id}`);
      return res.id;
    }
  } catch (err) {
    const detail = JSON.stringify(err.response?.data || err.message);
    console.error(`[SF] ❌ upsertLead failed for ${phone}: ${detail}`);
    return null;
  }
}

// ── Log Task (Activity) ─────────────────────────────────────────
//
// Creates a completed Task on the Lead record so every WhatsApp
// message appears in the SF activity timeline.
//
// If leadId is not provided, we look it up by phone first.

async function logTask({ phone, leadId, message, direction }) {
  if (!isSalesforceConfigured()) return;

  try {
    let sfLeadId = leadId;
    if (!sfLeadId) {
      const lead = await findLeadByPhone(phone).catch(() => null);
      sfLeadId = lead?.Id;
    }

    if (!sfLeadId) {
      console.warn(`[SF] ⚠️  logTask skipped — no Lead found for ${phone}`);
      return;
    }

    const subject = direction === 'inbound'
      ? 'WhatsApp — Customer Message'
      : 'WhatsApp — Bot Reply';

    await apiCall('POST', '/sobjects/Task/', {
      WhoId:        sfLeadId,
      Subject:      subject,
      Description:  (message || '').substring(0, 32000),
      ActivityDate: new Date().toISOString().split('T')[0],
      Status:       'Completed',
      Priority:     'Normal',
      Type:         'Other'
    });

    console.log(`[SF] ✅ Task logged (${direction}) for ${phone}`);
  } catch (err) {
    const detail = JSON.stringify(err.response?.data || err.message);
    console.error(`[SF] ❌ logTask failed for ${phone}: ${detail}`);
  }
}

// ── Config check ────────────────────────────────────────────────

function isSalesforceConfigured() {
  return !!(
    process.env.SF_CONSUMER_KEY &&
    process.env.SF_CONSUMER_SECRET &&
    process.env.SF_USERNAME &&
    process.env.SF_PASSWORD
  );
}

module.exports = { upsertLead, logTask, authenticate, isSalesforceConfigured };
