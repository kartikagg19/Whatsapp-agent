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

async function upsertLead({ phone, name, score, label, intent, budget_range, location_preference, timeline, purpose, site_visit_offered }) {
  const d   = getDB();
  const now = new Date().toISOString();
  const { data: ex } = await d.from('leads').select('id,message_count').eq('phone', phone).single();

  const extras = {};
  if (budget_range)        extras.budget_range        = budget_range;
  if (location_preference) extras.location_preference = location_preference;
  if (timeline)            extras.timeline            = timeline;
  if (purpose)             extras.purpose             = purpose;
  if (site_visit_offered)  extras.site_visit_offered  = true;

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

async function getAllLeads(limit = 200) {
  const { data, error } = await getDB().from('leads').select('*').order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

async function getLeadByPhone(phone) {
  const { data, error } = await getDB().from('leads').select('*').eq('phone', phone).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
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

// Returns true if this phone has EVER sent us an inbound message
// (role='user'). Used to decide if a free-form WhatsApp send is allowed
// per Meta's 24h rule — if false, we must use a template instead.
async function hasInboundFromPhone(phone) {
  const { count, error } = await getDB().from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .eq('role', 'user');
  if (error) {
    // On error, assume "unknown" → caller should treat as new (safer:
    // sending a template to an existing contact wastes a template send
    // but always delivers, whereas sending free-form to a new number
    // silently drops).
    console.warn(`hasInboundFromPhone(${phone}) failed: ${error.message}`);
    return false;
  }
  return (count || 0) > 0;
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

async function getKnowledgeText() {
  try {
    const docs = await getKnowledgeBase();
    if (!docs.length) return '';

    // Split into grouped (by project) and ungrouped
    const byGroup = {};
    const ungrouped = [];
    for (const doc of docs) {
      if (doc.project_group) {
        if (!byGroup[doc.project_group]) byGroup[doc.project_group] = [];
        byGroup[doc.project_group].push(doc);
      } else {
        ungrouped.push(doc);
      }
    }

    const sections = [];

    // Ungrouped text docs (original behavior)
    const ugText  = ungrouped.filter(d => d.content);
    const ugFiles = ungrouped.filter(d => d.file_url);
    if (ugText.length)  sections.push(ugText.map(d => `### ${d.name}\n${d.content}`).join('\n\n---\n\n'));
    if (ugFiles.length) sections.push(
      'FILES YOU CAN SEND (set send_document to the file_url when user asks for brochure/unit plan):\n' +
      ugFiles.map(d => `- ${d.name}: ${d.file_url}`).join('\n')
    );

    // Grouped projects — each project gets its own section
    for (const [group, items] of Object.entries(byGroup)) {
      let block = `## PROJECT: ${group}\n`;
      const jsonDocs = items.filter(d => d.file_type === 'json' && d.content);
      const textDocs = items.filter(d => d.file_type !== 'json' && d.content && !d.file_url);
      const fileDocs = items.filter(d => d.file_url);

      // FILES section goes FIRST so AI always sees it
      if (fileDocs.length) {
        block += `SENDABLE FILES FOR "${group}" (IMPORTANT — when user asks for brochure, plan, PDF, document, or any file about this project → pick the closest match below and set send_document to its URL):\n`;
        block += fileDocs.map(d => `  send_document URL for "${d.name}": ${d.file_url}`).join('\n') + '\n\n';
      }
      if (jsonDocs.length) block += jsonDocs.map(d => `### ${d.name}\n${d.content}`).join('\n\n') + '\n';
      if (textDocs.length) block += textDocs.map(d => `### ${d.name}\n${d.content}`).join('\n\n') + '\n';
      sections.push(block);
    }

    return sections.join('\n\n---\n\n');
  } catch { return ''; }
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

module.exports = { upsertLead, getAllLeads, getLeadByPhone, getStats, saveMessage, getHistory, getConversations, hasInboundFromPhone, getKnowledgeBase, addKnowledge, deleteKnowledge, getKnowledgeText, uploadToStorage, getLeadsForFollowUp, markFollowUpSent, getCostStats, getAppSettings, saveAppSettings };
