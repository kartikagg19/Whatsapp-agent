// Retry script — uploads only the 10 files that failed in the main run
require('dotenv').config({ path: __dirname + '/.env' });
const axios    = require('axios');
const FormData = require('form-data');
const AdmZip   = require('adm-zip');
const path     = require('path');

const ZIP_PATH = 'C:\\Users\\User\\Downloads\\2- krishna project sorted-20260530T102348Z-3-001.zip';
const BASE_URL = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const API      = BASE_URL + '/api';

// The 10 files that failed — keyed by exact filename in ZIP
const RETRY = [
  { group: 'Krishna Aura NX',              file: 'Krishna Aura NX - Brochure.pdf' },
  { group: 'Krishna Aurum',                file: 'Krishna Aurum - Brochure.pdf' },
  { group: 'Krishna Dharni',               file: 'Krishna Dharni - Brochure.pdf' },
  { group: 'Krishna Dharni',               file: 'Krishna Dharni A1 - Brochure.pdf' },
  { group: 'Krishna Greens',               file: 'Krishna Greens - Brochure.pdf' },
  { group: 'Krishna Group (Company-wide)', file: 'Krishna Group - Company Profile.pdf' },
  { group: 'Krishna Park View',            file: 'Krishna Park View - Brochure.pdf' },
  { group: 'Krishna Veer',                 file: 'Krishna Veer - Brochure.pdf' },
  { group: 'Krishna Vista',               file: 'Krishna Vista - Sale Chart (Plot 64 Sec 7) 07-05-2026.pdf' },
  { group: 'Siddhivinayak Krishna',        file: 'Siddhivinayak Krishna - Brochure.pdf' },
];

let token = '';

async function main() {
  // Login
  const lr = await axios.post(`${API}/login`, {
    email:    process.env.ADMIN_EMAIL    || 'shardul@propello.ai',
    password: process.env.ADMIN_PASSWORD || 'Propello@2025'
  });
  token = lr.data.token;
  console.log('✅ Logged in\n');

  const zip = new AdmZip(ZIP_PATH);
  let ok = 0, fail = 0;

  for (const { group, file } of RETRY) {
    // Find the entry in the ZIP
    const entry = zip.getEntries().find(e => e.entryName.endsWith('/' + file) || e.entryName.endsWith('\\' + file));
    if (!entry) { console.log(`❌ Not found in ZIP: ${file}`); fail++; continue; }

    process.stdout.write(`📤 ${group} / ${file} ... `);
    try {
      const buf = entry.getData();
      const fd  = new FormData();
      fd.append('file', buf, { filename: file, contentType: 'application/pdf' });
      fd.append('project_group', group);
      const r = await axios.post(`${API}/knowledge/upload`, fd, {
        headers: { Authorization: `Bearer ${token}`, ...fd.getHeaders() },
        maxContentLength: Infinity, maxBodyLength: Infinity,
        timeout: 120000
      });
      if (r.data.success) { console.log('✅'); ok++; }
      else                { console.log(`❌ ${r.data.error}`); fail++; }
    } catch (e) {
      console.log(`❌ ${e.response?.data?.error || e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ Done: ${ok} uploaded, ${fail} failed`);
}

main().catch(e => { console.error('💥', e.message); process.exit(1); });
