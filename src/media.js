'use strict';

// Media helpers shared by the real and demo services, plus the "Excel + media" ZIP export.

const path = require('path');
const archiver = require('archiver');
const { safeFileName, timeParts } = require('./format');
const { buildWorkbook, exportFileName } = require('./excel');

let sharp = null;
try { sharp = require('sharp'); } catch { /* previews are optional; the Excel still links every file */ }

const PREVIEW_PX = 176; // 2x the shown size, so previews stay sharp on high-DPI screens

/** Small square JPEG preview for the Excel row (photos, stickers, videos), or null. */
async function makePreview(service, m, file) {
  try {
    if (['image', 'sticker'].includes(m.type) && file && sharp) {
      const img = sharp(file.path, { animated: false }).rotate().resize(PREVIEW_PX, PREVIEW_PX, { fit: 'cover' });
      const buffer = m.type === 'sticker'
        ? await img.flatten({ background: '#ffffff' }).jpeg({ quality: 75 }).toBuffer()
        : await img.jpeg({ quality: 70 }).toBuffer();
      return { buffer, extension: 'jpeg' };
    }
    if (['video', 'ptv'].includes(m.type) && typeof service.getThumb === 'function') {
      // Videos: WhatsApp's own small preview frame.
      const t = await service.getThumb(m.id);
      if (!t) return null;
      if (t.type === 'image/jpeg' && !sharp) return { buffer: t.buffer, extension: 'jpeg' };
      if (sharp) {
        const buffer = await sharp(t.buffer).resize(PREVIEW_PX, PREVIEW_PX, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
        return { buffer, extension: 'jpeg' };
      }
    }
  } catch (err) {
    console.warn('[export] preview failed:', err.message);
  }
  return null;
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function extFor(mimetype, filename) {
  const fromName = filename && path.extname(filename).slice(1).toLowerCase();
  if (fromName && /^[a-z0-9]{1,6}$/.test(fromName)) return fromName;
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
  const sub = base.split('/')[1];
  return sub && /^[a-z0-9]{1,6}$/.test(sub) ? sub : 'bin';
}

/** Limits how many media downloads run at once (each one drives the hidden WhatsApp page). */
class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async run(task) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    try { return await task(); } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function mediaFileName(m, ext, used) {
  const t = timeParts(m.ts);
  const time = t.time.replace(':', '-').replace(' ', '');
  let base = `${t.iso}_${time}_${safeFileName(m.name).replace(/[()]/g, '').slice(0, 28)}_${m.typeLabel}`;
  base = base.replace(/\s+/g, '_');
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Collects every downloadable photo/video/audio/document of the filtered messages (into the local
 * media cache) and builds the Excel file. Returns a package that streamZip() turns into one .zip.
 */
async function prepareZip(service, chatId, params, onProgress) {
  const data = await service.getMessages(chatId, params);
  const mediaMsgs = data.messages.filter((m) => m.isMedia && m.type !== 'revoked');
  const media = new Map(); // message id -> "media/<file>" inside the zip, or null when unavailable
  const thumbs = new Map(); // message id -> preview shown in the Excel row
  const files = []; // { src, name } entries for the zip
  const used = new Set();
  let done = 0;
  let failed = 0;
  const report = (phase) => onProgress({ phase, done, total: mediaMsgs.length, failed });
  report('media');

  const queue = new Semaphore(5);
  await Promise.all(mediaMsgs.map((m) => queue.run(async () => {
    try {
      const file = await service.getMediaFile(m.id);
      if (file) {
        const rel = `media/${mediaFileName(m, extFor(file.mimetype, file.filename), used)}`;
        files.push({ src: file.path, name: rel });
        media.set(m.id, rel);
      } else {
        media.set(m.id, null);
        failed += 1;
      }
      const preview = await makePreview(service, m, file);
      if (preview) thumbs.set(m.id, preview);
    } catch (err) {
      console.warn('[export] media failed:', err.message);
      media.set(m.id, null);
      failed += 1;
    }
    done += 1;
    report('media');
  })));

  report('excel');
  const excelName = exportFileName(data.chat.name);
  const excel = Buffer.from(await buildWorkbook({ ...data, media, thumbs }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    zipName: excelName.replace(/\.xlsx$/i, '.zip'),
    excelName,
    excel,
    files,
    total: mediaMsgs.length,
    saved: files.length,
    failed,
    messages: data.messages.length,
  };
}

/** Streams the package to the browser as a single .zip download (Excel at the top, media/ inside). */
function streamZip(pkg, res) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => console.warn('[zip]', err.message));
    archive.on('error', reject);
    res.on('close', resolve);
    res.attachment(pkg.zipName);
    res.type('application/zip');
    archive.pipe(res);
    archive.append(pkg.excel, { name: pkg.excelName });
    // Photos and videos are already compressed, so store them as-is (much faster).
    for (const f of pkg.files) archive.file(f.src, { name: f.name, store: true });
    archive.finalize();
  });
}

module.exports = { extFor, Semaphore, prepareZip, streamZip };
