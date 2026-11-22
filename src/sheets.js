'use strict';

// Google Sheets sync: keeps a Google Sheet up to date with one WhatsApp login's chats.
//  • A "bot" Google account (a service account) writes into sheets that people share with it.
//    Its key file lives in C:\Users\<you>\WhatsAppChatExporter\google-service-account.json.
//  • Every group gets its own tab; all personal chats share one "Personal Chats" tab.
//  • Old messages are copied once (from the chosen date), then new ones every few seconds.
//  • Every message written is remembered (a short hash of its id), so nothing is written twice, and
//    messages WhatsApp only loads later (a fresh login gets its history in the background) are filled
//    in by "gap checks"; a hidden Sort column keeps each tab in time order after such fills.
//  • Progress is saved, so after a restart or a log out + scan of the same account it carries on.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const sharp = require('sharp');
const { Semaphore } = require('./media');

const DATA_ROOT = process.env.DATA_DIR || path.join(os.homedir(), 'WhatsAppChatExporter');
const KEY_FILE = process.env.GOOGLE_KEY_FILE || path.join(DATA_ROOT, 'google-service-account.json');
const DRY_RUN = process.env.SHEETS_DRY_RUN === '1'; // tests: write local files instead of calling Google
const DRY_DIR = path.join(DATA_ROOT, 'sheets-dry-run');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const MIN_GAP_MS = 1100; // Google allows 60 writes a minute for the bot: stay just under it
const ROWS_PER_WRITE = 1500; // keeps each request well under Google's size limit
const LIVE_DELAY_MS = 4000; // new messages are collected for a few seconds, then written together
const FULL_PASS_MS = 10 * 60 * 1000; // safety net: re-check every chat now and then
const MAX_CELL = 45000; // Google's limit is 50,000 characters per cell
// After a fresh login, WhatsApp delivers older history over several minutes: look for it again then.
const GAP_CHECKS_MIN = String(process.env.SHEETS_GAP_CHECKS_MIN || '3,10,30,90').split(',').map(Number).filter((n) => n > 0);

// Sheet layout (version 3). Version 2 sheets had no "Reply to" / "Photo" and are upgraded in place.
const GROUP_HEAD = ['Date', 'Time', 'Day', 'Sender', 'Phone', 'Message', 'Reply to', 'Type', 'Photo', 'Sort'];
const PERSONAL_HEAD = ['Chat', ...GROUP_HEAD];
const V1_HEAD = ['Date', 'Time', 'Day', 'Sender', 'Phone', 'Message', 'Type']; // first version (no gap filling)
const PHOTO_ROW_PX = 110; // rows with a photo are this tall, the others normal
const TEXT_ROW_PX = 21;
const PREVIEW_PX = 480; // photo size kept for the sheet (longest side)
const PHOTO_TYPES = new Set(['image', 'sticker']); // downloaded in full; videos show their preview frame
const ENRICH_CHUNK = 24; // old rows updated per write while a sheet is being upgraded
const cleanHost = (h) => String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
// Where the sheet's photo links point: the app's public link. Google's own image fetcher gets ngrok's
// free-plan warning page, so the sheet's "Photo helper" script fetches them instead (it can skip that
// page) and puts the pictures inside the cells. PHOTO_HOST can point the links somewhere else.
const photoHost = () => cleanHost(process.env.PHOTO_HOST || process.env.PUBLIC_HOST);
const PERSONAL_KEY = '_personal';
const PERSONAL_TITLE = 'Personal Chats';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The bot's Google login
// ---------------------------------------------------------------------------
let keyCache = null; // { mtimeMs, key }
let token = null; // { value, exp }

function loadKey() {
  if (DRY_RUN) return { client_email: 'dry-run-bot@example.iam.gserviceaccount.com' };
  try {
    const st = fs.statSync(KEY_FILE);
    if (!keyCache || keyCache.mtimeMs !== st.mtimeMs) {
      const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
      if (!key.client_email || !key.private_key) return null;
      keyCache = { mtimeMs: st.mtimeMs, key };
      token = null;
    }
    return keyCache.key;
  } catch {
    return null;
  }
}

const botEmail = () => (loadKey() || {}).client_email || '';

async function accessToken() {
  if (token && Date.now() < token.exp - 60000) return token.value;
  const key = loadKey();
  if (!key) throw userError('Google Sheets is not set up on this computer yet.', 503);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The Google bot could not sign in (${body.error_description || body.error || res.status}). Check the key file.`);
  token = { value: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

function userError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// One request at a time for all sheets, spaced out to respect Google's per-minute limit.
let nextSlot = 0;
async function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function google(method, url, body) {
  for (let attempt = 0; ; attempt += 1) {
    await waitTurn();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      if (err.status) throw err; // our own error (no key)
      res = null; // network trouble
    }
    if (res && res.ok) return res.json();
    const status = res ? res.status : 0;
    let detail = '';
    if (res) { try { detail = ((await res.json()).error || {}).message || ''; } catch { /* not json */ } }
    if ((status === 0 || status === 429 || status >= 500) && attempt < 6) {
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    if (status === 401) token = null;
    const err = new Error(detail || `Google Sheets error ${status || '(no internet)'}`);
    err.status = status;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Spreadsheet operations (real, or local files in dry-run mode)
// ---------------------------------------------------------------------------
function sheetIdFrom(input) {
  const s = String(input || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{25,}$/.test(s) ? s : '';
}

const dryFile = (id) => path.join(DRY_DIR, `${id}.json`);
function dryLoad(id) {
  try { return JSON.parse(fs.readFileSync(dryFile(id), 'utf8')); } catch { return null; }
}
function drySave(id, book) {
  fs.mkdirSync(DRY_DIR, { recursive: true });
  fs.writeFileSync(dryFile(id), JSON.stringify(book));
  const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
  for (const tab of book.sheets) {
    const name = tab.title.replace(/[^\w\- ]+/g, '_');
    fs.writeFileSync(path.join(DRY_DIR, `${id}__${name}.csv`), tab.rows.map((r) => r.map(csv).join(',')).join('\n'));
  }
}

async function getMeta(id) {
  if (DRY_RUN) {
    let book = dryLoad(id);
    if (!book) {
      if (!id.startsWith('dry')) throw Object.assign(new Error('not found'), { status: 404 });
      book = { title: 'Dry-run sheet', sheets: [{ sheetId: 0, title: 'Sheet1', rows: [] }] };
      drySave(id, book);
    }
    return { title: book.title, tabs: book.sheets.map((s) => ({ sheetId: s.sheetId, title: s.title })) };
  }
  const meta = await google('GET', `${SHEETS_API}/${id}?fields=properties.title,sheets.properties(sheetId,title)`);
  return {
    title: (meta.properties || {}).title || 'Google Sheet',
    tabs: (meta.sheets || []).map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title })),
  };
}

async function batchUpdate(id, requests) {
  if (!requests.length) return;
  if (!DRY_RUN) {
    await google('POST', `${SHEETS_API}/${id}:batchUpdate`, { requests });
    return;
  }
  await sleep(50);
  const book = dryLoad(id);
  const value = (v) => {
    const u = (v && v.userEnteredValue) || {};
    return u.numberValue !== undefined ? u.numberValue : u.formulaValue !== undefined ? u.formulaValue : (u.stringValue ?? '');
  };
  const tabOf = (sheetId) => {
    const tab = book.sheets.find((s) => s.sheetId === sheetId);
    if (!tab) throw Object.assign(new Error(`No grid with id: ${sheetId}`), { status: 400 });
    return tab;
  };
  for (const r of requests) {
    if (r.addSheet) book.sheets.push({ sheetId: r.addSheet.properties.sheetId, title: r.addSheet.properties.title, rows: [], heights: {} });
    if (r.appendCells) {
      const tab = tabOf(r.appendCells.sheetId);
      for (const row of r.appendCells.rows) tab.rows.push(row.values.map(value));
    }
    if (r.insertDimension) {
      const { sheetId, dimension, startIndex, endIndex } = r.insertDimension.range;
      const tab = tabOf(sheetId);
      const n = endIndex - startIndex;
      if (dimension === 'ROWS') {
        tab.rows.splice(startIndex, 0, ...Array.from({ length: n }, () => []));
        // like Google Sheets: rows below move down together with their heights
        const moved = {};
        for (const [i, px] of Object.entries(tab.heights || {})) moved[+i >= startIndex ? +i + n : +i] = px;
        tab.heights = moved;
      }
      else tab.rows.forEach((row) => { while (row.length < startIndex) row.push(''); row.splice(startIndex, 0, ...Array(n).fill('')); });
    }
    if (r.updateCells) {
      const { sheetId, rowIndex, columnIndex } = r.updateCells.start;
      const tab = tabOf(sheetId);
      r.updateCells.rows.forEach((row, i) => {
        const target = tab.rows[rowIndex + i] || (tab.rows[rowIndex + i] = []);
        row.values.forEach((v, j) => { target[columnIndex + j] = value(v); });
      });
    }
    if (r.updateDimensionProperties && r.updateDimensionProperties.range.dimension === 'ROWS') {
      const { sheetId, startIndex, endIndex } = r.updateDimensionProperties.range;
      const tab = tabOf(sheetId);
      tab.heights = tab.heights || {};
      for (let i = startIndex; i < endIndex; i += 1) tab.heights[i] = r.updateDimensionProperties.properties.pixelSize;
    }
    if (r.findReplace) {
      const re = new RegExp(r.findReplace.find, 'g');
      for (const tab of book.sheets) tab.rows = tab.rows.map((row) => row.map((v) => (typeof v === 'string' && v.startsWith('=') ? v.replace(re, r.findReplace.replacement) : v)));
    }
    if (r.sortRange) {
      const tab = tabOf(r.sortRange.range.sheetId);
      const col = r.sortRange.sortSpecs[0].dimensionIndex;
      tab.rows = [tab.rows[0], ...tab.rows.slice(1).sort((a, b) => a[col] - b[col])];
    }
  }
  drySave(id, book);
}

/** Values of some ranges (e.g. one column of each tab), unformatted. */
async function valuesBatchGet(id, ranges) {
  if (!ranges.length) return [];
  if (DRY_RUN) {
    const book = dryLoad(id);
    return ranges.map((range) => {
      const m = /^'(.*)'!([A-Z]+)2:/.exec(range);
      const tab = book.sheets.find((s) => s.title === m[1].replace(/''/g, "'"));
      const col = [...m[2]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      return tab ? tab.rows.slice(1).map((r) => r[col]) : [];
    });
  }
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await google('GET', `${SHEETS_API}/${id}/values:batchGet?${qs}&majorDimension=COLUMNS&valueRenderOption=UNFORMATTED_VALUE`);
  return (res.valueRanges || []).map((v) => ((v.values || [])[0] || []));
}

const cell = (v) => ({ userEnteredValue: { stringValue: String(v ?? '').slice(0, MAX_CELL) } });
const numCell = (n) => ({ userEnteredValue: { numberValue: n } });
const boldCell = (v) => ({ ...cell(v), userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.86, green: 0.97, blue: 0.9 } } });
const colLetter = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const quoteTitle = (t) => `'${String(t).replace(/'/g, "''")}'`;
const columnWidth = (sheetId, col, px) => ({
  updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' },
});
const headerCell = (sheetId, col, text) => ({
  updateCells: { start: { sheetId, rowIndex: 0, columnIndex: col }, rows: [{ values: [boldCell(text)] }], fields: 'userEnteredValue,userEnteredFormat(textFormat,backgroundColor)' },
});

/** Requests that create a new tab: bold frozen header, readable widths, hidden Sort column. */
function newTabRequests(sheetId, title, head) {
  const col = (name) => head.indexOf(name);
  const reqs = [
    // (2 rows: Google refuses to freeze every row of a sheet; rows are added as messages come in)
    { addSheet: { properties: { sheetId, title, gridProperties: { rowCount: 2, columnCount: head.length, frozenRowCount: 1 } } } },
    { appendCells: { sheetId, rows: [{ values: head.map(boldCell) }], fields: 'userEnteredValue,userEnteredFormat(textFormat,backgroundColor)' } },
    columnWidth(sheetId, col('Message'), 420),
  ];
  if (col('Reply to') >= 0) reqs.push(columnWidth(sheetId, col('Reply to'), 260));
  if (col('Photo') >= 0) reqs.push(columnWidth(sheetId, col('Photo'), 150));
  if (col('Sort') >= 0) {
    reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: col('Sort'), endIndex: col('Sort') + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  }
  return reqs;
}

/** Row heights for rows [start, start + flags.length): tall where flags[i] (a photo), normal elsewhere. */
function heightRequests(sheetId, start, flags) {
  const reqs = [];
  for (let i = 0; i < flags.length;) {
    let j = i;
    while (j < flags.length && flags[j] === flags[i]) j += 1;
    reqs.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: start + i, endIndex: start + j },
        properties: { pixelSize: flags[i] ? PHOTO_ROW_PX : TEXT_ROW_PX },
        fields: 'pixelSize',
      },
    });
    i = j;
  }
  return reqs;
}

function tabTitle(name, taken) {
  const base = String(name || 'Chat').replace(/[[\]*?/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Chat';
  let title = base;
  for (let n = 2; taken.has(title.toLowerCase()); n += 1) title = `${base} (${n})`;
  taken.add(title.toLowerCase());
  return title;
}

/** Index of the first value >= x in the sorted array. */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Number of values in the sorted array that are <= x (where a new row with sort value x goes). */
function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}
function mergeSorted(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0; let j = 0; let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Short, stable fingerprint of a message id (remembered so a message is never written twice). */
const fingerprint = (id) => crypto.createHash('sha1').update(String(id)).digest('base64url').slice(0, 10);

// ---------------------------------------------------------------------------
// Photos shown in the sheet: =IMAGE("https://<link>/sheet-img/<login>/<name>.jpg"), served by this PC
// ---------------------------------------------------------------------------
const imageDirs = new Map(); // login id -> folder with that login's sheet photos
const syncs = new Set(); // every running sheet sync (told when the photo link changes)

/** The photo link changed (the Cloudflare tunnel restarted): every sheet points its photos there. */
function photoHostChanged() {
  for (const s of syncs) if (s.enabled) s.kick();
}

/** File for GET /sheet-img/:sid/:name (only names this app made), or null. */
function photoFile(sid, name) {
  if (!/^(exporter|g[0-9a-f]{12})$/.test(sid) || !/^[0-9a-f]{32}\.jpg$/.test(name)) return null;
  const dir = imageDirs.get(sid);
  const file = dir && path.join(dir, name);
  return file && fs.existsSync(file) ? file : null;
}

// ---------------------------------------------------------------------------
// Sync of one WhatsApp login
// ---------------------------------------------------------------------------
const SINCE_DAYS = { 7: 7, 30: 30, 90: 90, 365: 365 };

class SheetSync extends EventEmitter {
  /**
   * @param {object} wa   the login's service: status(), listChatsForSync(), fetchForSync(id, sinceTs),
   *                      getThumb(id), getPhotoBuffer(id), 'chat-activity' events
   * @param {string} file where this login's sync settings and progress are saved
   * @param {{ imageDir?: string, imageSid?: string }} [opts] where this login's sheet photos are kept
   */
  constructor(wa, file, opts = {}) {
    super();
    this.wa = wa;
    this.file = file;
    this.imageDir = opts.imageDir || '';
    this.imageSid = opts.imageSid || '';
    if (this.imageDir && this.imageSid) imageDirs.set(this.imageSid, this.imageDir);
    this.photoQueue = new Semaphore(6);
    syncs.add(this);
    this.cfg = null;
    try { this.cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not connected yet */ }
    this.written = new Map(); // chat id -> Set of fingerprints (loaded from cfg.written)
    if (this.cfg) for (const [k, v] of Object.entries(this.cfg.written || {})) this.written.set(k, new Set(v ? v.split(',') : []));
    this.dirty = new Set();
    this.running = false;
    this.again = false;
    this.needFull = 'cursor'; // what the next full pass does: 'cursor' (new messages) or 'gaps' (everything since the start date)
    this.phase = 'idle';
    this.progress = { done: 0, total: 0 };
    this.error = '';
    this.pending = [];
    this.liveTimer = null;
    this.retryTimer = null;
    this.gapTimers = [];
    this.onActivity = (chatId) => this.markDirty(chatId);
    this.onStatus = (st) => this.statusChanged(st);
    wa.on('chat-activity', this.onActivity);
    wa.on('status', this.onStatus);
    this.fullTimer = setInterval(() => this.requestPass('cursor'), FULL_PASS_MS);
    this.fullTimer.unref();
  }

  get enabled() { return !!(this.cfg && this.cfg.enabled); }

  get version() { return (this.cfg && this.cfg.version) || 1; }

  /** First-version sheets have no Sort column: they only get new messages, no gap filling. */
  get canFillGaps() { return this.version >= 2; }

  status() {
    const c = this.cfg || {};
    return {
      configured: !!loadKey(),
      botEmail: botEmail(),
      enabled: this.enabled,
      sheetUrl: c.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit` : '',
      sheetTitle: c.title || '',
      since: c.since || '',
      phase: this.enabled ? this.phase : 'off',
      done: this.progress.done,
      total: this.progress.total,
      rows: c.rows || 0,
      lastWriteAt: c.lastWriteAt || 0,
      error: this.error,
      oldFormat: this.enabled && !this.canFillGaps,
      photos: !!photoHost() && this.version >= 2,
    };
  }

  changed() { this.emit('status', this.status()); }

  save() {
    if (!this.cfg) return;
    this.cfg.written = {};
    for (const [k, set] of this.written) this.cfg.written[k] = [...set].join(',');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.cfg));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) { console.warn('[sheets] could not save progress:', err.message); }
  }

  /** WhatsApp connected / disconnected. On connect: same account → carry on (and look for late history). */
  statusChanged(st) {
    if (!this.enabled) return;
    if (st.state !== 'ready') {
      if (this.phase !== 'waiting' && this.phase !== 'error') { this.phase = 'waiting'; this.changed(); }
      return;
    }
    const account = st.me && st.me.id;
    if (this.cfg.account && account && this.cfg.account !== account) {
      this.phase = 'error';
      this.error = `This sheet belongs to another WhatsApp account (+${this.cfg.account.split('@')[0]}). Stop sync and connect a new sheet for this one.`;
      this.changed();
      return;
    }
    if (!this.cfg.account && account) { this.cfg.account = account; this.save(); }
    this.error = '';
    this.requestPass('cursor');
    this.scheduleGapChecks(); // a fresh login keeps loading older history for a while
  }

  requestPass(kind) {
    if (!this.enabled) return;
    if (kind === 'gaps' && !this.canFillGaps) kind = 'cursor';
    if (this.needFull !== 'gaps') this.needFull = kind;
    this.kick();
  }

  scheduleGapChecks() {
    this.gapTimers.forEach(clearTimeout);
    this.gapTimers = GAP_CHECKS_MIN.map((m) => setTimeout(() => this.requestPass('gaps'), m * 60 * 1000));
    this.gapTimers.forEach((t) => t.unref());
  }

  /** Connect a sheet (or resume the same one) and start copying. */
  async connect({ sheet, since }) {
    if (!loadKey()) throw userError('Google Sheets is not set up on this computer yet.', 503);
    const id = sheetIdFrom(sheet);
    if (!id) throw userError('Paste the full link of your Google Sheet (it looks like https://docs.google.com/spreadsheets/d/…).');
    let meta;
    try {
      meta = await getMeta(id);
    } catch (err) {
      if (/has not been used|is disabled|SERVICE_DISABLED|API.*not.*enabled/i.test(err.message)) {
        throw userError('The Google Sheets API is not switched on for the bot yet. In Google Cloud open APIs & Services → Library → Google Sheets API → Enable, wait a minute, then try again.', 503);
      }
      if (err.status === 403 || err.status === 404) {
        throw userError(`The bot can't open this sheet. In the sheet press Share, add ${botEmail()} as Editor, then try again.`);
      }
      throw err;
    }
    const sinceKey = SINCE_DAYS[since] ? String(since) : 'all';
    const sinceTs = sinceKey === 'all' ? 0 : Math.floor(Date.now() / 1000) - SINCE_DAYS[sinceKey] * 86400;
    const me = this.wa.status().me;
    const resume = this.cfg && this.cfg.spreadsheetId === id;
    if (resume) {
      this.cfg = { ...this.cfg, enabled: true, title: meta.title };
    } else {
      this.cfg = {
        version: 3, enabled: true, spreadsheetId: id, title: meta.title, since: sinceKey, sinceTs, account: (me && me.id) || '',
        connectedAt: Date.now(), tabs: {}, cursors: {}, written: {}, rows: 0, lastWriteAt: 0,
        imgSecret: crypto.randomBytes(16).toString('hex'),
      };
      this.written = new Map();
      this.titles = null;
    }
    this.error = '';
    this.save();
    console.log(`[sheets] ${resume ? 'resumed' : 'connected'} "${meta.title}" (old messages: ${sinceKey === 'all' ? 'all available' : `last ${sinceKey} days`})`);
    this.requestPass(resume ? 'cursor' : 'gaps');
    this.scheduleGapChecks();
    this.changed();
    return this.status();
  }

  stop() {
    if (this.cfg) { this.cfg.enabled = false; this.save(); }
    this.phase = 'off';
    clearTimeout(this.liveTimer);
    clearTimeout(this.retryTimer);
    this.gapTimers.forEach(clearTimeout);
    console.log('[sheets] sync stopped');
    this.changed();
  }

  dispose() {
    clearInterval(this.fullTimer);
    clearTimeout(this.liveTimer);
    clearTimeout(this.retryTimer);
    this.gapTimers.forEach(clearTimeout);
    this.wa.off('chat-activity', this.onActivity);
    this.wa.off('status', this.onStatus);
    if (this.imageSid && imageDirs.get(this.imageSid) === this.imageDir) imageDirs.delete(this.imageSid);
    syncs.delete(this);
    this.cfg = this.cfg && { ...this.cfg, enabled: false }; // stops a running pass (nothing is saved)
  }

  markDirty(chatId) {
    if (!this.enabled || !chatId) return;
    this.dirty.add(chatId);
    if (!this.liveTimer) {
      this.liveTimer = setTimeout(() => { this.liveTimer = null; this.kick(); }, LIVE_DELAY_MS);
    }
  }

  kick() {
    if (this.running) { this.again = true; return; }
    this.loop().catch(() => { /* handled inside */ });
  }

  async loop() {
    this.running = true;
    try {
      do {
        this.again = false;
        if (!this.enabled) break;
        const st = this.wa.status();
        if (st.state !== 'ready') { this.phase = 'waiting'; return; } // resumes on "ready"
        if (this.cfg.account && st.me && st.me.id && st.me.id !== this.cfg.account) return; // other account
        if (this.version === 2) await this.upgradeToV3();
        if (this.version >= 3) await this.fixPhotoLinks();
        if (this.cfg.enrichPending) await this.enrichOldRows();
        if (this.needFull) {
          const kind = this.needFull;
          this.needFull = null;
          await this.fullPass(kind);
        }
        await this.processDirty();
      } while (this.enabled && (this.again || this.dirty.size || this.needFull));
      if (this.enabled) {
        this.phase = 'live';
        this.error = '';
      }
    } catch (err) {
      this.pending = [];
      this.error = err.status === 403 || err.status === 404
        ? `The bot lost access to the sheet. Share it again with ${botEmail()} as Editor.`
        : err.message;
      this.phase = 'error';
      console.warn('[sheets]', this.error);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.requestPass(this.canFillGaps ? 'gaps' : 'cursor'), 60 * 1000);
    } finally {
      this.running = false;
      this.changed();
    }
  }

  /**
   * 'cursor': chats with messages newer than what the sheet has.
   * 'gaps':   every chat active since the start date, compared message by message (fills late history).
   */
  async fullPass(kind) {
    const gaps = kind === 'gaps' && this.canFillGaps;
    const chats = (await this.wa.listChatsForSync())
      .filter((c) => c.t && c.t >= this.cfg.sinceTs)
      .filter((c) => { if (gaps) return true; const cur = this.cfg.cursors[c.id]; return !cur || c.t > cur.ts; })
      .sort((a, b) => b.t - a.t); // most recently active first
    if (!chats.length) return;
    const first = !this.cfg.backfilled;
    this.phase = first ? 'backfill' : gaps ? 'gaps' : 'catchup';
    this.progress = { done: 0, total: chats.length };
    this.changed();
    const before = this.cfg.rows || 0;
    for (const chat of chats) {
      if (!this.enabled) return;
      await this.collect(chat, gaps);
      if (this.pendingRows() >= ROWS_PER_WRITE) await this.flush();
      this.progress.done += 1;
      this.changed();
    }
    await this.flush();
    if (first) {
      this.cfg.backfilled = true;
      this.save();
      console.log(`[sheets] old messages copied: ${this.cfg.rows} rows in ${Object.keys(this.cfg.tabs).length} tabs`);
    } else if (gaps && this.cfg.rows > before) {
      console.log(`[sheets] filled in ${this.cfg.rows - before} messages WhatsApp loaded later`);
    }
  }

  pendingRows() { return this.pending.reduce((n, p) => n + p.rows.length, 0); }

  isWritten(chatId, msgId) {
    const set = this.written.get(chatId);
    return !!set && set.has(fingerprint(msgId));
  }

  /**
   * The Photo cell of a message: =IMAGE(link to a copy of the photo on this PC), or empty.
   * Photos and stickers are downloaded in full; videos (and photos WhatsApp no longer has) use the preview.
   */
  async photoCell(m) {
    const host = photoHost();
    if (!host || !this.imageDir || (!m.thumb && !PHOTO_TYPES.has(m.type))) return null;
    if (!this.cfg.imgSecret) { this.cfg.imgSecret = crypto.randomBytes(16).toString('hex'); this.save(); }
    const name = crypto.createHmac('sha256', this.cfg.imgSecret).update(String(m.id)).digest('hex').slice(0, 32);
    const file = path.join(this.imageDir, `${name}.jpg`);
    if (!fs.existsSync(file)) {
      const made = await this.photoQueue.run(async () => {
        let buf = null;
        if (PHOTO_TYPES.has(m.type)) { try { buf = await this.wa.getPhotoBuffer(m.id); } catch { buf = null; } }
        if (!buf && m.thumb) { try { buf = ((await this.wa.getThumb(m.id)) || {}).buffer || null; } catch { buf = null; } }
        if (!buf) return false;
        try {
          const jpg = await sharp(buf, { animated: false })
            .rotate()
            .resize({ width: PREVIEW_PX, height: PREVIEW_PX, fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 80 })
            .toBuffer();
          fs.mkdirSync(this.imageDir, { recursive: true });
          fs.writeFileSync(file, jpg);
          return true;
        } catch { return false; }
      });
      if (!made) return null;
    }
    return { userEnteredValue: { formulaValue: `=IMAGE("https://${host}/sheet-img/${this.imageSid}/${name}.jpg")` } };
  }

  /**
   * Photo cells link to the current photo address. The free Cloudflare tunnel gets a new address at
   * every start, so all =IMAGE() links in the sheet are switched over with one find & replace.
   */
  async fixPhotoLinks() {
    const host = photoHost();
    if (!host || this.cfg.photoHost === host) return;
    if (this.cfg.rows) {
      await batchUpdate(this.cfg.spreadsheetId, [{
        findReplace: {
          find: 'https://[^/"]+/sheet-img/', replacement: `https://${host}/sheet-img/`, searchByRegex: true, includeFormulas: true, allSheets: true,
        },
      }]);
      console.log(`[sheets] photo links in "${this.cfg.title}" now use ${host}`);
    }
    this.cfg.photoHost = host;
    this.save();
  }

  replyText(m) {
    return m.reply ? `↩ ${m.reply.name}: ${m.reply.text}` : '';
  }

  /** Row cells for a message in the current sheet layout, and whether it holds a photo. */
  async rowFor(m, chat, seq) {
    const personal = !chat.isGroup;
    if (this.version < 3) {
      const row = [cell(m.date), cell(m.time), cell(m.day), cell(m.name), cell(m.phone), cell(m.text), cell(m.typeLabel)];
      if (this.version === 2) row.push(numCell(m.ts + Math.min(seq, 999) / 1000));
      return { values: personal ? [cell(chat.name), ...row] : row, photo: false };
    }
    const photo = await this.photoCell(m);
    const row = [
      cell(m.date), cell(m.time), cell(m.day), cell(m.name), cell(m.phone), cell(m.text),
      cell(this.replyText(m)), cell(m.typeLabel), photo || cell(''), numCell(m.ts + Math.min(seq, 999) / 1000),
    ];
    return { values: personal ? [cell(chat.name), ...row] : row, photo: !!photo };
  }

  /**
   * Queues the chat's messages that are not in the sheet yet.
   * fromStart: look at everything since the start date (gap check); otherwise only after the newest written one.
   */
  async collect(chat, fromStart) {
    const cur = this.cfg.cursors[chat.id];
    const since = fromStart || !cur ? this.cfg.sinceTs : cur.ts;
    const queued = new Set(this.pending.flatMap((p) => (p.chatId === chat.id ? p.prints : [])));
    let msgs = (await this.wa.fetchForSync(chat.id, since)).filter((m) => m.ts >= this.cfg.sinceTs);
    if (this.canFillGaps) {
      msgs = msgs.filter((m) => !this.isWritten(chat.id, m.id) && !queued.has(fingerprint(m.id)));
    } else {
      // first-version sheets: only what comes after the newest written message
      msgs = msgs.filter((m) => !cur || m.ts > cur.ts || (m.ts === cur.ts && !(cur.ids || []).includes(m.id)));
    }
    if (!msgs.length) return;
    let seq = 0;
    let lastTs = -1;
    const seqs = msgs.map((m) => { seq = m.ts === lastTs ? seq + 1 : 0; lastTs = m.ts; return seq; }); // keeps WhatsApp's order within a second
    const built = await Promise.all(msgs.map((m, i) => this.rowFor(m, chat, seqs[i])));
    const rows = built.map((b, i) => ({ ...b, key: msgs[i].ts + Math.min(seqs[i], 999) / 1000 }));
    const maxTs = msgs[msgs.length - 1].ts;
    this.pending.push({
      key: chat.isGroup ? chat.id : PERSONAL_KEY,
      chat,
      chatId: chat.id,
      rows,
      prints: msgs.map((m) => fingerprint(m.id)),
      minTs: msgs[0].ts,
      maxTs,
      lastIds: msgs.filter((m) => m.ts === maxTs).map((m) => m.id),
    });
  }

  /** Writes all queued rows, then saves the progress. */
  async flush() {
    const pending = this.pending;
    if (!pending.length) return;
    const id = this.cfg.spreadsheetId;
    if (!this.titles) this.titles = new Set((await getMeta(id)).tabs.map((t) => t.title.toLowerCase()));
    const v3 = this.version >= 3;

    const requests = [];
    const created = [];
    const byTab = new Map(); // tab key -> { tab, rows }
    for (const p of pending) {
      let tab = this.cfg.tabs[p.key];
      if (!tab) {
        const personal = p.key === PERSONAL_KEY;
        const head = v3 ? (personal ? PERSONAL_HEAD : GROUP_HEAD) : personal ? ['Chat', ...V1_HEAD, ...(this.version === 2 ? ['Sort'] : [])] : [...V1_HEAD, ...(this.version === 2 ? ['Sort'] : [])];
        tab = { sheetId: crypto.randomInt(1e6, 2e9), title: tabTitle(personal ? PERSONAL_TITLE : p.chat.name, this.titles), sortCol: head.indexOf('Sort'), keys: [] };
        requests.push(...newTabRequests(tab.sheetId, tab.title, head));
        this.cfg.tabs[p.key] = tab;
        created.push(p.key);
      }
      if (!byTab.has(p.key)) byTab.set(p.key, { tab, rows: [] });
      byTab.get(p.key).rows.push(...p.rows);
    }

    const newKeys = new Map();
    for (const [k, { tab, rows }] of byTab) {
      if (!v3) { // older layouts: add at the end (version 2 re-sorts below)
        requests.push({ appendCells: { sheetId: tab.sheetId, rows: rows.map((r) => ({ values: r.values })), fields: 'userEnteredValue' } });
        continue;
      }
      // Each new row goes straight to its place in time order: older ones are inserted, newer appended.
      const keys = tab.keys || [];
      rows.sort((a, b) => a.key - b.key);
      const blocks = [];
      for (const r of rows) {
        const pos = upperBound(keys, r.key);
        const last = blocks[blocks.length - 1];
        if (last && last.pos === pos) last.rows.push(r); else blocks.push({ pos, rows: [r] });
      }
      let added = 0;
      for (const b of blocks) {
        const start = 1 + b.pos + added; // row 0 is the header
        const data = b.rows.map((r) => ({ values: r.values }));
        if (b.pos >= keys.length) {
          requests.push({ appendCells: { sheetId: tab.sheetId, rows: data, fields: 'userEnteredValue' } });
        } else {
          requests.push({ insertDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: start, endIndex: start + data.length }, inheritFromBefore: false } });
          requests.push({ updateCells: { start: { sheetId: tab.sheetId, rowIndex: start, columnIndex: 0 }, rows: data, fields: 'userEnteredValue' } });
        }
        requests.push(...heightRequests(tab.sheetId, start, b.rows.map((r) => r.photo)));
        added += b.rows.length;
      }
      newKeys.set(k, mergeSorted(keys, rows.map((r) => r.key)));
    }
    if (this.version === 2) {
      for (const p of pending) {
        const tab = this.cfg.tabs[p.key];
        if (tab.sortCol >= 0 && p.minTs < (tab.maxTs || 0)) {
          requests.push({ sortRange: { range: { sheetId: tab.sheetId, startRowIndex: 1 }, sortSpecs: [{ dimensionIndex: tab.sortCol, sortOrder: 'ASCENDING' }] } });
        }
      }
    }

    try {
      await batchUpdate(id, requests); // all or nothing
    } catch (err) {
      for (const k of created) delete this.cfg.tabs[k];
      this.titles = null;
      if (err.status === 400 && /grid|sheet ?id/i.test(err.message)) await this.forgetDeletedTabs();
      throw err;
    }

    for (const [k, keys] of newKeys) if (this.cfg.tabs[k]) this.cfg.tabs[k].keys = keys;
    for (const p of pending) {
      const set = this.written.get(p.chatId) || new Set();
      p.prints.forEach((f) => set.add(f));
      this.written.set(p.chatId, set);
      const cur = this.cfg.cursors[p.chatId];
      if (!cur || p.maxTs > cur.ts) this.cfg.cursors[p.chatId] = { ts: p.maxTs, ids: p.lastIds };
      else if (p.maxTs === cur.ts) cur.ids = [...new Set([...(cur.ids || []), ...p.lastIds])].slice(-200);
      const tab = this.cfg.tabs[p.key];
      if (tab) tab.maxTs = Math.max(tab.maxTs || 0, p.maxTs);
    }
    this.cfg.rows = (this.cfg.rows || 0) + this.pendingRows();
    this.cfg.lastWriteAt = Date.now();
    this.pending = [];
    this.save();
    this.changed();
  }

  /** Tabs someone deleted in the sheet: forget them; their chats start over in a new tab. */
  async forgetDeletedTabs() {
    const live = new Set((await getMeta(this.cfg.spreadsheetId)).tabs.map((t) => t.sheetId));
    for (const [k, t] of Object.entries(this.cfg.tabs)) {
      if (live.has(t.sheetId)) continue;
      delete this.cfg.tabs[k];
      const chatIds = k === PERSONAL_KEY ? Object.keys(this.cfg.cursors).filter((c) => !c.endsWith('@g.us')) : [k];
      for (const c of chatIds) { delete this.cfg.cursors[c]; this.written.delete(c); }
    }
    this.save();
  }

  /**
   * Version 2 → 3: adds the "Reply to" and "Photo" columns to every tab (rows stay where they are),
   * reads each tab's Sort column to know where rows are, then fills old rows' photos and replies.
   */
  async upgradeToV3() {
    const id = this.cfg.spreadsheetId;
    this.phase = 'upgrade';
    this.progress = { done: 0, total: 0 };
    this.changed();
    await this.forgetDeletedTabs();
    const meta = await getMeta(id);
    const titleOf = new Map(meta.tabs.map((t) => [t.sheetId, t.title]));
    const entries = Object.entries(this.cfg.tabs);
    const cols = await valuesBatchGet(id, entries.map(([, t]) => {
      const c = colLetter(t.sortCol);
      return `${quoteTitle(titleOf.get(t.sheetId))}!${c}2:${c}`;
    }));
    const requests = [];
    entries.forEach(([k, t], i) => {
      const head = k === PERSONAL_KEY ? PERSONAL_HEAD : GROUP_HEAD;
      const msgCol = head.indexOf('Message');
      const keys = (cols[i] || []).map(Number).filter((n) => Number.isFinite(n));
      const sorted = keys.every((x, j) => j === 0 || keys[j - 1] <= x);
      const sid = t.sheetId;
      requests.push(
        { insertDimension: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: msgCol + 1, endIndex: msgCol + 2 }, inheritFromBefore: true } },
        { insertDimension: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: msgCol + 3, endIndex: msgCol + 4 }, inheritFromBefore: true } },
        headerCell(sid, msgCol + 1, 'Reply to'),
        headerCell(sid, msgCol + 3, 'Photo'),
        columnWidth(sid, msgCol + 1, 260),
        columnWidth(sid, msgCol + 3, 150),
      );
      t.sortCol = head.indexOf('Sort');
      if (!sorted) {
        requests.push({ sortRange: { range: { sheetId: sid, startRowIndex: 1 }, sortSpecs: [{ dimensionIndex: t.sortCol, sortOrder: 'ASCENDING' }] } });
        keys.sort((a, b) => a - b);
      }
      t.keys = keys;
    });
    await batchUpdate(id, requests);
    this.cfg.version = 3;
    this.cfg.enrichPending = true;
    if (!this.cfg.imgSecret) this.cfg.imgSecret = crypto.randomBytes(16).toString('hex');
    this.save();
    console.log(`[sheets] sheet upgraded: "Reply to" and "Photo" columns added to ${entries.length} tabs`);
  }

  /**
   * Fills "Reply to" and "Photo" for rows written before those columns existed. A row is found by its
   * time (Sort value); messages sent in the same second are matched in order, and skipped when unclear.
   */
  async enrichOldRows() {
    const id = this.cfg.spreadsheetId;
    const chatIds = Object.keys(this.cfg.cursors);
    const chats = new Map((await this.wa.listChatsForSync()).map((c) => [c.id, c]));
    this.phase = 'upgrade';
    this.progress = { done: 0, total: chatIds.length };
    this.changed();

    // rows of each tab by second: second -> [sort value, …] in sheet order
    const bySecond = new Map();
    for (const [k, t] of Object.entries(this.cfg.tabs)) {
      const m = new Map();
      (t.keys || []).forEach((key) => { const s = Math.floor(key); if (!m.has(s)) m.set(s, []); m.get(s).push(key); });
      bySecond.set(k, m);
    }
    const personalAt = new Map(); // second -> [{ chat, msgs }]
    const targets = []; // { tabKey, key (the row's sort value), m }
    const pick = (tabKey, chat, msgsAt) => {
      for (const [s, list] of msgsAt) {
        const keysAt = (bySecond.get(tabKey) || new Map()).get(s) || [];
        if (keysAt.length !== list.length) continue; // unclear: skip
        list.forEach((m, j) => { if (m.reply || m.thumb || PHOTO_TYPES.has(m.type)) targets.push({ tabKey, key: keysAt[j], m }); });
      }
    };
    for (const chatId of chatIds) {
      if (!this.enabled) return;
      const chat = chats.get(chatId);
      if (chat) {
        const msgs = (await this.wa.fetchForSync(chatId, this.cfg.sinceTs)).filter((m) => this.isWritten(chatId, m.id));
        const msgsAt = new Map();
        for (const m of msgs) { if (!msgsAt.has(m.ts)) msgsAt.set(m.ts, []); msgsAt.get(m.ts).push(m); }
        if (chat.isGroup) pick(chatId, chat, msgsAt);
        else for (const [s, list] of msgsAt) { if (!personalAt.has(s)) personalAt.set(s, []); personalAt.get(s).push({ chat, list }); }
      }
      this.progress.done += 1;
      this.changed();
    }
    for (const [s, parts] of personalAt) if (parts.length === 1) pick(PERSONAL_KEY, parts[0].chat, new Map([[s, parts[0].list]]));

    // Write Reply to, Type, Photo (3 neighbouring cells) + tall rows for photos: newest first, a small
    // chunk at a time (photos downloaded side by side), so the sheet fills in visibly as it goes —
    // and new messages keep flowing in between chunks.
    targets.sort((a, b) => b.m.ts - a.m.ts);
    this.progress = { done: 0, total: targets.length };
    this.changed();
    for (let i = 0; i < targets.length; i += ENRICH_CHUNK) {
      if (!this.enabled) return;
      const chunk = targets.slice(i, i + ENRICH_CHUNK);
      const photos = await Promise.all(chunk.map((t) => this.photoCell(t.m).catch(() => null)));
      const requests = [];
      chunk.forEach((tgt, j) => {
        const tab = this.cfg.tabs[tgt.tabKey];
        if (!tab) return;
        // where the row is now (new messages may have been added above it meanwhile)
        const idx = lowerBound(tab.keys || [], tgt.key);
        if ((tab.keys || [])[idx] !== tgt.key) return;
        const row = idx + 1;
        const head = tgt.tabKey === PERSONAL_KEY ? PERSONAL_HEAD : GROUP_HEAD;
        requests.push({
          updateCells: {
            start: { sheetId: tab.sheetId, rowIndex: row, columnIndex: head.indexOf('Reply to') },
            rows: [{ values: [cell(this.replyText(tgt.m)), cell(tgt.m.typeLabel), photos[j] || cell('')] }],
            fields: 'userEnteredValue',
          },
        });
        if (photos[j]) requests.push(...heightRequests(tab.sheetId, row, [true]));
      });
      await batchUpdate(id, requests);
      this.progress.done = i + chunk.length;
      this.changed();
      await this.processDirty();
      this.phase = 'upgrade';
    }
    this.cfg.enrichPending = false;
    this.save();
    console.log(`[sheets] old rows updated with photos / replies: ${targets.length}`);
  }

  /** New messages that came in: write them now. */
  async processDirty() {
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    const chats = await this.wa.listChatsForSync();
    const byId = new Map(chats.map((c) => [c.id, c]));
    for (const id of ids) if (byId.has(id)) await this.collect(byId.get(id), false);
    await this.flush();
  }
}

module.exports = { SheetSync, botEmail, sheetIdFrom, photoFile, photoHostChanged, DATA_ROOT, KEY_FILE, isConfigured: () => !!loadKey() };
