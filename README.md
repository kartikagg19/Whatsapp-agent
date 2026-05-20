# DreamHome WhatsApp AI Bot ↔ PropelloCRM Integration

A Node.js + Express + Supabase bot that receives WhatsApp messages, generates AI replies using Google Gemini, and syncs conversations with PropelloCRM in real-time.

## Features

- **Real-time WhatsApp messaging** via Meta Graph API
- **AI-powered replies** using Google Gemini with customizable business context
- **Lead scoring & qualification** (HOT/WARM/COLD)
- **PropelloCRM integration** — sync inbound/outbound messages + lead escalation
- **CRM-triggered sends** — PropelloCRM can ask the bot to send WhatsApp messages
- **Dashboard UI** — manage settings, leads, knowledge base, send broadcasts
- **Reply delay simulation** — makes bot feel more human
- **Knowledge base** — upload PDFs/text to customize AI responses
- **Sales alerts** — instant notification for HOT leads

## Architecture

```
┌─────────────────┐                                  ┌──────────────────┐
│   PropelloCRM   │ ── POST /api/send (trigger) ──>  │  DreamHome Bot   │
│  (FastAPI/PG)   │                                  │  (Node/Supabase) │
│                 │ <── POST /api/whatsapp/timeline ─│                  │
│                 │ <── GET  /api/whatsapp/context ──│                  │
└─────────────────┘                                  └──────────────────┘
       ↑                                                       ↓
       │                                              ┌──────────────────┐
       │                                              │   Meta WhatsApp  │
       │                                              │   Graph API      │
       │                                              └──────────────────┘
       │                                                       ↓
       └────────────── (CRM auto-escalates) ←──────── Buyer's phone
```

## Quick Start

### 1. Prerequisites

- Node.js 18+
- Supabase account (free tier OK)
- Google Gemini API key
- Meta WhatsApp Business Account API credentials
- PropelloCRM instance (optional, for CRM sync only)

### 2. Environment Setup

```bash
cd backend
cp .env.example .env
```

Fill in `.env` with your keys:

```bash
# Google Gemini AI
GEMINI_API_KEY=your_gemini_api_key_here

# Meta WhatsApp Business API
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here
WEBHOOK_VERIFY_TOKEN=dreamhome2025secret

# Supabase Database
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here

# Sales Alert WhatsApp Number (with country code, no +)
SALES_PHONE_NUMBER=919876543210

# PropelloCRM Integration (optional, required for CRM sync)
CRM_BASE_URL=https://propellocrm.onrender.com
CRM_WEBHOOK_SECRET=<shared-secret-identical-to-crm-whatsapp-webhook-secret>
CRM_TIMEOUT_MS=10000

# Server
PORT=3000
NODE_ENV=development
```

### 3. Database Setup

Create these tables in Supabase:

```sql
-- Leads: buyer profiles + AI scoring
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  score INTEGER,
  label TEXT, -- HOT, WARM, COLD
  intent TEXT,
  message_count INTEGER DEFAULT 0,
  last_message TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Conversations: full chat history
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  role TEXT, -- 'user' or 'assistant'
  message TEXT,
  score INTEGER,
  created_at TIMESTAMP DEFAULT now()
);

-- Knowledge Base: custom business context
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  content TEXT,
  file_type TEXT,
  size_chars INTEGER,
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_updated_at ON leads(updated_at DESC);
CREATE INDEX idx_convos_phone ON conversations(phone);
```

### 4. Install & Run

```bash
npm install
npm run dev    # Runs on http://localhost:3000
```

### 5. Configure Meta Webhook

1. Go to [Meta App Dashboard](https://developers.facebook.com/apps)
2. Select your WhatsApp app → Configuration → Webhooks
3. Set **Callback URL**: `https://your-domain/webhook` (or `http://localhost:3000/webhook` for local testing)
4. Set **Verify Token**: `dreamhome2025secret` (match `WEBHOOK_VERIFY_TOKEN` in `.env`)
5. Subscribe to `messages` and `message_template_status_update` events

## PropelloCRM Integration

### How It Works

**Inbound Flow** (Buyer → Bot → CRM):
1. Buyer texts the bot's WhatsApp number
2. Bot receives message via Meta webhook
3. Bot generates AI reply using conversation history
4. Bot saves both messages locally (Supabase)
5. Bot syncs conversation to CRM timeline (fire-and-forget)
6. CRM auto-escalates HOT leads (score ≥ 70) to tasks + agent notifications

**Outbound Flow** (CRM → Bot → Buyer):
1. Sales ops clicks "Send WhatsApp" on a lead in PropelloCRM
2. CRM calls `POST /api/send` with X-Webhook-Secret header
3. Bot validates secret, checks dedupe (24h window per `call_id`)
4. If not a duplicate, bot sends to Meta WhatsApp
5. Bot saves message locally with `[CRM call_id]` prefix
6. Bot returns 200 even if Meta failed (CRM has its own logs)

### API Endpoints (CRM-side)

#### **POST /api/send** — Trigger WhatsApp message

CRM **must** send:
- Header: `X-Webhook-Secret: <CRM_WEBHOOK_SECRET>`
- Body (all fields required except call_id, template):

```json
{
  "phone": "919876543210",
  "message": "Hi Priya! 👋 How can I help?",
  "call_id": "crm-trigger-12345",        // optional: for idempotency
  "template": "campaign_announcement"     // optional: for analytics
}
```

Response:
- **200** with `{ success: true }` — message sent to Meta
- **200** with `{ success: true, deduped: true }` — duplicate within 24h, no send
- **200** with `{ success: false, error: "..." }` — Meta API error, message saved locally
- **403** with `{ error: "Invalid X-Webhook-Secret" }` — wrong/missing secret

#### **POST /webhook** — Receive inbound messages

Automatically called by Meta. Bot:
1. Saves user message to Supabase
2. Generates AI reply
3. Sends reply via Meta
4. Syncs both messages to CRM timeline via `POST /api/whatsapp/timeline`

#### **GET /api/leads** — List all leads

```bash
curl http://localhost:3000/api/leads
curl "http://localhost:3000/api/leads?label=HOT"  # Filter by HOT/WARM/COLD
```

#### **GET /api/leads/:phone** — Get lead + full chat

```bash
curl http://localhost:3000/api/leads/919876543210
```

Returns:
```json
{
  "success": true,
  "data": {
    "id": "...",
    "phone": "919876543210",
    "name": "Priya",
    "score": 8,
    "label": "HOT",
    "intent": "purchase",
    "message_count": 15,
    "conversations": [
      { "role": "user", "message": "Hi", "created_at": "..." },
      { "role": "assistant", "message": "Hello!", "created_at": "..." }
    ]
  }
}
```

### CRM Timeline Format

When bot syncs to `POST /api/whatsapp/timeline`, it sends:

```json
{
  "phone": "919876543210",
  "direction": "inbound" | "outbound",
  "message": "...",
  "call_id": "wa-in-wamid-123",
  "occurred_at": "2026-05-19T10:30:00Z",
  "ai_score": 80,                    // bot's 1-10 score × 10
  "intent": "purchase",
  "qualified": true,
  "summary": "Hot lead, ready for site visit",
  "profile_patch": {
    "budget_range": "1.5-2 Cr",
    "intent_detail": "2BHK"
  }
}
```

**CRM Behavior:**
- Idempotent on `(phone, call_id, direction)` — duplicate calls are safe
- If `ai_score >= 70`, creates HOT-lead task + notifies agent
- Shallow-merges `profile_patch` into lead's master profile

## Dashboard UI

Open `http://localhost:3000/dashboard/dashboard.html` in a browser.

### Features

- **Leads Tab**: View all leads, filter by HOT/WARM/COLD, click to detail
- **Lead Detail**: Full chat history, AI analysis, site visit scheduling, manual send
- **Send**: One-off or broadcast message to leads
- **Knowledge Base**: Upload PDFs/text to customize bot responses
- **Settings**: Adjust bot tone, model, hot/warm/cold thresholds, etc.

### Manual Send (Dashboard)

The dashboard's "Send" button calls `POST /api/send` **without** the `X-Webhook-Secret` header (for backward compat during v1). This is safe because:

1. Header validation is optional (if header present, must be correct; if absent, allow)
2. Dashboard is self-hosted (not exposed to the internet)
3. Future versions can update dashboard to send the header

To migrate dashboard to CRM-protected auth later, see **§7 risk** in the original PRD.

## AI Configuration

### System Prompt

Edit `backend/src/ai.js` to customize the system prompt. The prompt includes:

- **KNOWLEDGE BASE**: Dynamically injected from `knowledge_base` table
- **TONE**: Warm, conversational, human-like (not robotic)
- **QUALIFICATION**: Subtle lead scoring (budget, timeline, purpose, urgency)
- **OUTPUT FORMAT**: Strict JSON schema (bot replies with structured data)

### Settings (Dashboard)

Editable via Dashboard UI and stored in `settings.json`:

- `bot_name`: "Niharika" (or customize)
- `business_name`: "Krishna Group"
- `project_name`: "Krishna Aura"
- `language`: "hinglish", "english", "hindi"
- `tone`: "friendly", "professional", "casual"
- `ai_model`: "gemini-2.5-flash" (or newer)
- `hot_score`: 8 (out of 10)
- `warm_score`: 5 (out of 10)
- `reply_delay`: 0–5000ms (simulates human typing)
- `office_hours_on`: true/false (optional, off by default)
- `office_start`, `office_end`: "09:00", "21:00" (if enabled)

## Troubleshooting

### "Invalid X-Webhook-Secret"

Make sure `CRM_WEBHOOK_SECRET` in bot's `.env` matches the CRM's `WHATSAPP_WEBHOOK_SECRET`.

```bash
# Bot
CRM_WEBHOOK_SECRET=your_shared_secret_here

# CRM (.env or Render dashboard)
WHATSAPP_WEBHOOK_SECRET=your_shared_secret_here  # must match exactly
```

### Webhook Not Receiving Messages

1. Meta webhook URL must be publicly accessible (use Ngrok for local dev)
2. HTTPS required (Ngrok provides this)
3. Verify Token must match `WEBHOOK_VERIFY_TOKEN` in `.env`

```bash
# Local dev with Ngrok:
ngrok http 3000
# Then set Meta webhook to: https://your-ngrok-url/webhook
```

### Messages Not Syncing to CRM

Check if `CRM_BASE_URL` and `CRM_WEBHOOK_SECRET` are set. If not configured:
- Bot continues replying normally (✅ no breaking change)
- CRM sync is a no-op
- Check bot logs: `[CRM] ...` entries

### AI Replies Are Generic

1. Upload relevant business docs via Dashboard → Knowledge Base
2. Adjust system prompt in `src/ai.js`
3. Check `settings.json` tone/language matches audience

## Deployment

### Render (Production)

1. Connect GitHub repo to Render
2. Create **Web Service** from `backend/` directory
3. Set environment variables in Render dashboard
4. Deploy

### Vercel (Frontend Dashboard)

The dashboard is a static HTML file in `/dashboard/dashboard.html`. You can:

- Serve it via Render as a static asset
- Or deploy separately to Vercel/Netlify and update `apiBase` in the HTML

## Project Structure

```
backend/
├── src/
│   ├── index.js           # Express server setup
│   ├── ai.js              # Google Gemini AI brain
│   ├── database.js        # Supabase queries
│   ├── whatsapp.js        # Meta WhatsApp API
│   ├── crmClient.js       # PropelloCRM integration (NEW)
│   └── routes/
│       ├── admin.js       # /api endpoints (settings, send, leads)
│       └── webhook.js     # /webhook endpoint (inbound messages)
├── .env.example           # Environment variables template
├── package.json
└── README.md
dashboard/
├── dashboard.html         # Standalone UI
docs/
├── SETUP_GUIDE.txt        # Detailed setup instructions
```

## Key Files Modified for CRM Integration

1. **`backend/src/crmClient.js`** (NEW)
   - `syncTimeline(payload)` — fire-and-forget sync to CRM
   - `fetchContext(phone, callId)` — optional: pre-AI context fetch

2. **`backend/src/routes/webhook.js`**
   - Added imports: `const { syncTimeline } = require('../crmClient');`
   - After AI reply, sync inbound + outbound to CRM (lines ~90–120)

3. **`backend/src/routes/admin.js`**
   - In-memory dedupe map: `dedupeMap`, `checkAndRecordCallId()`
   - POST `/api/send` redesigned to:
     - Validate `X-Webhook-Secret` header (if present)
     - Support `call_id` (idempotency) + `template` (analytics)
     - Return 200 even on Meta errors (CRM contract)

4. **`backend/.env.example`**
   - Added CRM vars: `CRM_BASE_URL`, `CRM_WEBHOOK_SECRET`, `CRM_TIMEOUT_MS`

## Testing Acceptance Criteria

### AC1: POST /api/send without secret → HTTP 403

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: wrong_secret" \
  -d '{"phone":"919876543210","message":"Hi"}' 
# Expected: 403 Unauthorized
```

### AC2: Valid secret → message sent

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your_correct_secret" \
  -d '{"phone":"919876543210","message":"Hi","call_id":"test-1"}'
# Expected: 200 { success: true }
```

### AC3: Dedupe within 24h

```bash
# First call
curl -X POST http://localhost:3000/api/send \
  -H "X-Webhook-Secret: your_correct_secret" \
  -d '{"phone":"919876543210","message":"Hi","call_id":"test-1"}'
# Expected: 200 { success: true }

# Exact same call_id within 24h
curl -X POST http://localhost:3000/api/send \
  -H "X-Webhook-Secret: your_correct_secret" \
  -d '{"phone":"919876543210","message":"Hi","call_id":"test-1"}'
# Expected: 200 { success: true, deduped: true }
```

### AC4: Inbound → CRM timeline

1. Send a real WhatsApp message to the bot
2. Check CRM lead detail — should see 2 activity rows:
   - `whatsapp_inbound` (buyer's message)
   - `whatsapp_outbound` (bot's reply with ai_score)

### AC5: CRM down → bot still replies

Unset `CRM_BASE_URL` in `.env` and restart. Bot replies normally to inbound messages (CRM sync is silent no-op).

### AC6: HOT lead → CRM escalation

Send a message likely to score ≥ 8 (e.g., "I want to buy a 2BHK immediately, budget 2 crores"). Check CRM for HOT-lead task + agent notification.

## License

Proprietary — DreamHome Real Estate

## Questions?

Contact the team or review the original PRD (`docs/PRD.md`).
