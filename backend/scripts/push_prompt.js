#!/usr/bin/env node
// ================================================================
//  scripts/push_prompt.js — One-command prompt deployment
// ----------------------------------------------------------------
//  Usage:
//    node backend/scripts/push_prompt.js "C:/path/to/prompt.txt"
//    node backend/scripts/push_prompt.js          (defaults file path)
//
//  Two deployment paths, tried in order:
//
//  1. HTTP via the live backend (preferred). Set BACKEND_URL +
//     ADMIN_PASSWORD in backend/.env to use this path. The backend
//     hits Supabase from its own network, which sidesteps local
//     DNS / firewall / IPv6 issues that block direct connections.
//
//  2. Direct Supabase upsert (fallback). Requires SUPABASE_URL +
//     SUPABASE_ANON_KEY in backend/.env AND that your local machine
//     can actually reach jschkhmldxrsdxxwtqwz.supabase.co. If you've
//     seen "TypeError: fetch failed" before, path 1 is the answer.
//
//  After either path succeeds, the script also writes a local
//  backend/../settings.json so a *local* dev backend picks the new
//  prompt up immediately (production reads from Supabase on boot).
// ================================================================
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'waprompt v2.7.txt');
const SETTINGS_FILE       = path.resolve(__dirname, '..', '..', 'settings.json');

function getAdminToken() {
  const pass = process.env.ADMIN_PASSWORD || 'propello2025';
  return Buffer.from(`propello-dashboard:${pass}`).toString('base64');
}

async function pushViaHttp(promptText) {
  const base = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (!base) return { tried: false };
  const url = `${base}/api/system-prompt`;
  console.log(`🌐 Pushing via backend: ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify({ prompt: promptText }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(`HTTP ${res.status}: ${json.error || JSON.stringify(json)}`);
  }
  console.log(`✅ Pushed via backend: ${json.old_length} → ${json.new_length} chars (persisted_to_db=${json.persisted_to_db})`);
  if (json.warning) console.warn(`⚠️  Backend warning: ${json.warning}`);
  return { tried: true, ok: true };
}

async function pushViaSupabase(promptText) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY missing from backend/.env');
  }
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const existing = await db.from('app_settings').select('data').eq('id', 1).single();
  if (existing.error && existing.error.code !== 'PGRST116') {
    throw new Error(`read app_settings: ${existing.error.message}`);
  }
  const current = (existing.data && existing.data.data) || {};
  const oldLen  = (current.system_prompt || '').length;
  const merged  = { ...current, system_prompt: promptText };

  const up = await db.from('app_settings').upsert({
    id: 1,
    data: merged,
    updated_at: new Date().toISOString()
  });
  if (up.error) throw new Error(`upsert: ${up.error.message}`);
  console.log(`✅ Pushed via Supabase: ${oldLen} → ${promptText.length} chars`);
  return merged;
}

async function main() {
  const argPath   = process.argv[2];
  const promptPath = argPath ? path.resolve(argPath) : DEFAULT_PROMPT_PATH;

  if (!fs.existsSync(promptPath)) {
    console.error(`❌ Prompt file not found: ${promptPath}`);
    process.exit(1);
  }
  const promptText = fs.readFileSync(promptPath, 'utf8');
  if (!promptText.trim()) {
    console.error(`❌ Prompt file is empty: ${promptPath}`);
    process.exit(1);
  }
  console.log(`📄 Loaded prompt: ${promptPath} (${promptText.length.toLocaleString()} chars)`);

  // Try HTTP path first if BACKEND_URL is set.
  let merged = null;
  try {
    const r = await pushViaHttp(promptText);
    if (r.tried) {
      // HTTP path already wrote both Supabase and the backend's local
      // settings.json. We still write our own local cache below for
      // local-dev convenience.
      merged = { system_prompt: promptText };
    } else {
      console.log('ℹ️  BACKEND_URL not set in backend/.env — falling back to direct Supabase');
      merged = await pushViaSupabase(promptText);
    }
  } catch (e) {
    console.warn(`⚠️  HTTP push failed: ${e.message}`);
    console.log('   Falling back to direct Supabase upsert...');
    try { merged = await pushViaSupabase(promptText); }
    catch (e2) {
      console.error(`❌ Direct Supabase also failed: ${e2.message}`);
      console.error('\n💡 Set BACKEND_URL=https://<your-fly-app>.fly.dev in backend/.env');
      console.error('   so this script can push through the running backend instead.');
      process.exit(1);
    }
  }

  // Update local settings.json (operator-side cache for dev backends).
  try {
    const existingLocal = fs.existsSync(SETTINGS_FILE)
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
    const localMerged = { ...existingLocal, ...merged, system_prompt: promptText };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(localMerged, null, 2));
    console.log(`✅ Local settings.json cache updated: ${SETTINGS_FILE}`);
  } catch (e) {
    console.warn(`⚠️ Could not write local settings.json (${e.message}) — Supabase is still the source of truth.`);
  }

  console.log('\n🎉 Prompt deployed. Test by sending a message to the bot.');
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
