'use strict';

// Real WhatsApp connection, using whatsapp-web.js (it runs WhatsApp Web in a hidden
// Chrome window and links it to your phone through the "Linked devices" QR code).

const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { SYSTEM_TYPES, TYPE_LABELS, timeParts, inRange, cacheKey } = require('./format');
const { extFor, Semaphore } = require('./media');

// The login session is kept outside OneDrive so OneDrive sync can't lock Chrome's profile files.
const SESSION_ROOT = process.env.DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'WhatsAppChatExporter');

/**
 * Folders of one login session. The PC app uses the id 'exporter' (the original folder names, so an
 * existing login keeps working); every cloud visitor gets their own id and their own folders.
 */
function sessionPaths(id) {
  const sfx = id === 'exporter' ? '' : `-${id}`;
  return {
    sessionDir: path.join(SESSION_ROOT, `session-${id}`),
    ok: path.join(SESSION_ROOT, `session-ok${sfx}`), // written once a login reaches "ready"
    media: path.join(SESSION_ROOT, `media-cache${sfx}`), // downloaded photos/videos, reused by preview + export
    people: path.join(SESSION_ROOT, `people-cache${sfx}.json`), // sender names/numbers, so groups reopen fast
    // Chrome's HTTP cache lives outside the session folder, so WhatsApp Web's ~10 MB of scripts are
    // downloaded once and reused — even after a logout wipes the session (a big win on slow internet).
    browserCache: path.join(SESSION_ROOT, `browser-cache${sfx}`),
  };
}
const PEOPLE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_MSG_REFS = 40000;
const CACHE_TTL = 10 * 60 * 1000;
const CHAT_LIST_TTL = 2 * 60 * 1000;
const LOAD_TIMEOUT_MS = 3 * 60 * 1000; // whatsapp-web.js gives WhatsApp Web only 30 s to load by default
const READY_WATCHDOG_MS = 5 * 60 * 1000; // linked, but no sync progress for this long → reconnect
const MAX_STUCK_RESTARTS = 2;
const MAX_START_RETRIES = 8;
const TRANSIENT_ERROR = /net::ERR_|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Navigation timeout|socket hang up|auth timeout|Waiting failed|exceeded|timed out|Target closed|Protocol error/i;
const MAX_FETCH = 2000000;

/**
 * LocalAuth tuned for this app:
 *  - On Windows, whatsapp-web.js tries to delete the session folder while Chrome still has it open
 *    after a failed link (EBUSY) and then stops producing QR codes. WhatsApp Web has already wiped its
 *    own data at that point, so we skip the delete; stale folders are cleared before the next launch.
 *  - Skips downloading everyone's profile photos and web fonts while WhatsApp Web loads and syncs.
 *    (Message photos/videos come from other servers and are not affected.)
 */
class ExporterAuth extends LocalAuth {
  async logout() {
    try { await super.logout(); } catch { /* folder locked by the running browser — cleared on next start */ }
  }

  async afterBrowserInitialized() {
    await super.afterBrowserInitialized();
    const page = this.client && this.client.pupPage;
    if (!page || page.__lean) return;
    page.__lean = true;
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', {
        urls: ['*pps.whatsapp.net*', '*.woff2*', '*.woff?*', '*.ttf*'],
      });
    } catch (err) {
      console.warn('[whatsapp] could not trim network requests:', err.message);
    }
  }
}

function findBrowser() {
  const candidates = [process.env.CHROME_PATH];
  try {
    candidates.push(require('puppeteer').executablePath());
  } catch { /* puppeteer's own Chrome is not downloaded */ }
  for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    candidates.push(
      path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }
  // Linux servers / Docker
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome');
  return candidates.find((p) => p && fs.existsSync(p));
}

// If the server window was closed abruptly, its hidden Chrome can survive and keep the session
// folder locked, which makes the next start fail. Close only Chrome/Edge processes using our session folder.
function killStaleBrowsers(sessionDir) {
  if (process.platform !== 'win32') return;
  const dir = sessionDir.replace(/'/g, "''");
  const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | "
    + `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | `
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, stdio: 'ignore', windowsHide: true });
  } catch { /* nothing to clean up, or PowerShell unavailable */ }
}

const idStr = (v) => (typeof v === 'string' ? v : (v && v._serialized) || '');

// For photos/videos WhatsApp keeps a small JPEG preview (base64) in the raw message body.
function thumbOf(m) {
  const b = m && m.hasMedia && m._data && m._data.body;
  if (typeof b !== 'string' || b.length < 200 || b.length > 400000) return null;
  return /^[A-Za-z0-9+/]+$/.test(b.slice(0, 200)) ? b : null;
}

function describe(m) {
  const data = m._data || {};
  const type = m.type || 'chat';
  let typeLabel = TYPE_LABELS[type] || type;
  if (type === 'video' && data.isGif) typeLabel = 'GIF';
  let text = String(m.body || '').trim();

  switch (type) {
    case 'revoked':
      text = 'This message was deleted';
      break;
    case 'location': {
      const l = m.location || {};
      const place = l.name || l.address || l.description || '';
      const coords = l.latitude != null ? `${l.latitude}, ${l.longitude}` : '';
      text = [place, coords].filter(Boolean).join(' — ');
      break;
    }
    case 'vcard':
    case 'multi_vcard': {
      const cards = m.vCards && m.vCards.length ? m.vCards : [text];
      text = cards.map((v) => (/FN:(.*)/.exec(v) || [])[1]).filter(Boolean).join(', ') || 'Contact card';
      break;
    }
    case 'poll_creation':
      text = m.pollName || data.pollName || text;
      break;
    case 'ciphertext':
      text = 'Waiting for this message';
      break;
    default:
  }
  return { type, typeLabel, text, isMedia: !!m.hasMedia };
}

class WhatsAppService extends EventEmitter {
  /** @param {{ id?: string }} [opts] session id ('exporter' = the PC app's single session) */
  constructor(opts = {}) {
    super();
    this.clientId = opts.id || 'exporter';
    this.paths = sessionPaths(this.clientId);
    this.client = null;
    this.state = 'idle';
    this.message = '';
    this.qr = null;
    this.me = null;
    this.progress = 0;
    this.stopping = false;
    this.people = new Map(); // author id -> { name, phone }
    this.cache = new Map(); // cacheKey -> { at, data }
    this.chatList = null; // { at, data } — the chat list is slow to build, so keep it briefly
    this.chatListJob = null; // in-flight getChats() shared by concurrent callers
    this.startRetries = 0; // automatic retries after network errors while starting
    this.stuckRestarts = 0; // automatic reconnects when sync never reaches "ready"
    this.retryTimer = null;
    this.readyTimer = null;
    this.msgRefs = new Map(); // message id -> whatsapp-web.js Message (media messages only)
    this.mediaJobs = new Map(); // cache key -> in-flight download
    this.mediaQueue = new Semaphore(5);
    this.loadPeople();
    this.lock = Promise.resolve(); // one heavy WhatsApp job at a time
  }

  status() {
    return { state: this.state, message: this.message, qr: this.qr, me: this.me, progress: this.progress, demo: false };
  }

  set(state, message) {
    if (state === 'error' && message !== this.message) console.warn(`[whatsapp] ${message}`);
    this.state = state;
    this.message = message;
    this.emit('status', this.status());
  }

  /** A login that never reached "ready" can leave half-written data that makes the next link fail. */
  clearUnfinishedSession() {
    if (fs.existsSync(this.paths.ok) || !fs.existsSync(this.paths.sessionDir)) return;
    try {
      fs.rmSync(this.paths.sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      console.log('[whatsapp] cleared an unfinished login session — a fresh QR will be shown');
    } catch (err) {
      console.warn('[whatsapp] could not clear old session:', err.message);
    }
  }

  markSession(valid) {
    try {
      if (valid) fs.writeFileSync(this.paths.ok, new Date().toISOString());
      else fs.rmSync(this.paths.ok, { force: true });
    } catch { /* not critical */ }
  }

  async start() {
    if (this.client) return;
    this.progress = 0;
    this.startedAt = Date.now();
    this.lastSyncProgressAt = 0;
    this.set('starting', 'Opening WhatsApp Web…');
    killStaleBrowsers(this.paths.sessionDir);
    this.clearUnfinishedSession();

    // Timing of each login step, printed in the server window to see where time goes.
    const t0 = Date.now();
    const logged = new Set();
    const mark = (step) => {
      if (logged.has(step)) return;
      logged.add(step);
      console.log(`[login] ${step} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    };

    const client = new Client({
      authStrategy: new ExporterAuth({ clientId: this.clientId, dataPath: SESSION_ROOT }),
      authTimeoutMs: LOAD_TIMEOUT_MS,
      puppeteer: {
        headless: true,
        executablePath: findBrowser(),
        protocolTimeout: 15 * 60 * 1000, // loading big groups can take minutes
        // A lean browser: no extensions, sync, translate or background services competing with WhatsApp's sync.
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
          '--no-default-browser-check', '--disable-extensions', '--disable-default-apps', '--disable-sync',
          '--disable-background-networking', '--disable-component-update', '--mute-audio',
          '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion',
          `--disk-cache-dir=${this.paths.browserCache}`, '--disk-cache-size=268435456',
        ],
      },
    });
    this.client = client;
    const current = () => this.client === client;

    client.on('qr', async (code) => {
      if (!current()) return;
      mark('QR code shown');
      clearTimeout(this.qrWait);
      this.qr = await QRCode.toDataURL(code, {
        margin: 1, width: 380, errorCorrectionLevel: 'M', color: { dark: '#111417', light: '#ffffff' },
      });
      this.set('qr', 'Scan this QR code with WhatsApp → Linked devices');
    });
    // WhatsApp keeps sending sync progress (and can re-announce auth) after "ready";
    // once ready, those must not push the app back to the login screen.
    client.on('authenticated', () => {
      if (!current() || this.state === 'ready') return;
      mark('linked (authenticated)');
      this.qr = null;
      this.set('authenticated', 'Device linked! Opening your chats…');
      this.armReadyWatchdog(client);
    });
    client.on('loading_screen', (percent) => {
      if (!current() || this.state === 'ready') return;
      mark('sync started');
      this.lastSyncProgressAt = Date.now(); // the watchdog leaves a slow-but-moving sync alone
      this.armReadyWatchdog(client);
      this.qr = null;
      this.progress = Number(percent) || 0;
      this.set('loading', `Syncing your chats… ${this.progress}%`);
    });
    client.on('auth_failure', (msg) => {
      if (!current()) return;
      this.set('error', `Login failed (${msg}). Click Retry to get a fresh QR code.`);
    });
    client.on('ready', () => {
      if (!current()) return;
      mark('ready');
      const info = client.info || {};
      this.me = {
        name: info.pushname || 'You',
        number: info.wid ? info.wid.user : '',
        id: info.wid ? info.wid._serialized : '',
      };
      this.progress = 100;
      clearTimeout(this.readyTimer);
      this.watchdogFor = null;
      this.startRetries = 0;
      this.stuckRestarts = 0;
      this.markSession(true);
      this.set('ready', 'Connected');
      // Build the chat list right away so it is waiting when the page asks for it.
      this.getChats().catch((err) => console.warn('[chats] warm-up failed:', err.message));
    });
    client.on('disconnected', (reason) => {
      console.warn(`[whatsapp] disconnected: ${reason}${reason === 'LOGOUT' ? ' (link failed, or the device was unlinked from the phone)' : ''}`);
      if (!current() || this.stopping) return;
      this.markSession(false);
      this.me = null;
      clearTimeout(this.readyTimer);
      this.watchdogFor = null;
      // After a LOGOUT the same page reloads and shows a fresh QR — no need to relaunch the browser
      // and download WhatsApp Web again (that took 90 s on a slow connection).
      setTimeout(() => {
        if (!current() || this.stopping) return;
        const alive = client.pupBrowser && client.pupBrowser.isConnected();
        if (reason === 'LOGOUT' && alive) {
          this.qr = null;
          this.set('starting', 'Linking did not finish (weak connection?). A fresh QR code is coming — please scan again.');
          clearTimeout(this.qrWait);
          this.qrWait = setTimeout(() => {
            if (current() && this.state !== 'qr' && this.state !== 'ready' && !this.stopping) this.restart();
          }, 90 * 1000);
        } else {
          this.set('disconnected', `WhatsApp disconnected (${reason}). Preparing a new QR code…`);
          this.restart();
        }
      }, 300);
    });

    try {
      await client.initialize();
    } catch (err) {
      if (!current()) return;
      this.client = null;
      try { await client.destroy(); } catch { /* already closed */ }
      const message = (err && err.message) || String(err);
      if (TRANSIENT_ERROR.test(message) && this.startRetries < MAX_START_RETRIES) {
        // Wi-Fi switch, VPN, sleep/wake… try again by itself with a growing delay.
        this.startRetries += 1;
        const delay = Math.min(60, 5 * 2 ** (this.startRetries - 1));
        console.warn(`[start] ${message} — retry ${this.startRetries}/${MAX_START_RETRIES} in ${delay}s`);
        this.set('starting', `Slow or unstable internet — trying again in ${delay}s (attempt ${this.startRetries + 1})…`);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.start(), delay * 1000);
        return;
      }
      this.set('error', `Could not start WhatsApp Web: ${message}`);
    }
  }

  /**
   * Cloud: end this visitor's session for good — unlink the device from their phone if it is linked,
   * close the browser and delete every file kept for them on the server.
   */
  async purge() {
    this.stopping = true;
    try {
      if (this.client && this.state === 'ready') await this.client.logout();
    } catch (err) {
      console.warn('[purge] logout failed:', err.message);
    }
    await this.destroy();
    clearTimeout(this.peopleTimer);
    this.people.clear();
    const { sessionDir, ok, media, people, browserCache } = this.paths;
    for (const p of [sessionDir, ok, media, people, browserCache]) {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* best effort */ }
    }
  }

  /** Manual "Retry" button: start over with fresh retry budgets. */
  retry() {
    this.startRetries = 0;
    this.stuckRestarts = 0;
    return this.restart();
  }

  armReadyWatchdog(client) {
    if (this.watchdogFor === client) return; // already armed for this connection
    this.watchdogFor = client;
    clearTimeout(this.readyTimer);
    const check = () => {
      if (this.client !== client || this.state === 'ready') return;
      // Still receiving sync progress? Then it is just slow — keep waiting.
      const quietFor = Date.now() - (this.lastSyncProgressAt || 0);
      if (quietFor < READY_WATCHDOG_MS) {
        this.readyTimer = setTimeout(check, READY_WATCHDOG_MS - quietFor + 1000);
        return;
      }
      if (this.stuckRestarts >= MAX_STUCK_RESTARTS) {
        this.set('error', 'WhatsApp is taking too long to sync. Check your internet and phone, then press Retry.');
        return;
      }
      this.stuckRestarts += 1;
      console.warn(`[sync] not ready after ${READY_WATCHDOG_MS / 1000}s — reconnecting (${this.stuckRestarts}/${MAX_STUCK_RESTARTS})`);
      this.set('starting', 'Sync is taking too long — reconnecting (no new QR needed)…');
      this.restart();
    };
    this.lastSyncProgressAt = this.lastSyncProgressAt || Date.now();
    this.readyTimer = setTimeout(check, READY_WATCHDOG_MS);
  }

  async destroy() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.readyTimer);
    clearTimeout(this.qrWait);
    this.watchdogFor = null;
    const c = this.client;
    this.client = null;
    this.qr = null;
    this.me = null;
    this.cache.clear(); // (sender names in this.people survive reconnects; logout clears them)
    this.msgRefs.clear();
    this.chatList = null;
    this.chatListJob = null;
    if (c) {
      try { await c.destroy(); } catch { /* browser already gone */ }
    }
  }

  async restart() {
    if (this.stopping) return;
    this.stopping = true;
    try { await this.destroy(); } finally { this.stopping = false; }
    this.start();
  }

  async logout() {
    console.log('[whatsapp] log out requested from the app');
    this.stopping = true;
    const c = this.client;
    try {
      if (c && this.state === 'ready') await c.logout();
    } catch (err) {
      console.warn('[logout]', err.message);
    }
    await this.destroy();
    clearTimeout(this.peopleTimer);
    this.people.clear();
    this.markSession(false);
    for (const dir of [this.paths.sessionDir, this.paths.media, this.paths.people]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      } catch (err) {
        console.warn('[logout] could not remove', dir, err.message);
      }
    }
    this.stopping = false;
    this.start();
  }

  /** Connection details of the hidden WhatsApp Web page, for troubleshooting (no chat data). */
  async debugState() {
    const page = this.client && this.client.pupPage;
    if (!page) return { page: false, state: this.state };
    const pageState = await Promise.race([
      page.evaluate(() => {
        let socket = {};
        try {
          const s = window.require('WAWebSocketModel').Socket;
          socket = { socketState: s.state, hasSynced: s.hasSynced, stream: s.stream };
        } catch (e) { socket = { error: String(e) }; }
        return { url: location.href, title: document.title, injected: typeof window.WWebJS !== 'undefined', ...socket };
      }),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: 'page did not answer in 10s' }), 10000)),
    ]);
    return { state: this.state, hasInfo: !!this.client.info, ...pageState };
  }

  ensureReady() {
    if (!this.client || this.state !== 'ready') {
      const err = new Error('WhatsApp is not connected yet — please scan the QR code first.');
      err.status = 409;
      throw err;
    }
  }

  run(job) {
    const p = this.lock.then(job, job);
    this.lock = p.catch(() => {});
    return p;
  }

  async getChats({ fresh = false } = {}) {
    this.ensureReady();
    if (!fresh && this.chatList && Date.now() - this.chatList.at < CHAT_LIST_TTL) return this.chatList.data;
    if (!this.chatListJob) {
      const client = this.client;
      this.chatListJob = this.buildChatList(client)
        .then((data) => {
          if (this.client === client) this.chatList = { at: Date.now(), data };
          return data;
        })
        .finally(() => { this.chatListJob = null; });
    }
    return this.chatListJob;
  }

  async buildChatList(client) {
    const t0 = Date.now();
    let list = null;
    try {
      list = await this.quickChatList(client);
    } catch (err) {
      console.warn('[chats] quick list failed, falling back to the full lookup:', err.message);
    }
    if (!list || !list.length) list = await this.fullChatList(client);
    console.log(`[chats] ${list.length} chats listed in ${Date.now() - t0} ms`);
    return list.sort((a, b) => (b.pinned - a.pinned) || (b.timestamp - a.timestamp));
  }

  /**
   * Reads the chat list straight from WhatsApp Web's in-memory store: no server round-trips,
   * so it is ready almost instantly (whatsapp-web.js getChats() refreshes every group's
   * metadata over the network, which took minutes right after linking).
   */
  async quickChatList(client) {
    const raw = await client.pupPage.evaluate(() => {
      const C = window.require('WAWebCollections');
      const sid = (w) => (w && (w._serialized || w.$1)) || (w ? String(w) : '');
      return C.Chat.getModelsArray().map((chat) => {
        const id = sid(chat.id);
        const gm = chat.groupMetadata;
        let last = null;
        try {
          const msgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (!msgs[i].isNotification) { last = msgs[i]; break; }
          }
        } catch (e) { /* no messages loaded for this chat */ }
        let participants = 0;
        try {
          const p = gm && gm.participants;
          participants = p ? (p.length || (p.getModelsArray ? p.getModelsArray().length : 0)) : 0;
        } catch (e) { /* metadata not loaded yet */ }
        return {
          id,
          name: chat.formattedTitle || chat.name || '',
          isGroup: !!gm || id.endsWith('@g.us'),
          participants,
          timestamp: chat.t || 0,
          unread: chat.unreadCount > 0 ? chat.unreadCount : 0,
          pinned: !!chat.pin,
          archived: !!chat.archive,
          lastType: last ? last.type : '',
          lastText: last ? String((last.type === 'chat' ? last.body : last.caption) || '').slice(0, 90) : '',
        };
      });
    });
    return raw
      .filter((c) => c.id && c.id !== 'status@broadcast' && !c.id.endsWith('@newsletter'))
      .map((c) => ({
        id: c.id,
        name: c.name || c.id.split('@')[0] || 'Unnamed chat',
        isGroup: c.isGroup,
        participants: c.participants,
        timestamp: c.timestamp,
        unread: c.unread,
        pinned: c.pinned,
        archived: c.archived,
        preview: c.lastText || (c.lastType && c.lastType !== 'chat' ? (TYPE_LABELS[c.lastType] || c.lastType) : ''),
      }));
  }

  /** Slower fallback through whatsapp-web.js, in case WhatsApp Web's internals change. */
  async fullChatList(client) {
    const chats = await client.getChats();
    return chats
      .filter((c) => c.id && c.id._serialized !== 'status@broadcast' && c.id.server !== 'newsletter')
      .map((c) => {
        let participants = 0;
        try { participants = c.isGroup ? (c.groupMetadata?.participants?.length || 0) : 0; } catch { /* no metadata */ }
        let preview = '';
        if (c.lastMessage) {
          const d = describe(c.lastMessage);
          preview = (d.text || (d.type !== 'chat' ? d.typeLabel : '')).slice(0, 90);
        }
        return {
          id: c.id._serialized,
          name: c.name || c.id.user || 'Unnamed chat',
          isGroup: !!c.isGroup,
          participants,
          timestamp: c.timestamp || 0,
          unread: c.unreadCount || 0,
          pinned: !!c.pinned,
          archived: !!c.archived,
          preview,
        };
      });
  }

  getMessages(chatId, params) {
    this.ensureReady();
    const key = cacheKey(chatId, params);
    const hit = this.cache.get(key);
    if (!params.fresh && hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.data);

    return this.run(async () => {
      this.ensureReady();
      const chat = await this.client.getChatById(chatId);
      const raw = await this.loadRaw(chat, params);
      const msgs = raw
        .filter((m) => !SYSTEM_TYPES.has(m.type) && inRange(m.timestamp, params))
        .sort((a, b) => a.timestamp - b.timestamp);
      await this.resolvePeople(msgs);
      for (const m of msgs) if (m.hasMedia) this.msgRefs.set(m.id._serialized, m);
      while (this.msgRefs.size > MAX_MSG_REFS) this.msgRefs.delete(this.msgRefs.keys().next().value);

      const data = {
        chat: this.chatInfo(chat),
        messages: msgs.map((m) => this.serialize(m)),
        meta: { from: params.from, to: params.to, limit: params.limit, fetched: raw.length },
      };
      this.cache.set(key, { at: Date.now(), data });
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
      return data;
    });
  }

  async loadRaw(chat, { fromTs, limit }) {
    if (!fromTs) {
      const msgs = await chat.fetchMessages({ limit: limit === 'all' ? MAX_FETCH : limit });
      this.emit('progress', { loaded: msgs.length });
      return msgs;
    }
    // A start date is set: keep loading older history until we reach it (or run out).
    let step = 500;
    let msgs = [];
    for (;;) {
      msgs = await chat.fetchMessages({ limit: step });
      this.emit('progress', { loaded: msgs.length });
      const oldest = msgs.reduce((min, m) => Math.min(min, m.timestamp), Infinity);
      if (msgs.length < step || oldest <= fromTs || step >= MAX_FETCH) break;
      step *= 4;
    }
    return msgs;
  }

  loadPeople() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.paths.people, 'utf8'));
      const now = Date.now();
      for (const [id, p] of Object.entries(saved)) {
        if (p && p.name && now - (p.at || 0) < PEOPLE_TTL) this.people.set(id, p);
      }
    } catch { /* no cache yet */ }
  }

  savePeopleSoon() {
    clearTimeout(this.peopleTimer);
    this.peopleTimer = setTimeout(() => {
      try {
        fs.mkdirSync(SESSION_ROOT, { recursive: true });
        fs.writeFileSync(this.paths.people, JSON.stringify(Object.fromEntries(this.people)));
      } catch (err) { console.warn('[people] could not save cache:', err.message); }
    }, 1500);
  }

  async resolvePeople(msgs) {
    const notify = new Map();
    for (const m of msgs) {
      if (m.fromMe) continue;
      const id = m.author || m.from;
      if (!id) continue;
      const n = m._data && m._data.notifyName;
      if (n) notify.set(id, n);
      else if (!notify.has(id)) notify.set(id, '');
    }
    const unknown = [...notify.keys()].filter((id) => !this.people.has(id));
    if (!unknown.length) return;

    // Newer WhatsApp groups hide numbers behind "@lid" ids; ask for the real numbers (one call for all),
    // while the contact lookups below run at the same time.
    const lidPhones = new Map();
    const lids = unknown.filter((id) => id.endsWith('@lid'));
    const lidJob = (lids.length && typeof this.client.getContactLidAndPhone === 'function')
      ? this.client.getContactLidAndPhone(lids).then((res) => {
        (res || []).forEach((r) => {
          const lid = idStr(r && r.lid);
          const pn = idStr(r && r.pn);
          if (lid && pn) lidPhones.set(lid, pn);
        });
      }).catch(() => { /* not supported by this WhatsApp Web version */ })
      : Promise.resolve();

    const contacts = new Map();
    const contactJob = (async () => {
      for (let i = 0; i < unknown.length; i += 25) {
        await Promise.all(unknown.slice(i, i + 25).map(async (id) => {
          try { contacts.set(id, await this.client.getContactById(id)); } catch { /* unknown contact */ }
        }));
      }
    })();
    await Promise.all([lidJob, contactJob]);

    const now = Date.now();
    for (const id of unknown) {
      const contact = contacts.get(id) || null;
      let pnId = '';
      if (id.endsWith('@c.us')) pnId = id;
      else if (lidPhones.has(id)) pnId = lidPhones.get(id);
      else if (contact && contact.id && contact.id.server === 'c.us') pnId = contact.id._serialized;
      const phone = pnId ? `+${pnId.split('@')[0]}` : '';
      const name = (contact && (contact.name || contact.pushname || contact.verifiedName))
        || notify.get(id) || phone || 'Unknown';
      this.people.set(id, { name, phone: phone || 'Hidden (privacy)', at: now });
    }
    this.savePeopleSoon();
  }

  serialize(m) {
    const authorId = m.fromMe ? (this.me && this.me.id) || 'me' : (m.author || m.from || '');
    const who = m.fromMe
      ? { name: `${(this.me && this.me.name) || 'You'} (You)`, phone: this.me && this.me.number ? `+${this.me.number}` : '' }
      : this.people.get(authorId) || { name: 'Unknown', phone: '' };
    return {
      id: m.id._serialized,
      ts: m.timestamp,
      ...timeParts(m.timestamp),
      fromMe: !!m.fromMe,
      authorId,
      name: who.name,
      phone: who.phone,
      forwarded: !!m.isForwarded,
      thumb: !!thumbOf(m),
      ...describe(m),
    };
  }

  /** Small preview image for a photo/video message, or null. */
  async getThumb(id) {
    const b = thumbOf(this.msgRefs.get(id));
    return b ? { type: 'image/jpeg', buffer: Buffer.from(b, 'base64') } : null;
  }

  /**
   * Full media file for a message, downloaded once and kept in this session's media cache.
   * Resolves to { path, mimetype, filename } or null when WhatsApp no longer has the file.
   */
  async getMediaFile(id) {
    const key = crypto.createHash('sha1').update(id).digest('hex');
    const metaPath = path.join(this.paths.media, `${key}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (fs.existsSync(meta.path)) return meta;
    } catch { /* not downloaded yet */ }
    if (this.mediaJobs.has(key)) return this.mediaJobs.get(key);

    const job = this.mediaQueue.run(async () => {
      this.ensureReady();
      let msg = this.msgRefs.get(id);
      if (!msg) {
        try { msg = await this.client.getMessageById(id); } catch { msg = null; }
      }
      if (!msg || !msg.hasMedia) return null;
      const res = await msg.downloadMediaStream();
      if (!res) return null;
      fs.mkdirSync(this.paths.media, { recursive: true });
      const file = path.join(this.paths.media, `${key}.${extFor(res.mimetype, res.filename)}`);
      const part = `${file}.part`;
      try {
        await pipeline(res.stream, fs.createWriteStream(part));
        fs.renameSync(part, file);
      } catch (err) {
        fs.rmSync(part, { force: true });
        throw err;
      }
      const meta = { path: file, mimetype: res.mimetype || 'application/octet-stream', filename: res.filename || null };
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      return meta;
    }).finally(() => this.mediaJobs.delete(key));
    this.mediaJobs.set(key, job);
    return job;
  }

  chatInfo(chat) {
    let participants = 0;
    let description = '';
    let createdAt = null;
    if (chat.isGroup) {
      try {
        const meta = chat.groupMetadata || {};
        participants = (meta.participants || []).length;
        description = meta.desc || '';
        createdAt = meta.creation ? Number(meta.creation) : null;
      } catch { /* metadata unavailable */ }
    }
    return { id: chat.id._serialized, name: chat.name || chat.id.user, isGroup: !!chat.isGroup, participants, description, createdAt };
  }
}

module.exports = WhatsAppService;
