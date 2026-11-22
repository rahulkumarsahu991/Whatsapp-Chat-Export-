'use strict';

// Phone / other-device access: runs the normal exporter on this PC plus an ngrok tunnel that gives it
// one fixed https link.
//   https://<link>        share it: every person links their OWN WhatsApp (QR or phone-number code)
//   https://<link>/owner  you: Google sign-in (only the email(s) you choose) → your own saved login
//
//   start-mobile.bat            → first time asks for your ngrok details, then starts everything
//   start-mobile.bat --setup    → change the ngrok token / link / allowed emails

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// App data lives in C:\Users\<you>\WhatsAppChatExporter (same folder as src/whatsapp.js uses).
const ROOT = process.env.DATA_DIR || path.join(os.homedir(), 'WhatsAppChatExporter');
const NGROK = path.join(ROOT, 'ngrok', process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
const SETTINGS = path.join(ROOT, 'mobile-settings.json');
const POLICY = path.join(ROOT, 'ngrok-policy.yml');
const NGROK_ZIP = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const PORT = 3000;
// Google Sheet photos: Google's image fetcher gets ngrok's free-plan warning page, so the photos go
// through a free Cloudflare "quick tunnel" to a photo-only server instead (no account needed).
const CLOUDFLARED = path.join(ROOT, 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const PHOTO_PORT = PORT + 11;

const EMAIL = /^[^\s@'",]+@[^\s@'",]+\.[^\s@'",]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function openInBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
}

async function ensureNgrok() {
  if (fs.existsSync(NGROK)) return;
  if (process.platform !== 'win32') throw new Error(`Please install ngrok and put it at ${NGROK}`);
  console.log('  Downloading ngrok (one time, about 12 MB)…');
  fs.mkdirSync(path.dirname(NGROK), { recursive: true });
  const zip = path.join(os.tmpdir(), `ngrok-${Date.now()}.zip`);
  const res = await fetch(NGROK_ZIP);
  if (!res.ok) throw new Error(`ngrok download failed (${res.status})`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${path.dirname(NGROK).replace(/'/g, "''")}' -Force`],
  { stdio: 'inherit' });
  fs.rmSync(zip, { force: true });
}

async function setup() {
  console.log('\n  ===== Phone access setup (one time) =====\n');
  console.log('  1) Make a free ngrok account (Google sign-up is fine). Your authtoken page opens now.');
  openInBrowser('https://dashboard.ngrok.com/get-started/your-authtoken');
  let token = '';
  while (!token) token = await ask('     Paste your ngrok Authtoken here, then press Enter: ');
  execFileSync(NGROK, ['config', 'add-authtoken', token], { stdio: 'inherit' });

  console.log('\n  2) Your free fixed link: the Domains page opens now — copy the domain shown there');
  console.log('     (it looks like  something-something.ngrok-free.dev ; click "+ New Domain" if none).');
  openInBrowser('https://dashboard.ngrok.com/domains');
  let domain = '';
  while (!DOMAIN.test(domain)) {
    domain = (await ask('     Paste the domain here: ')).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  console.log('\n  3) Who may open the app? Only these Google accounts get in (your own Gmail).');
  let emails = [];
  while (!emails.length || !emails.every((e) => EMAIL.test(e))) {
    emails = (await ask('     Google email(s), comma separated: ')).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  }

  const settings = { domain, emails, ownerKey: crypto.randomBytes(24).toString('base64url') };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log('\n  Saved. Next time just double-click start-mobile.bat.\n');
  return settings;
}

/**
 * ngrok traffic policy:
 *  - every request: drop any x-wa-exporter-email header the visitor sent (nobody can fake it);
 *  - /owner only: Google sign-in → block every other account → pass the signed-in email to the app,
 *    which then lets that browser use the owner's WhatsApp.
 * Everything else is open: each visitor gets their own WhatsApp login, so they only ever see their own chats.
 */
function writePolicy(emails) {
  const list = emails.map((e) => `'${e}'`).join(', ');
  // (/ngrok/… are ngrok's own sign-in/sign-out pages; they must go through the oauth step too)
  const OWNER_PATH = "(req.url.path.startsWith('/owner') || req.url.path.startsWith('/ngrok/'))";
  fs.writeFileSync(POLICY, [
    'on_http_request:',
    '  - actions:',
    '      - type: remove-headers',
    '        config:',
    '          headers:',
    '            - x-wa-exporter-email',
    '  - expressions:',
    `      - "${OWNER_PATH}"`,
    '    actions:',
    '      - type: oauth',
    '        config:',
    '          provider: google',
    '  - expressions:',
    `      - "${OWNER_PATH} && !(actions.ngrok.oauth.identity.email in [${list}])"`,
    '    actions:',
    '      - type: deny',
    '        config:',
    '          status_code: 403',
    '  - expressions:',
    `      - "${OWNER_PATH}"`,
    '    actions:',
    '      - type: add-headers',
    '        config:',
    '          headers:',
    '            x-wa-exporter-email: "${actions.ngrok.oauth.identity.email}"',
    '',
  ].join('\n'));
}

function startTunnel(domain) {
  const child = spawn(NGROK, [
    'http', String(PORT), '--url', `https://${domain}`, '--traffic-policy-file', POLICY,
    '--log', 'stdout', '--log-format', 'logfmt', '--log-level', 'warn',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const show = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const err = /err="?([^"]+)"?/.exec(line) || /(ERR_NGROK_\d+[^\n]*)/.exec(line);
      if (err) console.warn(`  [ngrok] ${err[1]}`);
    }
  };
  child.stdout.on('data', show);
  child.stderr.on('data', show);
  child.on('exit', (code) => {
    if (code) console.warn(`  [ngrok] stopped (code ${code}). The phone link is offline; the app still works on this PC.`);
  });
  process.on('exit', () => { try { child.kill(); } catch { /* already gone */ } });
  return child;
}

/** Downloads url (or the byte range [from, to]) into file; gives up if no data arrives for 60 s. */
async function downloadPart(url, file, from, to) {
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), 60000);
  const keepAlive = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), 60000); };
  try {
    const headers = from !== undefined ? { Range: `bytes=${from}-${to}` } : {};
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Readable.fromWeb(res.body);
    body.on('data', keepAlive);
    await pipeline(body, fs.createWriteStream(file));
  } finally {
    clearTimeout(stall);
  }
}

/**
 * Downloads a big file in 6 pieces at once (GitHub's downloads can be very slow per connection on
 * some networks), retrying a piece that stalls; falls back to one plain download.
 */
async function downloadFile(url, file) {
  const PIECES = 6;
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const size = Number(head.headers.get('content-length')) || 0;
  if (!head.ok || !size || head.headers.get('accept-ranges') !== 'bytes') return downloadPart(url, file);
  const finalUrl = head.url; // after GitHub's redirect
  const step = Math.ceil(size / PIECES);
  const parts = Array.from({ length: PIECES }, (_, i) => ({ from: i * step, to: Math.min(size, (i + 1) * step) - 1, file: `${file}.${i}` }));
  await Promise.all(parts.map(async (p) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await downloadPart(finalUrl, p.file, p.from, p.to);
        if (fs.statSync(p.file).size !== p.to - p.from + 1) throw new Error('piece incomplete');
        return;
      } catch (err) {
        if (attempt >= 6) throw err;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }));
  const out = fs.createWriteStream(file);
  for (const p of parts) {
    await new Promise((resolve, reject) => {
      const src = fs.createReadStream(p.file);
      src.on('error', reject);
      src.on('end', resolve);
      src.pipe(out, { end: false });
    });
    fs.rmSync(p.file, { force: true });
  }
  await new Promise((resolve) => out.end(resolve));
}

/** Cloudflare's tunnel program (official build from Cloudflare's GitHub), downloaded once. */
async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED)) return true;
  if (process.platform !== 'win32') return false;
  console.log('  Downloading the Cloudflare tunnel for Google Sheet photos in the background (one time, about 55 MB)…');
  fs.mkdirSync(path.dirname(CLOUDFLARED), { recursive: true });
  const part = `${CLOUDFLARED}.part`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await downloadFile(CLOUDFLARED_URL, part);
      if (fs.statSync(part).size < 10 * 1024 * 1024) throw new Error('the file is too small');
      fs.renameSync(part, CLOUDFLARED);
      console.log('  [photos] Cloudflare tunnel downloaded');
      return true;
    } catch (err) {
      fs.rmSync(part, { force: true });
      for (let i = 0; i < 6; i += 1) fs.rmSync(`${part}.${i}`, { force: true });
      const why = err.name === 'AbortError' ? 'the download stalled' : err.message;
      console.warn(`  [photos] Cloudflare download attempt ${attempt} failed (${why})${attempt < 5 ? ', trying again' : ''}`);
      await new Promise((r) => setTimeout(r, 15000 * attempt));
    }
  }
  console.warn('  [photos] could not download the Cloudflare tunnel. Sheet photos stay off until the next start.');
  return false;
}

/** In the background: get the tunnel program, start it, and point the sheets' photos at it. */
async function setupPhotoTunnel() {
  if (!(await ensureCloudflared())) return;
  startPhotoTunnel((host) => {
    if (process.env.PHOTO_HOST === host) return;
    process.env.PHOTO_HOST = host;
    console.log(`  * Google Sheet photos go through https://${host}`);
    require('./src/sheets').photoHostChanged(); // the sheets switch their photo links to this address
  });
}

/** Runs the photo tunnel (restarting it if it stops); onHost(host) whenever its address is known/changes. */
function startPhotoTunnel(onHost) {
  let child = null;
  let tries = 0;
  let quitting = false;
  const run = () => {
    child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PHOTO_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const read = (chunk) => {
      const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(String(chunk));
      if (m) { tries = 0; onHost(m[1].toLowerCase()); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      if (quitting) return;
      tries += 1;
      const wait = Math.min(300, 10 * tries);
      console.warn(`  [photos] Cloudflare tunnel stopped (code ${code}); starting it again in ${wait}s`);
      setTimeout(run, wait * 1000);
    });
  };
  run();
  process.on('exit', () => { quitting = true; try { child.kill(); } catch { /* already gone */ } });
}

(async () => {
  await ensureNgrok();
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* first run */ }
  if (!settings || process.argv.includes('--setup')) settings = await setup();
  if (!settings.ownerKey) {
    // Secret for the owner's browser cookie (set after Google sign-in at /owner). New setup = new key.
    settings.ownerKey = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  }

  writePolicy(settings.emails);
  if (process.argv.includes('--print-policy')) {
    console.log(fs.readFileSync(POLICY, 'utf8'));
    return;
  }
  process.env.PUBLIC_HOST = settings.domain;
  process.env.ALLOWED_EMAILS = settings.emails.join(',');
  process.env.OWNER_KEY = settings.ownerKey;
  startTunnel(settings.domain);
  process.env.PHOTO_PORT = String(PHOTO_PORT);
  require('./server.js'); // the normal exporter, now also reachable at https://<domain>
  // Sheet photos: never holds up the app; photo links switch over once the tunnel is up.
  setupPhotoTunnel().catch((err) => console.warn(`  [photos] ${err.message}`));
})().catch((err) => {
  console.error(`\n  Phone access could not start: ${err.message}\n`);
  process.exitCode = 1;
});
