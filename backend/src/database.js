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

async function upsertLead({ phone, name, score, label, intent, budget_range, location_preference, timeline, purpose }) {
  const d   = getDB();
  const now = new Date().toISOString();
  const { data: ex } = await d.from('leads').select('id,message_count').eq('phone', phone).single();

  const extras = {};
  if (budget_range)        extras.budget_range        = budget_range;
  if (location_preference) extras.location_preference = location_preference;
  if (timeline)            extras.timeline            = timeline;
  if (purpose)             extras.purpose             = purpose;

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

async function saveMessage({ phone, role, message, score }) {
  const { data, error } = await getDB().from('conversations')
    .insert({ phone, role, message, score: score||null, created_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
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

async function addKnowledge({ name, content, file_type, size_chars, file_url }) {
  const row = { name, content, file_type, size_chars, created_at: new Date().toISOString() };
  if (file_url) row.file_url = file_url;
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
    const textDocs = docs.filter(d => d.content);
    const fileDocs = docs.filter(d => d.file_url);
    let result = textDocs.map(d => `### ${d.name}\n${d.content}`).join('\n\n---\n\n');
    if (fileDocs.length) {
      result += '\n\n---\nFILES YOU CAN SEND (set send_document to the file_url when user asks for brochure/unit plan):\n' +
        fileDocs.map(d => `- ${d.name}: ${d.file_url}`).join('\n');
    }
    return result;
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

module.exports = { upsertLead, getAllLeads, getLeadByPhone, getStats, saveMessage, getHistory, getConversations, getKnowledgeBase, addKnowledge, deleteKnowledge, getKnowledgeText, uploadToStorage, getLeadsForFollowUp, markFollowUpSent };
