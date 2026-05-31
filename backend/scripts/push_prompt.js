#!/usr/bin/env node
// ================================================================
//  scripts/push_prompt.js — One-command prompt deployment
// ----------------------------------------------------------------
//  Usage:
//    node backend/scripts/push_prompt.js "C:/path/to/prompt.txt"
//    node backend/scripts/push_prompt.js                    (defaults to
//                                                            ../waprompt v2.7.txt)
//
//  Reads the given .txt/.md file, then upserts it into the Supabase
//  app_settings row that the running backend hydrates on boot. The
//  next AI call uses the new prompt — no redeploy needed (assuming
//  Fly.io / your host re-hydrates settings.json from Supabase on
//  every boot, which it does in this repo).
//
//  ALSO writes a local backend/settings.json so the currently-running
//  local backend picks it up immediately without a restart, since
//  ai.js reads settings.json synchronously per request.
//
//  Note: This is the ONLY blessed way to deploy a new prompt outside
//  the dashboard. Keep the prompt in a versioned text file and run
//  this script after every edit — it becomes your "git push" for the
//  prompt.
// ================================================================
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'waprompt v2.7.txt');
const SETTINGS_FILE       = path.resolve(__dirname, '..', '..', 'settings.json');

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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ SUPABASE_URL / SUPABASE_ANON_KEY missing from backend/.env');
    process.exit(1);
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Fetch the current row so we preserve every other setting.
  const existing = await db.from('app_settings').select('data').eq('id', 1).single();
  if (existing.error && existing.error.code !== 'PGRST116') {
    console.error('❌ Failed to read app_settings:', existing.error.message);
    process.exit(1);
  }
  const current = (existing.data && existing.data.data) || {};
  const oldLen  = (current.system_prompt || '').length;
  const merged  = { ...current, system_prompt: promptText };

  const up = await db.from('app_settings').upsert({
    id: 1,
    data: merged,
    updated_at: new Date().toISOString()
  });
  if (up.error) {
    console.error('❌ Supabase upsert failed:', up.error.message);
    process.exit(1);
  }
  console.log(`✅ app_settings.system_prompt updated: ${oldLen.toLocaleString()} → ${promptText.length.toLocaleString()} chars`);

  // Update local settings.json so a running local backend picks it
  // up on the next request (it reads the file synchronously). Fly.io
  // / containerised backends will pick it up on their next boot via
  // db.hydrateSettingsFromDB().
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    console.log(`✅ Local settings.json cache updated: ${SETTINGS_FILE}`);
  } catch (e) {
    console.warn(`⚠️ Could not write local settings.json (${e.message}) — Supabase is still the source of truth.`);
  }

  console.log('\n🎉 Prompt deployed. Test by sending a message to the bot.');
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
