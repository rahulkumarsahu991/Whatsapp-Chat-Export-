'use strict';

// Demo mode (start-demo.bat / `npm run demo`): same interface as the real WhatsApp service,
// but with sample groups so you can try the interface and the Excel export without logging in.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { TYPE_LABELS, timeParts, inRange, cacheKey } = require('./format');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function rng(seedText) {
  let a = 0;
  for (const ch of seedText) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = [
  'Aarav Sharma', 'Priya Verma', 'Rohan Gupta', 'Ananya Singh', 'Vikram Mehta', 'Sneha Iyer',
  'Karan Malhotra', 'Pooja Nair', 'Arjun Reddy', 'Neha Joshi', 'Rahul Kapoor', 'Kavya Menon',
  'Aditya Rao', 'Isha Patel', 'Manish Yadav', 'Ritu Chauhan',
];
const LINES = [
  'Good morning everyone 🌞', 'Kal meeting kitne baje hai?', 'Sab log time pe aa jana please',
  'Done ✅', 'Photos share karo yaar', 'Happy birthday! 🎂🎉', 'Thank you so much 🙏',
  'Location bhej raha hoon', 'Main 10 min me pahunch raha hoon', 'Agenda for tomorrow:\n1. Budget\n2. Venue\n3. Food',
  'Haha 😂', 'Kya plan hai weekend ka?', 'Payment kar diya, screenshot bhejta hoon', 'Ok noted 👍',
  'Please check the document I shared', 'Bahut badhiya!', 'Who is coming for the match?',
  'Reminder: dues by Friday', 'Traffic bahut hai aaj', 'Congratulations 🎊', 'See you all soon',
];
const GROUPS = [
  { name: 'Family Parivaar ❤️', members: 9, days: 120, count: 640 },
  { name: 'Office Team 2026', members: 14, days: 75, count: 900 },
  { name: 'College Friends 🎓', members: 12, days: 200, count: 520 },
  { name: 'Sunday Cricket Club 🏏', members: 11, days: 60, count: 310 },
  { name: 'Society Committee', members: 16, days: 150, count: 420 },
  { name: 'Goa Trip Planning 🌴', members: 6, days: 30, count: 260 },
];

class DemoService extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.message = '';
    this.qr = null;
    this.me = null;
    this.progress = 0;
    this.groups = this.buildGroups();
  }

  status() {
    return { state: this.state, message: this.message, qr: this.qr, me: this.me, progress: this.progress, demo: true };
  }

  set(state, message) {
    this.state = state;
    this.message = message;
    this.emit('status', this.status());
  }

  buildGroups() {
    const now = Math.floor(Date.now() / 1000);
    return GROUPS.map((g, gi) => {
      const rand = rng(g.name);
      const members = PEOPLE.slice(gi, gi + g.members).concat(PEOPLE).slice(0, g.members).map((name, i) => ({
        id: `9198${String(1000000 + gi * 97 + i * 7919).padStart(8, '0')}@c.us`,
        name,
      }));
      const messages = [];
      let ts = now - g.days * 86400;
      const gap = (g.days * 86400) / g.count;
      for (let i = 0; i < g.count; i++) {
        ts += Math.floor(gap * (0.2 + rand() * 1.6));
        if (ts > now) ts = now - (g.count - i);
        const fromMe = rand() < 0.14;
        const who = members[Math.floor(rand() * members.length)];
        const r = rand();
        const type = r < 0.8 ? 'chat' : r < 0.88 ? 'image' : r < 0.92 ? 'ptt' : r < 0.95 ? 'document' : r < 0.97 ? 'video' : r < 0.985 ? 'sticker' : 'revoked';
        let text = '';
        if (type === 'chat') text = LINES[Math.floor(rand() * LINES.length)];
        else if (type === 'image' && rand() < 0.5) text = 'Check this out 📸';
        else if (type === 'document') text = 'Report_Final.pdf';
        else if (type === 'revoked') text = 'This message was deleted';
        messages.push({
          id: `${gi}_${i}`,
          ts,
          ...timeParts(ts),
          fromMe,
          authorId: fromMe ? 'me' : who.id,
          name: fromMe ? 'Demo User (You)' : who.name,
          phone: fromMe ? '+919800000000' : `+${who.id.split('@')[0]}`,
          forwarded: rand() < 0.04,
          type,
          typeLabel: TYPE_LABELS[type],
          text,
          isMedia: !['chat', 'revoked'].includes(type),
          thumb: ['image', 'video', 'sticker'].includes(type),
        });
        // Like real chats: a photo often comes with a second photo and/or a line of text in the same minute.
        if (type === 'image' && rand() < 0.6) {
          const extra = rand() < 0.4 ? ['image', 'chat'] : ['chat'];
          extra.forEach((t, k) => {
            const ets = ts - (ts % 60) + Math.min(59, (ts % 60) + 5 + k * 5);
            messages.push({
              id: `${gi}_${i}_${k}`,
              ts: ets,
              ...timeParts(ets),
              fromMe,
              authorId: fromMe ? 'me' : who.id,
              name: fromMe ? 'Demo User (You)' : who.name,
              phone: fromMe ? '+919800000000' : `+${who.id.split('@')[0]}`,
              forwarded: false,
              type: t,
              typeLabel: TYPE_LABELS[t],
              text: t === 'chat' ? LINES[Math.floor(rand() * LINES.length)] : '',
              isMedia: t !== 'chat',
              thumb: t === 'image',
            });
          });
        }
      }
      messages.sort((a, b) => a.ts - b.ts);
      const last = messages[messages.length - 1];
      return {
        info: {
          id: `1203630${gi}${String(now).slice(-6)}@g.us`,
          name: g.name,
          isGroup: true,
          participants: g.members + 1,
          description: `Sample group for demo mode — ${g.members + 1} members`,
          createdAt: now - (g.days + 40) * 86400,
        },
        messages,
        last,
        unread: gi % 3 === 0 ? gi + 2 : 0,
      };
    });
  }

  async start() {
    this.set('starting', 'Starting demo engine…');
    await wait(1200);
    this.qr = await QRCode.toDataURL('DEMO MODE - this is not a real WhatsApp QR code', {
      margin: 1, width: 380, color: { dark: '#111417', light: '#ffffff' },
    });
    this.set('qr', 'Waiting for you to scan the QR code');
  }

  async simulateScan() {
    if (this.state !== 'qr') return;
    this.qr = null;
    this.set('authenticated', 'Device linked! Syncing your chats…');
    for (const p of [18, 42, 67, 88, 100]) {
      await wait(450);
      this.progress = p;
      this.set('loading', `Syncing your chats… ${p}%`);
    }
    this.me = { name: 'Demo User', number: '919800000000', id: 'me' };
    this.set('ready', 'Connected');
  }

  ensureReady() {
    if (this.state !== 'ready') {
      const err = new Error('Not connected yet — click the QR code to simulate a scan.');
      err.status = 409;
      throw err;
    }
  }

  async getChats() {
    this.ensureReady();
    const groups = this.groups.map((g) => ({
      id: g.info.id,
      name: g.info.name,
      isGroup: true,
      participants: g.info.participants,
      timestamp: g.last.ts,
      unread: g.unread,
      pinned: false,
      archived: false,
      preview: g.last.text || g.last.typeLabel,
    }));
    const now = Math.floor(Date.now() / 1000);
    const direct = PEOPLE.slice(0, 4).map((name, i) => ({
      id: `91990000000${i}@c.us`, name, isGroup: false, participants: 0,
      timestamp: now - (i + 1) * 5400, unread: 0, pinned: false, archived: false, preview: LINES[i + 3],
    }));
    return [...groups, ...direct].sort((a, b) => b.timestamp - a.timestamp);
  }

  async getMessages(chatId, params) {
    this.ensureReady();
    await wait(700);
    const g = this.groups.find((x) => x.info.id === chatId);
    if (!g) {
      const err = new Error('Demo mode only has sample messages for the groups.');
      err.status = 404;
      throw err;
    }
    let msgs = g.messages;
    if (!params.fromTs && params.limit !== 'all') msgs = msgs.slice(-params.limit);
    msgs = msgs.filter((m) => inRange(m.ts, params));
    this.emit('progress', { loaded: msgs.length });
    return {
      chat: g.info,
      messages: msgs,
      meta: { from: params.from, to: params.to, limit: params.limit, fetched: msgs.length, key: cacheKey(chatId, params) },
    };
  }

  findMessage(id) {
    for (const g of this.groups) {
      const m = g.messages.find((x) => x.id === id);
      if (m) return m;
    }
    return null;
  }

  // Sample "photos" are generated SVG pictures; videos and voice notes behave as expired media.
  demoSvg(m, label) {
    const hue = (m.ts * 37) % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 80) % 360},75%,35%)"/></linearGradient></defs>
<rect width="640" height="480" fill="url(#g)"/><circle cx="480" cy="140" r="60" fill="rgba(255,255,255,.35)"/>
<path d="M0 400 L180 240 L320 360 L440 280 L640 420 L640 480 L0 480Z" fill="rgba(0,0,0,.25)"/>
<text x="40" y="80" font-family="Segoe UI,Arial" font-size="34" font-weight="700" fill="#fff">${label}</text>
<text x="40" y="122" font-family="Segoe UI,Arial" font-size="22" fill="#fff">${m.date} ${m.time}</text></svg>`;
  }

  async getThumb(id) {
    const m = this.findMessage(id);
    if (!m || !m.thumb) return null;
    return { type: 'image/svg+xml', buffer: Buffer.from(this.demoSvg(m, m.type === 'video' ? '▶ Demo video' : 'Demo photo')) };
  }

  async getMediaFile(id) {
    const m = this.findMessage(id);
    if (!m || !m.isMedia || ['video', 'ptt', 'audio'].includes(m.type)) return null;
    const dir = path.join(os.tmpdir(), 'wa-exporter-demo-media');
    fs.mkdirSync(dir, { recursive: true });
    if (m.type === 'document') {
      const file = path.join(dir, `${m.id}.txt`);
      fs.writeFileSync(file, `Demo document from ${m.name}\n${m.date} ${m.time}\n`);
      return { path: file, mimetype: 'text/plain', filename: 'Report_Final.txt' };
    }
    const file = path.join(dir, `${m.id}.svg`);
    fs.writeFileSync(file, this.demoSvg(m, m.type === 'sticker' ? 'Demo sticker' : 'Demo photo'));
    return { path: file, mimetype: 'image/svg+xml', filename: null };
  }

  async restart() {
    this.qr = null;
    this.start();
  }

  async logout() {
    this.me = null;
    this.progress = 0;
    this.start();
  }

  async destroy() {}
}

module.exports = DemoService;
