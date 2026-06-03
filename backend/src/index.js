// ================================================================
//  src/index.js — Main Server
// ================================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');

const webhookRouter      = require('./routes/webhook');
const adminRouter        = require('./routes/admin');
const analyticsRouter    = require('./routes/analytics');
const salesforceRouter   = require('./routes/salesforce');
const { startFollowUpScheduler } = require('./followup');
const { startAnalyzerWorker }    = require('./analyzerWorker');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: true, // allow all origins — dashboard is internal tool
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Webhook-Secret'],
  credentials: true
}));
app.use(morgan('dev'));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use('/webhook', webhookRouter);
// Analytics mounted BEFORE admin so /api/analytics/* never falls through
// to adminRouter's catch-all 404 handler (if any).
app.use('/api/analytics',  analyticsRouter);
app.use('/api/salesforce', salesforceRouter);
app.use('/api',            adminRouter);

app.get('/', (req, res) => res.json({
  status:  'online',
  service: 'DreamHome WhatsApp AI Bot',
  time:    new Date().toISOString()
}));

app.listen(PORT, () => {
  console.log('\n🏠 ================================');
  console.log('   DreamHome Bot is RUNNING!');
  console.log('🏠 ================================');
  console.log(`✅ Server   : http://localhost:${PORT}`);
  console.log(`📡 Webhook  : http://localhost:${PORT}/webhook`);
  console.log(`🔑 Token    : ${process.env.WEBHOOK_VERIFY_TOKEN}`);
  console.log(`🤖 AI Model : Gemini 2.5 Flash\n`);
  startFollowUpScheduler();
  startAnalyzerWorker();
});
