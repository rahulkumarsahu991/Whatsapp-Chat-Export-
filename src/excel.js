'use strict';

// Builds the styled .xlsx: Chats (date-wise rows), Members Summary, Daily Activity, Group Info.

const ExcelJS = require('exceljs');
const { timeParts, safeFileName } = require('./format');

const C = {
  dark: 'FF075E54', teal: 'FF128C7E', green: 'FF25D366', zebra: 'FFF3FAF6', mine: 'FFE6F8DA',
  gold: 'FFB8902A', goldLight: 'FFFFF4D1', royal: 'FF2B1D63', ink: 'FF1F2A2E', grey: 'FF7A7A7A',
  border: 'FFD5E5DD', white: 'FFFFFFFF',
};
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.border } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
const MAX_CELL = 32000;

// Excel stores dates without a timezone, so pass the local calendar day as a UTC date.
function excelDate(ts) {
  const d = new Date(ts * 1000);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function nowStamp() {
  const p = timeParts(Date.now() / 1000);
  return `${p.date} ${p.time}`;
}

const clip = (text) => (text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text);

/**
 * One Excel row per "post": messages from the same person, back to back, in the same minute
 * (e.g. a photo plus the text sent with it, or an album of photos) are merged into one row.
 */
function groupPosts(messages) {
  const posts = [];
  for (const m of messages) {
    const last = posts[posts.length - 1];
    const prev = last && last.parts[last.parts.length - 1];
    const same = prev && prev.authorId === m.authorId && prev.date === m.date && prev.time === m.time
      && prev.type !== 'revoked' && m.type !== 'revoked';
    if (same) last.parts.push(m);
    else posts.push({ ts: m.ts, date: m.date, time: m.time, day: m.day, name: m.name, phone: m.phone, fromMe: m.fromMe, parts: [m] });
  }
  return posts;
}

const PLURAL = { Photo: 'Photos', Video: 'Videos', Sticker: 'Stickers', Document: 'Documents', 'Voice note': 'Voice notes', Audio: 'Audios', Contact: 'Contacts', GIF: 'GIFs' };

/** "Text + 2 Photos" style summary of what a post contains. */
function postType(parts) {
  const counts = new Map();
  for (const p of parts) counts.set(p.typeLabel, (counts.get(p.typeLabel) || 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${n} ${PLURAL[label] || `${label}s`}` : label)).join(' + ');
}

/**
 * Text of a post. With media columns the photos/videos are shown next to it, so media without a
 * caption adds nothing here; without them a short [Photo] marker keeps the information.
 */
function postText(parts, withMedia) {
  const lines = parts.map((m) => {
    let text = m.text || '';
    if (m.type === 'revoked') text = '[This message was deleted]';
    else if (m.type !== 'chat') {
      if (withMedia && m.isMedia) text = m.type === 'document' ? '' : text;
      else text = text ? `[${m.typeLabel}] ${text}` : `[${m.typeLabel}]`;
    }
    if (text && m.forwarded) text = `(Forwarded) ${text}`;
    return text;
  }).filter(Boolean);
  return clip(lines.join('\n'));
}

function titleBlock(ws, cols, title, subtitle, argb) {
  const last = ws.getColumn(cols).letter;
  ws.mergeCells(`A1:${last}1`);
  ws.mergeCells(`A2:${last}2`);
  const t = ws.getCell('A1');
  t.value = title;
  t.font = { name: 'Cambria', size: 16, bold: true, color: { argb: C.white } };
  t.fill = fill(argb);
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 34;
  const s = ws.getCell('A2');
  s.value = subtitle;
  s.font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.ink } };
  s.fill = fill(C.goldLight);
  s.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.getRow(2).height = 22;
  ws.getRow(3).height = 6;
}

function headerRow(ws, labels, argb) {
  const row = ws.getRow(4);
  row.values = labels;
  row.height = 24;
  row.eachCell((c) => {
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.white } };
    c.fill = fill(argb);
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = box;
  });
}

function styleBody(row, i, { center = [], dates = [], wrap = [] } = {}, rowFill) {
  row.eachCell({ includeEmpty: true }, (c, col) => {
    c.border = box;
    c.font = { name: 'Calibri', size: 10.5, color: { argb: C.ink } };
    c.fill = fill(rowFill || (i % 2 ? C.zebra : C.white));
    c.alignment = {
      vertical: 'top',
      horizontal: center.includes(col) ? 'center' : 'left',
      wrapText: wrap.includes(col),
    };
    if (dates.includes(col)) c.numFmt = 'dd-mm-yyyy';
  });
}

function setWidths(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function periodText(messages, meta) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const fmt = (iso) => iso.split('-').reverse().join('-');
  const from = meta.from ? fmt(meta.from) : first ? first.date : '—';
  const to = meta.to ? fmt(meta.to) : last ? last.date : '—';
  return `${from}  to  ${to}`;
}

const THUMB_PX = 88; // shown size of a photo preview inside a row
const THUMBS_PER_ROW = 3;
const EMU = 9525; // Excel drawing units per pixel

/**
 * @param {object} args
 * @param {Map<string, string|null>} [args.media] message id -> "media/<file>" (relative to the workbook) or null if
 *   unavailable. When given, the Chats sheet gets Photos + Media Files columns.
 * @param {Map<string, {buffer: Buffer, extension: string}>} [args.thumbs] small previews to show in the Photos column.
 */
async function buildWorkbook({ chat, messages, meta = {}, media, thumbs = new Map() }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WhatsApp Chat Exporter 3D';
  wb.created = new Date();
  const period = periodText(messages, meta);
  const sub = `Period: ${period}   •   Messages: ${messages.length.toLocaleString('en-IN')}   •   Exported on ${nowStamp()}`;
  const view = [{ state: 'frozen', ySplit: 4 }];
  const page = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // 1) Chats — one row per post (same person, same minute), date-wise
  const withMedia = media instanceof Map;
  const posts = groupPosts(messages);
  const cols = withMedia ? 10 : 8;
  const PHOTO_COL = 9; // I: previews
  const FILES_COL = 10; // J: file names / links
  const ws = wb.addWorksheet('Chats', { views: view, pageSetup: page, properties: { tabColor: { argb: C.green } } });
  // Photos column: about 7 px per width unit → room for THUMBS_PER_ROW previews side by side.
  const photoColWidth = Math.ceil(((THUMB_PX + 6) * THUMBS_PER_ROW + 6) / 7);
  setWidths(ws, withMedia ? [7, 13, 11, 12, 24, 18, 60, 16, photoColWidth, 38] : [7, 13, 11, 12, 26, 19, 80, 16]);
  titleBlock(ws, cols, `${chat.name} — WhatsApp Chat Export`, sub, C.dark);
  headerRow(ws, ['S.No', 'Date', 'Time', 'Day', 'Sender Name', 'Phone Number', 'Message', 'Type', ...(withMedia ? ['Photos', 'Media Files'] : [])], C.teal);

  posts.forEach((post, i) => {
    const values = [i + 1, excelDate(post.ts), post.time, post.day, post.name, post.phone, postText(post.parts, withMedia), postType(post.parts)];
    if (withMedia) values.push('', '');
    const row = ws.addRow(values);
    styleBody(row, i, { center: [1, 2, 3, 4, 8], dates: [2], wrap: [7, 8, FILES_COL] }, post.fromMe ? C.mine : null);
    if (post.parts.every((p) => p.type === 'revoked')) row.getCell(7).font = { name: 'Calibri', size: 10.5, italic: true, color: { argb: C.grey } };
    row.getCell(5).font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: C.dark } };
    if (!withMedia) return;

    // Media Files: every file of the post (one per line); the cell links to the first one.
    const mediaParts = post.parts.filter((p) => media.has(p.id));
    if (mediaParts.length) {
      const names = mediaParts.map((p) => (media.get(p.id) ? media.get(p.id).replace(/^media\//, '') : `${p.typeLabel} — not available`));
      const firstLink = mediaParts.map((p) => media.get(p.id)).find(Boolean);
      const cell = row.getCell(FILES_COL);
      cell.value = firstLink ? { text: names.join('\n'), hyperlink: firstLink, tooltip: 'Open file' } : names.join('\n');
      cell.font = firstLink
        ? { name: 'Calibri', size: 10, underline: true, color: { argb: 'FF0563C1' } }
        : { name: 'Calibri', size: 10, italic: true, color: { argb: C.grey } };
    }

    // Photos: small previews inside the row; each one opens the full file when clicked.
    const shown = post.parts.filter((p) => thumbs.has(p.id)).slice(0, THUMBS_PER_ROW);
    if (!shown.length) return;
    // (More than THUMBS_PER_ROW photos: Type says e.g. "5 Photos" and Media Files lists every file.)
    row.height = (THUMB_PX + 10) * 0.75; // points
    shown.forEach((p, k) => {
      const t = thumbs.get(p.id);
      const imageId = wb.addImage({ buffer: t.buffer, extension: t.extension });
      const link = media.get(p.id);
      ws.addImage(imageId, {
        tl: { nativeCol: PHOTO_COL - 1, nativeColOff: (4 + k * (THUMB_PX + 6)) * EMU, nativeRow: row.number - 1, nativeRowOff: 5 * EMU },
        ext: { width: THUMB_PX, height: THUMB_PX },
        editAs: 'oneCell',
        ...(link ? { hyperlinks: { hyperlink: link, tooltip: `Open ${p.typeLabel.toLowerCase()}` } } : {}),
      });
    });
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols } };

  // 2) Members Summary
  const stats = new Map();
  for (const m of messages) {
    const key = m.authorId || m.name;
    const s = stats.get(key) || { name: m.name, phone: m.phone, count: 0, media: 0, first: m.ts, last: m.ts };
    s.count += 1;
    if (m.isMedia) s.media += 1;
    s.first = Math.min(s.first, m.ts);
    s.last = Math.max(s.last, m.ts);
    stats.set(key, s);
  }
  const members = [...stats.values()].sort((a, b) => b.count - a.count);
  const ms = wb.addWorksheet('Members Summary', { views: view, properties: { tabColor: { argb: 'FFD4AF37' } } });
  setWidths(ms, [8, 28, 19, 12, 10, 11, 15, 15]);
  titleBlock(ms, 8, `${chat.name} — Members Summary`, `Period: ${period}   •   Active members: ${members.length}`, C.royal);
  headerRow(ms, ['Rank', 'Sender Name', 'Phone Number', 'Messages', 'Media', 'Share %', 'First Message', 'Last Message'], C.gold);
  members.forEach((s, i) => {
    const row = ms.addRow([i + 1, s.name, s.phone, s.count, s.media, messages.length ? s.count / messages.length : 0, excelDate(s.first), excelDate(s.last)]);
    styleBody(row, i, { center: [1, 4, 5, 6, 7, 8], dates: [7, 8] });
    row.getCell(6).numFmt = '0.0%';
  });
  if (members.length) ms.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 8 } };

  // 3) Daily Activity — message count per date
  const days = new Map();
  for (const m of messages) {
    const d = days.get(m.iso) || { ts: m.ts, day: m.day, count: 0, people: new Set() };
    d.count += 1;
    d.people.add(m.authorId || m.name);
    days.set(m.iso, d);
  }
  const daily = [...days.values()].sort((a, b) => a.ts - b.ts);
  const peak = daily.reduce((mx, d) => Math.max(mx, d.count), 1);
  const da = wb.addWorksheet('Daily Activity', { views: view, properties: { tabColor: { argb: 'FF3F7CF0' } } });
  setWidths(da, [14, 12, 12, 14, 42]);
  titleBlock(da, 5, `${chat.name} — Daily Activity`, `Period: ${period}   •   Active days: ${daily.length}`, C.dark);
  headerRow(da, ['Date', 'Day', 'Messages', 'Active Members', 'Activity'], C.teal);
  daily.forEach((d, i) => {
    const bar = '█'.repeat(Math.max(1, Math.round((d.count / peak) * 30)));
    const row = da.addRow([excelDate(d.ts), d.day, d.count, d.people.size, bar]);
    styleBody(row, i, { center: [1, 2, 3, 4], dates: [1] });
    row.getCell(5).font = { name: 'Calibri', size: 10, color: { argb: C.green } };
  });

  // 4) Group Info
  const gi = wb.addWorksheet('Group Info', { properties: { tabColor: { argb: 'FF9B5DE5' } } });
  setWidths(gi, [24, 70]);
  titleBlock(gi, 2, chat.name, 'Export details', C.royal);
  headerRow(gi, ['Field', 'Value'], C.gold);
  const created = chat.createdAt ? timeParts(chat.createdAt) : null;
  const info = [
    ['Chat name', chat.name],
    ['Chat type', chat.isGroup ? 'Group' : 'Individual chat'],
    ['Chat ID', chat.id],
    ['Members', chat.isGroup ? chat.participants : 2],
    ['Group created', created ? `${created.date} ${created.time}` : '—'],
    ['Description', chat.description || '—'],
    ['Period exported', period],
    ['Messages exported', messages.length],
    ['Active members', members.length],
    ['Media messages', messages.filter((m) => m.isMedia).length],
    ...(withMedia ? [['Media files saved', [...media.values()].filter(Boolean).length]] : []),
    ['Exported on', nowStamp()],
  ];
  info.forEach((pair, i) => {
    const row = gi.addRow(pair);
    styleBody(row, i, { wrap: [2] });
    row.getCell(1).font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: C.dark } };
  });

  return wb.xlsx.writeBuffer();
}

function exportFileName(chatName) {
  return `${safeFileName(chatName)}_WhatsApp_Export_${timeParts(Date.now() / 1000).iso}.xlsx`;
}

module.exports = { buildWorkbook, exportFileName };
