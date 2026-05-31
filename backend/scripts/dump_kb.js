#!/usr/bin/env node
// ================================================================
//  scripts/dump_kb.js — Inspect Supabase knowledge_base contents
// ----------------------------------------------------------------
//  Usage:
//    node backend/scripts/dump_kb.js
//
//  Prints every row in the knowledge_base table grouped by project,
//  with the doc_type / image_type that mediaTypes.inferRowType()
//  resolves it to. This is the single source of truth for what the
//  bot can actually send.
//
//  Use this to confirm:
//    1. Every project has the file types you expect (brochure,
//       elevation, etc.)
//    2. No row is missing file_url (rows without a URL can't be sent)
//    3. The inferred type for each filename matches what the prompt
//       will request — e.g. "Krishna Vista - Building Render.jpeg"
//       should map to image:elevation (because the regex catches
//       "elevation / building render" before falling through to
//       generic render).
//
//  If something's off, either rename the file in Supabase storage
//  or extend the regexes in backend/src/mediaTypes.js.
// ================================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { inferRowType, PDF_DOC_TYPES, IMAGE_TYPES } = require('../src/mediaTypes');

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('❌ SUPABASE_URL / SUPABASE_ANON_KEY missing from backend/.env');
    process.exit(1);
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const { data, error } = await db
    .from('knowledge_base')
    .select('id,name,file_type,project_group,file_url,size_chars')
    .order('project_group', { ascending: true });
  if (error) { console.error('❌', error.message); process.exit(1); }

  const groups = new Map();
  for (const r of (data || [])) {
    const g = (r.project_group || '(ungrouped)').trim() || '(ungrouped)';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  let totalUrls = 0;
  const typesAvailableByProject = new Map();

  for (const g of [...groups.keys()].sort()) {
    const rows = groups.get(g);
    console.log(`\n━━━ ${g} (${rows.length} rows) ━━━`);
    const seenTypes = new Set();
    for (const r of rows) {
      const t = inferRowType(r);
      const tag = t ? `${t.kind}:${t.type}` : '(no-url or unknown)';
      const urlMark = r.file_url ? '✅' : '❌';
      console.log(`  ${urlMark}  [${(r.file_type||'').padEnd(6)}] ${tag.padEnd(28)} | ${r.name}`);
      if (r.file_url) {
        totalUrls++;
        if (t) seenTypes.add(`${t.kind}:${t.type}`);
      }
    }
    typesAvailableByProject.set(g, seenTypes);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
  console.log(`TOTAL rows: ${data.length}   with file_url: ${totalUrls}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━\n`);

  // Per-project coverage matrix: which doc/image types each project has.
  console.log('COVERAGE — what each project can actually send:\n');
  const allTypes = [
    ...PDF_DOC_TYPES.map(t => `pdf:${t}`),
    ...IMAGE_TYPES.map(t   => `image:${t}`)
  ];
  const projectNames = [...typesAvailableByProject.keys()].filter(g => g !== '(ungrouped)').sort();
  for (const g of projectNames) {
    const has = typesAvailableByProject.get(g);
    const missing = allTypes.filter(t => !has.has(t));
    console.log(`  ${g}`);
    console.log(`    HAS:     ${[...has].sort().join(', ') || '(nothing)'}`);
    console.log(`    MISSING: ${missing.join(', ') || '(none)'}`);
  }
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
