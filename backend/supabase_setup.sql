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
