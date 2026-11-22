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

// App data lives in C:\Users\<you>\WhatsAppChatExporter (same folder as src/whatsapp.js uses).
const ROOT = process.env.DATA_DIR || path.join(os.homedir(), 'WhatsAppChatExporter');
const NGROK = path.join(ROOT, 'ngrok', process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
const SETTINGS = path.join(ROOT, 'mobile-settings.json');
const POLICY = path.join(ROOT, 'ngrok-policy.yml');
const NGROK_ZIP = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const PORT = 3000;

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
  require('./server.js'); // the normal exporter, now also reachable at https://<domain>
})().catch((err) => {
  console.error(`\n  Phone access could not start: ${err.message}\n`);
  process.exitCode = 1;
});
