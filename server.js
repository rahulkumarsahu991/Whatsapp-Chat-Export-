'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const { parseQuery } = require('./src/format');
const { buildWorkbook, exportFileName } = require('./src/excel');
const { prepareZip, streamZip } = require('./src/media');

const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const OPEN_BROWSER = !process.argv.includes('--no-open');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg && portArg.split('=')[1]) || Number(process.env.PORT) || 3000;

const Service = DEMO ? require('./src/demo') : require('./src/whatsapp');
const wa = new Service();

// Only this computer may use the app: your WhatsApp is never exposed to the network.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocalHost = (host = '') => LOCAL_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase());
const isLocalOrigin = (origin) => {
  if (!origin) return true;
  try { return isLocalHost(new URL(origin).host); } catch { return false; }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest: (req, cb) => cb(null, isLocalHost(req.headers.host) && isLocalOrigin(req.headers.origin)),
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!isLocalHost(req.headers.host)) return res.status(403).send('Forbidden');
  if (req.method === 'POST' && req.get('X-App') !== '1') return res.status(403).json({ error: 'Forbidden' });
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

app.get('/api/status', (req, res) => res.json(wa.status()));

app.get('/api/debug', route(async (req, res) => {
  res.json(wa.debugState ? await wa.debugState() : { state: wa.status().state });
}));

app.post('/api/restart', route(async (req, res) => {
  if (typeof wa.retry === 'function') wa.retry(); else wa.restart();
  res.json({ ok: true });
}));

app.post('/api/logout', route(async (req, res) => {
  await wa.logout();
  res.json({ ok: true });
}));

if (DEMO) {
  app.post('/api/demo/scan', route(async (req, res) => {
    wa.simulateScan();
    res.json({ ok: true });
  }));
}

app.get('/api/chats', route(async (req, res) => {
  res.json({ chats: await wa.getChats({ fresh: req.query.fresh === '1' }) });
}));

app.get('/api/chats/:id/messages', route(async (req, res) => {
  res.json(await wa.getMessages(req.params.id, parseQuery(req.query)));
}));

app.get('/api/chats/:id/export', route(async (req, res) => {
  const data = await wa.getMessages(req.params.id, parseQuery(req.query));
  const buffer = await buildWorkbook(data);
  res.attachment(exportFileName(data.chat.name));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buffer));
}));

// ---- photos / videos / voice notes / documents ----
app.get('/api/media/:id/thumb', route(async (req, res) => {
  const thumb = await wa.getThumb(req.params.id);
  if (!thumb) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(thumb.type).send(thumb.buffer);
}));

app.get('/api/media/:id', route(async (req, res) => {
  const file = await wa.getMediaFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'This media is no longer available on WhatsApp.' });
  if (req.query.download === '1') return res.download(file.path, file.filename || path.basename(file.path));
  res.sendFile(file.path, { headers: { 'Content-Type': file.mimetype, 'Cache-Control': 'private, max-age=86400' } });
}));

// Excel + all media as ONE .zip that the browser downloads directly.
// Step 1 (POST) gathers the media with progress over the socket; step 2 (GET) streams the zip.
let exportJob = null;
const readyZips = new Map(); // token -> { pkg, at }
const ZIP_TTL = 30 * 60 * 1000;

app.post('/api/chats/:id/export-zip', route(async (req, res) => {
  if (exportJob) return res.status(409).json({ error: 'An export is already running — please wait for it to finish.' });
  const jobId = /^[a-z0-9]{1,40}$/.test(String(req.query.job || '')) ? String(req.query.job) : Date.now().toString(36);
  exportJob = prepareZip(wa, req.params.id, parseQuery(req.query), (p) => io.emit('export-progress', { jobId, ...p }))
    .then((pkg) => {
      const token = crypto.randomBytes(16).toString('hex');
      readyZips.set(token, { pkg, at: Date.now() });
      for (const [t, z] of readyZips) if (Date.now() - z.at > ZIP_TTL) readyZips.delete(t);
      const { zipName, total, saved, failed, messages } = pkg;
      io.emit('export-done', { jobId, url: `/api/download/${token}`, zipName, total, saved, failed, messages });
    })
    .catch((err) => {
      console.error('[export]', err.message);
      io.emit('export-error', { jobId, error: err.message });
    })
    .finally(() => { exportJob = null; });
  res.json({ jobId });
}));

app.get('/api/download/:token', route(async (req, res) => {
  const entry = readyZips.get(req.params.token);
  if (!entry || Date.now() - entry.at > ZIP_TTL) {
    return res.status(404).send('This download has expired — please export again.');
  }
  await streamZip(entry.pkg, res);
}));

wa.on('status', (st) => io.emit('status', st));
wa.on('progress', (p) => io.emit('progress', p));
io.on('connection', (socket) => socket.emit('status', wa.status()));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use - the exporter may already be running.`);
    console.error(`  Open http://localhost:${PORT} or close the other window and try again.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  * WhatsApp Chat Exporter 3D');
  console.log(`  * Open ${url} in your browser${DEMO ? '  (DEMO MODE - sample data)' : ''}`);
  console.log('  * Keep this window open while you use the app. Press Ctrl+C to stop.\n');
  if (OPEN_BROWSER && process.platform === 'win32') exec(`start "" "${url}"`);
  wa.start();
});

process.on('unhandledRejection', (err) => console.warn('[warn]', (err && err.message) || err));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  Closing WhatsApp engine…');
  try { await wa.destroy(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Clean stop (closes WhatsApp's hidden browser properly so the saved login stays valid).
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  setTimeout(shutdown, 100);
});
process.on('SIGHUP', shutdown); // Windows: the server window was closed with X
