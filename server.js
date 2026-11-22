'use strict';

// Who gets which WhatsApp login:
//  • This PC (http://localhost:3000): the owner's saved login.
//  • The shared link (start-mobile.bat → ngrok tunnel → this PC):
//     – https://<link>/owner  Google sign-in, only the owner's Gmail → the owner's login on that device;
//     – https://<link>        anyone with the link gets their OWN temporary login (scan a QR, or type a
//                             code on a phone). Nobody sees the owner's chats or anyone else's. A guest
//                             login is unlinked and deleted when they log out, when they leave
//                             (GUEST_IDLE_MIN), and when the app stops.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const compression = require('compression');
const express = require('express');
const { Server } = require('socket.io');
const { parseQuery } = require('./src/format');
const { buildWorkbook, exportFileName } = require('./src/excel');
const { prepareZip, streamZip } = require('./src/media');
const { SheetSync, photoFile } = require('./src/sheets');

const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const OPEN_BROWSER = !process.argv.includes('--no-open');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg && portArg.split('=')[1]) || Number(process.env.PORT) || 3000;

const Service = DEMO ? require('./src/demo') : require('./src/whatsapp');

// ---- who may call us ----
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostOnly = (host = '') => host.replace(/:\d+$/, '').toLowerCase();
const isLocalHost = (host = '') => LOCAL_HOSTS.has(hostOnly(host));
const isLocalOrigin = (origin) => {
  if (!origin) return true;
  try { return isLocalHost(new URL(origin).host); } catch { return false; }
};

// Set by mobile.js. Without PUBLIC_HOST nothing but this computer can open the app.
const PUBLIC_HOST = hostOnly(String(process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
const ALLOWED_EMAILS = String(process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const OWNER_KEY = String(process.env.OWNER_KEY || ''); // secret in the owner's cookie after Google sign-in
const isPublicHost = (host = '') => !!PUBLIC_HOST && hostOnly(host) === PUBLIC_HOST;
const isPublicOrigin = (origin) => {
  if (!origin) return true;
  try { return isPublicHost(new URL(origin).host); } catch { return false; }
};
// ngrok's traffic policy deletes any x-wa-exporter-email header a visitor sends and, on /owner only,
// sets it to the Google account that signed in.
const signedInEmail = (headers) => String(headers['x-wa-exporter-email'] || '').trim().toLowerCase();

// ---- guest limits ----
const MAX_GUESTS = Math.max(1, Number(process.env.MAX_GUESTS) || 3); // each login runs its own Chrome (~300 MB)
const GUEST_IDLE_MIN = Math.max(5, Number(process.env.GUEST_IDLE_MINUTES) || 20); // page closed this long → logged out
const GUEST_QR_MIN = 15; // never linked after this long → closed (even with the page open)
const GUEST_MAX_HOURS = 3; // linked but not used for this long → logged out (even with the page open)

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ }
  }
  return out;
}

function cookie(name, value, { maxAge, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').includes('https');

/** Which login a request (or socket) belongs to: { owner: true } or { token } of a guest ('' = none yet). */
function identify(headers) {
  if (isLocalHost(headers.host)) return { owner: true };
  const c = parseCookies(headers.cookie);
  if (OWNER_KEY && c.wa_owner && safeEqual(c.wa_owner, OWNER_KEY)) return { owner: true };
  return { owner: false, token: /^[A-Za-z0-9_-]{32}$/.test(c.wa_guest || '') ? c.wa_guest : '' };
}

// ---------------------------------------------------------------------------
// Sessions (one per WhatsApp login)
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  allowRequest: (req, cb) => {
    const { host, origin } = req.headers;
    cb(null, (isLocalHost(host) && isLocalOrigin(origin)) || (isPublicHost(host) && isPublicOrigin(origin)));
  },
});

const sessions = new Map(); // key ('owner' or a guest token) -> session
const zips = new Map(); // download token -> { pkg, at }
const ZIP_TTL = 30 * 60 * 1000;

function createSession(key, id, guest, persistent = false) {
  const wa = new Service({ id });
  const s = {
    key, wa, guest, persistent, room: `s:${key}`, createdAt: Date.now(), lastSeen: Date.now(), sockets: 0, exportJob: null, qrSince: 0,
  };
  wa.on('status', (st) => {
    s.qrSince = st.state === 'qr' ? (s.qrSince || Date.now()) : 0;
    io.to(s.room).emit('status', st);
  });
  wa.on('progress', (p) => io.to(s.room).emit('progress', p));
  // Google Sheets sync of this login (settings and progress are saved next to the login).
  s.sync = new SheetSync(wa, wa.paths.sync, { imageDir: wa.paths.sheetImages, imageSid: id });
  s.sync.on('status', (st) => io.to(s.room).emit('sync', st));
  sessions.set(key, s);
  return s;
}

const owner = createSession('owner', 'exporter', false);
const guestCount = () => [...sessions.values()].filter((s) => s.guest).length;

/** A guest who syncs to a sheet keeps their login across restarts (keep.json); others are temporary. */
function setPersistent(s, on) {
  s.persistent = on;
  if (!s.wa.paths.keep) return; // demo
  try {
    if (on) fs.writeFileSync(s.wa.paths.keep, JSON.stringify({ token: s.key, since: new Date().toISOString() }));
    else fs.rmSync(s.wa.paths.keep, { force: true });
  } catch (err) { console.warn('[guest] could not save the keep setting:', err.message); }
}

async function dropGuest(s, why) {
  if (sessions.get(s.key) !== s) return;
  sessions.delete(s.key);
  console.log(`[guest] ${s.key.slice(0, 6)}… closed (${why}) — ${guestCount()}/${MAX_GUESTS} guests`);
  io.to(s.room).emit('session-ended', { why });
  s.sync.dispose();
  try { await s.wa.purge(); } catch (err) { console.warn('[guest] cleanup failed:', err.message); }
}

function sessionOf(req) {
  const who = identify(req.headers);
  const s = who.owner ? owner : sessions.get(who.token);
  if (s) s.lastSeen = Date.now();
  return s;
}

// A few new guest logins per visitor IP (each one starts a Chrome on this PC).
const starts = new Map(); // ip -> [timestamps]
function tooManyStarts(ip) {
  const now = Date.now();
  const list = (starts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  starts.set(ip, list);
  return list.length > 6;
}
const visitorIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// Housekeeping: guests who left are logged out and their files deleted.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.guest || s.exportJob) continue;
    if (s.persistent) {
      // Syncing guests stay — unless WhatsApp asks for a new QR for 15 minutes (they unlinked this device).
      if (s.qrSince && now - s.qrSince > GUEST_QR_MIN * 60 * 1000) dropGuest(s, 'unlinked from the phone');
      continue;
    }
    const idle = now - s.lastSeen;
    const linked = s.wa.status().state === 'ready';
    if (s.sockets === 0 && idle > GUEST_IDLE_MIN * 60 * 1000) dropGuest(s, 'page closed');
    else if (!linked && now - s.createdAt > GUEST_QR_MIN * 60 * 1000 && idle > 5 * 60 * 1000) dropGuest(s, 'never linked');
    else if (linked && idle > GUEST_MAX_HOURS * 3600 * 1000) dropGuest(s, 'not used for hours');
  }
  for (const [t, z] of zips) if (now - z.at > ZIP_TTL) zips.delete(t);
  for (const [ip, list] of starts) if (!list.some((t) => now - t < 10 * 60 * 1000)) starts.delete(ip);
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  const { host, origin } = req.headers;
  if (isPublicHost(host)) {
    if (!isPublicOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });
  } else if (!isLocalHost(host) || !isLocalOrigin(origin)) {
    return res.status(403).send('Forbidden');
  }
  if (req.method === 'POST' && req.get('X-App') !== '1') return res.status(403).json({ error: 'Forbidden' });
  next();
});
// Page files and chat data go out compressed (5-8x smaller): what makes the shared link fast on phones.
// (Photos, videos and ZIPs are already compressed and are sent as they are.)
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '64kb' }));

// The owner's door on the shared link: ngrok asks for Google sign-in here first.
app.get('/owner', (req, res) => {
  if (!isPublicHost(req.headers.host)) return res.redirect('/');
  const email = signedInEmail(req.headers);
  if (!OWNER_KEY || !email || !ALLOWED_EMAILS.includes(email)) {
    console.warn(`[owner] refused ${email || 'a visitor who did not sign in'}`);
    return res.status(403).send(email
      ? `This Google account (${email}) is not the owner's. Open the link without /owner to link your own WhatsApp.`
      : 'Please restart start-mobile.bat so the Google sign-in for /owner is switched on.');
  }
  res.set('Set-Cookie', [
    cookie('wa_owner', OWNER_KEY, { maxAge: 30 * 24 * 3600, secure: isHttps(req) }),
    cookie('wa_guest', '', { maxAge: 0, secure: isHttps(req) }),
  ]);
  console.log(`[owner] ${email} opened the app through the shared link`);
  res.redirect('/');
});

// Photos in the Google Sheet (=IMAGE(...) cells): Google fetches them from here through the link.
// Names are long random hashes made by the sync, so they can't be guessed.
app.get('/sheet-img/:sid/:name', (req, res) => {
  const file = photoFile(req.params.sid, req.params.name);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('jpeg').sendFile(file);
});

// The page asks for /css/app.css?v=… and /js/app.js?v=… (v changes whenever those files change), so
// phones keep them cached and a repeat visit only downloads the small page itself.
const PUBLIC_DIR = path.join(__dirname, 'public');
function assetVersion() {
  const stamp = ['css/app.css', 'js/app.js']
    .map((f) => { try { return fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs; } catch { return 0; } }).join('-');
  return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 10);
}
app.get(['/', '/index.html'], (req, res) => {
  const v = assetVersion();
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('/css/app.css"', `/css/app.css?v=${v}"`)
    .replace('/js/app.js"', `/js/app.js?v=${v}"`);
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
});
app.use((req, res, next) => {
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
});
app.use(express.static(PUBLIC_DIR, { cacheControl: false, index: false }));

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

// The page calls this first: it tells it whose login it is, and starts a guest login when needed.
app.post('/api/session', route(async (req, res) => {
  const who = identify(req.headers);
  if (who.owner) return res.json({ role: 'owner', local: isLocalHost(req.headers.host) });
  const existing = sessions.get(who.token);
  if (existing) {
    existing.lastSeen = Date.now();
    return res.json({ role: 'guest', idleMinutes: GUEST_IDLE_MIN, persistent: existing.persistent });
  }
  if (tooManyStarts(visitorIp(req))) {
    return res.status(429).json({ error: 'Too many new logins from your network — please wait 10 minutes.' });
  }
  if (guestCount() >= MAX_GUESTS) {
    // Make room by closing the longest-idle guest who never linked and has no page open.
    const idle = [...sessions.values()]
      .filter((s) => s.guest && !s.persistent && s.sockets === 0 && !s.exportJob && s.wa.status().state !== 'ready')
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (idle) await dropGuest(idle, 'making room');
    else return res.status(503).json({ error: `${MAX_GUESTS} people are using the app right now. Please try again in a few minutes.`, busy: true });
  }
  const token = crypto.randomBytes(24).toString('base64url'); // 32 characters
  const id = `g${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  const s = createSession(token, id, true);
  console.log(`[guest] ${token.slice(0, 6)}… started — ${guestCount()}/${MAX_GUESTS} guests`);
  s.wa.start();
  res.set('Set-Cookie', cookie('wa_guest', token, { maxAge: 24 * 3600, secure: isHttps(req) }));
  res.json({ role: 'guest', idleMinutes: GUEST_IDLE_MIN, started: true });
}));

// Everything below belongs to the caller's own login.
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

// "Link with phone number instead" (for people who open the link on the phone they want to link).
api.post('/pair', route(async (req, res) => {
  const code = await req.s.wa.requestPairCode(req.body && req.body.phone);
  res.json({ code });
}));

api.post('/logout', route(async (req, res) => {
  if (req.s.guest) {
    await dropGuest(req.s, 'logged out');
    res.set('Set-Cookie', cookie('wa_guest', '', { maxAge: 0, secure: isHttps(req) }));
    return res.json({ ok: true, ended: true });
  }
  // The sheet setting stays: after scanning the same account again, the sync carries on by itself.
  await req.s.wa.logout();
  res.json({ ok: true });
}));

// ---- Google Sheets sync ----
api.get('/sync', (req, res) => res.json(req.s.sync.status()));

api.post('/sync', route(async (req, res) => {
  const s = req.s;
  if (s.wa.status().state !== 'ready') return res.status(409).json({ error: 'Link your WhatsApp first.' });
  const st = await s.sync.connect({ sheet: req.body && req.body.sheet, since: req.body && req.body.since });
  if (s.guest && !s.persistent) {
    setPersistent(s, true);
    // Keep this browser's access to the login for a year (the sync itself doesn't need the page open).
    res.set('Set-Cookie', cookie('wa_guest', s.key, { maxAge: 365 * 24 * 3600, secure: isHttps(req) }));
    console.log(`[guest] ${s.key.slice(0, 6)}… now syncs to Google Sheets — login kept`);
  }
  res.json(st);
}));

api.post('/sync/stop', route(async (req, res) => {
  const s = req.s;
  s.sync.stop();
  if (s.guest && s.persistent) {
    setPersistent(s, false); // back to a temporary login (logged out when unused)
    s.lastSeen = Date.now();
  }
  res.json(s.sync.status());
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

// Many previews in ONE request (one round trip instead of one per photo — much faster over the link).
api.post('/thumbs', route(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 300).map(String) : [];
  const thumbs = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const t = await req.s.wa.getThumb(id);
      if (t) thumbs[id] = `data:${t.type};base64,${t.buffer.toString('base64')}`;
    } catch { /* no preview for this one */ }
  }));
  res.json({ thumbs });
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
    .finally(() => { s.exportJob = null; s.lastSeen = Date.now(); });
  res.json({ jobId });
}));

// The zip link itself is the secret (random, expires after 30 minutes).
app.get('/api/download/:token', route(async (req, res) => {
  const entry = zips.get(req.params.token);
  if (!entry || Date.now() - entry.at > ZIP_TTL) {
    return res.status(404).send('This download has expired — please export again.');
  }
  await streamZip(entry.pkg, res);
}));

// Clean stop, from this PC only (closes the hidden browsers properly so the owner's login stays valid).
app.post('/api/shutdown', (req, res) => {
  if (!isLocalHost(req.headers.host)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true });
  setTimeout(shutdown, 100);
});

app.use('/api', api);

// ---- live updates ----
io.on('connection', (socket) => {
  const who = identify(socket.handshake.headers);
  const s = who.owner ? owner : sessions.get(who.token);
  if (!s) {
    socket.emit('session-ended', { why: 'missing' });
    socket.disconnect(true);
    return;
  }
  s.sockets += 1;
  s.lastSeen = Date.now();
  socket.join(s.room);
  socket.emit('status', s.wa.status());
  socket.emit('sync', s.sync.status());
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

// Temporary guest logins left over from the last run are deleted; guests who sync to a Google Sheet
// keep their login and are started again, so their sheet keeps updating.
const restored = Service.clearGuests().map(({ id, token }) => createSession(token, id, true, true));
if (restored.length) console.log(`[guest] ${restored.length} syncing guest login(s) restored`);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  * WhatsApp Chat Exporter');
  console.log(`  * On this PC: ${url}${DEMO ? '  (DEMO MODE - sample data)' : ''}`);
  if (PUBLIC_HOST) {
    console.log(`  * Send this link to others: https://${PUBLIC_HOST}`);
    console.log(`    Each person links their OWN WhatsApp (up to ${MAX_GUESTS} at a time); nobody sees your chats.`);
    console.log(`  * You on your phone: https://${PUBLIC_HOST}/owner  (Google sign-in: ${ALLOWED_EMAILS.join(', ') || 'nobody - run start-mobile.bat --setup'})`);
  }
  const { isConfigured, botEmail, KEY_FILE } = require('./src/sheets');
  console.log(isConfigured()
    ? `  * Google Sheets sync: ready (bot: ${botEmail()})`
    : `  * Google Sheets sync: not set up yet (put the bot key at ${KEY_FILE})`);
  console.log('  * Keep this window open while the app is in use. Press Ctrl+C to stop.\n');
  if (OPEN_BROWSER && process.platform === 'win32') exec(`start "" "${url}"`);
  owner.wa.start();
  restored.forEach((s, i) => setTimeout(() => s.wa.start(), (i + 1) * 15000)); // one Chrome at a time
});

process.on('unhandledRejection', (err) => console.warn('[warn]', (err && err.message) || err));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  Closing WhatsApp…');
  const guests = [...sessions.values()].filter((s) => s.guest);
  const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
  await Promise.race([
    Promise.all([
      owner.wa.destroy().catch(() => {}),
      // syncing guests keep their login (closed properly, started again next time); the rest are logged out
      ...guests.map((s) => (s.persistent ? s.wa.destroy().catch(() => {}) : dropGuest(s, 'app stopped'))),
    ]),
    timeout,
  ]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // Windows: the server window was closed with X
