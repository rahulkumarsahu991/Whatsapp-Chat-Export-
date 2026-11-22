/**
 * WhatsApp Chat Exporter: Photo helper for Google Sheets
 *
 * Puts the real photos INSIDE this sheet (like the Excel export) instead of links.
 * A photo that is inside stays there, even when the exporter's PC is off.
 *
 * One-time setup (in this Apps Script window):
 *   1. In the function list at the top choose "setup", then press ▶ Run.
 *   2. Google asks for permission: Review permissions → choose your account → Advanced →
 *      "Go to … (unsafe)" → Allow. (It is your own script; Google shows this for every new script.)
 * After that it runs by itself every minute and turns new photo links into photos.
 */

var PHOTO_LINK = /^=IMAGE\("(https:\/\/[^"]+\/sheet-img\/[^"?]+)"\)$/i;
var TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run after 6 minutes
var BATCH = 15; // photos downloaded at the same time

/** Run this once: starts the every-minute check and does the first round now. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'embedPhotos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('embedPhotos').timeBased().everyMinutes(1).create();
  embedPhotos();
}

/** Turns every =IMAGE("…/sheet-img/…") cell of the "Photo" columns into a photo stored in the cell. */
function embedPhotos() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still busy
  var started = Date.now();
  var done = 0;
  try {
    var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sheet = sheets[s];
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow < 2 || lastCol < 1) continue;
      var col = sheet.getRange(1, 1, 1, lastCol).getValues()[0].indexOf('Photo') + 1;
      if (!col) continue;
      var formulas = sheet.getRange(2, col, lastRow - 1, 1).getFormulas();
      var todo = [];
      for (var i = formulas.length - 1; i >= 0; i--) { // newest messages (at the bottom) first
        var m = PHOTO_LINK.exec(formulas[i][0]);
        if (m) todo.push({ row: i + 2, formula: formulas[i][0], url: m[1] });
      }
      for (var b = 0; b < todo.length; b += BATCH) {
        if (Date.now() - started > TIME_BUDGET_MS) return; // the next run carries on
        var batch = todo.slice(b, b + BATCH);
        var responses = UrlFetchApp.fetchAll(batch.map(function (t) {
          // the header skips ngrok's "Visit Site" page, so the picture itself comes back
          return { url: t.url, headers: { 'ngrok-skip-browser-warning': '1' }, muteHttpExceptions: true };
        }));
        for (var k = 0; k < batch.length; k++) {
          var res = responses[k];
          var headers = res.getHeaders();
          var type = String(headers['Content-Type'] || headers['content-type'] || '');
          if (res.getResponseCode() !== 200 || type.indexOf('image/') !== 0) continue; // PC off: try later
          var cell = sheet.getRange(batch[k].row, col);
          if (cell.getFormula() !== batch[k].formula) continue; // rows moved meanwhile: next run
          if (putPhoto(cell, res.getBlob(), batch[k].url)) done++;
        }
      }
    }
  } finally {
    lock.releaseLock();
    if (done) console.log(done + ' photos put into the sheet');
  }
}

function putPhoto(cell, blob, url) {
  var asImage = function (b) {
    return SpreadsheetApp.newCellImage()
      .setSourceUrl('data:image/jpeg;base64,' + Utilities.base64Encode(b.getBytes()))
      .setAltTextTitle('WhatsApp photo')
      .build();
  };
  try {
    cell.setValue(asImage(blob));
    return true;
  } catch (e) {
    try { // too big for a cell: use a smaller copy
      var small = UrlFetchApp.fetch(url + '?s=small', { headers: { 'ngrok-skip-browser-warning': '1' }, muteHttpExceptions: true });
      if (small.getResponseCode() !== 200) return false;
      cell.setValue(asImage(small.getBlob()));
      return true;
    } catch (e2) {
      return false;
    }
  }
}
