/**
 * Trace Scan 受け取りスクリプト（Google スプレッドシートに貼り付けて「ウェブアプリ」として公開する）
 *
 * スマホのページ（Trace Scan）が QR の中身をまとめて送ってくるので、
 *   Log シート     … 読んだ QR を1件1行で全部残す（同じ QR は1回だけ）
 *   Summary シート … 1台（S/N）1行。工程ごと（GAGE / 1ST / FINAL / LOAD）に最新の合否・日時・装置・値を並べる
 * に書く。QR の形式: TR1|S/N|工程|合否|YYYYMMDDhhmmss|装置ID|項目=値;項目=値
 */
var STAGES = ["GAGE", "1ST", "FINAL", "LOAD"];
var LOG_HEAD = ["Received", "Key", "Serial", "Stage", "Result", "Measured", "Device", "Values", "Phone", "Scanned on phone", "Raw"];

function sheet_(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  }
  return sh;
}

function summaryHead_() {
  var h = ["Serial"];
  STAGES.forEach(function (s) { h.push(s + " Result", s + " Date", s + " Device", s + " Values"); });
  h.push("Stages done", "Last update");
  return h;
}

function parse_(raw) {
  var p = String(raw).trim().split("|");
  if (p.length < 6 || p[0] !== "TR1") return null;
  if (!/^P\d{8}$/.test(p[1]) || !/^\d{14}$/.test(p[4])) return null;
  var dt = p[4];
  return {
    serial: p[1], stage: p[2], result: p[3], dtKey: dt,
    measured: dt.slice(0, 4) + "/" + dt.slice(4, 6) + "/" + dt.slice(6, 8) + " " + dt.slice(8, 10) + ":" + dt.slice(10, 12) + ":" + dt.slice(12, 14),
    device: p[5], values: p.slice(6).join("|"),
    key: [p[1], p[2], dt, p[5]].join("|")
  };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var log = sheet_("Log", LOG_HEAD);
  return json_({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName(), rows: Math.max(log.getLastRow() - 1, 0) });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    var res = addRecords_(body.records || [], body.phone || "");
    res.ok = true;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function addRecords_(records, phone) {
  var log = sheet_("Log", LOG_HEAD);
  var n = log.getLastRow() - 1;
  var keys = {};
  if (n > 0) log.getRange(2, 2, n, 1).getValues().forEach(function (r) { keys[r[0]] = true; });
  var added = [], duplicate = [], invalid = [], rows = [], recs = [];
  var now = new Date();
  records.forEach(function (x) {
    var r = parse_(x.raw);
    if (!r) { invalid.push(x.key); return; }
    if (keys[r.key]) { duplicate.push(x.key); return; }
    keys[r.key] = true;
    rows.push([now, r.key, r.serial, r.stage, r.result, r.measured, r.device, r.values, phone, x.scannedAt || "", String(x.raw)]);
    recs.push(r);
    added.push(x.key);
  });
  if (rows.length) {
    log.getRange(log.getLastRow() + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
    updateSummary_(recs, now);
  }
  return { added: added, duplicate: duplicate, invalid: invalid };
}

function updateSummary_(recs, now) {
  var head = summaryHead_();
  var sum = sheet_("Summary", head);
  var n = sum.getLastRow() - 1;
  var data = n > 0 ? sum.getRange(2, 1, n, head.length).getValues() : [];
  var index = {};
  data.forEach(function (row, i) { index[row[0]] = i; });
  recs.forEach(function (r) {
    var si = STAGES.indexOf(String(r.stage).toUpperCase());
    if (si < 0) return;
    var i = index[r.serial];
    if (i === undefined) {
      var blank = head.map(function () { return ""; });
      blank[0] = r.serial;
      data.push(blank);
      i = index[r.serial] = data.length - 1;
    }
    var row = data[i], c = 1 + si * 4;
    // 同じ工程を測り直したときは、測定日時が新しい方を残す
    if (row[c + 1] && String(row[c + 1]) > r.measured) return;
    row[c] = r.result; row[c + 1] = r.measured; row[c + 2] = r.device; row[c + 3] = r.values;
    row[head.length - 2] = STAGES.filter(function (s, k) { return row[1 + k * 4] !== ""; }).join(" ");
    row[head.length - 1] = now;
  });
  if (data.length) {
    sum.getRange(2, 1, data.length, head.length).setNumberFormat("@").setValues(data.map(function (row) {
      return row.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss") : String(v); });
    }));
  }
}
