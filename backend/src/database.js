// ================================================================
//  src/database.js — Supabase Free Database
// ================================================================
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

let db = null;
const getDB = () => {
  if (!db) {
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      realtime: { transport: WebSocket }
    });
  }
  return db;
};

// ── LEADS ────────────────────────────────────────────────────────

async function upsertLead({ phone, name, score, label, intent, budget_range, location_preference, timeline, purpose, site_visit_offered, campaign }) {
  const d   = getDB();
  const now = new Date().toISOString();
  const { data: ex } = await d.from('leads').select('id,message_count,campaign').eq('phone', phone).single();

  const extras = {};
  if (budget_range)        extras.budget_range        = budget_range;
  if (location_preference) extras.location_preference = location_preference;
  if (timeline)            extras.timeline            = timeline;
  if (purpose)             extras.purpose             = purpose;
  if (site_visit_offered)  extras.site_visit_offered  = true;
  // Only set campaign on new leads or if not already set (first-touch attribution)
  if (campaign && (!ex || !ex.campaign)) extras.campaign = campaign;

  if (ex) {
    const { data, error } = await d.from('leads')
      .update({ name: name || undefined, score, label, intent, ...extras, message_count: (ex.message_count||0)+1, last_message: now, updated_at: now })
      .eq('phone', phone).select().single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await d.from('leads')
      .insert({ phone, name: name||'Unknown', score, label, intent, ...extras, message_count: 1, last_message: now, created_at: now, updated_at: now })
      .select().single();
    if (error) throw error;
    return data;
  }
}

async function getAllLeads(limit = 5000) {
  const { data, error } = await getDB().from('leads').select('*').order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

async function getLeadByPhone(phone) {
  const { data, error } = await getDB().from('leads').select('*').eq('phone', phone).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function getAllCampaigns() {
  const { data, error } = await getDB().from('leads').select('campaign').not('campaign', 'is', null).neq('campaign', '');
  if (error) return [];
  const unique = [...new Set((data || []).map(r => r.campaign).filter(Boolean))].sort();
  return unique;
}

async function getStats() {
  const { data, error } = await getDB().from('leads').select('label');
  if (error) throw error;
  const leads = data || [];
  return {
    total: leads.length,
    hot:   leads.filter(l => l.label === 'HOT').length,
    warm:  leads.filter(l => l.label === 'WARM').length,
    cold:  leads.filter(l => l.label === 'COLD').length
  };
}

// ── CONVERSATIONS ─────────────────────────────────────────────────

async function saveMessage({ phone, role, message, score, input_tokens, output_tokens }) {
  const row = { phone, role, message, score: score||null, created_at: new Date().toISOString() };
  if (input_tokens)  row.input_tokens  = input_tokens;
  if (output_tokens) row.output_tokens = output_tokens;
  const { data, error } = await getDB().from('conversations').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function getCostStats() {
  const { data, error } = await getDB()
    .from('conversations')
    .select('phone, role, input_tokens, output_tokens, created_at');
  if (error) throw error;
  const rows = (data || []).filter(r => r.input_tokens || r.output_tokens);

  const INPUT_PER_TOKEN  = 0.15 / 1_000_000; // USD — Gemini 2.5 Flash
  const OUTPUT_PER_TOKEN = 0.60 / 1_000_000; // USD — Gemini 2.5 Flash
  const USD_TO_INR = 84;

  const byPhone = {};
  let totalInput = 0, totalOutput = 0;

  for (const r of rows) {
    const inp = r.input_tokens  || 0;
    const out = r.output_tokens || 0;
    totalInput  += inp;
    totalOutput += out;
    if (!byPhone[r.phone]) byPhone[r.phone] = { phone: r.phone, input_tokens: 0, output_tokens: 0, messages: 0 };
    byPhone[r.phone].input_tokens  += inp;
    byPhone[r.phone].output_tokens += out;
    byPhone[r.phone].messages++;
  }

  const calcCost = (inp, out) => ({
    usd: parseFloat((inp * INPUT_PER_TOKEN + out * OUTPUT_PER_TOKEN).toFixed(6)),
    inr: parseFloat(((inp * INPUT_PER_TOKEN + out * OUTPUT_PER_TOKEN) * USD_TO_INR).toFixed(4))
  });

  const perLead = Object.values(byPhone).map(l => ({
    ...l,
    cost: calcCost(l.input_tokens, l.output_tokens)
  })).sort((a, b) => b.cost.usd - a.cost.usd);

  const total = calcCost(totalInput, totalOutput);
  const avgPerConversation = perLead.length
    ? calcCost(totalInput / perLead.length, totalOutput / perLead.length)
    : { usd: 0, inr: 0 };

  return { total, avgPerConversation, perLead, totalConversations: perLead.length };
}

// Returns true if this phone has sent us an inbound message within
// Meta's free-form delivery window (24 hours). Used by /api/send to
// decide whether free-form text is allowed or we must use a template.
//
// Meta silently drops free-form sends to phones outside the 24h
// window (HTTP 200 from the API, but no delivery), so this check is
// the line between "delivered" and "lost".
async function hasRecentInboundFromPhone(phone, windowHours = 24) {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { count, error } = await getDB().from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .eq('role', 'user')
    .gte('created_at', cutoff);
  if (error) {
    // On error, assume "outside window" — safer to send a template
    // (always delivers) than free-form (might silently drop).
    console.warn(`hasRecentInboundFromPhone(${phone}) failed: ${error.message}`);
    return false;
  }
  return (count || 0) > 0;
}

// Kept as a thin alias for callers that only care "has ever messaged".
// Currently unused after the 24h-window switch; safe to remove later.
async function hasInboundFromPhone(phone) {
  return hasRecentInboundFromPhone(phone, 24 * 365); // ~1 year
}

async function getHistory(phone, limit = 20) {
  const { data, error } = await getDB().from('conversations')
    .select('role,message').eq('phone', phone)
    .order('created_at', { ascending: false }) // newest first
    .limit(limit);
  if (error) throw error;
  // reverse so AI receives messages in chronological order
  return (data||[]).reverse().map(r => ({ role: r.role, content: r.message }));
}

async function getConversations(phone) {
  const { data, error } = await getDB().from('conversations')
    .select('*').eq('phone', phone).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── KNOWLEDGE BASE ────────────────────────────────────────────────

async function getKnowledgeBase() {
  const { data, error } = await getDB().from('knowledge_base')
    .select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function addKnowledge({ name, content, file_type, size_chars, file_url, project_group }) {
  const row = { name, content, file_type, size_chars, created_at: new Date().toISOString() };
  if (file_url)      row.file_url      = file_url;
  if (project_group) row.project_group = project_group;
  const { data, error } = await getDB().from('knowledge_base')
    .insert(row).select().single();
  if (error) throw error;
  return data;
}

async function deleteKnowledge(id) {
  const { error } = await getDB().from('knowledge_base').delete().eq('id', id);
  if (error) throw error;
}

// Build a snapshot of every project in the knowledge base shaped for
// the v2.7 prompt's Block 0 placeholders:
//   - project_knowledge_base : per-project facts (from the .json file
//     uploaded for each project, parsed)
//   - pdf_document_database  : per-project list of { doc_type, label,
//     supabase_url } derived from PDF rows
//   - image_database         : per-project list of { image_type,
//     label, supabase_url, format } derived from image rows
//
// Multi-project bot: we emit ONE section per project, each containing
// all three blocks for that project, so the model can pick the right
// one based on which project the user is asking about.
//
// Returns: a single big string ready to drop into the system prompt.
async function getKnowledgeText() {
  try {
    const { buildMediaDatabases } = require('./mediaTypes');
    const docs = await getKnowledgeBase();
    if (!docs.length) return '';

    const byGroup = new Map();
    const ungrouped = [];
    for (const d of docs) {
      const g = (d.project_group || '').trim();
      if (g) {
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(d);
      } else {
        ungrouped.push(d);
      }
    }

    const sections = [];

    // Header — index of available projects so the model can quickly
    // see which projects we have data for.
    const projectIndex = [...byGroup.keys()].sort();
    if (projectIndex.length) {
      sections.push(
        'AVAILABLE PROJECTS (you can only discuss these — never invent):\n' +
        projectIndex.map(p => `- ${p}`).join('\n')
      );
    }

    // Per-project sections.
    for (const group of projectIndex) {
      const items = byGroup.get(group);
      const { pdf_db, image_db } = buildMediaDatabases(items, group);

      // Parse the project JSON file if present, else fall back to a
      // minimal stub so the AI knows the project exists.
      const jsonDocs = items.filter(d => d.file_type === 'json' && d.content);
      let projectKb = { project_name: group };
      for (const j of jsonDocs) {
        try { projectKb = { project_name: group, ...JSON.parse(j.content) }; break; }
        catch { /* malformed json — skip, keep stub */ }
      }

      // Text-only docs (uploaded as raw text / scanned PDFs without
      // extractable text). Treated as supplementary context.
      const textDocs = items.filter(d => d.content && d.file_type !== 'json' && !d.file_url);

      // Whitelist of types this project ACTUALLY has — stops the
      // model from inventing types ("render") when only one exists
      // ("elevation"). The model must pick from this list verbatim.
      const availableDocs   = [...new Set(pdf_db.documents.map(d => d.doc_type))];
      const availableImages = [...new Set(image_db.images.map(i => i.image_type))];

      let block = `\n━━━━━━━━━━━━━━━━━━━━\nPROJECT BLOCK: ${group}\n━━━━━━━━━━━━━━━━━━━━\n`;
      block += `available_documents = ${JSON.stringify(availableDocs)}\n`;
      block += `available_images    = ${JSON.stringify(availableImages)}\n`;
      block += `(★ For "${group}", documents_to_attach[] entries MUST be picked from available_documents only; images_to_attach[] entries MUST be picked from available_images only. If a user asks for a type not in these lists, say "yeh abhi available nahi hai — confirm karke bhejti hoon" and leave the array empty. NEVER invent a type.)\n\n`;
      block += `project_knowledge_base = ${JSON.stringify(projectKb, null, 2)}\n\n`;
      block += `pdf_document_database = ${JSON.stringify(pdf_db, null, 2)}\n\n`;
      block += `image_database = ${JSON.stringify(image_db, null, 2)}\n`;
      if (textDocs.length) {
        block += `\nSUPPLEMENTARY NOTES:\n` +
          textDocs.map(d => `### ${d.name}\n${d.content}`).join('\n\n');
      }
      sections.push(block);
    }

    // Ungrouped legacy rows — keep at the end as plain context. Bot
    // can read them but they don't participate in media dispatch.
    if (ungrouped.length) {
      const ugText = ungrouped.filter(d => d.content);
      if (ugText.length) {
        sections.push(
          'UNGROUPED NOTES:\n' +
          ugText.map(d => `### ${d.name}\n${d.content}`).join('\n\n---\n\n')
        );
      }
    }

    return sections.join('\n\n---\n\n');
  } catch (e) {
    console.warn('⚠️ getKnowledgeText failed:', e.message);
    return '';
  }
}

// Upload file buffer to Supabase Storage
async function uploadToStorage(filename, buffer, mimetype) {
  const { data, error } = await getDB().storage
    .from('documents')
    .upload(filename, buffer, { contentType: mimetype, upsert: true });
  if (error) throw error;
  const { data: urlData } = getDB().storage.from('documents').getPublicUrl(filename);
  return urlData.publicUrl;
}

// Find leads that need a follow-up based on inactivity
async function getLeadsForFollowUp({ coldHours = 72, warmHours = 48, hotHours = 24 } = {}) {
  const now = new Date();
  const { data, error } = await getDB().from('leads')
    .select('*')
    .order('last_message', { ascending: true });
  if (error) throw error;
  return (data || []).filter(lead => {
    const lastMsg = lead.last_message ? new Date(lead.last_message) : null;
    if (!lastMsg) return false;
    const hoursAgo = (now - lastMsg) / 3600000;
    const threshold = lead.label === 'HOT' ? hotHours : lead.label === 'WARM' ? warmHours : coldHours;
    // Only follow up if enough time has passed AND not already followed up recently
    const lastFollowUp = lead.follow_up_sent_at ? new Date(lead.follow_up_sent_at) : null;
    if (lastFollowUp) {
      const followUpHoursAgo = (now - lastFollowUp) / 3600000;
      if (followUpHoursAgo < threshold) return false;
    }
    return hoursAgo >= threshold;
  });
}

async function markFollowUpSent(phone) {
  const { error } = await getDB().from('leads')
    .update({ follow_up_sent_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) throw error;
}

// ── APP SETTINGS (single-row durable config) ─────────────────────
// Backs settings.json on disk so Fly.io ephemeral containers don't
// lose template defaults on redeploy. See backend/sql/app_settings.sql.

async function getAppSettings() {
  const { data, error } = await getDB()
    .from('app_settings')
    .select('data')
    .eq('id', 1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data?.data || null;
}

async function saveAppSettings(settingsObj) {
  const { error } = await getDB()
    .from('app_settings')
    .upsert({ id: 1, data: settingsObj, updated_at: new Date().toISOString() });
  if (error) throw error;
}

module.exports = {
  getDB,
  upsertLead,
  getAllLeads,
  getLeadByPhone,
  getStats,
  getAllCampaigns,
  saveMessage,
  getHistory,
  getConversations,
  hasInboundFromPhone,
  hasRecentInboundFromPhone,
  getKnowledgeBase,
  addKnowledge,
  deleteKnowledge,
  getKnowledgeText,
  uploadToStorage,
  getLeadsForFollowUp,
  markFollowUpSent,
  getCostStats,
  getAppSettings,
  saveAppSettings
};
