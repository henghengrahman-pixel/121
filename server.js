import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const API_KEY = String(process.env.API_KEY || '').trim();
const LATE_MINUTES = Number(process.env.LATE_MINUTES || 8);
const TIMEZONE = String(process.env.TIMEZONE || 'Asia/Jakarta').trim();
const DATA_FILE = String(process.env.DATA_FILE || path.join(process.cwd(), 'reported.json'));
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '*').trim();

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ reported: {}, createdAt: new Date().toISOString() }, null, 2));
  }
}

function readStore() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (!data.reported || typeof data.reported !== 'object') data.reported = {};
    return data;
  } catch {
    return { reported: {}, createdAt: new Date().toISOString() };
  }
}

function writeStore(data) {
  ensureDataFile();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function cleanOldReports(data) {
  const now = Date.now();
  const maxAge = 1000 * 60 * 60 * 24 * 14;
  for (const [key, item] of Object.entries(data.reported || {})) {
    const t = new Date(item.reportedAt || item.createdAt || 0).getTime();
    if (!t || now - t > maxAge) delete data.reported[key];
  }
}

function setCors(req, res, next) {
  const origin = req.headers.origin || '*';
  if (ALLOWED_ORIGINS === '*') {
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
  } else {
    const allowed = ALLOWED_ORIGINS.split(',').map(v => v.trim()).filter(Boolean);
    if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'API_KEY belum diisi di Railway ENV' });
  const key = String(req.headers['x-api-key'] || req.query.api_key || '').trim();
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'API key salah' });
  next();
}

function nowWibText() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(new Date()).replace(/\./g, ':');
}

function safeText(v, max = 900) {
  return String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}

function buildDepositKey(dep) {
  const raw = [dep.user, dep.date, dep.amount, dep.bankAsal].map(v => String(v || '').trim().toLowerCase()).join('|');
  return Buffer.from(raw).toString('base64url').slice(0, 120);
}

function buildMessage(dep) {
  return [
    '🚨 DEPOSIT BELUM DIPROSES > ' + LATE_MINUTES + ' MENIT',
    '',
    'User: ' + safeText(dep.user || '-'),
    'Tanggal Form: ' + safeText(dep.date || '-') + ' WIB',
    'Umur: ' + safeText(dep.ageText || '-') ,
    'Amount: ' + safeText(dep.amount || '-'),
    'Balance: ' + safeText(dep.balance || '-'),
    'Bank Asal: ' + safeText(dep.bankAsal || '-'),
    'Info: ' + safeText(dep.info || '-'),
    '',
    'Device: ' + safeText(dep.deviceName || '-'),
    'Dilapor: ' + nowWibText() + ' WIB',
    '',
    'Mohon segera cek form deposit.'
  ].join('\n');
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: 'BOT_TOKEN / CHAT_ID belum diisi di Railway ENV' };
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) return { ok: false, error: data.description || `Telegram HTTP ${resp.status}` };
  return { ok: true, telegram: data.result?.message_id || null };
}

app.use(setCors);
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'deposit-railway-sync-server',
    status: 'running',
    timezone: TIMEZONE,
    wibNow: nowWibText(),
    lateMinutes: LATE_MINUTES,
    telegramReady: Boolean(BOT_TOKEN && CHAT_ID),
    apiKeyReady: Boolean(API_KEY)
  });
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), wibNow: nowWibText() }));

app.post('/api/report-deposits', requireApiKey, async (req, res) => {
  const deposits = Array.isArray(req.body?.deposits) ? req.body.deposits : [];
  const deviceName = safeText(req.body?.deviceName || req.headers['x-device-name'] || 'chrome', 80);
  if (!deposits.length) return res.json({ ok: true, received: 0, sent: 0, skipped: 0, errors: [] });

  const store = readStore();
  cleanOldReports(store);

  const results = [];
  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const dep0 of deposits) {
    const dep = { ...dep0, deviceName: dep0.deviceName || deviceName };
    const key = safeText(dep.id || dep.key || buildDepositKey(dep), 160);
    if (!key) {
      skipped++;
      results.push({ ok: false, skipped: true, reason: 'empty_key' });
      continue;
    }

    if (store.reported[key]) {
      skipped++;
      results.push({ ok: true, key, skipped: true, reason: 'already_reported', reportedAt: store.reported[key].reportedAt });
      continue;
    }

    const message = buildMessage(dep);
    const tg = await sendTelegram(message);
    if (tg.ok) {
      sent++;
      store.reported[key] = {
        key,
        user: safeText(dep.user, 120),
        amount: safeText(dep.amount, 80),
        date: safeText(dep.date, 80),
        deviceName,
        reportedAt: new Date().toISOString(),
        telegramMessageId: tg.telegram
      };
      results.push({ ok: true, key, sent: true });
    } else {
      errors.push({ key, error: tg.error });
      results.push({ ok: false, key, error: tg.error });
    }
  }

  writeStore(store);
  res.json({ ok: errors.length === 0, received: deposits.length, sent, skipped, errors, results });
});

app.get('/api/status', requireApiKey, (req, res) => {
  const store = readStore();
  cleanOldReports(store);
  writeStore(store);
  const items = Object.values(store.reported || {}).sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt))).slice(0, 50);
  res.json({ ok: true, reportedCount: Object.keys(store.reported || {}).length, latest: items, wibNow: nowWibText() });
});

app.post('/api/reset', requireApiKey, (req, res) => {
  const data = { reported: {}, resetAt: new Date().toISOString() };
  writeStore(data);
  res.json({ ok: true, message: 'Data anti-spam berhasil direset' });
});

app.post('/api/test-telegram', requireApiKey, async (req, res) => {
  const text = '✅ Test Telegram berhasil\nServer Railway aktif.\nWaktu WIB: ' + nowWibText();
  const result = await sendTelegram(text);
  res.status(result.ok ? 200 : 500).json(result);
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Route tidak ditemukan' }));

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`DEPOSIT SYNC SERVER RUNNING PORT ${PORT}`);
});
