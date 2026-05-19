-- ================================================================
--  SUPABASE DATABASE SETUP
--  Go to: supabase.com → Your Project → SQL Editor → Paste & Run
-- ================================================================

CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT DEFAULT 'Unknown',
  score         INTEGER DEFAULT 0,
  label         TEXT DEFAULT 'COLD',
  intent        TEXT DEFAULT 'general',
  message_count INTEGER DEFAULT 0,
  last_message  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON knowledge_base FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_kb_created ON knowledge_base (created_at DESC);
