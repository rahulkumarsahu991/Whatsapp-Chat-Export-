/**
 * WhatsApp Chat Exporter: Photo helper for Google Sheets
 *
 * 1. Puts the real photos INSIDE this sheet (like the Excel export) instead of links. A photo that
 *    is inside stays there, even when the exporter's PC is off.
 * 2. Adds a "📷 WhatsApp" menu with a Photo viewer: click any photo and see it big.
 *
 * One-time setup (in this Apps Script window):
 *   1. In the function list at the top choose "setup", then press ▶ Run.
 *   2. Google asks for permission: Review permissions → choose your account → Advanced →
 *      "Go to … (unsafe)" → Allow. (It is your own script; Google shows this for every new script.)
 * After that it runs by itself every minute. Reload the sheet once to see the 📷 WhatsApp menu.
 * Updating to a newer version: paste the new code over the old one and Save (no need to run setup again).
 */

var PHOTO_LINK = /^=IMAGE\("(https:\/\/[^"]+\/sheet-img\/[^"?]+)"\)$/i;
var TIME_BUDGET_MS = 5 * 60 * 1000; // Apps Script stops a run after 6 minutes
var BATCH = 40; // photos downloaded side by side, then written together
var SKIP_WARNING = { 'ngrok-skip-browser-warning': '1' }; // gets the picture, not ngrok's "Visit Site" page

/** Run this once: starts the every-minute check and does the first round now. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'embedPhotos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('embedPhotos').timeBased().everyMinutes(1).create();
  embedPhotos();
}

function photoColumn(sheet) {
  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() < 2 || lastCol < 1) return 0;
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].indexOf('Photo') + 1;
}

function asImage(bytes, link) {
  return SpreadsheetApp.newCellImage()
    .setSourceUrl('data:image/jpeg;base64,' + Utilities.base64Encode(bytes))
    .setAltTextTitle('WhatsApp photo')
    .setAltTextDescription(link) // remembered for the Photo viewer
    .build();
}

/** Turns the =IMAGE("…/sheet-img/…") cells of every "Photo" column into photos stored in the cells. */
function embedPhotos() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still busy
  var started = Date.now();
  var done = 0;
  try {
    var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sheet = sheets[s];
      var col = photoColumn(sheet);
      if (!col) continue;
      var tried = {}; // rows whose photo couldn't be fetched in this run
      for (;;) {
        if (Date.now() - started > TIME_BUDGET_MS) return; // the next run carries on
        var lastRow = sheet.getLastRow();
        var column = sheet.getRange(2, col, lastRow - 1, 1);
        var formulas = column.getFormulas();
        var todo = [];
        for (var i = formulas.length - 1; i >= 0 && todo.length < BATCH; i--) { // newest (bottom) first
          var m = PHOTO_LINK.exec(formulas[i][0]);
          if (m && !tried[i + 2]) todo.push({ row: i + 2, formula: formulas[i][0], url: m[1] });
        }
        if (!todo.length) break;
        var responses = UrlFetchApp.fetchAll(todo.map(function (t) {
          return { url: t.url, headers: SKIP_WARNING, muteHttpExceptions: true };
        }));
        // rows may have moved while downloading: check once, then write everything without reading
        var now = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getFormulas();
        var writes = [];
        for (var k = 0; k < todo.length; k++) {
          var res = responses[k];
          var headers = res.getHeaders();
          var type = String(headers['Content-Type'] || headers['content-type'] || '');
          if (res.getResponseCode() !== 200 || type.indexOf('image/') !== 0) { tried[todo[k].row] = true; continue; }
          if (!now[todo[k].row - 2] || now[todo[k].row - 2][0] !== todo[k].formula) continue; // moved: next round
          writes.push({ row: todo[k].row, bytes: res.getBlob().getBytes(), url: todo[k].url });
        }
        try {
          writes.forEach(function (w) { sheet.getRange(w.row, col).setValue(asImage(w.bytes, w.url)); });
          SpreadsheetApp.flush();
          done += writes.length;
        } catch (e) {
          // one of them was too big for a cell: write them one by one, using a smaller copy if needed
          writes.forEach(function (w) {
            var cell = sheet.getRange(w.row, col);
            if (!PHOTO_LINK.test(cell.getFormula())) return; // already a photo (or the row moved)
            try { cell.setValue(asImage(w.bytes, w.url)); SpreadsheetApp.flush(); done++; return; } catch (e1) { /* too big */ }
            try {
              var small = UrlFetchApp.fetch(w.url + '?s=small', { headers: SKIP_WARNING, muteHttpExceptions: true });
              if (small.getResponseCode() === 200) { cell.setValue(asImage(small.getBlob().getBytes(), w.url)); SpreadsheetApp.flush(); done++; }
            } catch (e2) { tried[w.row] = true; }
          });
        }
      }
    }
  } finally {
    lock.releaseLock();
    if (done) console.log(done + ' photos put into the sheet');
  }
}

// ---------------------------------------------------------------------------------------------------
// Photo viewer: 📷 WhatsApp → Photo viewer, then click any photo to see it big
// ---------------------------------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📷 WhatsApp')
    .addItem('Photo viewer (click a photo to see it big)', 'openViewer')
    .addItem('Show the selected photo full screen', 'showBig')
    .addToUi();
}

function openViewer() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(VIEWER_HTML).setTitle('WhatsApp photo'));
}

/** The photo of the selected row as a data URL, plus who sent it and when (for the viewer). */
function selectedPhoto() {
  var range = SpreadsheetApp.getActiveRange();
  if (!range) return null;
  var sheet = range.getSheet();
  var col = photoColumn(sheet);
  var row = range.getRow();
  if (!col || row < 2) return null;
  var cell = sheet.getRange(row, col);
  var value = cell.getValue();
  var link = '';
  var src = '';
  if (value && value.valueType === SpreadsheetApp.ValueType.IMAGE) {
    link = value.getAltTextDescription() || '';
    try { src = value.getContentUrl() || ''; } catch (e) { src = ''; }
  } else {
    var m = PHOTO_LINK.exec(cell.getFormula());
    if (m) link = m[1];
  }
  if (!src && !link) return { key: sheet.getName() + '!' + row, none: true };
  if (!src) {
    var res = UrlFetchApp.fetch(link, { headers: SKIP_WARNING, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { key: sheet.getName() + '!' + row, none: true, offline: true };
    src = 'data:image/jpeg;base64,' + Utilities.base64Encode(res.getBlob().getBytes());
  }
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(row, 1, 1, head.length).getDisplayValues()[0];
  var pick = function (name) { var i = head.indexOf(name); return i < 0 ? '' : data[i]; };
  return {
    key: sheet.getName() + '!' + row,
    src: src,
    caption: [pick('Sender'), pick('Date') + ' ' + pick('Time'), pick('Message')].filter(function (x) { return String(x).trim(); }).join(' · '),
  };
}

function showBig() {
  var p = selectedPhoto();
  var ui = SpreadsheetApp.getUi();
  if (!p || p.none) { ui.alert(p && p.offline ? 'The exporter PC is off — this photo is not in the sheet yet.' : 'Select a cell in a row that has a photo.'); return; }
  var html = '<div style="font:13px Arial;text-align:center"><img src="' + p.src + '" style="max-width:100%;max-height:78vh;border-radius:6px">'
    + '<p>' + String(p.caption || '').replace(/[<>&]/g, '') + '</p></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(900).setHeight(700), 'WhatsApp photo');
}

var VIEWER_HTML = [
  '<style>body{font:13px Arial;margin:8px;color:#222}img{width:100%;border-radius:8px;background:#f2f2f2;cursor:zoom-in}',
  'p{margin:8px 0;line-height:1.4}button{width:100%;padding:8px;border:0;border-radius:6px;background:#25d366;color:#fff;font-weight:bold;cursor:pointer}</style>',
  '<p id="hint">Click a photo (or any cell of its row) in the sheet.</p>',
  '<img id="photo" hidden onclick="google.script.run.showBig()">',
  '<p id="cap"></p>',
  '<button onclick="google.script.run.showBig()">See it full screen</button>',
  '<script>',
  'var last="";',
  'function tick(){google.script.run.withSuccessHandler(function(p){',
  '  if(p&&p.key!==last){last=p.key;var img=document.getElementById("photo");',
  '    if(p.src){img.src=p.src;img.hidden=false;document.getElementById("hint").textContent="";}',
  '    else{img.hidden=true;document.getElementById("hint").textContent=p.offline?"The exporter PC is off right now.":"No photo in this row.";}',
  '    document.getElementById("cap").textContent=p.caption||"";}',
  '  setTimeout(tick,800);}).withFailureHandler(function(){setTimeout(tick,2000);}).selectedPhoto();}',
  'tick();',
  '</script>',
].join('\n');
