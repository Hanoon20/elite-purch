/**
 * Elite Colour World - System Log
 * Google Apps Script web app that stores sign-ins and shows them (only) to people who can edit the ledger Sheet.
 *
 * What it does
 *   - "visit": the dashboard sends it right after someone signs in with Google. One row is added to the
 *              "System Log" tab: time, email, access (Editor / Viewer / No access), device, browser, screen.
 *   - "me":    tells the dashboard whether this person has Add bill (Editor) access -> shows the System Log menu item.
 *   - "list":  returns the log. Refused unless the caller is the Sheet owner or an Editor of the ledger Sheet.
 *
 * Every request carries the person's Google access token. It is verified with Google (tokeninfo) and must have
 * been issued to THIS dashboard's OAuth client, so nobody can write or read the log by just knowing the URL.
 *
 * Setup: see SETUP.md. Create a NEW, private Google Sheet for the log, open Extensions > Apps Script there,
 * paste this file, then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 */

// ---- Settings ------------------------------------------------------------
const LEDGER_SHEET_ID = "1AUdMpLW4znCaB7UQbdjzmzcNUMX32xGLi5At8dCEfxQ";   // the purchase ledger (decides who is an Editor)
const CLIENT_ID = "848505807317-682h1an2d78ertgg190oeo9f3qalgh58.apps.googleusercontent.com";  // the dashboard's OAuth client
const LOG_SHEET_NAME = "System Log";
const TIMEZONE = "Asia/Colombo";
const MAX_ROWS_RETURNED = 1000;          // newest rows sent to the dashboard
const HEADERS = ["Time", "Email", "Event", "Access", "Device", "Model", "OS", "Browser", "Type", "Screen", "Display", "Language", "Timezone"];

// ---- Entry points --------------------------------------------------------
function doGet() {
  return json_({ ok: true, service: "Elite Colour World system log" });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const email = verifyToken_(req.token);
    const access = accessOf_(email);
    const isEditor = access === "Editor";

    switch (req.action) {
      case "visit":
        appendVisit_(email, access, req.device || {});
        return json_({ ok: true, isEditor: isEditor, access: access });
      case "me":
        return json_({ ok: true, isEditor: isEditor, access: access });
      case "list":
        if (!isEditor) return json_({ ok: false, error: "forbidden" });
        return json_({ ok: true, isEditor: true, rows: readRows_() });
      default:
        return json_({ ok: false, error: "bad_action" });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ---- Who is calling? -----------------------------------------------------
function verifyToken_(token) {
  if (!token || typeof token !== "string" || token.length > 4096) throw new Error("no_token");
  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;

  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("bad_token");
  const info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID && info.azp !== CLIENT_ID) throw new Error("wrong_client");
  if (!info.email || String(info.email_verified) !== "true") throw new Error("no_email");

  const email = String(info.email).toLowerCase();
  cache.put(key, email, Math.max(30, Math.min(300, (Number(info.expires_in) || 90) - 30)));
  return email;
}

// "Editor" = owner or editor of the ledger Sheet (the people who can use Add bill)
function accessOf_(email) {
  const cache = CacheService.getScriptCache();
  const key = "acc_" + email;
  const hit = cache.get(key);
  if (hit) return hit;

  const ss = SpreadsheetApp.openById(LEDGER_SHEET_ID);
  const same = function (u) { return !!u && String(u.getEmail()).toLowerCase() === email; };
  let access = "No access";
  if (same(ss.getOwner()) || ss.getEditors().some(same)) access = "Editor";
  else if (ss.getViewers().some(same)) access = "Viewer";
  cache.put(key, access, 300);
  return access;
}

// ---- The log -------------------------------------------------------------
function logSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange("A:A").setNumberFormat("@");   // keep the time as text, exactly as written
  }
  return sheet;
}

function appendVisit_(email, access, d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    logSheet_().appendRow([
      Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      email, "Sign in", access,
      safe_(d.label), safe_(d.model), safe_(d.os), safe_(d.browser), safe_(d.type),
      safe_(d.screen), safe_(d.display), safe_(d.lang), safe_(d.tz)
    ]);
  } finally {
    lock.releaseLock();
  }
}

function readRows_() {
  const sheet = logSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const n = Math.min(MAX_ROWS_RETURNED, last - 1);
  const values = sheet.getRange(last - n + 1, 1, n, HEADERS.length).getValues();
  return values.reverse().map(function (r) {
    return {
      t: timeText_(r[0]), email: r[1], event: r[2], access: r[3], device: r[4], model: r[5], os: r[6],
      browser: r[7], type: r[8], screen: r[9], display: r[10], lang: r[11], tz: r[12]
    };
  });
}

// ---- Helpers -------------------------------------------------------------
function timeText_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX") : String(v || "");
}

// Short plain text only; a leading = + - @ would be read as a formula by Sheets
function safe_(v) {
  const s = (v === null || v === undefined ? "" : String(v)).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
