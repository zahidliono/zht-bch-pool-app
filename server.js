const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const RPC_HOST = process.env.BCH_RPC_HOST || 'bchn';
const RPC_PORT = process.env.BCH_RPC_PORT || '28332';
const RPC_USER = process.env.BCH_RPC_USER || 'bch';
const RPC_PASS = process.env.BCH_RPC_PASS || '';
const CKPOOL_STATUS_DIR = process.env.CKPOOL_STATUS_DIR || '/data/pool/www/pool';
const CKPOOL_USERS_DIR = process.env.CKPOOL_USERS_DIR || '/data/pool/www/users';
const SETTINGS_FILE = '/data/settings.json';
const PORT = process.env.PORT || 3000;

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'zht', method, params });
    const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
    const opts = {
      hostname: RPC_HOST,
      port: parseInt(RPC_PORT),
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          j.error ? reject(new Error(j.error.message)) : resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

function readPoolStatus() {
  const data = {};
  try {
    const files = fs.readdirSync(CKPOOL_STATUS_DIR);
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CKPOOL_STATUS_DIR, f), 'utf8').trim();
        if (raw.startsWith('{')) Object.assign(data, JSON.parse(raw));
      } catch (_) {}
    }
  } catch (_) {}
  return data;
}

function readWorkers() {
  const workers = [];
  try {
    const files = fs.readdirSync(CKPOOL_USERS_DIR);
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CKPOOL_USERS_DIR, f), 'utf8').trim();
        if (raw.startsWith('{')) {
          const u = JSON.parse(raw);
          workers.push({ name: f.replace('.json', ''), ...u });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return workers;
}

function parseHashrate(str) {
  const m = String(str || '0H').match(/^([0-9.]+)([A-Za-z]+)/);
  if (!m) return { val: '0', unit: 'H/s' };
  return { val: m[1], unit: m[2] + '/s' };
}

function formatShare(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return { val: (n / 1e12).toFixed(2), unit: 'T' };
  if (n >= 1e9)  return { val: (n / 1e9).toFixed(2),  unit: 'G' };
  if (n >= 1e6)  return { val: (n / 1e6).toFixed(2),  unit: 'M' };
  if (n >= 1e3)  return { val: (n / 1e3).toFixed(2),  unit: 'K' };
  return { val: String(n), unit: '' };
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (_) { return {}; }
}

// ── API ──────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const [chainRes, miningRes] = await Promise.allSettled([
    rpcCall('getblockchaininfo'),
    rpcCall('getmininginfo')
  ]);
  const pool = readPoolStatus();
  const workers = readWorkers();
  const settings = readSettings();

  const chain = chainRes.status === 'fulfilled' ? chainRes.value : null;
  const mining = miningRes.status === 'fulfilled' ? miningRes.value : null;

  res.json({
    node: chain ? {
      synced: chain.initialblockdownload === false,
      progress: chain.verificationprogress,
      blocks: chain.blocks,
      headers: chain.headers,
      difficulty: mining ? mining.difficulty : null,
      networkhashps: mining ? mining.networkhashps : null,
      chain: chain.chain
    } : null,
    pool: {
      hashrate1m: pool.hashrate1m || '0H',
      hashrate5m: pool.hashrate5m || '0H',
      hashrate1hr: pool.hashrate1hr || '0H',
      workers: pool.Workers || 0,
      users: pool.Users || 0,
      bestshare: pool.bestshare || 0,
      runtime: pool.runtime || 0,
      SPS1m: pool.SPS1m || 0
    },
    workers,
    settings,
    channel: process.env.APP_CHANNEL || 'ZHT'
  });
});

app.get('/api/widget/sync', async (req, res) => {
  try {
    const info = await rpcCall('getblockchaininfo');
    const pct = (info.verificationprogress * 100).toFixed(1);
    const synced = info.initialblockdownload === false;
    res.json({
      type: 'text-with-progress',
      title: 'BCH sync',
      text: synced ? 'Synced' : `${pct}%`,
      progressLabel: synced ? 'Synced' : 'In progress',
      progress: info.verificationprogress
    });
  } catch (_) {
    res.json({ type: 'text-with-progress', title: 'BCH sync', text: 'Offline', progress: 0, progressLabel: 'Node offline' });
  }
});

app.get('/api/widget/pool', (req, res) => {
  const pool = readPoolStatus();
  const hr = parseHashrate(pool.hashrate1m);
  const bs = formatShare(pool.bestshare);
  res.json({
    type: 'three-stats',
    items: [
      { title: 'Hashrate', text: hr.val, subtext: hr.unit },
      { title: 'Workers',  text: String(pool.Workers || 0) },
      { title: 'Best Share', text: bs.val, subtext: bs.unit }
    ]
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const current = readSettings();
    const updated = { ...current, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`ZHT BCH Pool Dashboard on :${PORT}`));
