'use strict';

// Two ways to run:
//  • PC mode (default, start.bat): one WhatsApp login, only this computer can open it (127.0.0.1).
//  • Cloud mode (CLOUD=1): a public server where every visitor gets their own, isolated WhatsApp
//    session (own QR, own login, own files). Optional ACCESS_CODE keeps strangers out.

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { parseQuery } = require('./src/format');
const { buildWorkbook, exportFileName } = require('./src/excel');
const { prepareZip, streamZip } = require('./src/media');

// `--set=KEY=value` sets an environment variable (handy where env vars are awkward, e.g. local tests).
for (const a of process.argv) {
  const m = /^--set=([A-Z_]+)=(.*)$/.exec(a);
  if (m) process.env[m[1]] = m[2];
}
const arg = (name) => process.argv.includes(`--${name}`);
const DEMO = arg('demo') || process.env.DEMO === '1';
const CLOUD = arg('cloud') || process.env.CLOUD === '1';
const OPEN_BROWSER = !arg('no-open') && !CLOUD;
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg && portArg.split('=')[1]) || Number(process.env.PORT) || 3000;

// ---- cloud settings (environment variables) ----
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // if set, visitors must enter it before a QR is shown
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS) || 2); // each login runs its own Chrome (~400 MB)
const IDLE_MIN = Math.max(5, Number(process.env.IDLE_MINUTES) || 20); // unlinked sessions are dropped after this
const LINKED_IDLE_HOURS = Math.max(1, Number(process.env.LINKED_IDLE_HOURS) || 12); // linked ones: log out after this
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rahulkumarsahu991.github.io')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

const Service = DEMO ? require('./src/demo') : require('./src/whatsapp');

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const sessions = new Map(); // token -> session
const zips = new Map(); // download token -> { pkg, at }
const ZIP_TTL = 30 * 60 * 1000;
let io = null;

function createSession(token, serviceId) {
  const wa = new Service({ id: serviceId });
  const s = { token, wa, room: `s:${token}`, lastSeen: Date.now(), sockets: 0, exportJob: null };
  wa.on('status', (st) => io.to(s.room).emit('status', st));
  wa.on('progress', (p) => io.to(s.room).emit('progress', p));
  sessions.set(token, s);
  return s;
}

async function dropSession(s, why) {
  sessions.delete(s.token);
  console.log(`[session] closed ${s.token.slice(0, 6)}… (${why}) — ${sessions.size} open`);
  io.to(s.room).emit('session-expired');
  try {
    if (typeof s.wa.purge === 'function') await s.wa.purge(); else await s.wa.destroy();
  } catch (err) {
    console.warn('[session] cleanup failed:', err.message);
  }
}

// PC mode: exactly one session, always there.
const LOCAL_TOKEN = 'local';
if (!CLOUD) createSession(LOCAL_TOKEN, 'exporter');

const tokenOf = (req) => (CLOUD ? String(req.get('X-Session') || req.query.s || '') : LOCAL_TOKEN);
function sessionOf(req) {
  const s = sessions.get(tokenOf(req));
  if (s) s.lastSeen = Date.now();
  return s;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Simple per-IP limit on how often new sessions (= new Chrome instances) can be started.
const sessionStarts = new Map(); // ip -> [timestamps]
function tooManyStarts(ip) {
  const now = Date.now();
  const list = (sessionStarts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  sessionStarts.set(ip, list);
  return list.length > 5;
}

// Cloud housekeeping: free the server from abandoned sessions.
if (CLOUD) {
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.sockets > 0 || s.exportJob) continue;
      const idle = now - s.lastSeen;
      const linked = s.wa.status().state === 'ready';
      if (!linked && idle > IDLE_MIN * 60 * 1000) dropSession(s, 'never linked, idle');
      else if (linked && idle > LINKED_IDLE_HOURS * 3600 * 1000) dropSession(s, 'linked but unused');
    }
    for (const [t, z] of zips) if (now - z.at > ZIP_TTL) zips.delete(t);
  }, 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// HTTP basics: who may call us
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocalHost = (host = '') => LOCAL_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase());
const originAllowed = (origin, host) => {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (!CLOUD) return isLocalHost(o.host);
    return o.host === host || ALLOWED_ORIGINS.includes(o.origin);
  } catch { return false; }
};

io = new Server(server, {
  cors: CLOUD ? { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] } : undefined,
  allowRequest: (req, cb) => cb(null, (CLOUD || isLocalHost(req.headers.host)) && originAllowed(req.headers.origin, req.headers.host)),
});

app.disable('x-powered-by');
app.set('trust proxy', CLOUD); // behind the host's HTTPS proxy
app.use(compression()); // JSON/HTML/JS go out gzip-compressed — much faster on slow connections
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (!CLOUD && !isLocalHost(req.headers.host)) return res.status(403).send('Forbidden');
  const origin = req.headers.origin;
  if (CLOUD && origin && ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, X-App, X-Session',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!originAllowed(origin, req.headers.host)) return res.status(403).json({ error: 'Forbidden' });
  if (req.method === 'POST' && req.get('X-App') !== '1') return res.status(403).json({ error: 'Forbidden' });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: CLOUD ? '1h' : 0 }));

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

// What the page needs to know before it starts.
app.get('/api/config', (req, res) => res.json({ cloud: CLOUD, demo: DEMO, needCode: CLOUD && !!ACCESS_CODE }));

// Start a session (cloud) — returns the token the page sends with every request.
app.post('/api/session', route(async (req, res) => {
  if (!CLOUD) return res.json({ token: LOCAL_TOKEN });
  if (ACCESS_CODE && !safeEqual((req.body && req.body.code) || '', ACCESS_CODE)) {
    return res.status(401).json({ error: 'Wrong access code.', needCode: true });
  }
  if (tooManyStarts(req.ip)) return res.status(429).json({ error: 'Too many attempts — please wait a few minutes.' });
  if (sessions.size >= MAX_SESSIONS) {
    // Make room by closing the longest-idle session that never linked.
    const idle = [...sessions.values()]
      .filter((s) => s.sockets === 0 && s.wa.status().state !== 'ready' && !s.exportJob)
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (idle) await dropSession(idle, 'making room');
    else return res.status(503).json({ error: 'The server is busy with other people right now. Please try again in a few minutes.' });
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const serviceId = `u${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  const s = createSession(token, serviceId);
  console.log(`[session] opened ${token.slice(0, 6)}… — ${sessions.size}/${MAX_SESSIONS}`);
  s.wa.start();
  res.json({ token });
}));

// Everything below belongs to one session.
const api = express.Router();
api.use((req, res, next) => {
  req.s = sessionOf(req);
  if (!req.s) return res.status(401).json({ error: 'Your session has ended — reload the page to start again.', code: 'NO_SESSION' });
  next();
});

api.get('/status', (req, res) => res.json(req.s.wa.status()));

api.get('/debug', route(async (req, res) => {
  const { wa } = req.s;
  res.json(wa.debugState ? await wa.debugState() : { state: wa.status().state });
}));

api.post('/restart', route(async (req, res) => {
  const { wa } = req.s;
  if (typeof wa.retry === 'function') wa.retry(); else wa.restart();
  res.json({ ok: true });
}));

api.post('/logout', route(async (req, res) => {
  await req.s.wa.logout();
  res.json({ ok: true });
}));

if (DEMO) {
  api.post('/demo/scan', route(async (req, res) => {
    req.s.wa.simulateScan();
    res.json({ ok: true });
  }));
}

api.get('/chats', route(async (req, res) => {
  res.json({ chats: await req.s.wa.getChats({ fresh: req.query.fresh === '1' }) });
}));

api.get('/chats/:id/messages', route(async (req, res) => {
  res.json(await req.s.wa.getMessages(req.params.id, parseQuery(req.query)));
}));

api.get('/chats/:id/export', route(async (req, res) => {
  const data = await req.s.wa.getMessages(req.params.id, parseQuery(req.query));
  const buffer = await buildWorkbook(data);
  res.attachment(exportFileName(data.chat.name));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(buffer));
}));

// ---- photos / videos / voice notes / documents ----
api.get('/media/:id/thumb', route(async (req, res) => {
  const thumb = await req.s.wa.getThumb(req.params.id);
  if (!thumb) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(thumb.type).send(thumb.buffer);
}));

api.get('/media/:id', route(async (req, res) => {
  const file = await req.s.wa.getMediaFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'This media is no longer available on WhatsApp.' });
  if (req.query.download === '1') return res.download(file.path, file.filename || path.basename(file.path));
  res.sendFile(file.path, { headers: { 'Content-Type': file.mimetype, 'Cache-Control': 'private, max-age=86400' } });
}));

// Excel + all media as ONE .zip that the browser downloads directly.
// Step 1 (POST) gathers the media with progress over the socket; step 2 (GET) streams the zip.
api.post('/chats/:id/export-zip', route(async (req, res) => {
  const s = req.s;
  if (s.exportJob) return res.status(409).json({ error: 'An export is already running — please wait for it to finish.' });
  const jobId = /^[a-z0-9]{1,40}$/.test(String(req.query.job || '')) ? String(req.query.job) : Date.now().toString(36);
  const emit = (event, data) => io.to(s.room).emit(event, { jobId, ...data });
  s.exportJob = prepareZip(s.wa, req.params.id, parseQuery(req.query), (p) => emit('export-progress', p))
    .then((pkg) => {
      const token = crypto.randomBytes(16).toString('hex');
      zips.set(token, { pkg, at: Date.now() });
      const { zipName, total, saved, failed, messages } = pkg;
      emit('export-done', { url: `/api/download/${token}`, zipName, total, saved, failed, messages });
    })
    .catch((err) => {
      console.error('[export]', err.message);
      emit('export-error', { error: err.message });
    })
    .finally(() => { s.exportJob = null; });
  res.json({ jobId });
}));

// The zip link itself is the secret (random, expires after 30 minutes), so a plain link can download it.
app.get('/api/download/:token', route(async (req, res) => {
  const entry = zips.get(req.params.token);
  if (!entry || Date.now() - entry.at > ZIP_TTL) {
    return res.status(404).send('This download has expired — please export again.');
  }
  await streamZip(entry.pkg, res);
}));

app.use('/api', api);

// ---- live updates ----
io.on('connection', (socket) => {
  const token = CLOUD ? String((socket.handshake.auth && socket.handshake.auth.token) || '') : LOCAL_TOKEN;
  const s = sessions.get(token);
  if (!s) {
    socket.emit('session-expired');
    socket.disconnect(true);
    return;
  }
  s.sockets += 1;
  s.lastSeen = Date.now();
  socket.join(s.room);
  socket.emit('status', s.wa.status());
  socket.on('disconnect', () => {
    s.sockets = Math.max(0, s.sockets - 1);
    s.lastSeen = Date.now();
  });
});

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use - the exporter may already be running.`);
    console.error(`  Open http://localhost:${PORT} or close the other window and try again.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, CLOUD ? '0.0.0.0' : '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  * WhatsApp Chat Exporter');
  if (CLOUD) {
    console.log(`  * Cloud mode on port ${PORT}${DEMO ? ' (DEMO data)' : ''} — up to ${MAX_SESSIONS} people at once`);
    console.log(`  * Access code: ${ACCESS_CODE ? 'required' : 'OFF (anyone with the link can use it)'}`);
    console.log(`  * Website origins allowed: ${ALLOWED_ORIGINS.join(', ') || '(same site only)'}\n`);
  } else {
    console.log(`  * Open ${url} in your browser${DEMO ? '  (DEMO MODE - sample data)' : ''}`);
    console.log('  * Keep this window open while you use the app. Press Ctrl+C to stop.\n');
    if (OPEN_BROWSER && process.platform === 'win32') exec(`start "" "${url}"`);
    sessions.get(LOCAL_TOKEN).wa.start();
  }
});

process.on('unhandledRejection', (err) => console.warn('[warn]', (err && err.message) || err));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  Closing WhatsApp engine…');
  await Promise.all([...sessions.values()].map((s) => s.wa.destroy().catch(() => {})));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // Windows: the server window was closed with X

// Clean stop for the PC app (closes WhatsApp's hidden browser properly so the saved login stays valid).
if (!CLOUD) {
  app.post('/api/shutdown', (req, res) => {
    res.json({ ok: true });
    setTimeout(shutdown, 100);
  });
}
