'use strict';

// Shared helpers used by the WhatsApp service, the demo service and the Excel builder.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

// WhatsApp message types that are system noise (encryption notices, "X joined", etc.)
const SYSTEM_TYPES = new Set([
  'e2e_notification', 'notification_template', 'gp2', 'notification', 'protocol',
  'broadcast_notification', 'newsletter_notification', 'pinned_message', 'debug',
]);

const TYPE_LABELS = {
  chat: 'Text', image: 'Photo', video: 'Video', audio: 'Audio', ptt: 'Voice note',
  ptv: 'Video note', document: 'Document', sticker: 'Sticker', location: 'Location',
  vcard: 'Contact', multi_vcard: 'Contacts', revoked: 'Deleted', poll_creation: 'Poll',
  call_log: 'Call', ciphertext: 'Waiting', event_creation: 'Event', album: 'Album', order: 'Order',
  product: 'Product', payment: 'Payment', interactive: 'Interactive',
  buttons_response: 'Reply', list_response: 'Reply', template_button_reply: 'Reply',
};

/** Local-time pieces of a unix timestamp (seconds). */
function timeParts(ts) {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  return {
    date: `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`,
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`,
    day: DAYS[d.getDay()],
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Turns ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1000|all into a normalised filter. */
function parseQuery(q = {}) {
  const from = ISO_DAY.test(q.from || '') ? q.from : null;
  const to = ISO_DAY.test(q.to || '') ? q.to : null;
  const fromTs = from ? Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000) : null;
  const toTs = to ? Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000) : null;
  const limit = q.limit === 'all' ? 'all' : Math.min(Math.max(parseInt(q.limit, 10) || 1000, 1), 1000000);
  // fresh=1 (the Load / refresh button) skips the short-lived message cache, e.g. right after linking
  // when WhatsApp is still delivering older history.
  return { from, to, fromTs, toTs, limit, fresh: q.fresh === '1' };
}

function inRange(ts, { fromTs, toTs }) {
  return (fromTs == null || ts >= fromTs) && (toTs == null || ts <= toTs);
}

const cacheKey = (chatId, p) => [chatId, p.from, p.to, p.limit].join('|');

function safeFileName(name) {
  const cleaned = String(name || 'WhatsApp')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || 'WhatsApp';
}

module.exports = { SYSTEM_TYPES, TYPE_LABELS, timeParts, parseQuery, inRange, cacheKey, safeFileName };
