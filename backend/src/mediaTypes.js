// ================================================================
//  src/mediaTypes.js — Single source of truth for media types
// ----------------------------------------------------------------
//  The v2.7 prompt contract requires the AI to emit type strings
//  (e.g. "brochure", "elevation") instead of raw URLs. This module:
//    1. Defines the fixed vocabulary of doc_type and image_type
//       values that match the prompt's tables.
//    2. Maps filename + file_type from the knowledge_base rows into
//       one of those type strings, so existing uploads work without
//       a schema change.
//    3. Builds the {pdf_document_database} and {image_database}
//       blocks that ai.js injects per project.
//    4. Resolves a type string back to a knowledge_base row at
//       dispatch time, so orchestrator.js knows which file_url to
//       hand to WhatsApp.
//
//  IMPORTANT: doc_type / image_type vocabularies MUST stay in sync
//  with waprompt v2.7's Block 0 tables. If you add a new type to
//  the prompt, add it here too (and the inference regex).
// ================================================================

const PDF_DOC_TYPES = [
  'brochure',
  'floor_plan',
  'price_sheet',
  'payment_plan',
  'rera_certificate',
  'location_map',
  'cp_kit',
  'site_visit_guide'
];

const IMAGE_TYPES = [
  'site_photo',
  'interior',
  'amenity',
  'elevation',
  'render',
  'location_map_image',
  'floor_plan_image',
  'cp_kit_image'
];

// ── Filename → type inference ─────────────────────────────────────
// Ordered: first regex that matches wins. Specific patterns before
// generic ones (e.g. "sale chart" before "chart").

// Order matters — first match wins. More specific patterns must come
// before generic ones (e.g. "site visit guide" before any "site").
const DOC_TYPE_PATTERNS = [
  { type: 'site_visit_guide', re: /site\s*visit\s*guide|visit\s*guide/i },
  { type: 'rera_certificate', re: /\brera\b/i },
  { type: 'payment_plan',     re: /payment\s*(plan|schedule)|emi\s*plan|installment/i },
  // price_sheet — includes "sale plan", "sale chart", "area statement",
  // "saleable area". A "sale plan" in this dataset is a per-unit pricing
  // + area breakdown, not a layout drawing.
  { type: 'price_sheet',      re: /cost\s*sheet|price\s*sheet|sale\s*chart|sale\s*plan|saleable\s*area|area\s*statement|rate\s*card|pricing|price\s*list/i },
  // location_map — "location layout map" must match here, before
  // floor_plan (which contains "layout").
  { type: 'location_map',     re: /location\s*(layout\s*)?map|connectivity\s*map|site\s*map|location\s*plan/i },
  // floor_plan — actual layout drawings. "furniture plan" goes here
  // because it's a per-unit furniture/room layout.
  { type: 'floor_plan',       re: /floor\s*plan|unit\s*plan|layout\s*plan|furniture\s*plan|naksha/i },
  { type: 'cp_kit',           re: /cp\s*kit|partner\s*kit|channel\s*partner/i },
  { type: 'brochure',         re: /brochur/i },
];

const IMAGE_TYPE_PATTERNS = [
  { type: 'floor_plan_image',   re: /floor\s*plan|unit\s*plan|layout/i },
  { type: 'location_map_image', re: /location\s*map|connectivity|map/i },
  { type: 'cp_kit_image',       re: /cp\s*kit|partner\s*kit/i },
  { type: 'elevation',          re: /elevation|building\s*render|building\s*photo|exterior/i },
  { type: 'render',             re: /render|3d|artist\s*impression/i },
  { type: 'interior',           re: /interior|inside|room|flat\s*photo|bedroom|kitchen|living/i },
  { type: 'amenity',            re: /amenit|clubhouse|pool|gym|garden|playground|lobby/i },
  { type: 'site_photo',         re: /site\s*photo|construction|on[\s\-]?ground|aerial|drone/i },
];

function isImageFile(row) {
  if ((row.file_type || '').toLowerCase() === 'image') return true;
  return /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(row.name || '') ||
         /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(row.file_url || '');
}

function isPdfFile(row) {
  if ((row.file_type || '').toLowerCase() === 'pdf') return true;
  return /\.pdf(\?|#|$)/i.test(row.name || '') ||
         /\.pdf(\?|#|$)/i.test(row.file_url || '');
}

// Map ONE knowledge_base row to its inferred type.
// Returns { kind: 'pdf'|'image', type: '<type_string>' } or null.
function inferRowType(row) {
  if (!row || !row.file_url) return null;
  const name = row.name || '';
  if (isImageFile(row)) {
    for (const p of IMAGE_TYPE_PATTERNS) {
      if (p.re.test(name)) return { kind: 'image', type: p.type };
    }
    // Image with no recognisable label — default to render
    return { kind: 'image', type: 'render' };
  }
  if (isPdfFile(row)) {
    for (const p of DOC_TYPE_PATTERNS) {
      if (p.re.test(name)) return { kind: 'pdf', type: p.type };
    }
    // PDF with no recognisable label — default to brochure
    return { kind: 'pdf', type: 'brochure' };
  }
  return null;
}

// Build the per-project pdf_document_database + image_database JSON
// objects expected by the v2.7 prompt's Block 0 placeholders.
function buildMediaDatabases(kbRows, projectGroup) {
  const rows = (kbRows || []).filter(
    r => (r.project_group || '').toLowerCase().trim() ===
         (projectGroup || '').toLowerCase().trim()
  );
  const documents = [];
  const images = [];
  for (const r of rows) {
    const t = inferRowType(r);
    if (!t) continue;
    const entry = {
      label: r.name || '',
      supabase_url: r.file_url,
      description: ''
    };
    if (t.kind === 'pdf') {
      documents.push({ doc_type: t.type, ...entry });
    } else {
      const fmt = (r.name || '').toLowerCase().match(/\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/);
      images.push({ image_type: t.type, format: fmt ? fmt[1] : 'jpeg', ...entry });
    }
  }
  return {
    pdf_db: { project_name: projectGroup, documents },
    image_db: { project_name: projectGroup, images }
  };
}

// Build databases for ALL projects (when the bot can't yet tell
// which project a conversation is about). The prompt's media-dispatch
// logic still needs to see real type strings to pick from.
function buildAllProjectMediaDatabases(kbRows) {
  const groups = new Map();
  for (const r of (kbRows || [])) {
    const g = (r.project_group || '').trim();
    if (!g || !r.file_url) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const result = {};
  for (const [g, rows] of groups.entries()) {
    result[g] = buildMediaDatabases(rows, g);
  }
  return result;
}

// At dispatch time: given a type string (and optionally a project
// hint), return the knowledge_base row(s) whose file_url should be
// sent. Returns array (may be empty). The prompt allows multiple
// files of the same type — backend sends all of them.
function resolveTypeToRows(kbRows, kind, typeString, projectHint) {
  const target = (typeString || '').toLowerCase().trim();
  const hint = (projectHint || '').toLowerCase().trim();
  const matches = [];
  for (const r of (kbRows || [])) {
    if (!r.file_url) continue;
    const t = inferRowType(r);
    if (!t || t.kind !== kind) continue;
    if (t.type !== target) continue;
    if (hint) {
      const pg = (r.project_group || '').toLowerCase().trim();
      if (pg !== hint) continue;
    }
    matches.push(r);
  }
  return matches;
}

module.exports = {
  PDF_DOC_TYPES,
  IMAGE_TYPES,
  inferRowType,
  isImageFile,
  isPdfFile,
  buildMediaDatabases,
  buildAllProjectMediaDatabases,
  resolveTypeToRows,
};
