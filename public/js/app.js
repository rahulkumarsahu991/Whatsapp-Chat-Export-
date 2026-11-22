// UI logic: QR login → WhatsApp Web-style group list → messages, photos & videos (chat / table) → export.
// Styling is Tailwind utility classes (built into /css/app.css by `npm run build:css`).

const $ = (sel) => document.querySelector(sel);
const els = {
  login: $('#login'), app: $('#app'), shell: $('#shell'), demoRibbon: $('#demoRibbon'),
  loginCard: $('#loginCard'), qrFlip: $('#qrFlip'), qrFrame: $('#qrFrame'), qrImg: $('#qrImg'),
  qrLoader: $('#qrLoader'), qrLoaderText: $('#qrLoaderText'), qrHint: $('#qrHint'),
  syncText: $('#syncText'), syncBar: $('#syncBar'), syncElapsed: $('#syncElapsed'), statusPill: $('#statusPill'), statusText: $('#statusText'), retryBtn: $('#retryBtn'),
  meAvatar: $('#meAvatar'), meName: $('#meName'), meNumber: $('#meNumber'),
  refreshBtn: $('#refreshBtn'), logoutBtn: $('#logoutBtn'), search: $('#search'),
  groupCount: $('#groupCount'), allCount: $('#allCount'), chatList: $('#chatList'),
  emptyState: $('#emptyState'), conversation: $('#conversation'), backBtn: $('#backBtn'),
  convAvatar: $('#convAvatar'), convName: $('#convName'), convMeta: $('#convMeta'),
  exportBtn: $('#exportBtn'), exportLabel: $('#exportLabel'), mediaToggle: $('#mediaToggle'), fab: $('#fab'),
  exportSheet: $('#exportSheet'), sheetTitle: $('#sheetTitle'), sheetSummary: $('#sheetSummary'),
  sheetMediaToggle: $('#sheetMediaToggle'), sheetExportBtn: $('#sheetExportBtn'), sheetExportLabel: $('#sheetExportLabel'),
  loadBtn: $('#loadBtn'), fromDate: $('#fromDate'), toDate: $('#toDate'),
  limitSel: $('#limitSel'), chips: $('#chips'), filterNote: $('#filterNote'),
  filters: $('#filters'), filtersBtn: $('#filtersBtn'), filtersSummary: $('#filtersSummary'), statsLine: $('#statsLine'), datePill: $('#datePill'),
  stTotal: $('#stTotal'), stMedia: $('#stMedia'), stMembers: $('#stMembers'), stFirst: $('#stFirst'), stLast: $('#stLast'),
  chatView: $('#chatView'), tableView: $('#tableView'), tableBody: $('#tableBody'), busy: $('#busy'), busyText: $('#busyText'),
  viewer: $('#viewer'), viewerTitle: $('#viewerTitle'), viewerSub: $('#viewerSub'), viewerBody: $('#viewerBody'),
  viewerDownload: $('#viewerDownload'), viewerClose: $('#viewerClose'),
  exportPanel: $('#exportPanel'), exportSpinner: $('#exportSpinner'), exportCheck: $('#exportCheck'), exportTitle: $('#exportTitle'),
  exportDetail: $('#exportDetail'), exportBar: $('#exportBar'), exportClose: $('#exportClose'), downloadAgainBtn: $('#downloadAgainBtn'),
  toasts: $('#toasts'),
  modeBadge: $('#modeBadge'), guestNote: $('#guestNote'),
  pairBox: $('#pairBox'), pairToggle: $('#pairToggle'), pairForm: $('#pairForm'), pairPhone: $('#pairPhone'), pairBtn: $('#pairBtn'),
  pairCodeBox: $('#pairCodeBox'), pairCode: $('#pairCode'), pairCancel: $('#pairCancel'),
  syncBtn: $('#syncBtn'), syncDot: $('#syncDot'), syncPanel: $('#syncPanel'), syncNotReady: $('#syncNotReady'),
  syncForm: $('#syncForm'), botEmail: $('#botEmail'), sheetLink: $('#sheetLink'), syncSince: $('#syncSince'),
  syncGuestNote: $('#syncGuestNote'), syncConnectBtn: $('#syncConnectBtn'), syncOn: $('#syncOn'),
  syncSheetLink: $('#syncSheetLink'), syncSheetTitle: $('#syncSheetTitle'), syncPhase: $('#syncPhase'),
  syncBarBox: $('#syncBarBox'), syncBar: $('#syncBar'), syncStats: $('#syncStats'), syncError: $('#syncError'), syncStopBtn: $('#syncStopBtn'),
};

const state = {
  status: null, screen: 'login', chats: [], tab: 'groups', query: '',
  selected: null, data: null, view: 'chat', loadToken: 0, exportJob: null, exportUrl: null,
  guest: false, ended: false, // guest = someone using the shared link with their own temporary login
};

// Render in pages so even groups with thousands of messages open instantly (older pages load on scroll).
const CHAT_PAGE = 150;
const TABLE_PAGE = 300;
const ANIMATED_BUBBLES = 25;
const TYPE_ICONS = {
  image: '📷', video: '🎬', audio: '🎵', ptt: '🎤', ptv: '🎥', document: '📄', sticker: '🌟', location: '📍',
  vcard: '👤', multi_vcard: '👥', poll_creation: '📊', call_log: '📞', revoked: '🚫', event_creation: '📅', album: '🖼️',
};
const VISUAL = new Set(['image', 'video', 'sticker', 'ptv']);
const PLAYABLE = new Set(['video', 'ptv']);
const AUDIO = new Set(['audio', 'ptt']);

/* ---------------- helpers ---------------- */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const setActive = (el, on) => el.toggleAttribute('data-active', !!on);
const mediaUrl = (id) => `/api/media/${encodeURIComponent(id)}`;
// Opened through the shared link (phone / other device) rather than on the PC itself.
const REMOTE = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/* ---- photo previews: fetched many at a time (one round trip per page, not one per photo) ---- */
const thumbCache = new Map(); // message id -> data: URL
const thumbQueue = new Set();
let thumbBusy = false;

function fillThumbs(root) {
  for (const img of root.querySelectorAll('img[data-thumb]:not([src])')) {
    const url = thumbCache.get(img.dataset.thumb);
    if (url) img.src = url; else thumbQueue.add(img.dataset.thumb);
  }
  if (thumbQueue.size && !thumbBusy) flushThumbs();
}

async function flushThumbs() {
  thumbBusy = true;
  while (thumbQueue.size) {
    const ids = [...thumbQueue].slice(0, 150);
    ids.forEach((id) => thumbQueue.delete(id));
    let thumbs = {};
    try { thumbs = (await (await postJson('/api/thumbs', { ids })).json()).thumbs || {}; } catch { /* show icons */ }
    for (const [id, url] of Object.entries(thumbs)) thumbCache.set(id, url);
    while (thumbCache.size > 3000) thumbCache.delete(thumbCache.keys().next().value);
    const asked = new Set(ids);
    for (const img of document.querySelectorAll('img[data-thumb]:not([src])')) {
      const id = img.dataset.thumb;
      if (thumbs[id]) img.src = thumbs[id];
      else if (asked.has(id)) img.replaceWith(mediaIcon());
    }
  }
  thumbBusy = false;
}

function mediaIcon() {
  const icon = document.createElement('span');
  icon.className = 'grid size-full min-h-10 min-w-10 place-items-center text-3xl';
  icon.textContent = '🖼️';
  return icon;
}
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

function hue(str = '') {
  let h = 0;
  for (const ch of str) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
function initials(name = '') {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '#';
}
const GROUP_ICON = '<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14c2.6.1 4.4 1.7 5 4.6"/></svg>';
function avatarInner(name, isGroup) {
  const inner = initials(name);
  return inner === '#' && isGroup ? GROUP_ICON : esc(inner);
}
function setAvatar(el, name, isGroup) {
  el.style.setProperty('--h', hue(name));
  el.innerHTML = avatarInner(name, isGroup);
}

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const days = Math.floor((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en-IN', { weekday: 'long' });
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function dayLabel(m) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (m.iso === isoOf(new Date())) return 'Today';
  if (m.iso === isoOf(y)) return 'Yesterday';
  return `${m.day}, ${new Date(m.ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

async function api(path, opts = {}) {
  // (ngrok-skip-browser-warning: on the phone link, keeps ngrok's free-plan notice page out of data requests)
  const res = await fetch(path, { ...opts, headers: { 'X-App': '1', 'ngrok-skip-browser-warning': '1', ...(opts.headers || {}) } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let body = null;
    try { body = await res.json(); msg = body.error || msg; } catch { /* not json */ }
    if (body && body.code === 'NO_SESSION') showEnded();
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res;
}
const postJson = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

const TOAST_COLORS = { info: 'border-l-neon-cyan', success: 'border-l-wa', error: 'border-l-rose-500' };
function toast(text, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `animate-toast rounded-xl border border-white/10 border-l-4 ${TOAST_COLORS[kind] || TOAST_COLORS.info} bg-ink-2 px-4 py-3 text-sm text-slate-100 shadow-2xl shadow-black/60 transition duration-300`;
  el.textContent = text;
  els.toasts.append(el);
  setTimeout(() => {
    el.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

function sparkle(fromEl) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = fromEl.getBoundingClientRect();
  const colors = ['#25d366', '#22d3ee', '#8b5cf6', '#ec4899', '#a3e635', '#ffffff'];
  for (let i = 0; i < 36; i++) {
    const s = document.createElement('i');
    s.className = 'pointer-events-none fixed z-[90] size-2 rounded-sm';
    s.style.background = colors[i % colors.length];
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    document.body.append(s);
    const a = Math.random() * Math.PI * 2;
    const d = 60 + Math.random() * 150;
    s.animate([
      { transform: 'translate(-50%,-50%) rotate(0) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d + 90}px) rotate(${Math.random() * 720}deg) scale(.3)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 600, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => s.remove();
  }
}

/* ---------------- micro-interactions (mouse only) ---------------- */
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

function tilt(el, max) {
  if (!el || !finePointer) return;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * max * 2}deg`);
    el.style.setProperty('--rx', `${-((e.clientY - r.top) / r.height - 0.5) * max * 2}deg`);
  });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
}

function magnetic(el) {
  if (!el || !finePointer) return;
  el.style.transition = 'transform .2s ease-out, box-shadow .2s';
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.12}px, ${(e.clientY - r.top - r.height / 2) * 0.2}px)`;
  });
  el.addEventListener('pointerleave', () => { el.style.transform = ''; });
}

document.addEventListener('pointermove', (e) => {
  const el = e.target instanceof Element ? e.target.closest('.spotlight') : null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - r.left}px`);
  el.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

/* ---------------- screens & status ---------------- */
function setScreen(name) {
  if (state.screen === name) return;
  state.screen = name;
  els.login.hidden = name !== 'login';
  els.app.hidden = name !== 'app';
}

// Seconds since the phone scanned the QR, shown on the "Linked!" card while WhatsApp syncs.
let syncTimer = null;
let syncStart = 0;
function trackSync(syncing) {
  if (!syncing) {
    clearInterval(syncTimer);
    syncTimer = null;
    els.syncElapsed.textContent = '';
    return;
  }
  if (syncTimer) return;
  syncStart = Date.now();
  const tick = () => { els.syncElapsed.textContent = `${Math.round((Date.now() - syncStart) / 1000)}s`; };
  tick();
  syncTimer = setInterval(tick, 1000);
}

function renderStatus(st) {
  if (state.ended) return;
  state.status = st;
  els.demoRibbon.hidden = !st.demo;
  renderPairing(st);
  trackSync(st.state === 'authenticated' || st.state === 'loading');

  if (st.state === 'ready') {
    const wasApp = state.screen === 'app';
    setScreen('app');
    const me = st.me || {};
    els.meName.textContent = me.name || 'You';
    els.meNumber.textContent = me.number ? `+${me.number}` : '';
    setAvatar(els.meAvatar, me.name || 'You', false);
    if (!wasApp) { resetConversation(); loadChats(); }
    return;
  }

  setScreen('login');
  els.statusPill.dataset.state = st.state;
  els.statusText.textContent = st.message || 'Connecting…';
  els.qrFlip.classList.toggle('flipped', st.state === 'authenticated' || st.state === 'loading');
  els.syncText.textContent = st.message || 'Syncing your chats…';
  els.syncBar.style.width = `${Math.max(5, st.progress || 0)}%`;
  els.retryBtn.hidden = st.state !== 'error';

  if (st.qr) {
    els.qrImg.src = st.qr;
    els.qrImg.hidden = false;
    els.qrLoader.hidden = true;
    els.qrFrame.classList.add('live');
  } else {
    els.qrImg.hidden = true;
    els.qrLoader.hidden = false;
    els.qrFrame.classList.remove('live');
    els.qrLoaderText.textContent = st.state === 'error' ? 'QR code unavailable — press Retry' : (st.message || 'Preparing QR code…');
  }
  els.qrFrame.classList.toggle('demo', !!st.demo && st.state === 'qr');
  els.qrHint.textContent = st.demo && st.state === 'qr'
    ? 'Demo mode: click the QR code to simulate a scan'
    : 'The QR code refreshes automatically — keep this page open';
  trackQrWait(!st.qr && (st.state === 'starting' || st.state === 'disconnected'), st.message);
}

/* ---- link with phone number instead of scanning (a phone can't scan its own screen) ---- */
function renderPairing(st) {
  const waiting = st.state === 'qr';
  els.pairBox.hidden = !waiting;
  const code = waiting && st.code ? String(st.code) : '';
  els.pairCodeBox.hidden = !code;
  els.pairToggle.hidden = !!code || !els.pairForm.hidden;
  if (code) {
    els.pairForm.hidden = true;
    els.pairCode.textContent = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  }
}

function openPairForm() {
  els.pairForm.hidden = false;
  els.pairToggle.hidden = true;
  if (!els.pairPhone.value) els.pairPhone.value = store.get('pairPhone') || '';
}

async function requestPairCode(e) {
  e.preventDefault();
  const digits = els.pairPhone.value.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 10) {
    toast('Type your number with the country code, e.g. 91 98765 43210', 'error');
    els.pairPhone.focus();
    return;
  }
  // Indian 10-digit mobile numbers without the country code: add +91.
  const phone = digits.length === 10 && /^[6-9]/.test(digits) ? `91${digits}` : digits;
  els.pairBtn.disabled = true;
  els.pairBtn.textContent = 'Wait…';
  try {
    const r = await (await postJson('/api/pair', { phone })).json();
    store.set('pairPhone', els.pairPhone.value);
    if (r.code && state.status) renderPairing({ ...state.status, code: r.code });
    toast('Code ready — check WhatsApp on your phone', 'success');
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    els.pairBtn.disabled = false;
    els.pairBtn.textContent = 'Get code';
  }
}

/** This visitor's temporary login is gone (logged out, timed out, or the app restarted). */
function showEnded(message) {
  if (state.ended) return;
  state.ended = true;
  setScreen('login');
  els.pairBox.hidden = true;
  els.qrFlip.classList.remove('flipped');
  els.qrImg.hidden = true;
  els.qrLoader.hidden = false;
  els.qrFrame.classList.remove('live');
  els.qrLoaderText.textContent = 'Logged out';
  els.qrLoader.firstElementChild.hidden = true; // stop the spinner
  els.qrHint.textContent = '';
  els.statusPill.dataset.state = 'disconnected';
  els.statusText.textContent = message || 'Your session ended. Your WhatsApp was unlinked and your data deleted from this app.';
  els.retryBtn.textContent = 'Start again';
  els.retryBtn.hidden = false;
  trackQrWait(false);
}

/** Who is this page for? The owner (this PC, or /owner on the shared link) or a guest with their own login. */
async function startSession() {
  try {
    const info = await (await api('/api/session', { method: 'POST' })).json();
    state.guest = info.role === 'guest';
    if (state.guest) {
      els.modeBadge.textContent = 'Your own private login';
      els.guestNote.hidden = false;
      els.guestNote.textContent = info.persistent
        ? 'Private: only you see your chats. Google Sheet sync is on, so your WhatsApp stays linked to this app — stop it with the sheet button (📊) or by logging out.'
        : `Private & temporary: only you see your chats. When you log out, or close this page for ${info.idleMinutes || 20} minutes, this app unlinks from your WhatsApp and deletes your data.`;
      els.logoutBtn.title = 'Log out & delete my data';
    } else if (!info.local) {
      els.modeBadge.textContent = 'Your WhatsApp, from anywhere';
    }
    if (matchMedia('(pointer: coarse)').matches) openPairForm(); // touch screen: probably the phone to link
    socket.connect();
  } catch (err) {
    els.statusPill.dataset.state = 'error';
    els.statusText.textContent = err.message;
    els.qrLoaderText.textContent = err.status === 503 ? 'Busy right now' : 'Could not start';
    els.retryBtn.textContent = 'Try again';
    els.retryBtn.hidden = false;
    state.ended = true; // the button reloads the page
  }
}

// While the QR is being prepared, count the seconds so a slow connection doesn't look frozen.
let qrWaitTimer = null;
let qrWaitStart = 0;
let qrWaitMsg = '';
function trackQrWait(waiting, message) {
  if (!waiting) {
    clearInterval(qrWaitTimer);
    qrWaitTimer = null;
    return;
  }
  qrWaitMsg = message || 'Preparing QR code…';
  if (!qrWaitTimer) {
    qrWaitStart = Date.now();
    qrWaitTimer = setInterval(paintQrWait, 1000);
  }
  paintQrWait();
}
function paintQrWait() {
  const s = Math.round((Date.now() - qrWaitStart) / 1000);
  els.qrLoaderText.textContent = `${qrWaitMsg} ${s}s`;
  if (s >= 20) {
    els.qrHint.textContent = 'Slow internet? The first start downloads WhatsApp Web (about 10 MB) — later starts reuse it and are much faster.';
  }
}

/* ---------------- chat list ---------------- */
async function loadChats(fresh = false) {
  els.chatList.innerHTML = '<li class="px-3 pb-1 pt-2 text-xs text-slate-500">Loading your chats…</li>'
    + Array.from({ length: 8 }, () => '<li class="skeleton mx-1 my-1.5 h-16 rounded-2xl"></li>').join('');
  els.refreshBtn.classList.add('spinning');
  try {
    const { chats } = await (await api(`/api/chats${fresh ? '?fresh=1' : ''}`)).json();
    state.chats = chats;
    renderList();
  } catch (err) {
    toast(err.message, 'error');
    els.chatList.innerHTML = '<li class="px-4 py-10 text-center text-sm text-slate-500">Could not load chats. Press refresh to try again.</li>';
  } finally {
    els.refreshBtn.classList.remove('spinning');
  }
}

function renderList() {
  const q = state.query.trim().toLowerCase();
  const groups = state.chats.filter((c) => c.isGroup);
  els.groupCount.textContent = fmtNum(groups.length);
  els.allCount.textContent = fmtNum(state.chats.length);
  const items = (state.tab === 'groups' ? groups : state.chats).filter((c) => !q || c.name.toLowerCase().includes(q));
  if (!items.length) {
    els.chatList.innerHTML = `<li class="px-4 py-10 text-center text-sm text-slate-500">${q ? `No chat matches “${esc(state.query)}”` : 'No groups found on this account.'}</li>`;
    return;
  }
  els.chatList.innerHTML = items.map((c, i) => `
    <li data-id="${esc(c.id)}" tabindex="0" ${state.selected?.id === c.id ? 'data-active' : ''} style="animation-delay:${Math.min(i, 20) * 25}ms"
        class="chat-item spotlight group animate-bubble relative my-0.5 flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 outline-none transition hover:bg-white/[0.05] focus-visible:bg-white/[0.07] data-active:bg-wa/10 data-active:ring-1 data-active:ring-wa/30 sm:py-2.5">
      <div class="avatar grid size-12 shrink-0 place-items-center rounded-full font-display text-sm font-bold text-white" style="--h:${hue(c.name)}">${avatarInner(c.name, c.isGroup)}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-medium">${esc(c.name)}</span>
          <time class="shrink-0 text-[11px] text-slate-500 group-data-active:text-wa">${listTime(c.timestamp)}</time>
        </div>
        <div class="mt-0.5 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[13px] text-slate-400">${c.isGroup && c.participants ? `<span class="mr-1.5 text-neon-cyan">👥 ${c.participants}</span>` : ''}${esc(c.preview)}</span>
          ${c.unread ? `<b class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-wa px-1.5 text-[11px] font-bold text-ink">${c.unread}</b>` : ''}
        </div>
      </div>
    </li>`).join('');
}

/* ---------------- conversation ---------------- */
function resetConversation() {
  state.selected = null;
  state.data = null;
  state.loadToken += 1;
  els.conversation.hidden = true;
  els.emptyState.hidden = false;
  els.shell.classList.remove('show-chat');
}

function selectChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  state.selected = chat;
  state.data = null;
  els.chatList.querySelectorAll('.chat-item').forEach((li) => setActive(li, li.dataset.id === id));
  els.emptyState.hidden = true;
  els.conversation.hidden = false;
  els.shell.classList.add('show-chat');
  setAvatar(els.convAvatar, chat.name, chat.isGroup);
  els.convName.textContent = chat.name;
  els.convMeta.textContent = chat.isGroup ? `${fmtNum(chat.participants)} members · group` : 'Individual chat';
  els.chatView.innerHTML = '';
  els.tableBody.innerHTML = '';
  renderStats([]);
  loadMessages();
}

function queryString() {
  const p = new URLSearchParams();
  if (els.fromDate.value) p.set('from', els.fromDate.value);
  if (els.toDate.value) p.set('to', els.toDate.value);
  p.set('limit', els.limitSel.value);
  return p.toString();
}

const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function setFiltersOpen(open) {
  els.filters.classList.toggle('open', open);
  els.filtersBtn.setAttribute('aria-expanded', String(open));
}
// "Compact" = phones and tablets (< 1024px): filters fold away, export lives in the floating button.
const isPhone = () => matchMedia('(max-width: 1023px)').matches;

function updateFilterNote() {
  const hasFrom = !!els.fromDate.value;
  const from = els.fromDate.value;
  const to = els.toDate.value;
  const sameMonth = from && to && from.slice(0, 7) === to.slice(0, 7);
  els.filtersSummary.textContent = from && to
    ? (from === to ? shortDate(from) : sameMonth ? `${Number(from.slice(8))}–${shortDate(to)}` : `${shortDate(from)} – ${shortDate(to)}`)
    : from ? `From ${shortDate(from)}`
      : to ? `Until ${shortDate(to)}`
        : els.limitSel.selectedOptions[0].textContent;
  els.limitSel.disabled = hasFrom;
  els.filterNote.textContent = hasFrom
    ? 'Start date set — every message from that date onward is loaded (older history is fetched automatically).'
    : 'Tip: pick a date range, then Export — the export contains exactly what you see here.';
}

function setBusy(on, text) {
  els.busy.hidden = !on;
  if (text) els.busyText.textContent = text;
  els.loadBtn.disabled = on;
  els.loadBtn.classList.toggle('working', on);
}

async function loadMessages(fresh = false) {
  const chat = state.selected;
  if (!chat) return;
  if (els.fromDate.value && els.toDate.value && els.fromDate.value > els.toDate.value) {
    toast('“From” date is after the “To” date.', 'error');
    return;
  }
  const token = ++state.loadToken;
  setBusy(true, 'Fetching messages…');
  const base = `/api/chats/${encodeURIComponent(chat.id)}/messages`;
  const fetchData = async (qs) => (await api(`${base}?${qs}${fresh ? '&fresh=1' : ''}`)).json();
  // Show the newest messages first (about 1-2 s), then load the rest of the period in the background
  // (1,000 messages can take 10 s or more the first time). Only for the plain "last N messages" chat view.
  const limit = els.limitSel.value;
  const quick = state.view === 'chat' && !els.fromDate.value && !els.toDate.value && (limit === 'all' || Number(limit) > CHAT_PAGE);
  let first = null;
  try {
    if (quick) {
      first = await fetchData(`limit=${CHAT_PAGE}`);
      if (token !== state.loadToken) return;
      state.data = first;
      renderMessages();
      setBusy(false);
      if (first.messages.length >= CHAT_PAGE) els.statsLine.textContent = 'Showing the newest messages · loading older ones…';
      else return; // the chat has no more messages than that
    }
    const data = await fetchData(queryString());
    if (token !== state.loadToken) return;
    if (first) mergeOlder(first, data); else { state.data = data; renderMessages(); }
  } catch (err) {
    if (token !== state.loadToken) return;
    toast(err.message, 'error');
    if (first) renderStats(first.messages);
    else els.chatView.innerHTML = `<div class="grid h-full place-items-center p-6 text-center text-slate-400">${esc(err.message)}</div>`;
  } finally {
    if (token === state.loadToken) setBusy(false);
  }
}

/** The full period arrived while the newest messages are on screen: add the older ones without a jump. */
function mergeOlder(first, data) {
  state.data = data;
  const full = data.messages;
  const shown = first.messages;
  const extra = full.length - shown.length;
  const sameTail = extra >= 0 && shown.length > 0 && full[full.length - 1].id === shown[shown.length - 1].id
    && full[extra].id === shown[0].id;
  if (state.view !== 'chat' || chatPaging.msgs !== shown || !sameTail) {
    renderMessages(); // something changed meanwhile (new message, other view): just draw it again
    return;
  }
  renderStats(full);
  chatPaging.msgs = full;
  chatPaging.start += extra;
  if (chatPaging.start > 0 && !document.getElementById('chatTop')) {
    const view = els.chatView;
    const before = view.scrollHeight;
    view.insertAdjacentHTML('afterbegin', TOP_LOADER);
    view.scrollTop += view.scrollHeight - before;
  }
  fillChat();
}

function renderStats(msgs) {
  const authors = new Set(msgs.map((m) => m.authorId || m.name));
  els.stTotal.textContent = msgs.length ? fmtNum(msgs.length) : '0';
  els.stMedia.textContent = fmtNum(msgs.filter((m) => m.type === 'image' || m.type === 'video').length);
  els.stMembers.textContent = msgs.length ? fmtNum(authors.size) : '0';
  els.stFirst.textContent = msgs.length ? msgs[0].date : '—';
  els.stLast.textContent = msgs.length ? msgs[msgs.length - 1].date : '—';
  els.statsLine.textContent = msgs.length
    ? `${fmtNum(msgs.length)} messages · ${els.stMedia.textContent} photos/videos · ${fmtNum(authors.size)} members · ${msgs[0].date} → ${msgs[msgs.length - 1].date}`
    : '';
}

const PLAY_BADGE = '<span class="pointer-events-none absolute inset-0 grid place-items-center"><span class="grid size-12 place-items-center rounded-full bg-black/60 text-white ring-2 ring-white/70"><svg class="ml-0.5 size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></span>';

/** Photo / video / voice note / document block inside a chat bubble. */
function mediaHtml(m) {
  const id = esc(m.id);
  if (VISUAL.has(m.type)) {
    const sticker = m.type === 'sticker';
    const box = sticker ? 'size-32 bg-transparent' : 'aspect-[4/3] w-72 max-w-full bg-black/40';
    const fit = sticker ? 'object-contain' : 'object-cover';
    let inner;
    if (!PLAYABLE.has(m.type) && (!REMOTE || !m.thumb)) {
      // Photos/stickers on this PC: the real image loads lazily, only when it scrolls into view.
      inner = `<img src="${mediaUrl(m.id)}" loading="lazy" decoding="async" alt="${esc(m.typeLabel)}" class="size-full ${fit}">`;
    } else if (m.thumb) {
      // Videos (and photos on the shared link): only the small preview here, fetched in batches;
      // the full file downloads when it is opened.
      inner = `<img data-thumb="${id}" decoding="async" alt="${esc(m.typeLabel)}" class="size-full ${fit}">`;
    } else {
      inner = `<span class="grid size-full place-items-center text-4xl">${TYPE_ICONS[m.type] || '📎'}</span>`;
    }
    return `<button type="button" data-media="${id}" aria-label="Open ${esc(m.typeLabel)}" class="relative mb-1 block overflow-hidden rounded-xl ${box} transition hover:brightness-110">${inner}${PLAYABLE.has(m.type) ? PLAY_BADGE : ''}</button>`;
  }
  if (AUDIO.has(m.type)) {
    return `<div class="mb-1 flex items-center gap-2"><span class="text-lg">${TYPE_ICONS[m.type]}</span><audio controls preload="none" src="${mediaUrl(m.id)}" class="h-10 w-60 max-w-full"></audio></div>`;
  }
  if (m.type === 'document') {
    return `<a href="${mediaUrl(m.id)}?download=1" class="mb-1 flex max-w-72 items-center gap-3 rounded-xl bg-black/25 px-3 py-2.5 transition hover:bg-black/35"><span class="text-2xl">📄</span><span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${esc(m.text || 'Document')}</span><span class="text-xs opacity-60">Tap to download</span></span></a>`;
  }
  return `<span class="mr-1.5 inline-flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-xs font-medium">${TYPE_ICONS[m.type] || '📎'} ${esc(m.typeLabel)}</span>`;
}

function bodyHtml(m) {
  if (m.type === 'revoked') return `<span class="italic text-slate-400">🚫 ${esc(m.text)}</span>`;
  let fwd = m.forwarded ? '<span class="block text-[11px] italic opacity-60">↪ Forwarded</span>' : '';
  // a reply shows the message it answers on top, like WhatsApp
  if (m.reply) {
    fwd += `<span class="mb-1 block max-w-full rounded-lg border-l-4 border-wa/70 bg-black/25 px-2.5 py-1 text-[12.5px] leading-snug"><b class="block truncate text-wa">${esc(m.reply.name)}</b><span class="line-clamp-2 whitespace-normal opacity-80">${esc(m.reply.text)}</span></span>`;
  }
  if (m.isMedia) {
    const caption = m.type === 'document' ? '' : esc(m.text);
    return `${fwd}${mediaHtml(m)}${caption}`;
  }
  const tag = m.type !== 'chat'
    ? `<span class="mr-1.5 inline-flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-xs font-medium">${TYPE_ICONS[m.type] || '📎'} ${esc(m.typeLabel)}</span>`
    : '';
  return `${fwd}${tag}${esc(m.text)}`;
}

/** Compact media cell for the table view. */
function tableBodyHtml(m) {
  if (m.type === 'revoked') return `<span class="italic text-slate-400">🚫 ${esc(m.text)}</span>`;
  if (VISUAL.has(m.type)) {
    const thumb = m.thumb
      ? `<img data-thumb="${esc(m.id)}" alt="" class="size-10 shrink-0 rounded-md bg-white/10 object-cover">`
      : `<span class="grid size-10 shrink-0 place-items-center rounded-md bg-white/10">${TYPE_ICONS[m.type] || '📎'}</span>`;
    return `<button type="button" data-media="${esc(m.id)}" class="flex items-center gap-2.5 text-left hover:text-neon-cyan">${thumb}<span>${esc(m.text) || `<span class="text-slate-400">${esc(m.typeLabel)} · view</span>`}</span></button>`;
  }
  if (m.isMedia) {
    return `<a href="${mediaUrl(m.id)}?download=1" class="hover:text-neon-cyan">${TYPE_ICONS[m.type] || '📎'} ${esc(m.text || m.typeLabel)} <span class="text-xs text-slate-500">download</span></a>`;
  }
  return bodyHtml(m);
}

function renderMessages() {
  const msgs = state.data?.messages || [];
  renderStats(msgs);
  if (state.view === 'chat') renderChat(msgs); else renderTable(msgs);
}

/* ---- chat view: paged rendering ---- */
const chatPaging = { msgs: [], start: 0, isGroup: false };
const chipHtml = (m) => `<div data-chip="${esc(m.iso)}" class="my-4 flex justify-center"><span class="rounded-full border border-white/10 bg-ink-2 px-3.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-300 shadow-lg">${esc(dayLabel(m))}</span></div>`;

function bubbleHtml(m, prev, animate) {
  const cont = !!prev && prev.iso === m.iso && prev.authorId === m.authorId;
  const visual = VISUAL.has(m.type);
  const who = chatPaging.isGroup && !m.fromMe && !cont
    ? `<span class="sender mb-0.5 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold ${visual ? 'px-1.5' : ''}" style="--h:${hue(m.authorId || m.name)}">${esc(m.name)}${m.phone && m.phone !== m.name ? `<i class="text-[11px] font-normal not-italic text-slate-400">${esc(m.phone)}</i>` : ''}</span>`
    : '';
  const corner = cont ? '' : m.fromMe ? 'rounded-tr-md' : 'rounded-tl-md';
  const look = m.fromMe ? 'bg-emerald-700 text-white' : 'border border-white/[0.06] bg-[#1a1d2e] text-slate-100';
  return `<div data-day="${esc(dayLabel(m))}" class="${animate ? 'animate-bubble' : ''} flex ${m.fromMe ? 'justify-end' : ''} ${cont ? 'mt-0.5' : 'mt-2'}"><div class="relative max-w-[min(85%,640px)] whitespace-pre-wrap break-words rounded-2xl ${corner} ${look} ${visual ? 'p-1.5 pb-1' : 'px-3 py-1.5'} text-[14.5px] leading-relaxed shadow-md shadow-black/30 sm:max-w-[min(75%,640px)]">${who}${bodyHtml(m)}<span class="float-right -mb-1 ml-3 mt-1.5 text-[11px] opacity-55 ${visual ? 'mr-1.5' : ''}">${esc(m.time)}</span></div></div>`;
}

/** HTML for msgs[from, to): starts with that day's chip, adds a chip whenever the day changes. */
function chatChunkHtml(from, to, animateTail) {
  const { msgs } = chatPaging;
  let html = '';
  for (let i = from; i < to; i++) {
    const m = msgs[i];
    const prev = i > from ? msgs[i - 1] : null;
    if (!prev || prev.iso !== m.iso) html += chipHtml(m);
    html += bubbleHtml(m, prev, animateTail && i >= to - ANIMATED_BUBBLES);
  }
  return html;
}

const TOP_LOADER = '<div id="chatTop" class="py-3 text-center text-xs text-slate-500">Loading earlier messages…</div>';

function renderChat(msgs) {
  if (!msgs.length) {
    els.chatView.innerHTML = '<div class="grid h-full place-items-center p-6 text-center text-slate-400">No messages in this period. Try a wider date range or “All available”.</div>';
    return;
  }
  chatPaging.msgs = msgs;
  chatPaging.isGroup = !!state.data.chat?.isGroup;
  chatPaging.start = Math.max(0, msgs.length - CHAT_PAGE);
  els.chatView.innerHTML = (chatPaging.start > 0 ? TOP_LOADER : '') + chatChunkHtml(chatPaging.start, msgs.length, true);
  els.chatView.scrollTop = els.chatView.scrollHeight;
  fillChat();
  fillThumbs(els.chatView);
}

const NEAR_EDGE = 600; // px from the edge at which the next page is rendered

/** Keep adding older pages while there is not enough content to scroll. */
function fillChat() {
  const v = els.chatView;
  if (!v.clientHeight) return; // not laid out (hidden) — scrolling will page in later
  while (chatPaging.start > 0 && v.scrollTop < NEAR_EDGE) loadEarlier();
}

function loadEarlier() {
  const { msgs, start } = chatPaging;
  if (start <= 0) return;
  const newStart = Math.max(0, start - CHAT_PAGE);
  const view = els.chatView;
  const firstChip = view.querySelector('[data-chip]');
  const before = view.scrollHeight;
  document.getElementById('chatTop')?.remove();
  view.insertAdjacentHTML('afterbegin', (newStart > 0 ? TOP_LOADER : '') + chatChunkHtml(newStart, start, false));
  // The older page may end on the same day the current view starts with: drop the duplicate chip.
  if (firstChip && msgs[start - 1].iso === msgs[start].iso) firstChip.remove();
  chatPaging.start = newStart;
  view.scrollTop += view.scrollHeight - before;
  fillThumbs(view);
}

// Scrolling near the top renders the previous page; a floating date pill (like WhatsApp)
// shows the day of the messages at the top while scrolling.
let pillTimer = null;
let pillFrame = 0;
els.chatView.addEventListener('scroll', () => {
  if (chatPaging.start > 0 && els.chatView.scrollTop < NEAR_EDGE) loadEarlier();
  if (pillFrame) return;
  pillFrame = requestAnimationFrame(() => {
    pillFrame = 0;
    const r = els.chatView.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 48);
    const row = hit && hit.closest('[data-day],[data-chip]');
    const label = row && (row.dataset.day || row.textContent.trim());
    if (!label) return;
    els.datePill.textContent = label;
    els.datePill.classList.remove('opacity-0');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => els.datePill.classList.add('opacity-0'), 1200);
  });
}, { passive: true });

/* ---- table view: paged rendering ---- */
const tablePaging = { msgs: [], end: 0 };
const TD = 'border-b border-white/[0.05] px-3 py-2.5 align-top';
function tableRowsHtml(from, to) {
  let html = '';
  for (let i = from; i < to; i++) {
    const m = tablePaging.msgs[i];
    html += `<tr class="${m.fromMe ? 'bg-wa/[0.07]' : 'odd:bg-white/[0.02]'} transition-colors hover:bg-white/[0.06]">
      <td class="${TD} text-slate-500">${i + 1}</td>
      <td class="${TD} whitespace-nowrap text-slate-300">${esc(m.date)}</td>
      <td class="${TD} whitespace-nowrap text-slate-400">${esc(m.time)}</td>
      <td class="${TD} whitespace-nowrap text-slate-400">${esc(m.day)}</td>
      <td class="${TD} sender whitespace-nowrap font-medium" style="--h:${hue(m.authorId || m.name)}">${esc(m.name)}</td>
      <td class="${TD} whitespace-nowrap tabular-nums text-slate-400">${esc(m.phone)}</td>
      <td class="${TD} min-w-[240px] whitespace-pre-wrap break-words text-slate-200">${tableBodyHtml(m)}</td>
      <td class="${TD} whitespace-nowrap text-slate-400">${esc(m.typeLabel)}</td>
    </tr>`;
  }
  return html;
}
const TABLE_LOADER = '<tr id="tableMore"><td colspan="8" class="px-3 py-4 text-center text-xs text-slate-500">Loading more rows…</td></tr>';

function renderTable(msgs) {
  if (!msgs.length) {
    els.tableBody.innerHTML = '<tr><td colspan="8" class="px-3 py-12 text-center text-slate-400">No messages in this period.</td></tr>';
    return;
  }
  tablePaging.msgs = msgs;
  tablePaging.end = Math.min(msgs.length, TABLE_PAGE);
  els.tableBody.innerHTML = tableRowsHtml(0, tablePaging.end) + (tablePaging.end < msgs.length ? TABLE_LOADER : '');
  els.tableView.scrollTop = 0;
  fillTable();
  fillThumbs(els.tableBody);
}

function loadMoreRows() {
  const { msgs, end } = tablePaging;
  if (end >= msgs.length) return;
  const newEnd = Math.min(msgs.length, end + TABLE_PAGE);
  document.getElementById('tableMore')?.remove();
  els.tableBody.insertAdjacentHTML('beforeend', tableRowsHtml(end, newEnd) + (newEnd < msgs.length ? TABLE_LOADER : ''));
  tablePaging.end = newEnd;
  fillThumbs(els.tableBody);
}

const tableNearEnd = () => {
  const v = els.tableView;
  return v.scrollHeight - v.scrollTop - v.clientHeight < NEAR_EDGE;
};
function fillTable() {
  if (!els.tableView.clientHeight) return;
  while (tablePaging.end < tablePaging.msgs.length && tableNearEnd()) loadMoreRows();
}
els.tableView.addEventListener('scroll', () => { if (tableNearEnd()) loadMoreRows(); }, { passive: true });

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((b) => setActive(b, b.dataset.view === view));
  els.chatView.hidden = view !== 'chat';
  els.tableView.hidden = view !== 'table';
  if (state.data) renderMessages();
}

/* ---------------- media viewer ---------------- */
function findMessage(id) {
  return state.data?.messages.find((m) => m.id === id) || null;
}

function viewerMessage(text) {
  els.viewerBody.innerHTML = `<div class="max-w-sm rounded-2xl border border-white/10 bg-ink-2 p-6 text-center text-sm leading-relaxed text-slate-300"><p class="mb-2 text-3xl">🖼️</p>${esc(text)}</div>`;
}

function openViewer(id) {
  const m = findMessage(id);
  if (!m) return;
  els.viewerTitle.textContent = `${m.name} · ${m.typeLabel}`;
  els.viewerSub.textContent = `${m.date} · ${m.day} · ${m.time}${m.text ? ` — ${m.text}` : ''}`;
  els.viewerDownload.href = `${mediaUrl(id)}?download=1`;
  // Show the small preview at once (if we have it) while the full file loads.
  const spinner = '<div class="size-12 animate-spin rounded-full border-4 border-white/10 border-t-wa border-r-neon-cyan"></div>';
  const preview = thumbCache.get(id);
  els.viewerBody.innerHTML = preview
    ? `<div class="relative grid place-items-center"><img src="${esc(preview)}" alt="" class="max-h-[80vh] max-w-full rounded-lg object-contain opacity-60 blur-[2px]"><div class="absolute">${spinner}</div></div>`
    : spinner;
  els.viewer.hidden = false;
  document.body.style.overflow = 'hidden';

  const unavailable = 'This file is no longer available. WhatsApp only keeps old photos and videos for a limited time, and only while the phone still has them.';
  const el = document.createElement(PLAYABLE.has(m.type) ? 'video' : 'img');
  el.className = 'max-h-full max-w-full rounded-lg object-contain shadow-2xl';
  if (el.tagName === 'VIDEO') {
    Object.assign(el, { controls: true, autoplay: true, playsInline: true });
    el.addEventListener('loadeddata', () => els.viewerBody.replaceChildren(el), { once: true });
  } else {
    el.alt = m.text || m.typeLabel;
    el.addEventListener('load', () => els.viewerBody.replaceChildren(el), { once: true });
  }
  el.addEventListener('error', () => { if (!els.viewer.hidden) viewerMessage(unavailable); }, { once: true });
  el.src = mediaUrl(id);
  if (el.tagName === 'VIDEO') el.load();
}

function closeViewer() {
  els.viewer.hidden = true;
  els.viewerBody.querySelector('video')?.pause();
  els.viewerBody.replaceChildren();
  document.body.style.overflow = '';
}

/* ---------------- Google Sheet sync ---------------- */
let syncStatus = null;
const timeAgo = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

function renderSync(st) {
  if (!st) return;
  syncStatus = st;
  els.syncDot.hidden = !st.enabled;
  els.syncDot.classList.toggle('bg-rose-500', st.phase === 'error');
  els.syncDot.classList.toggle('bg-wa', st.phase !== 'error');
  els.syncNotReady.hidden = st.configured || st.enabled;
  els.syncForm.hidden = !st.configured || st.enabled;
  els.syncOn.hidden = !st.enabled;
  els.botEmail.textContent = st.botEmail || '';
  els.syncGuestNote.hidden = !state.guest;
  if (!st.enabled) return;

  els.syncSheetLink.href = st.sheetUrl;
  els.syncSheetTitle.textContent = st.sheetTitle || 'Your Google Sheet';
  const busy = st.phase === 'backfill' || st.phase === 'catchup' || st.phase === 'gaps' || st.phase === 'upgrade';
  const phases = {
    upgrade: `Adding photos & replies to the sheet… ${fmtNum(st.done)} / ${fmtNum(st.total)}`,
    backfill: `Copying old messages… ${fmtNum(st.done)} / ${fmtNum(st.total)} chats`,
    catchup: `Catching up on new messages… ${fmtNum(st.done)} / ${fmtNum(st.total)} chats`,
    gaps: `Checking for older messages WhatsApp loaded later… ${fmtNum(st.done)} / ${fmtNum(st.total)} chats`,
    live: '✅ Live — new messages are added automatically',
    waiting: '⏳ Waiting for WhatsApp to connect…',
    error: '⚠️ Sync problem — retrying every minute',
    idle: 'Starting…',
  };
  els.syncPhase.textContent = phases[st.phase] || 'Starting…';
  els.syncBarBox.hidden = !busy;
  els.syncBar.style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 5}%`;
  els.syncStats.textContent = `${fmtNum(st.rows)} messages in the sheet${st.lastWriteAt ? ` · last update ${timeAgo(st.lastWriteAt)}` : ''}${
    st.photos ? '' : ' · photos show in the sheet only when the app runs with start-mobile.bat'}`;
  const oldFormat = st.oldFormat
    ? 'This sheet was connected with the first version: it gets new messages, but older ones WhatsApp loaded late are not filled in. For a complete sheet: Stop sync, make a new sheet and connect that.'
    : '';
  els.syncError.hidden = !st.error && !oldFormat;
  els.syncError.textContent = st.error || oldFormat;
}

async function openSyncPanel() {
  els.syncPanel.hidden = false;
  document.body.style.overflow = 'hidden';
  try { renderSync(await (await api('/api/sync')).json()); } catch (err) { toast(err.message, 'error'); }
}
function closeSyncPanel() {
  els.syncPanel.hidden = true;
  document.body.style.overflow = '';
}

async function connectSheet(e) {
  e.preventDefault();
  const sheet = els.sheetLink.value.trim();
  if (!/docs\.google\.com\/spreadsheets\/d\//.test(sheet)) {
    toast('Paste the full link of your Google Sheet', 'error');
    els.sheetLink.focus();
    return;
  }
  els.syncConnectBtn.disabled = true;
  els.syncConnectBtn.textContent = 'Checking the sheet…';
  try {
    renderSync(await (await postJson('/api/sync', { sheet, since: els.syncSince.value })).json());
    toast('Connected — copying your chats to the sheet', 'success');
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    els.syncConnectBtn.disabled = false;
    els.syncConnectBtn.textContent = 'Connect & start sync';
  }
}

async function stopSync() {
  const question = state.guest
    ? 'Stop the sync? The sheet keeps what it has. Your login becomes temporary again (logged out when you leave).'
    : 'Stop the sync? The sheet keeps what it has; new messages are no longer added.';
  if (!confirm(question)) return;
  try { renderSync(await (await api('/api/sync/stop', { method: 'POST' })).json()); toast('Sync stopped', 'success'); } catch (err) { toast(err.message, 'error'); }
}

/* ---------------- export ---------------- */
function fileNameFrom(disposition) {
  if (!disposition) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : '';
}

/** The desktop switch and the phone sheet switch are the same setting. */
function setIncludeMedia(on, save = true) {
  els.mediaToggle.checked = on;
  els.sheetMediaToggle.checked = on;
  if (save) store.set('includeMedia', on ? '1' : '0');
  updateExportLabel();
}

function updateExportLabel() {
  const label = els.mediaToggle.checked ? 'Download ZIP' : 'Download Excel';
  els.sheetExportLabel.textContent = els.mediaToggle.checked ? 'Download ZIP (Excel + media)' : 'Download Excel';
  if (!els.exportBtn.disabled) els.exportLabel.textContent = label;
}

function setExporting(on, label) {
  els.exportBtn.disabled = on;
  els.fab.disabled = on;
  els.exportBtn.classList.toggle('working', on);
  els.exportLabel.textContent = on ? label : '';
  if (!on) updateExportLabel();
}

/** Starts a normal browser download (streams straight to the Downloads folder, no page memory). */
function startDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

function openSheet() {
  const chat = state.selected;
  if (!chat) return;
  els.sheetTitle.textContent = chat.name;
  els.sheetSummary.textContent = `${els.filtersSummary.textContent} · ${els.statsLine.textContent.split(' · ').slice(0, 2).join(' · ') || 'no messages loaded'}`;
  els.exportSheet.hidden = false;
}
function closeSheet() { els.exportSheet.hidden = true; }

async function exportExcelOnly(chat) {
  setExporting(true, 'Preparing Excel…');
  try {
    const res = await api(`/api/chats/${encodeURIComponent(chat.id)}/export?${queryString()}`);
    const blob = await res.blob();
    const name = fileNameFrom(res.headers.get('Content-Disposition')) || `${chat.name}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    sparkle(isPhone() ? els.fab : els.exportBtn);
    toast(`Excel ready: ${name} (check your Downloads folder)`, 'success', 6000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setExporting(false);
  }
}

function showExportPanel({ title, detail, pct, done = false, failed = false }) {
  els.exportPanel.hidden = false;
  els.exportTitle.textContent = title;
  els.exportDetail.textContent = detail || '';
  els.exportBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  els.exportSpinner.hidden = done || failed;
  els.exportCheck.hidden = !done;
  els.exportClose.hidden = !(done || failed);
  els.downloadAgainBtn.hidden = !done || !state.exportUrl;
}

async function exportWithMedia(chat) {
  setExporting(true, 'Preparing…');
  state.exportUrl = null;
  showExportPanel({ title: `Exporting “${chat.name}”`, detail: 'Loading messages…', pct: 2 });
  // The job id is chosen here so progress events that arrive before the HTTP reply are not missed.
  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  state.exportJob = jobId;
  try {
    await api(`/api/chats/${encodeURIComponent(chat.id)}/export-zip?${queryString()}&job=${jobId}`, { method: 'POST' });
  } catch (err) {
    state.exportJob = null;
    setExporting(false);
    showExportPanel({ title: 'Export failed', detail: err.message, pct: 100, failed: true });
  }
}

function exportExcel() {
  const chat = state.selected;
  if (!chat) return;
  if (els.mediaToggle.checked) exportWithMedia(chat); else exportExcelOnly(chat);
}

function applyRange(range) {
  const today = new Date();
  els.chips.querySelectorAll('button').forEach((b) => setActive(b, b.dataset.range === range && range !== 'clear'));
  if (range === 'clear') {
    els.fromDate.value = '';
    els.toDate.value = '';
  } else if (range === 'today') {
    els.fromDate.value = isoOf(today);
    els.toDate.value = isoOf(today);
  } else if (range === 'month') {
    els.fromDate.value = isoOf(new Date(today.getFullYear(), today.getMonth(), 1));
    els.toDate.value = isoOf(today);
  } else {
    const from = new Date(today);
    from.setDate(from.getDate() - (Number(range) - 1));
    els.fromDate.value = isoOf(from);
    els.toDate.value = isoOf(today);
  }
  updateFilterNote();
  loadMessages();
}

/* ---------------- events ---------------- */
els.chatList.addEventListener('click', (e) => {
  const li = e.target.closest('.chat-item');
  if (li) selectChat(li.dataset.id);
});
els.chatList.addEventListener('keydown', (e) => {
  const li = e.target.closest('.chat-item');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectChat(li.dataset.id); }
});
els.search.addEventListener('input', () => { state.query = els.search.value; renderList(); });
document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
  state.tab = tab.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((t) => setActive(t, t === tab));
  els.search.placeholder = state.tab === 'groups' ? 'Search groups…' : 'Search all chats…';
  renderList();
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  applyRange(b.dataset.range);
  if (isPhone()) setFiltersOpen(false); // give the screen back to the chat
});
els.filtersBtn.addEventListener('click', () => setFiltersOpen(!els.filters.classList.contains('open')));
[els.fromDate, els.toDate, els.limitSel].forEach((el) => el.addEventListener('change', () => {
  els.chips.querySelectorAll('button').forEach((b) => setActive(b, false));
  updateFilterNote();
  loadMessages();
}));
els.loadBtn.addEventListener('click', () => { loadMessages(true); if (isPhone()) setFiltersOpen(false); });
els.exportBtn.addEventListener('click', exportExcel);
els.mediaToggle.addEventListener('change', () => setIncludeMedia(els.mediaToggle.checked));
els.sheetMediaToggle.addEventListener('change', () => setIncludeMedia(els.sheetMediaToggle.checked));
els.fab.addEventListener('click', openSheet);
els.sheetExportBtn.addEventListener('click', () => { closeSheet(); exportExcel(); });
els.exportSheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
els.refreshBtn.addEventListener('click', () => loadChats(true));
els.backBtn.addEventListener('click', () => els.shell.classList.remove('show-chat'));
els.logoutBtn.addEventListener('click', async () => {
  const question = state.guest
    ? 'Log out? This app unlinks from your WhatsApp and deletes your chats, photos and files from it.'
    : 'Log out? This unlinks the exporter from your WhatsApp and clears downloaded media from this computer. Google Sheet sync pauses and carries on by itself after you scan the same account again.';
  if (!confirm(question)) return;
  try {
    const r = await (await api('/api/logout', { method: 'POST' })).json();
    if (r.ended) showEnded('Logged out. Your WhatsApp was unlinked and your data deleted from this app.');
    else toast('Logged out', 'success');
  } catch (err) { toast(err.message, 'error'); }
});
els.retryBtn.addEventListener('click', async () => {
  if (state.ended) { window.location.reload(); return; }
  try { await api('/api/restart', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
});
els.pairToggle.addEventListener('click', () => { openPairForm(); els.pairPhone.focus(); });
els.pairForm.addEventListener('submit', requestPairCode);
els.pairCancel.addEventListener('click', async () => {
  els.pairCodeBox.hidden = true;
  try { await api('/api/restart', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
});
els.pairCode.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.pairCode.textContent.replace(/-/g, ''));
    toast('Code copied', 'success', 2000);
  } catch { /* clipboard not allowed */ }
});
els.qrFrame.addEventListener('click', async () => {
  if (!state.status?.demo || state.status.state !== 'qr') return;
  try { await api('/api/demo/scan', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); }
});

// media: open viewer, and swap broken thumbnails for an icon
[els.chatView, els.tableView].forEach((view) => {
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-media]');
    if (btn) openViewer(btn.dataset.media);
  });
  view.addEventListener('error', (e) => {
    if (e.target.tagName !== 'IMG') return;
    e.target.replaceWith(mediaIcon());
  }, true);
});
els.viewerClose.addEventListener('click', closeViewer);
els.viewer.addEventListener('click', (e) => { if (e.target === els.viewerBody) closeViewer(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.viewer.hidden) closeViewer();
  else if (!els.exportSheet.hidden) closeSheet();
  else if (!els.syncPanel.hidden) closeSyncPanel();
});

els.exportClose.addEventListener('click', () => { els.exportPanel.hidden = true; });
els.downloadAgainBtn.addEventListener('click', () => { if (state.exportUrl) startDownload(state.exportUrl); });

tilt(els.loginCard, 4);
document.querySelectorAll('.tilt-sm').forEach((el) => tilt(el, 8));
magnetic(els.loadBtn);
setIncludeMedia(store.get('includeMedia') !== '0', false);
updateFilterNote();

/* ---------------- live connection ---------------- */
// Connects after startSession(), so a guest's login cookie is already set for the handshake.
// WebSocket first: connects in one round trip (polling first needed 3-4 over the shared link).
const socket = io({ autoConnect: false, transports: ['websocket', 'polling'], tryAllTransports: true });
socket.on('status', renderStatus);
socket.on('sync', renderSync);
els.syncBtn.addEventListener('click', openSyncPanel);
els.syncPanel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSyncPanel(); });
els.syncForm.addEventListener('submit', connectSheet);
els.syncStopBtn.addEventListener('click', stopSync);
els.botEmail.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(els.botEmail.textContent); toast('Email copied', 'success', 2000); } catch { /* clipboard blocked */ }
});
setInterval(() => { if (!els.syncPanel.hidden && syncStatus) renderSync(syncStatus); }, 30000); // refresh "x min ago"
// "Photo helper" for the Google Sheet: copy its code for the sheet's Apps Script editor
document.getElementById('copyHelperBtn').addEventListener('click', async () => {
  try {
    const code = await (await fetch('/photo-helper.gs', { headers: { 'ngrok-skip-browser-warning': '1' } })).text();
    await navigator.clipboard.writeText(code);
    toast('Helper code copied — paste it in Apps Script', 'success', 4000);
  } catch {
    window.open('/photo-helper.gs', '_blank'); // clipboard blocked: show the code to copy by hand
  }
});
socket.on('session-ended', (r) => showEnded(r && r.why === 'app stopped'
  ? 'The app was stopped on the host computer, so your WhatsApp was unlinked and your data deleted.'
  : undefined));
socket.on('progress', (p) => {
  if (!els.busy.hidden && p && p.loaded) els.busyText.textContent = `Fetching messages… ${fmtNum(p.loaded)} loaded`;
});
socket.on('export-progress', (p) => {
  if (p.jobId !== state.exportJob) return;
  if (p.phase === 'excel') {
    showExportPanel({ title: 'Writing Excel file…', detail: `${fmtNum(p.done - p.failed)} media files saved`, pct: 97 });
    return;
  }
  const pct = p.total ? 5 + (p.done / p.total) * 90 : 50;
  const detail = p.total
    ? `Saving photos, videos & files: ${fmtNum(p.done)} / ${fmtNum(p.total)}${p.failed ? ` · ${fmtNum(p.failed)} no longer available` : ''}`
    : 'No photos or videos in this period — writing Excel…';
  showExportPanel({ title: 'Exporting…', detail, pct });
});
socket.on('export-done', (r) => {
  if (r.jobId !== state.exportJob) return;
  state.exportJob = null;
  state.exportUrl = r.url;
  setExporting(false);
  startDownload(r.url);
  showExportPanel({
    title: 'Download started',
    detail: `${r.zipName} — ${fmtNum(r.messages)} messages + ${fmtNum(r.saved)} media files${r.failed ? ` (${fmtNum(r.failed)} no longer available)` : ''}. Check your Downloads.`,
    pct: 100,
    done: true,
  });
  sparkle(isPhone() ? els.fab : els.exportBtn);
});
socket.on('export-error', (r) => {
  if (r.jobId !== state.exportJob) return;
  state.exportJob = null;
  setExporting(false);
  showExportPanel({ title: 'Export failed', detail: r.error, pct: 100, failed: true });
});
socket.on('disconnect', () => {
  if (state.ended) return;
  if (state.screen === 'login') {
    els.statusPill.dataset.state = 'error';
    els.statusText.textContent = state.guest
      ? 'Lost connection — check your internet. Reconnecting…'
      : 'Lost connection to the exporter — is the server window still open?';
  } else {
    toast(state.guest ? 'Lost connection — reconnecting…' : 'Lost connection to the exporter server. Restart it with start.bat.', 'error', 8000);
  }
});

startSession();
