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

const GROUP_HEAD = ['Date', 'Time', 'Day', 'Sender', 'Phone', 'Message', 'Type', 'Sort'];
const PERSONAL_HEAD = ['Chat', ...GROUP_HEAD];
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
  const value = (v) => (v.userEnteredValue.numberValue !== undefined ? v.userEnteredValue.numberValue : v.userEnteredValue.stringValue);
  for (const r of requests) {
    if (r.addSheet) book.sheets.push({ sheetId: r.addSheet.properties.sheetId, title: r.addSheet.properties.title, rows: [] });
    if (r.appendCells) {
      const tab = book.sheets.find((s) => s.sheetId === r.appendCells.sheetId);
      if (!tab) throw Object.assign(new Error(`No grid with id: ${r.appendCells.sheetId}`), { status: 400 });
      for (const row of r.appendCells.rows) tab.rows.push(row.values.map(value));
    }
    if (r.sortRange) {
      const tab = book.sheets.find((s) => s.sheetId === r.sortRange.range.sheetId);
      const col = r.sortRange.sortSpecs[0].dimensionIndex;
      tab.rows = [tab.rows[0], ...tab.rows.slice(1).sort((a, b) => a[col] - b[col])];
    }
  }
  drySave(id, book);
}

const cell = (v) => ({ userEnteredValue: { stringValue: String(v ?? '').slice(0, MAX_CELL) } });
const numCell = (n) => ({ userEnteredValue: { numberValue: n } });
const boldCell = (v) => ({ ...cell(v), userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.86, green: 0.97, blue: 0.9 } } });

/** Requests that create a new tab: bold frozen header, wide Message column, hidden Sort column. */
function newTabRequests(sheetId, title, head) {
  const msgCol = head.indexOf('Message');
  const sortCol = head.indexOf('Sort');
  const columns = (start, properties, fields) => ({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + 1 }, properties, fields },
  });
  return [
    // (2 rows: Google refuses to freeze every row of a sheet; rows are added as messages come in)
    { addSheet: { properties: { sheetId, title, gridProperties: { rowCount: 2, columnCount: head.length, frozenRowCount: 1 } } } },
    { appendCells: { sheetId, rows: [{ values: head.map(boldCell) }], fields: 'userEnteredValue,userEnteredFormat(textFormat,backgroundColor)' } },
    columns(msgCol, { pixelSize: 420 }, 'pixelSize'),
    columns(sortCol, { hiddenByUser: true }, 'hiddenByUser'),
  ];
}

function tabTitle(name, taken) {
  const base = String(name || 'Chat').replace(/[[\]*?/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Chat';
  let title = base;
  for (let n = 2; taken.has(title.toLowerCase()); n += 1) title = `${base} (${n})`;
  taken.add(title.toLowerCase());
  return title;
}

/** Short, stable fingerprint of a message id (remembered so a message is never written twice). */
const fingerprint = (id) => crypto.createHash('sha1').update(String(id)).digest('base64url').slice(0, 10);

// ---------------------------------------------------------------------------
// Sync of one WhatsApp login
// ---------------------------------------------------------------------------
const SINCE_DAYS = { 7: 7, 30: 30, 90: 90, 365: 365 };

class SheetSync extends EventEmitter {
  /**
   * @param {object} wa   the login's service: status(), listChatsForSync(), fetchForSync(id, sinceTs), 'chat-activity' events
   * @param {string} file where this login's sync settings and progress are saved
   */
  constructor(wa, file) {
    super();
    this.wa = wa;
    this.file = file;
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

  /** Old (first version) sheets have no Sort column: they only get new messages, no gap filling. */
  get canFillGaps() { return !!(this.cfg && this.cfg.version >= 2); }

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
        version: 2, enabled: true, spreadsheetId: id, title: meta.title, since: sinceKey, sinceTs, account: (me && me.id) || '',
        connectedAt: Date.now(), tabs: {}, cursors: {}, written: {}, rows: 0, lastWriteAt: 0,
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
        if (this.needFull) {
          const kind = this.needFull;
          this.needFull = null;
          await this.fullPass(kind);
        }
        if (this.dirty.size) {
          const ids = [...this.dirty];
          this.dirty.clear();
          const chats = await this.wa.listChatsForSync();
          const byId = new Map(chats.map((c) => [c.id, c]));
          for (const id of ids) if (byId.has(id)) await this.collect(byId.get(id), false);
          await this.flush();
        }
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
    const personal = !chat.isGroup;
    let seq = 0;
    let lastTs = -1;
    const rows = msgs.map((m) => {
      seq = m.ts === lastTs ? seq + 1 : 0; // keeps WhatsApp's order for messages in the same second
      lastTs = m.ts;
      const row = [cell(m.date), cell(m.time), cell(m.day), cell(m.name), cell(m.phone), cell(m.text), cell(m.typeLabel)];
      if (this.canFillGaps) row.push(numCell(m.ts + Math.min(seq, 999) / 1000));
      return personal ? [cell(chat.name), ...row] : row;
    });
    const maxTs = msgs[msgs.length - 1].ts;
    const minTs = msgs[0].ts;
    this.pending.push({
      key: personal ? PERSONAL_KEY : chat.id,
      chat,
      chatId: chat.id,
      rows,
      prints: msgs.map((m) => fingerprint(m.id)),
      minTs,
      maxTs,
      lastIds: msgs.filter((m) => m.ts === maxTs).map((m) => m.id),
    });
  }

  /** Writes all queued rows (creating tabs, re-sorting a tab when older messages were added), then saves. */
  async flush() {
    const pending = this.pending;
    if (!pending.length) return;
    const id = this.cfg.spreadsheetId;
    if (!this.titles) this.titles = new Set((await getMeta(id)).tabs.map((t) => t.title.toLowerCase()));

    const requests = [];
    const created = [];
    const resort = new Map(); // sheetId -> sort column
    const tabMax = {};
    for (const p of pending) {
      let tab = this.cfg.tabs[p.key];
      if (!tab) {
        const personal = p.key === PERSONAL_KEY;
        const head = personal ? PERSONAL_HEAD : GROUP_HEAD;
        tab = { sheetId: crypto.randomInt(1e6, 2e9), title: tabTitle(personal ? PERSONAL_TITLE : p.chat.name, this.titles), sortCol: head.indexOf('Sort'), maxTs: 0 };
        requests.push(...newTabRequests(tab.sheetId, tab.title, head));
        this.cfg.tabs[p.key] = tab;
        created.push(p.key);
      }
      requests.push({ appendCells: { sheetId: tab.sheetId, rows: p.rows.map((values) => ({ values })), fields: 'userEnteredValue' } });
      const max = tabMax[p.key] !== undefined ? tabMax[p.key] : (tab.maxTs || 0);
      if (this.canFillGaps && tab.sortCol >= 0 && p.minTs < max) resort.set(tab.sheetId, tab.sortCol); // older than what is there
      tabMax[p.key] = Math.max(max, p.maxTs);
    }
    for (const [sheetId, sortCol] of resort) {
      requests.push({ sortRange: { range: { sheetId, startRowIndex: 1 }, sortSpecs: [{ dimensionIndex: sortCol, sortOrder: 'ASCENDING' }] } });
    }

    try {
      await batchUpdate(id, requests); // all or nothing
    } catch (err) {
      for (const k of created) delete this.cfg.tabs[k];
      this.titles = null;
      // A tab we made was deleted in the sheet: forget it so the next pass creates it again.
      if (err.status === 400 && /grid|sheet ?id/i.test(err.message)) {
        const live = new Set((await getMeta(id)).tabs.map((t) => t.sheetId));
        for (const [k, t] of Object.entries(this.cfg.tabs)) {
          if (live.has(t.sheetId)) continue;
          delete this.cfg.tabs[k];
          // its chats start over, so the re-created tab gets all their messages again
          const chatIds = k === PERSONAL_KEY ? Object.keys(this.cfg.cursors).filter((c) => !c.endsWith('@g.us')) : [k];
          for (const c of chatIds) { delete this.cfg.cursors[c]; this.written.delete(c); }
        }
        this.save();
      }
      throw err;
    }

    const rows = this.pendingRows();
    for (const p of pending) {
      const set = this.written.get(p.chatId) || new Set();
      p.prints.forEach((f) => set.add(f));
      this.written.set(p.chatId, set);
      const cur = this.cfg.cursors[p.chatId];
      if (!cur || p.maxTs > cur.ts) this.cfg.cursors[p.chatId] = { ts: p.maxTs, ids: p.lastIds };
      else if (p.maxTs === cur.ts) cur.ids = [...new Set([...(cur.ids || []), ...p.lastIds])].slice(-200);
    }
    for (const [k, max] of Object.entries(tabMax)) if (this.cfg.tabs[k]) this.cfg.tabs[k].maxTs = max;
    this.cfg.rows = (this.cfg.rows || 0) + rows;
    this.cfg.lastWriteAt = Date.now();
    this.pending = [];
    this.save();
    this.changed();
  }
}

module.exports = { SheetSync, botEmail, sheetIdFrom, DATA_ROOT, KEY_FILE, isConfigured: () => !!loadKey() };
