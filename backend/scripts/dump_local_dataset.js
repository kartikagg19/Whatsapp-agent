#!/usr/bin/env node
// Walks a local dataset folder (each subfolder = one project_group)
// and prints the same coverage matrix dump_kb.js prints from Supabase.
// Useful when the live Supabase mirror is identical to the dataset.
//
// Usage:
//   node backend/scripts/dump_local_dataset.js "<path to dataset root>"
const fs   = require('fs');
const path = require('path');
const { inferRowType, PDF_DOC_TYPES, IMAGE_TYPES } = require('../src/mediaTypes');

const root = process.argv[2];
if (!root) { console.error('usage: node dump_local_dataset.js <dataset root>'); process.exit(1); }
if (!fs.existsSync(root)) { console.error(`not found: ${root}`); process.exit(1); }

const groups = new Map();
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const project = entry.name;
  const dir = path.join(root, entry.name);
  const rows = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    const name = f.name;
    const lname = name.toLowerCase();
    let file_type = 'text';
    if (lname.endsWith('.pdf')) file_type = 'pdf';
    else if (/\.(jpe?g|png|gif|webp|bmp)$/i.test(lname)) file_type = 'image';
    else if (lname.endsWith('.json')) file_type = 'json';
    rows.push({
      name,
      file_type,
      project_group: project,
      // Treat every file as if it has a file_url (i.e. uploaded to Supabase).
      file_url: file_type === 'json' ? null : `local://${project}/${name}`,
    });
  }
  groups.set(project, rows);
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
    const mark = r.file_url ? '✅' : '❌';
    console.log(`  ${mark}  [${(r.file_type||'').padEnd(6)}] ${tag.padEnd(28)} | ${r.name}`);
    if (r.file_url && t) seenTypes.add(`${t.kind}:${t.type}`);
    if (r.file_url) totalUrls++;
  }
  typesAvailableByProject.set(g, seenTypes);
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━`);
console.log(`TOTAL files: ${[...groups.values()].reduce((a,b)=>a+b.length,0)}   sendable: ${totalUrls}`);
console.log(`━━━━━━━━━━━━━━━━━━━━\n`);
console.log('COVERAGE — what each project can actually send:\n');
const allTypes = [
  ...PDF_DOC_TYPES.map(t => `pdf:${t}`),
  ...IMAGE_TYPES.map(t   => `image:${t}`)
];
for (const g of [...typesAvailableByProject.keys()].sort()) {
  const has = typesAvailableByProject.get(g);
  const missing = allTypes.filter(t => !has.has(t));
  console.log(`  ${g}`);
  console.log(`    HAS:     ${[...has].sort().join(', ') || '(nothing)'}`);
  console.log(`    MISSING: ${missing.join(', ') || '(none)'}`);
}
