-- ================================================================
--  SUPABASE DATABASE SETUP
--  Go to: supabase.com → Your Project → SQL Editor → Paste & Run
-- ================================================================

CREATE TABLE IF NOT EXISTS leads (
  id                  BIGSERIAL PRIMARY KEY,
  phone               TEXT UNIQUE NOT NULL,
  name                TEXT DEFAULT 'Unknown',
  score               INTEGER DEFAULT 0,
  label               TEXT DEFAULT 'COLD',
  intent              TEXT DEFAULT 'general',
  budget_range        TEXT,
  location_preference TEXT,
  timeline            TEXT,
  purpose             TEXT,
  message_count       INTEGER DEFAULT 0,
  last_message        TIMESTAMPTZ,
  follow_up_sent_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Run these if upgrading an existing leads table:
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_range        TEXT;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_preference TEXT;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS timeline            TEXT;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS purpose             TEXT;
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_sent_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS conversations (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT NOT NULL,
  role       TEXT NOT NULL,
  message    TEXT NOT NULL,
  score      INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_phone   ON leads (phone);
CREATE INDEX IF NOT EXISTS idx_leads_label   ON leads (label);
CREATE INDEX IF NOT EXISTS idx_conv_phone    ON conversations (phone);

-- ── KNOWLEDGE BASE ────────────────────────────────────────────────
-- Stores uploaded PDFs and text documents the AI references per reply.

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  file_type  TEXT DEFAULT 'text',
  size_chars INTEGER DEFAULT 0,
  file_url   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Run this if upgrading an existing knowledge_base table:
-- ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS file_url TEXT;

ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON knowledge_base FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_kb_created ON knowledge_base (created_at DESC);

-- ── RLS: leads & conversations ────────────────────────────────────
ALTER TABLE leads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON leads         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON conversations FOR ALL USING (true) WITH CHECK (true);

-- ── STORAGE: documents bucket ─────────────────────────────────────
-- 1. Go to Supabase → Storage → Create bucket named "documents" (Public ON)
-- 2. Then run these policies:

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "allow_all_storage_select"
  ON storage.objects FOR SELECT USING (bucket_id = 'documents');

CREATE POLICY "allow_all_storage_insert"
  ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'documents');

CREATE POLICY "allow_all_storage_update"
  ON storage.objects FOR UPDATE USING (bucket_id = 'documents');

CREATE POLICY "allow_all_storage_delete"
  ON storage.objects FOR DELETE USING (bucket_id = 'documents');
