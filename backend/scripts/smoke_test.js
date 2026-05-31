#!/usr/bin/env node
// Self-contained smoke test for the v2.7 media-dispatch pipeline.
// Doesn't talk to Gemini, Supabase, or WhatsApp — just verifies the
// pure-function bits don't blow up and produce the expected shapes.
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const {
  inferRowType, buildMediaDatabases, resolveTypeToRows,
} = require('../src/mediaTypes');

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); console.log(`✅ ${name}`); passed++; } catch (e) { console.log(`❌ ${name}\n   ${e.message}`); failed++; } };
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

// ── Sample knowledge_base rows mirroring real Krishna Vista uploads ──
const krishnaVistaRows = [
  { id: 1, name: 'Krishna Vista - Building Render.jpeg',                       file_type: 'image', project_group: 'Krishna Vista', file_url: 'https://x.supabase.co/storage/v1/object/public/documents/Krishna%20Vista/Krishna%20Vista%20-%20Building%20Render.jpeg' },
  { id: 2, name: 'Krishna Vista - Cost Sheet (Plot 64 Sec 7).pdf',             file_type: 'pdf',   project_group: 'Krishna Vista', file_url: 'https://x.supabase.co/storage/v1/object/public/documents/Krishna%20Vista/cost.pdf' },
  { id: 3, name: 'Krishna Vista - Floor Plans (Plot 64 Sec 7) 25-05-2026.pdf', file_type: 'pdf',   project_group: 'Krishna Vista', file_url: 'https://x.supabase.co/storage/v1/object/public/documents/Krishna%20Vista/floor.pdf' },
  { id: 4, name: 'Krishna Vista - Payment Schedule (shared with Krishna Elite).pdf', file_type: 'pdf', project_group: 'Krishna Vista', file_url: 'https://x.supabase.co/storage/v1/object/public/documents/Krishna%20Vista/pay.pdf' },
  { id: 5, name: 'Krishna Vista - Sale Chart (Plot 64 Sec 7) 07-05-2026.pdf',  file_type: 'pdf',   project_group: 'Krishna Vista', file_url: 'https://x.supabase.co/storage/v1/object/public/documents/Krishna%20Vista/sale.pdf' },
  { id: 6, name: 'Krishna Vista - project_data.json',                          file_type: 'json',  project_group: 'Krishna Vista', file_url: null, content: '{"project_name":"Krishna Vista","status":"upcoming"}' },
];
const krishnaAuraRows = [
  { id: 10, name: 'Krishna Aura NX - Brochure.pdf', file_type: 'pdf', project_group: 'Krishna Aura NX', file_url: 'https://x.supabase.co/aura/brochure.pdf' },
];

const allRows = [...krishnaVistaRows, ...krishnaAuraRows];

// ── Type inference ──────────────────────────────────────────────────
t('Building Render.jpeg → image:elevation', () => {
  eq(inferRowType(krishnaVistaRows[0]), { kind: 'image', type: 'elevation' });
});
t('Cost Sheet PDF → pdf:price_sheet', () => {
  eq(inferRowType(krishnaVistaRows[1]), { kind: 'pdf', type: 'price_sheet' });
});
t('Floor Plans PDF → pdf:floor_plan', () => {
  eq(inferRowType(krishnaVistaRows[2]), { kind: 'pdf', type: 'floor_plan' });
});
t('Payment Schedule PDF → pdf:payment_plan', () => {
  eq(inferRowType(krishnaVistaRows[3]), { kind: 'pdf', type: 'payment_plan' });
});
t('Sale Chart PDF → pdf:price_sheet', () => {
  eq(inferRowType(krishnaVistaRows[4]), { kind: 'pdf', type: 'price_sheet' });
});
t('JSON file (no file_url) → null', () => {
  eq(inferRowType(krishnaVistaRows[5]), null);
});
t('Aura NX Brochure → pdf:brochure', () => {
  eq(inferRowType(krishnaAuraRows[0]), { kind: 'pdf', type: 'brochure' });
});

// ── Media DB build per project ──────────────────────────────────────
t('Vista DB has 1 image + 4 PDFs', () => {
  const { pdf_db, image_db } = buildMediaDatabases(krishnaVistaRows, 'Krishna Vista');
  eq(pdf_db.documents.length,  4, 'pdf count');
  eq(image_db.images.length,   1, 'image count');
  eq(pdf_db.documents.find(d => d.doc_type === 'floor_plan')?.supabase_url, krishnaVistaRows[2].file_url);
  eq(image_db.images[0].image_type, 'elevation');
});

// ── Resolution at dispatch time ─────────────────────────────────────
t('resolveTypeToRows: price_sheet for Vista → 2 rows (cost + sale chart)', () => {
  const rows = resolveTypeToRows(allRows, 'pdf', 'price_sheet', 'Krishna Vista');
  eq(rows.length, 2);
});
t('resolveTypeToRows: brochure for Vista → 0 (Vista has no brochure)', () => {
  const rows = resolveTypeToRows(allRows, 'pdf', 'brochure', 'Krishna Vista');
  eq(rows.length, 0);
});
t('resolveTypeToRows: brochure for Aura NX → 1', () => {
  const rows = resolveTypeToRows(allRows, 'pdf', 'brochure', 'Krishna Aura NX');
  eq(rows.length, 1);
});
t('resolveTypeToRows: elevation for Vista → 1', () => {
  const rows = resolveTypeToRows(allRows, 'image', 'elevation', 'Krishna Vista');
  eq(rows.length, 1);
});
t('resolveTypeToRows: WITHOUT project hint matches across projects', () => {
  const rows = resolveTypeToRows(allRows, 'pdf', 'brochure');
  eq(rows.length, 1);
});

// ── Parser (ai.js exports getAIReply only; pull parseModelOutput
//    via internal eval since it's not exported. Skip if unavailable.) ─
const fs = require('fs');
const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
const hasParser = /function parseModelOutput/.test(aiSrc);
t('ai.js exposes parseModelOutput (internal)', () => { if (!hasParser) throw new Error('not found'); });

// Build a fake v2.7-shaped response and parse it via require
// re-exporting trick: temporarily monkeypatch module.exports.
const aiPath = path.join(__dirname, '..', 'src', 'ai.js');
let testParser;
try {
  // Read+eval just the parser fn standalone — safer than requireing the
  // whole module (which would initialise Gemini client + dotenv).
  const m = aiSrc.match(/function parseModelOutput\(raw\)[\s\S]*?\n\}\n/);
  if (m) {
    testParser = new Function('raw', m[0].replace('function parseModelOutput(raw)', 'return (function(raw)') + ')(raw)');
  }
} catch {}

t('parser: v2.7 fenced output extracts both halves', () => {
  if (!testParser) throw new Error('parser not extractable');
  const raw =
`Yeh lo Krishna Vista ka cost sheet!
---LEAD_STATE---
{
  "reply_message": "Yeh lo Krishna Vista ka cost sheet!",
  "documents_to_attach": ["price_sheet"],
  "images_to_attach": [],
  "project_in_scope": "Krishna Vista",
  "lead_score": 6,
  "qualified": true
}
---END_LEAD_STATE---`;
  const out = testParser(raw);
  eq(out.reply_message, 'Yeh lo Krishna Vista ka cost sheet!');
  eq(out.documents_to_attach, ['price_sheet']);
  eq(out.project_in_scope, 'Krishna Vista');
});

t('parser: legacy JSON-only output still parses', () => {
  if (!testParser) throw new Error('parser not extractable');
  const raw = JSON.stringify({ reply_message: 'hi', lead_score: 5, send_document: null });
  const out = testParser(raw);
  eq(out.reply_message, 'hi');
});

t('parser: bare text fallback returns reply_message', () => {
  if (!testParser) throw new Error('parser not extractable');
  const out = testParser('just plain text, no fence');
  eq(out.reply_message, 'just plain text, no fence');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
