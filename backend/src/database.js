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

async function upsertLead({ phone, name, score, label, intent }) {
  const d   = getDB();
  const now = new Date().toISOString();
  const { data: ex } = await d.from('leads').select('id,message_count').eq('phone', phone).single();

  if (ex) {
    const { data, error } = await d.from('leads')
      .update({ name: name || undefined, score, label, intent, message_count: (ex.message_count||0)+1, last_message: now, updated_at: now })
      .eq('phone', phone).select().single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await d.from('leads')
      .insert({ phone, name: name||'Unknown', score, label, intent, message_count: 1, last_message: now, created_at: now, updated_at: now })
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

async function getHistory(phone, limit = 10) {
  const { data, error } = await getDB().from('conversations')
    .select('role,message').eq('phone', phone).order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return (data||[]).map(r => ({ role: r.role, content: r.message }));
}

async function getConversations(phone) {
  const { data, error } = await getDB().from('conversations')
    .select('*').eq('phone', phone).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = { upsertLead, getAllLeads, getLeadByPhone, getStats, saveMessage, getHistory, getConversations };
