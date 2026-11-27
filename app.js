"use strict";
window.__ledgerBooted = "v10";   // theme.js checks this to detect a wrong / stale app.js on the server
// ---------------------------------------------------------------------------
// Security: refuse to run inside another site's frame (clickjacking guard).
// GitHub Pages can't send the frame-ancestors header, so this is done here.
// ---------------------------------------------------------------------------
if(window.top !== window.self){
  document.documentElement.innerHTML = "";
  throw new Error("Elite Ledger can't be embedded in another page.");
}
 
// ---------------------------------------------------------------------------
// App feel: iOS Safari ignores user-scalable=no, so block pinch-zoom here too
// ---------------------------------------------------------------------------
["gesturestart", "gesturechange"].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
document.addEventListener("touchmove", e => { if(e.touches.length > 1) e.preventDefault(); }, { passive: false });
 
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SHEET_ID = "1AUdMpLW4znCaB7UQbdjzmzcNUMX32xGLi5At8dCEfxQ";
const MONTH_SHEETS = ["Jan","Feb","Mar","Apr","May","June","July","Aug","Sep","Oct","Nov","Dec"];
const SALE_TAB = "Sale";                               // extra tab for sale purchases (same A–D columns as the month tabs)
const SHEETS = ["2025", ...MONTH_SHEETS, SALE_TAB];
const SB_IC = {"wal": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 7a2 2 0 0 1 2-2h13v4\"/><path d=\"M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z\"/><circle cx=\"16.5\" cy=\"14.5\" r=\"1.2\"/></svg>", "bill": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M7 3h8l4 4v14H7z\"/><path d=\"M15 3v4h4M10 12h6M10 16h6\"/></svg>", "sup": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"9\" cy=\"8\" r=\"3.2\"/><path d=\"M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5\"/><path d=\"M16 5.5a3 3 0 0 1 0 5.6M18 14.8c1.8.7 3 2.4 3 5.2\"/></svg>", "top": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 18l5-6 4 3 7-9\"/><path d=\"M15 6h5v5\"/></svg>"};
const SB_COL = { wal: "#E2B43A", bill: "#E2B43A", sup: "#4FC48A", top: "#5EA4FF" };
const SALE_K = SHEETS.length - 1;                      // sheet index of the Sale tab
// short axis label so 14 labels fit under their bars ("June" -> "Jun")
const chartLabel = s => (s === "June" || s === "July") ? s.slice(0, 3) : s;
const sheetLabel = k => k === 0 ? "2025 archive" : k === SALE_K ? "Sale purchases" : `${MONTH_SHEETS[k-1]} 2026`;
const HEADER_MARKER = "supplier name";
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const API_OPTS = "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER";
 
// LOGIN — real security via Google Sign-In. Only Google accounts that are
// (1) added as Test users in the OAuth consent screen AND
// (2) given at least Viewer access to the Google Sheet itself
// can sign in and see any data. Both checks are enforced by Google.
const CLIENT_ID = "848505807317-682h1an2d78ertgg190oeo9f3qalgh58.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/userinfo.email";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets"; // asked for only when adding a bill
const TOKEN_KEY = "ledger_token_v3";     // {token, exp, scope}
const EMAIL_KEY = "ledger_user_email";
const CACHE_KEY = "ledger_cache_v7";     // last loaded data, for instant paint
const LOCK_MSG_KEY = "ledger_lock_msg";  // reason shown on the sign-in screen after an auto-lock
const IDLE_LOCK_MINUTES = 30;            // lock and wipe the data after this long without activity
const LOG_URL = "https://script.google.com/macros/s/AKfycbxOqxaO86nlWEvHxBvUdoSHe79rDbRU6dzoowjlp78Sn3DdcyYiENx-vTqNk1EfqcpW/exec";                      // System Log: paste the Apps Script web app URL here (see system-log/SETUP.md). Empty = System Log is off.
const LOG_FLAG_KEY = "ledger_log_editor"; // sessionStorage: "1" if this person has Add bill (Editor) access
 
const $ = id => document.getElementById(id);
 
// sessionStorage can throw (private mode, blocked storage) — never let that break the app.
// sessionStorage (not localStorage) so nothing survives closing the tab/app.
const store = {
  get(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ sessionStorage.setItem(k,v); }catch(e){} },
  del(k){ try{ sessionStorage.removeItem(k); }catch(e){} }
};
 
// Fonts are loaded without blocking the first paint (and without an inline handler, which the CSP forbids)
{ const f = $("fontCss"); if(f) f.media = "all"; }
 
let accessToken = null;
let tokenExp = 0;
let currentUserEmail = store.get(EMAIL_KEY);
let tokenClient = null;
let grantedScopes = "";
let authWaiter = null;   // set while an in-app permission request (e.g. write access) is pending
 
(function restoreToken(){
  try{
    const t = JSON.parse(store.get(TOKEN_KEY) || "null");
    if(t && t.token && t.exp > Date.now() + 60000){ accessToken = t.token; tokenExp = t.exp; grantedScopes = t.scope || ""; }
    else store.del(TOKEN_KEY);
  }catch(e){ store.del(TOKEN_KEY); }
})();
 
// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function onGsiLoaded(){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      const waiter = authWaiter; authWaiter = null;
      $("googleSignInBtn").disabled = false;
      if(resp.error){ waiter ? waiter(resp.error) : showSignInError(resp.error); return; }
      accessToken = resp.access_token;
      grantedScopes = resp.scope || SCOPES;
      tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      store.set(TOKEN_KEY, JSON.stringify({token: accessToken, exp: tokenExp, scope: grantedScopes}));
      markActive();
      if(waiter){ waiter(null); return; }
      enterDashboard();
    },
    error_callback: (err) => {
      const waiter = authWaiter; authWaiter = null;
      $("googleSignInBtn").disabled = false;
      const code = err && err.type ? err.type : "unknown_error";
      waiter ? waiter(code) : showSignInError(code);
    }
  });
  $("googleSignInBtn").disabled = false;
  $("signInLabel").textContent = "Sign in with Google";
}
// The GSI script is async: it may finish before or after this script runs
if(window.google && google.accounts && google.accounts.oauth2) onGsiLoaded();
else $("gsiScript").addEventListener("load", onGsiLoaded);
 
// If Google's sign-in script never arrives (blocked network, ad-blocker, weak signal) don't hang forever:
// say so, and let the button retry by loading the script again.
let gsiRetrying = false;
function gsiFailed(){
  if(tokenClient) return;
  $("signInLabel").textContent = "Retry sign-in";
  $("googleSignInBtn").disabled = false;
  $("lockError").textContent = "⚠️ Google sign-in couldn't load. Check your internet, turn off VPN / ad-blocker for this site, then tap Retry.";
}
$("gsiScript").addEventListener("error", gsiFailed);
setTimeout(gsiFailed, 8000);
function retryGsi(){
  if(gsiRetrying) return;
  gsiRetrying = true;
  $("googleSignInBtn").disabled = true;
  $("signInLabel").textContent = "Loading sign-in…";
  $("lockError").textContent = "";
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client?r=" + Date.now();
  s.onload = () => { gsiRetrying = false; onGsiLoaded(); };
  s.onerror = () => { gsiRetrying = false; gsiFailed(); };
  document.head.appendChild(s);
}
 
function showSignInError(code){
  $("lockError").textContent = (code === "access_denied" || code === "popup_closed")
    ? "Sign-in cancelled. Try again."
    : "⚠️ Access blocked — this Google account isn't authorized for this dashboard. Contact the admin to be added as a Test user + Sheet viewer.";
}
 
function signIn(){
  if(!tokenClient){ retryGsi(); return; }
  $("googleSignInBtn").disabled = true;
  $("lockError").textContent = "";
  // Empty prompt: returning users skip the consent screen (faster sign-in)
  tokenClient.requestAccessToken({ prompt: "", login_hint: currentUserEmail || undefined });
}
 
const hasWriteScope = () => grantedScopes.split(/\s+/).includes(WRITE_SCOPE);
 
// Must be called directly from a click handler, or the browser blocks Google's popup
function requestWriteAccess(){
  return new Promise((resolve, reject) => {
    if(!tokenClient){ reject("not_ready"); return; }
    authWaiter = err => err ? reject(err) : hasWriteScope() ? resolve() : reject("scope_denied");
    tokenClient.requestAccessToken({ prompt: "", scope: SCOPES + " " + WRITE_SCOPE, login_hint: currentUserEmail || undefined });
  });
}
 
function signOut(){
  if(accessToken && window.google && google.accounts && google.accounts.oauth2){
    try{ google.accounts.oauth2.revoke(accessToken, () => {}); }catch(e){}
  }
  [TOKEN_KEY, EMAIL_KEY, CACHE_KEY, LOG_FLAG_KEY].forEach(store.del);
  accessToken = null; CHQ = null;
  location.reload();
}
 
// Drops the session and every copy of the ledger data (memory, page, storage),
// then reloads to a clean sign-in screen that explains why.
function secureLock(message){
  [TOKEN_KEY, CACHE_KEY, LOG_FLAG_KEY].forEach(store.del);
  accessToken = null; CHQ = null;
  store.set(LOCK_MSG_KEY, message);
  location.reload();
}
function lock(message){ secureLock(message || "Please sign in again."); }
 
// ---------------------------------------------------------------------------
// Auto-lock: after IDLE_LOCK_MINUTES without use, or when Google's 1-hour
// session ends. Protects the data on a phone or PC left unattended.
// ---------------------------------------------------------------------------
let lastActive = Date.now();
function markActive(){ lastActive = Date.now(); }
["pointerdown", "keydown", "wheel", "touchstart"].forEach(ev => window.addEventListener(ev, markActive, { passive: true, capture: true }));
function checkSession(){
  if(!accessToken || billSaving) return;
  if(Date.now() - lastActive > IDLE_LOCK_MINUTES * 60000){
    secureLock(`Locked after ${IDLE_LOCK_MINUTES} minutes without activity. Sign in again to continue.`);
  } else if(tokenExp && Date.now() > tokenExp - 30000){
    secureLock("Your Google session ended (1 hour). Sign in again to continue.");
  }
}
setInterval(checkSession, 30000);
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") checkSession(); });
 
async function fetchUserEmail(){
  try{
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if(res.ok){
      const d = await res.json();
      if(d.email){
        currentUserEmail = d.email;
        store.set(EMAIL_KEY, d.email);
        showAccount();
        applyMenus(); route();
      }
    }
  }catch(e){ /* non-fatal */ }
}
 
function showAccount(){
  const email = currentUserEmail || "";
  $("accountEmail").textContent = email || "Google account";
  $("avatarLetter").textContent = (email[0] || "?").toUpperCase();
  $("menuAvatarLetter").textContent = (email[0] || "?").toUpperCase();
  $("avatar").classList.add("show");
  document.body.classList.add("authed");
  if(typeof applyMenus === "function") applyMenus();
}
 
function enterDashboard(){
  $("lockScreen").classList.add("hidden");
  showAccount();
  // Data and email lookups run in parallel — nothing waits on the other
  if(!currentUserEmail) fetchUserEmail();
  loadAll(false);
  logSignIn();
  // landed on #cheques before signing in: start the cheque load now, no manual refresh needed
  if(location.hash === "#cheques"){ chqErr = ""; route(); }
}
 
// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
// Bill shape (compact for speed + cache size): {s: supplier, i: invoice, a: amount, t: local-midnight ms | null, k: sheet index, r: row index in the sheet (0-based)}
let BILLS = [];
let BY_SUPPLIER = new Map();   // supplier -> bills[]
let BY_SHEET = SHEETS.map(() => []);   // sheet index -> bills[] in sheet row order
 
const clean = v => (v === null || v === undefined) ? "" : String(v).replace(/[​-‍﻿]/g,"").trim();
const esc = s => s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 
function toLocalISODate(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function parseLocalMs(str){
  if(!str) return null;
  const [y,m,d] = str.split("-").map(Number);
  return new Date(y, m-1, d).getTime();
}
// Google Sheets serial (days since 1899-12-30) -> local-midnight ms, no TZ shift
function serialToMs(serial){
  if(typeof serial !== "number" || isNaN(serial)) return null;
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}
 
function parseRows(rows, k, out){
  let i = 0;
  while(i < rows.length && clean(rows[i] && rows[i][0]).toLowerCase() !== HEADER_MARKER) i++;
  for(i++; i < rows.length; i++){
    const r = rows[i];
    if(!r || !r.length) continue;
    const s = clean(r[0]);
    const a = typeof r[2] === "number" && isFinite(r[2]) ? r[2] : 0;
    if(!s && !a) continue; // blank filler rows
    out.push({ s: s || "(Unnamed)", i: clean(r[1]), a, t: serialToMs(r[3]), k, r: i });
  }
}
 
class HttpError extends Error{ constructor(status, detail){ super(detail || "HTTP " + status); this.status = status; this.detail = detail || ""; } }
 
async function api(url, body, method){
  const opts = { headers: { Authorization: `Bearer ${accessToken}` }, referrerPolicy: "no-referrer", cache: "no-store" };
  if(body){ opts.method = method || "POST"; opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  opts.signal = ctl.signal;
  let res;
  try{ res = await fetch(url, opts); }
  finally{ clearTimeout(timer); }
  if(!res.ok){
    let detail = "";
    try{ detail = (await res.json()).error.message || ""; }catch(e){}
    throw new HttpError(res.status, detail);
  }
  return res.json();
}
const apiGet = url => api(url);
const rangeFor = name => encodeURIComponent(`'${name}'!A:D`);
 
// One batched request for all 14 sheets, asking Google for only the cell values
// (no range metadata) to keep the download small. If a sheet tab is missing,
// batchGet fails as a whole — fall back to per-sheet.
async function fetchAll(){
  const bills = [], errors = [];
  try{
    const qs = SHEETS.map(s => "ranges=" + rangeFor(s)).join("&");
    const data = await apiGet(`${API}/values:batchGet?${qs}&${API_OPTS}&fields=valueRanges(values)`);
    (data.valueRanges || []).forEach((vr, k) => parseRows(vr.values || [], k, bills));
    return { bills, errors, forbidden: false };
  }catch(e){
    if(e.status === 401) throw e;
    if(e.status === 403) return { bills, errors: SHEETS.slice(), forbidden: true };
  }
  const results = await Promise.allSettled(SHEETS.map(s => apiGet(`${API}/values/${rangeFor(s)}?${API_OPTS}&fields=values`)));
  let forbidden = false;
  for(let k = 0; k < results.length; k++){
    const r = results[k];
    if(r.status === "fulfilled") parseRows(r.value.values || [], k, bills);
    else{
      if(r.reason && r.reason.status === 401) throw r.reason;
      if(r.reason && r.reason.status === 403) forbidden = true;
      errors.push(SHEETS[k]);
    }
  }
  // Everything failed without an auth reason (offline?) — keep showing the old data
  if(!bills.length && errors.length === SHEETS.length && !forbidden) throw new Error("network");
  return { bills, errors, forbidden };
}
 
let loading = false;
async function loadAll(manual){
  if(loading || !accessToken) return;
  loading = true;
  const btn = $("refreshBtn");
  btn.classList.add("spinning");
  if(manual) $("statusMsg").textContent = "Refreshing…";
 
  try{
    const { bills, errors, forbidden } = await fetchAll();
    if(forbidden && !bills.length){
      setStatus(`⚠️ Access denied for ${currentUserEmail || "this account"} — ask the admin to share the Sheet with this exact email as Viewer.`);
    } else {
      setData(bills);
      store.set(CACHE_KEY, JSON.stringify({ at: Date.now(), email: currentUserEmail, bills }));
      setUpdated(new Date(), false);
      setStatus(errors.length ? `⚠️ Couldn't load: ${errors.join(", ")}` : "");
    }
  }catch(e){
    if(e.status === 401) lock("Your session expired. Please sign in again.");
    else setStatus("⚠️ Network error — showing last loaded data. Tap Refresh to retry.");
  }finally{
    loading = false;
    btn.classList.remove("spinning");
  }
}
 
function setStatus(msg){ $("statusMsg").textContent = msg; }
function setUpdated(when, stale){
  const t = when.toLocaleTimeString("en-LK", {hour:"2-digit", minute:"2-digit"});
  $("updatedAt").textContent = stale ? `Cached ${t} · refreshing…` : `Updated ${t}`;
  $("liveDot").classList.toggle("stale", stale);
}
 
function setData(bills){
  BILLS = bills;
  BY_SUPPLIER = new Map();
  BY_SHEET = SHEETS.map(() => []);
  for(const b of bills){
    if(BY_SHEET[b.k]) BY_SHEET[b.k].push(b);
    let arr = BY_SUPPLIER.get(b.s);
    if(!arr) BY_SUPPLIER.set(b.s, arr = []);
    arr.push(b);
  }
  // Paint on the next frame so input stays responsive
  requestAnimationFrame(() => { render(); if(!svView.hidden) renderSupplierView(); if(!sbView.hidden) renderSheetsView(); });
}
 
// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const nf2 = new Intl.NumberFormat("en-LK", {minimumFractionDigits:2, maximumFractionDigits:2});
const nf0 = new Intl.NumberFormat("en-LK");
const fmtMoney = n => "Rs. " + nf2.format(n || 0);
const fmtInt = n => nf0.format(n || 0);
function fmtCompact(n){
  n = n || 0;
  const abs = Math.abs(n);
  if(abs >= 1e9) return "Rs. " + (n/1e9).toFixed(2) + "B";
  if(abs >= 1e6) return "Rs. " + (n/1e6).toFixed(2) + "M";
  if(abs >= 1e3) return "Rs. " + (n/1e3).toFixed(2) + "K";
  return fmtMoney(n);
}
function setVal(id, text, title){
  const el = $(id);
  el.textContent = text;
  el.classList.remove("skel");
  if(title) el.title = title;
}
 
// ---------------------------------------------------------------------------
// Render — every aggregate is computed in a single pass over the bills
// ---------------------------------------------------------------------------
let selectedSheet = -1;
let SHEET_SUMS = [], SHEET_COUNTS = [];
 
function render(){
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const tmStart = new Date(y, m, 1).getTime(), tmEnd = new Date(y, m+1, 1).getTime();
  const lmStart = new Date(y, m-1, 1).getTime();
 
  let total = 0, month = 0, monthN = 0, last = 0, lastN = 0;
  const sums = new Array(SHEETS.length).fill(0), counts = new Array(SHEETS.length).fill(0);
  const bySup = new Map();
 
  for(const b of BILLS){
    total += b.a;
    sums[b.k] += b.a; counts[b.k]++;
    if(b.t !== null){
      if(b.t >= tmStart && b.t < tmEnd){ month += b.a; monthN++; }
      else if(b.t >= lmStart && b.t < tmStart){ last += b.a; lastN++; }
    }
    bySup.set(b.s, (bySup.get(b.s) || 0) + b.a);
  }
  SHEET_SUMS = sums; SHEET_COUNTS = counts;
  const n = BILLS.length;
 
  setVal("k-total", fmtCompact(total), fmtMoney(total));
  setVal("k-month", fmtCompact(month), fmtMoney(month));
  setVal("k-last", fmtCompact(last), fmtMoney(last));
  $("k-bills").textContent = fmtInt(n);
  $("k-suppliers").textContent = fmtInt(bySup.size);
  $("k-monthbills").textContent = fmtInt(monthN);
  $("k-lastbills").textContent = fmtInt(lastN);
  $("k-avg").textContent = n ? fmtCompact(total / n).replace("Rs. ", "Rs.") : "—";
  $("k-monthavg").textContent = monthN ? fmtCompact(month / monthN).replace("Rs. ", "Rs.") : "—";
  $("k-lastavg").textContent = lastN ? fmtCompact(last / lastN).replace("Rs. ", "Rs.") : "—";
  const sp = $("heroSpark");
  if(sp){
    const yr = sums.slice(1, 13), cur = now.getFullYear() === 2026 ? now.getMonth() : 11, W = 300, H = 80, P = 6;
    const mx = Math.max(1, ...yr.slice(0, cur + 1)), X = i => P + i * (W - 2 * P) / 11, Y = v => H - P - v / mx * (H - 2 * P - 6);
    const pts = yr.slice(0, cur + 1).map((v, i) => [X(i), Y(v)]);
    let d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for(let i = 1; i < pts.length; i++){ const p0 = pts[i - 2] || pts[i - 1], p1 = pts[i - 1], p2 = pts[i], p3 = pts[i + 1] || p2, t = 0.18;
      const c1 = [p1[0] + (p2[0] - p0[0]) * t, Math.min(H - P, Math.max(P, p1[1] + (p2[1] - p0[1]) * t))], c2 = [p2[0] - (p3[0] - p1[0]) * t, Math.min(H - P, Math.max(P, p2[1] - (p3[1] - p1[1]) * t))];
      d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`; }
    const last = pts[pts.length - 1];
    sp.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="hsG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E2B43A" stop-opacity=".38"/><stop offset="1" stop-color="#E2B43A" stop-opacity="0"/></linearGradient></defs>
      <path class="hs-g" d="M${P} ${H - P}H${W - P}M${P} ${(H / 2).toFixed(0)}H${W - P}"/><path d="${d}L${last[0].toFixed(1)} ${H - P}L${pts[0][0].toFixed(1)} ${H - P}Z" fill="url(#hsG)"/><path class="hs-l" d="${d}"/></svg>
      <i class="hs-d" style="left:${(last[0] / W * 100).toFixed(2)}%;top:${(last[1] / H * 100).toFixed(2)}%"></i>
      <div class="hs-m">${"JFMAMJJASOND".split("").map((c, i) => `<span class="${i === cur ? "on" : ""}">${c}</span>`).join("")}</div>`;
  }
 
  renderChart(now);
  renderTopSuppliers();
  renderSupplierOptions(bySup);
  updateFinder();
}
 
function barShort(v){ return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "K" : String(Math.round(v)); }
function renderChart(now){
  const max = Math.max(1, ...SHEET_SUMS);
  if(selectedSheet < 0){
    // Default to the current month's sheet in the current year, else the latest sheet with data
    selectedSheet = now.getFullYear() === 2025 ? 0 : 1 + now.getMonth();
    if(!SHEET_COUNTS[selectedSheet]){
      for(let k = SALE_K - 1; k >= 0; k--) if(SHEET_COUNTS[k]){ selectedSheet = k; break; }
    }
  }
  $("chart").innerHTML = SHEETS.map((s, k) => {
    const h = (SHEET_SUMS[k] / max * 100).toFixed(1);
    return `<button class="bar-col${k === selectedSheet ? " sel" : ""}" type="button" role="listitem" data-k="${k}"
      aria-label="${s}: ${fmtMoney(SHEET_SUMS[k])}"><div class="bar" style="height:${h}%;animation-delay:${k*25}ms"><i class="bar-v${SHEET_SUMS[k] ? "" : " z"}">${barShort(SHEET_SUMS[k])}</i></div></button>`;
  }).join("");
  $("chartLabels").innerHTML = SHEETS.map((s, k) => `<span class="${k === selectedSheet ? "sel" : ""}" title="${sheetLabel(k)}">${chartLabel(s)}</span>`).join("");
  showDetail(selectedSheet);
}
 
function showDetail(k){
  const total = SHEET_SUMS.reduce((a, b) => a + b, 0) || 1;
  $("detailName").textContent = sheetLabel(k);
  $("detailVal").textContent = fmtMoney(SHEET_SUMS[k] || 0);
  $("detailSub").innerHTML = `<span class="tg" style="--tc:#E2B43A"><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 12h6M10 16h6"/></svg></i><b>${fmtInt(SHEET_COUNTS[k] || 0)}</b> bills</span><span class="tg" style="--tc:#5EA4FF"><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="17" r="2.2"/></svg></i><b>${((SHEET_SUMS[k] || 0) / total * 100).toFixed(1)}%</b> of total</span>`;
}
 
function selectBar(k){
  selectedSheet = k;
  document.querySelectorAll("#chart .bar-col").forEach((el, i) => el.classList.toggle("sel", i === k));
  document.querySelectorAll("#chartLabels span").forEach((el, i) => el.classList.toggle("sel", i === k));
  showDetail(k);
}
 
let topPeriod = "thisMonth";   // default period; keep in step with the .active chip in index.html
 
// Returns {from, to, label} in local-midnight ms, or {msg} when custom dates are incomplete
function topRange(){
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const ms = (yy, mm, dd) => new Date(yy, mm, dd).getTime();
  const SM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = t => { const x = new Date(t); return `${SM[x.getMonth()]} ${x.getFullYear()}`; };
  const day = t => { const x = new Date(t); return `${String(x.getDate()).padStart(2,"0")} ${SM[x.getMonth()]} ${x.getFullYear()}`; };
  switch(topPeriod){
    case "thisMonth": { const f = ms(y, m, 1);     return { from: f, to: ms(y, m + 1, 0), label: mon(f) }; }
    case "lastMonth": { const f = ms(y, m - 1, 1); return { from: f, to: ms(y, m, 0),     label: mon(f) }; }
    case "last3":     { const f = ms(y, m - 2, 1); return { from: f, to: ms(y, m + 1, 0), label: `${mon(f)} – ${mon(ms(y, m, 1))}` }; }
    case "last30":    { const f = ms(y, m, d - 29), t = ms(y, m, d); return { from: f, to: t, label: `${day(f)} – ${day(t)}` }; }
    case "custom": {
      const f = parseLocalMs($("topFrom").value), t = parseLocalMs($("topTo").value);
      if(f === null || t === null) return { msg: "Pick both From and To dates." };
      if(f > t) return { msg: "⚠️ From date is after To date." };
      return { from: f, to: t, label: `${day(f)} – ${day(t)}` };
    }
    default: return { from: -Infinity, to: Infinity, label: "All time" };
  }
}
 
function renderTopSuppliers(){
  const list = $("topList"), summary = $("topSummary");
  const r = topRange();
  if(r.msg){ summary.innerHTML = ""; list.innerHTML = `<div class="empty">${esc(r.msg)}</div>`; return; }
 
  // aggregate in one pass; undated bills only count in All time
  const bySup = new Map();
  let total = 0, n = 0;
  for(const b of BILLS){
    if(topPeriod !== "all" && (b.t === null || b.t < r.from || b.t > r.to)) continue;
    bySup.set(b.s, (bySup.get(b.s) || 0) + b.a);
    total += b.a; n++;
  }
  summary.innerHTML = `<span>${esc(r.label)}</span><span><b class="num">${fmtMoney(total)}</b> · ${fmtInt(n)} bill${n === 1 ? "" : "s"}</span>`;
 
  const top = [...bySup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = top.length ? top[0][1] : 1;
  list.innerHTML = top.length ? top.map(([name, amt], i) => `
    <div class="supplier-row">
      <div class="rank">${i + 1}</div>
      <div class="supplier-name" title="${esc(name)}">${esc(name)}</div>
      <div class="supplier-amt num">${fmtMoney(amt)}</div>
      <div class="share-track"><div class="share-bar" style="width:${(amt / max * 100).toFixed(1)}%"></div></div>
      <div class="share-pct num">${total ? (amt / total * 100).toFixed(1) : "0.0"}%</div>
    </div>`).join("") : `<div class="empty">${BILLS.length ? "No bills in this period" : "No data yet"}</div>`;
}
 
$("topChips").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if(!c) return;
  topPeriod = c.dataset.p;
  document.querySelectorAll("#topChips .chip").forEach(x => x.classList.toggle("active", x === c));
  $("topCustom").hidden = topPeriod !== "custom";
  if(topPeriod === "custom" && !$("topFrom").value){
    const n = new Date();
    $("topFrom").value = toLocalISODate(new Date(n.getFullYear(), n.getMonth(), 1));
    $("topTo").value = toLocalISODate(n);
  }
  renderTopSuppliers();
});
["topFrom", "topTo"].forEach(id => {
  $(id).addEventListener("change", renderTopSuppliers);
  $(id).addEventListener("click", e => { try{ e.currentTarget.showPicker(); }catch(err){} });
});
 
// ---------------------------------------------------------------------------
// Searchable supplier picker (shared by the finder and the Add Bill form)
// ---------------------------------------------------------------------------
let SUPPLIERS = [];          // [{name, total, lc}] sorted by name
const COMBOS = [];
let comboSeq = 0;
 
function renderSupplierOptions(bySup){
  SUPPLIERS = [...bySup.entries()]
    .map(([name, total]) => ({ name, total, lc: name.toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  COMBOS.forEach(c => c.refresh());
}
 
function createCombo(root, { labelId, placeholder, allowNew = false, onChange = () => {} }){
  const id = "cb" + (++comboSeq);
  root.innerHTML = `
    <button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${labelId} ${id}-text">
      <span id="${id}-text" class="placeholder">${esc(placeholder)}</span>
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 7.5l4.5 5 4.5-5z"/></svg>
    </button>
    <div class="combo-panel" hidden>
      <div class="combo-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="search" placeholder="${allowNew ? "Search or type a new supplier…" : "Search supplier…"}" autocomplete="off" spellcheck="false"
          enterkeyhint="done" role="combobox" aria-controls="${id}-list" aria-expanded="true" aria-autocomplete="list" aria-label="Search supplier">
      </div>
      <ul class="combo-list" id="${id}-list" role="listbox" aria-labelledby="${labelId}"></ul>
    </div>`;
  const btn = root.querySelector(".combo-btn"), text = root.querySelector(".combo-btn span");
  const panel = root.querySelector(".combo-panel"), input = root.querySelector("input"), list = root.querySelector("ul");
  let value = "", matches = [], active = -1;
 
  function set(name, silent){
    value = name;
    text.textContent = name || placeholder;
    text.classList.toggle("placeholder", !name);
    if(!silent) onChange(name);
  }
  function open(prefill){
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    input.value = prefill || "";
    filter();
    input.focus();
  }
  function close(focusBtn){
    if(panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if(focusBtn) btn.focus();
  }
  function filter(){
    const raw = input.value.trim().replace(/\s+/g, " "), q = raw.toLowerCase();
    matches = q ? SUPPLIERS.filter(s => s.lc.includes(q)) : SUPPLIERS.slice();
    // Names that start with the query come first
    if(q) matches.sort((a, b) => (b.lc.startsWith(q) - a.lc.startsWith(q)) || a.name.localeCompare(b.name));
    if(allowNew && q && !SUPPLIERS.some(s => s.lc === q)) matches.push({ name: raw, isNew: true });
    active = q ? (matches.length ? 0 : -1) : matches.findIndex(s => s.name === value);
    const hl = name => {
      const i = q ? name.toLowerCase().indexOf(q) : -1;
      if(i < 0) return esc(name);
      return esc(name.slice(0, i)) + "<mark>" + esc(name.slice(i, i + q.length)) + "</mark>" + esc(name.slice(i + q.length));
    };
    list.innerHTML = matches.length ? matches.map((s, i) => s.isNew
      ? `<li class="combo-opt combo-new" role="option" id="${id}-o${i}" data-i="${i}" aria-selected="false"><span class="n">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
           Add “${esc(s.name)}” as new supplier</span></li>`
      : `<li class="combo-opt" role="option" id="${id}-o${i}" data-i="${i}" aria-selected="${s.name === value}">
           <span class="n">${hl(s.name)}</span><span class="v num">${fmtCompact(s.total)}</span></li>`).join("")
      : `<li class="combo-empty">${!SUPPLIERS.length ? (allowNew ? "Type the supplier name" : "Loading suppliers…")
                                                     : `No supplier matches “${esc(raw)}”`}</li>`;
    syncActive();
  }
  function syncActive(){
    list.querySelectorAll(".combo-opt.active").forEach(el => el.classList.remove("active"));
    const el = active >= 0 ? list.querySelector(`[data-i="${active}"]`) : null;
    if(el){ el.classList.add("active"); el.scrollIntoView({ block: "nearest" }); }
    input.setAttribute("aria-activedescendant", el ? el.id : "");
  }
  function pick(i){
    const s = matches[i];
    if(!s) return;
    close(true);
    set(s.name);
  }
 
  btn.addEventListener("click", () => panel.hidden ? open() : close(false));
  btn.addEventListener("keydown", e => {
    if(e.key === "ArrowDown"){ e.preventDefault(); open(); }
    else if(e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey){
      e.preventDefault(); open(e.key); // typing on the closed button starts a search
    }
  });
  input.addEventListener("input", filter);
  input.addEventListener("keydown", e => {
    const n = matches.length;
    if(e.key === "ArrowDown"){ e.preventDefault(); if(n){ active = (active + 1) % n; syncActive(); } }
    else if(e.key === "ArrowUp"){ e.preventDefault(); if(n){ active = (active - 1 + n) % n; syncActive(); } }
    else if(e.key === "Enter"){ e.preventDefault(); pick(active); }
    else if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(true); }
    else if(e.key === "Tab") close(false);
  });
  list.addEventListener("mousedown", e => e.preventDefault()); // keep focus in the search box
  list.addEventListener("click", e => { const o = e.target.closest(".combo-opt"); if(o) pick(+o.dataset.i); });
  document.addEventListener("click", e => { if(!root.contains(e.target)) close(false); });
 
  const combo = {
    get value(){ return value; },
    set, open, close,
    focus(){ btn.focus(); },
    refresh(){
      // The finder only allows suppliers that exist; the bill form may hold a new one
      if(value && !allowNew && !SUPPLIERS.some(s => s.name === value)) set("", true);
      if(!panel.hidden) filter();
    }
  };
  COMBOS.push(combo);
  return combo;
}
 
const finderCombo = createCombo($("supplierCombo"), { labelId: "supplierLabel", placeholder: "Choose a supplier…", onChange: updateFinder });
 
// ---------------------------------------------------------------------------
// Quick finder
// ---------------------------------------------------------------------------
let finderMode = "range";
 
function setMode(mode){
  finderMode = mode;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.mode === mode)));
  $("supplierField").hidden = mode === "range";
  $("dateFields").hidden = mode === "supplier";
  updateFinder();
}
 
function updateFinder(){
  const valEl = $("resultValue"), subEl = $("resultSub"), labelEl = $("resultLabel");
  const setMsg = (msg, cls) => { valEl.textContent = msg; valEl.className = "result-value num " + cls; subEl.textContent = ""; };
  const needSupplier = finderMode !== "range", needDates = finderMode !== "supplier";
  const supplier = finderCombo.value;
  labelEl.textContent = finderMode === "range" ? "Total purchase in range"
                      : finderMode === "supplier" ? "Supplier total (all dates)" : "Supplier total in range";
 
  if(!BILLS.length){ setMsg("Loading…", "muted"); return; }
  if(needSupplier && !supplier){ setMsg("Choose a supplier", "muted"); return; }
 
  let from = -Infinity, to = Infinity;
  if(needDates){
    const f = parseLocalMs($("dateFrom").value), t = parseLocalMs($("dateTo").value);
    if(f === null || t === null){ setMsg("Pick both dates", "muted"); return; }
    if(f > t){ setMsg("⚠️ From date is after To date", "err"); return; }
    from = f; to = t;
  }
 
  const pool = needSupplier ? (BY_SUPPLIER.get(supplier) || []) : BILLS;
  let sum = 0, count = 0;
  for(const b of pool){
    if(needDates && (b.t === null || b.t < from || b.t > to)) continue;
    sum += b.a; count++;
  }
  valEl.className = "result-value num";
  valEl.textContent = fmtMoney(sum);
  subEl.textContent = `${fmtInt(count)} bill${count === 1 ? "" : "s"}` + (count ? ` · avg ${fmtMoney(sum / count)}` : "");
}
 
function applyPreset(p){
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  let from, to;
  if(p === "thisMonth"){ from = new Date(y, m, 1); to = new Date(y, m+1, 0); }
  else if(p === "lastMonth"){ from = new Date(y, m-1, 1); to = new Date(y, m, 0); }
  else if(p === "last30"){ to = new Date(y, m, now.getDate()); from = new Date(y, m, now.getDate() - 29); }
  else if(p === "ytd"){ from = new Date(y, 0, 1); to = new Date(y, m, now.getDate()); }
  else { // all time: span the data
    let lo = Infinity, hi = -Infinity;
    for(const b of BILLS) if(b.t !== null){ if(b.t < lo) lo = b.t; if(b.t > hi) hi = b.t; }
    from = new Date(isFinite(lo) ? lo : new Date(2025, 0, 1).getTime());
    to = new Date(isFinite(hi) ? hi : now.getTime());
  }
  $("dateFrom").value = toLocalISODate(from);
  $("dateTo").value = toLocalISODate(to);
  document.querySelectorAll("#presetChips .chip").forEach(c => c.classList.toggle("active", c.dataset.preset === p));
  updateFinder();
}
 
// ---------------------------------------------------------------------------
// Supplier bills page: pick a supplier + period, see every bill (uses the data already loaded)
// ---------------------------------------------------------------------------
const dashView = $("dashView"), svView = $("supplierView");
const MONTH_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
let svPeriod = "thisMonth";
const svCombo = createCombo($("svCombo"), { labelId: "svSupLabel", placeholder: "Choose a supplier…", onChange: () => renderSupplierView() });
 
const fmtDay = ms => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2,"0")} ${MONTH_LONG[d.getMonth()].slice(0,3)} ${d.getFullYear()}`;
};
 
// Returns {from, to} in local-midnight ms, or {msg} when custom dates are incomplete
function svRange(){
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const ms = (yy, mm, dd) => new Date(yy, mm, dd).getTime();
  switch(svPeriod){
    case "thisMonth": return { from: ms(y, m, 1),     to: ms(y, m + 1, 0) };
    case "lastMonth": return { from: ms(y, m - 1, 1), to: ms(y, m, 0) };
    case "last3":     return { from: ms(y, m - 2, 1), to: ms(y, m + 1, 0) };
    case "ytd":       return { from: ms(y, 0, 1),     to: ms(y, 11, 31) };
    case "custom": {
      const f = parseLocalMs($("svFrom").value), t = parseLocalMs($("svTo").value);
      if(f === null || t === null) return { msg: "Pick both From and To dates." };
      if(f > t) return { msg: "⚠️ From date is after To date." };
      return { from: f, to: t };
    }
    default: return { from: -Infinity, to: Infinity };
  }
}
 
function svPeriodLabel(r){
  if(svPeriod === "all") return "All time";
  if(svPeriod === "thisMonth" || svPeriod === "lastMonth"){
    const d = new Date(r.from); return `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;
  }
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}
 
function renderSupplierView(){
  const out = $("svOut");
  const card = msg => { out.innerHTML = `<div class="card" style="margin-top:14px"><div class="empty">${msg}</div></div>`; };
  const supplier = svCombo.value;
 
  if(!BILLS.length){ card("Loading bills…"); return; }
  if(!supplier){ card("Choose a supplier to see their bills."); return; }
  const r = svRange();
  if(r.msg){ card(esc(r.msg)); return; }
 
  const all = BY_SUPPLIER.get(supplier) || [];
  const undated = all.filter(b => b.t === null).length;
  const list = all.filter(b => b.t === null ? svPeriod === "all" : (b.t >= r.from && b.t <= r.to));
  // newest first; undated bills (all-time view only) go last
  list.sort((a, b) => (a.t === null) - (b.t === null) || (b.t || 0) - (a.t || 0) || b.k - a.k);
 
  const total = list.reduce((s, b) => s + b.a, 0);
  const biggest = list.reduce((m, b) => Math.max(m, b.a), 0);
  const stat = (cls, label, value, sub) =>
    `<div class="sv-stat ${cls}"><div class="k">${label}</div><div class="v num" title="${esc(value.full || "")}">${esc(value.text)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
  const money = n => ({ text: fmtCompact(n), full: fmtMoney(n) });
 
  let html = `<div class="sv-stats">` +
    stat("main", "Total", money(total), `${fmtInt(list.length)} bill${list.length === 1 ? "" : "s"} · ${svPeriodLabel(r)}`) +
    stat("", "Bills", { text: fmtInt(list.length) }) +
    stat("", "Average", money(list.length ? total / list.length : 0)) +
    stat("", "Largest", money(biggest)) +
    `</div>`;
 
  html += `<section class="card" aria-label="Bills"><div class="sv-head"><div class="sv-name">${esc(supplier)}</div><div class="sv-period">${esc(svPeriodLabel(r))}</div></div>`;
 
  if(!list.length){
    html += `<div class="empty">No bills for this supplier in this period.</div>`;
  } else {
    // group by month (list is already sorted)
    let groupKey = null, groupSum = 0, groupHtml = "", groupLabel = "";
    const flush = () => {
      if(groupKey === null) return;
      html += `<div class="sv-month"><span class="m">${esc(groupLabel)}</span><span class="t num">${fmtMoney(groupSum)}</span></div>` + groupHtml;
    };
    for(const b of list){
      const d = b.t === null ? null : new Date(b.t);
      const key = d ? d.getFullYear() * 12 + d.getMonth() : "nodate";
      if(key !== groupKey){
        flush();
        groupKey = key; groupSum = 0; groupHtml = "";
        groupLabel = d ? `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}` : "No date";
      }
      groupSum += b.a;
      groupHtml += `<div class="sv-row"><div class="sv-date">${b.t === null ? "—" : fmtDay(b.t)}</div>` +
        `<div class="sv-inv${b.i ? "" : " none"}">${b.i ? esc(b.i) : "No invoice no."}</div>` +
        `<div class="sv-amt num">${fmtMoney(b.a)}</div></div>`;
    }
    flush();
    html += `<div class="sv-foot"><span>Total (${fmtInt(list.length)} bill${list.length === 1 ? "" : "s"})</span><span class="num">${fmtMoney(total)}</span></div>`;
  }
  if(undated && svPeriod !== "all") html += `<div class="sv-note">${undated} bill${undated === 1 ? " has" : "s have"} no date and show only under All time.</div>`;
  html += `</section>`;
  out.innerHTML = html;
}
 
// ---------------------------------------------------------------------------
// Sheets & Bills page: pick a sheet (2025, Jan … Dec), see all its bills, sort / search them
// ---------------------------------------------------------------------------
const sbView = $("sheetsView");
let sbSheet = -1, sbSort = "recent", sbQuery = "";
const SB_LABEL = k => k === 0 ? "2025" : k === SALE_K ? "Sale" : MONTH_SHEETS[k - 1];
const SB_TITLE = k => k === 0 ? "2025 archive" : k === SALE_K ? "Sale purchases" : `${MONTH_LONG[k - 1]} 2026`;
const SB_HINTS = {
  recent: "Newest entries first, based on the order bills were added in the sheet (last row = latest).",
  oldest: "Oldest entries first (top rows of the sheet)."
};
 
// index of the sheet for the current month (same rule the monthly chart uses)
function sbCurrentSheet(){
  const now = new Date();
  return now.getFullYear() === 2025 ? 0 : 1 + now.getMonth();
}
// sheet for last month (January -> the 2025 archive, which holds December 2025)
function sbLastSheet(){
  const now = new Date();
  return now.getFullYear() === 2025 || now.getMonth() === 0 ? 0 : now.getMonth();
}
function sbDefaultSheet(){
  let k = sbCurrentSheet();
  if(!(BY_SHEET[k] && BY_SHEET[k].length)){
    for(let j = SALE_K - 1; j >= 0; j--) if(BY_SHEET[j].length){ k = j; break; }
  }
  return k;
}
 
function sbRenderTabs(){
  const box = $("sbTabs");
  box.innerHTML = SHEETS.map((s, k) => {
    const n = BY_SHEET[k].length;
    return `<button class="sb-tab${n ? "" : " empty"}" type="button" role="tab" data-k="${k}" aria-selected="${k === sbSheet}">` +
           `<span>${esc(SB_LABEL(k))}</span><small>${fmtInt(n)}</small></button>`;
  }).join("");
  const sel = box.querySelector('[aria-selected="true"]');
  if(sel) box.scrollLeft = sel.offsetLeft - (box.clientWidth - sel.offsetWidth) / 2;
}
 
function sbSorted(rows){
  const nullLast = (a, b) => (a.t === null) - (b.t === null);
  switch(sbSort){
    case "recent":   return rows.reverse();                                   // file order is oldest -> newest
    case "oldest":   return rows;
    case "amtHigh":  return rows.sort((a, b) => b.a - a.a);
    case "amtLow":   return rows.sort((a, b) => a.a - b.a);
    case "dateNew":  return rows.sort((a, b) => nullLast(a, b) || b.t - a.t);
    case "dateOld":  return rows.sort((a, b) => nullLast(a, b) || a.t - b.t);
    case "supplier": return rows.sort((a, b) => a.s.localeCompare(b.s));
    default:         return rows;
  }
}
 
function renderSheetsView(){
  const stats = $("sbStats"), list = $("sbList");
  const msg = t => `<div class="card"><div class="empty">${t}</div></div>`;
  if(!BILLS.length){ $("sbTabs").innerHTML = ""; stats.innerHTML = ""; list.innerHTML = msg("Loading bills…"); return; }
  if(sbSheet < 0) sbSheet = sbDefaultSheet();
  sbRenderTabs();
  $("sbHint").textContent = SB_HINTS[sbSort] || "";
 
  const all = BY_SHEET[sbSheet];
  const q = sbQuery.trim().toLowerCase();
  let rows = q ? all.filter(b => b.s.toLowerCase().includes(q) || b.i.toLowerCase().includes(q)) : all.slice();
  rows = sbSorted(rows);
 
  let total = 0, biggest = 0;
  const sups = new Set();
  for(const b of rows){ total += b.a; if(b.a > biggest) biggest = b.a; sups.add(b.s); }
  const stat = (cls, label, text, sub, title, ic) =>
    `<div class="sv-stat ${cls}" style="--accent:${SB_COL[ic]}"><div class="k"><span>${label}</span><i class="sb-ic">${SB_IC[ic]}</i></div><div class="v num" title="${esc(title || "")}">${esc(text)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
  stats.innerHTML = `<div class="sv-stats">` +
    stat("main", q ? "Total (filtered)" : "Total", fmtCompact(total), `${SB_TITLE(sbSheet)} · ${fmtMoney(total)}`, fmtMoney(total), "wal") +
    stat("", "Bills", fmtInt(rows.length), q ? "matching bills" : "bills in this sheet", "", "bill") +
    stat("", "Suppliers", fmtInt(sups.size), "unique suppliers", "", "sup") +
    stat("", "Largest", fmtCompact(biggest), "single biggest bill", fmtMoney(biggest), "top") +
    `</div>`;
 
  if(!all.length){ list.innerHTML = msg(`No bills in ${esc(SB_TITLE(sbSheet))} yet.`); return; }
  if(!rows.length){ list.innerHTML = msg(`No bills match “${esc(sbQuery.trim())}” in ${esc(SB_TITLE(sbSheet))}.`); return; }
 
  const row = b => `<div class="sb-row"><div class="sb-sup">${esc(b.s)}</div>` +
    `<div class="sb-meta"><span class="sb-inv${b.i ? "" : " none"}">${b.i ? esc(b.i) : "No invoice no."}</span>` +
    `<span class="sb-date">${b.t === null ? "No date" : fmtDay(b.t)}</span>` +
    `<span class="sb-rown">${typeof b.r === "number" ? "Row " + (b.r + 1) : ""}</span></div>` +
    `<div class="sb-amt num">${fmtMoney(b.a)}</div></div>`;
 
  list.innerHTML = `<section class="card" aria-label="Bills in ${esc(SB_TITLE(sbSheet))}">` +
    `<div class="sv-head"><div class="sv-name">${esc(SB_TITLE(sbSheet))}</div>` +
    `<div class="sb-count">${q ? `Showing ${fmtInt(rows.length)} of ${fmtInt(all.length)} bills` : `${fmtInt(rows.length)} bill${rows.length === 1 ? "" : "s"}`}</div></div>` +
    `<div class="sb-colhead" aria-hidden="true"><span>Supplier</span><span>Invoice</span><span>Date</span><span>Row</span><span class="r">Amount</span></div>` +
    rows.map(row).join("") + `</section>`;
}
 
$("sbTabs").addEventListener("click", e => {
  const t = e.target.closest(".sb-tab"); if(!t) return;
  sbSheet = +t.dataset.k;
  renderSheetsView();
  window.scrollTo(0, 0);
});
$("sbSort").addEventListener("change", e => { sbSort = e.target.value; renderSheetsView(); });
$("sbSearch").addEventListener("input", e => { sbQuery = e.target.value; renderSheetsView(); });
$("openSheetsBtn").addEventListener("click", () => { location.hash = "sheets"; });
// Dashboard "This Month" card -> Sheets & Bills, on this month's sheet (search cleared, so every bill shows)
function openThisMonthBills(){
  sbSheet = sbCurrentSheet();
  sbQuery = ""; $("sbSearch").value = "";
  location.hash = "sheets";
}
function openLastMonthBills(){
  sbSheet = sbLastSheet();
  sbQuery = ""; $("sbSearch").value = "";
  location.hash = "sheets";
}
$("kpiMonth").addEventListener("click", openThisMonthBills);
$("kpiMonth").addEventListener("keydown", e => {
  if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openThisMonthBills(); }
});
$("kpiLast").addEventListener("click", openLastMonthBills);
$("kpiLast").addEventListener("keydown", e => {
  if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openLastMonthBills(); }
});
$("sbBack").addEventListener("click", () => { location.hash = "dashboard"; });
 
// ---------------------------------------------------------------------------
// System Log: every Google sign-in is recorded by the Apps Script web app (system-log/Code.gs).
// The server decides who may see it: only the Sheet owner / Editors (the people who can use Add bill).
// Nothing is logged or shown while LOG_URL is empty.
// ---------------------------------------------------------------------------
const lgView = $("logView");
let logEditor = store.get(LOG_FLAG_KEY) === "1" ? true : store.get(LOG_FLAG_KEY) === "0" ? false : null;   // null = not known yet
let LOG_ROWS = null, lgLoading = false, lgError = "", lgTab = "recent", lgQuery = "";
const LK_TZ = "Asia/Colombo";
 
async function logCall(payload){
  if(!LOG_URL || !accessToken) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try{
    // text/plain keeps this a "simple" request (Apps Script web apps do not answer CORS preflights)
    const res = await fetch(LOG_URL, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ token: accessToken }, payload)),
      redirect: "follow", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: ctl.signal
    });
    return await res.json();
  }catch(e){ return null; }
  finally{ clearTimeout(timer); }
}
 
// What we record about the device: type, model (when the browser shares it), OS, browser, screen. No IP, no location.
async function deviceInfo(){
  const ua = navigator.userAgent || "", uad = navigator.userAgentData;
  let os = "Unknown", osVer = "", model = "", type = "Desktop", m;
  if(/iPhone/.test(ua)){ os = "iOS"; type = "Mobile"; model = "iPhone"; }
  else if(/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)){ os = "iPadOS"; type = "Tablet"; model = "iPad"; }
  else if(/Android/.test(ua)){ os = "Android"; type = /Mobile/.test(ua) ? "Mobile" : "Tablet";
    if((m = ua.match(/Android ([\d.]+)/))) osVer = m[1];
    if((m = ua.match(/Android [\d.]+; ([^;)]+)/)) && m[1].trim() !== "K") model = m[1].trim(); }
  else if(/Windows/.test(ua)) os = "Windows";
  else if(/CrOS/.test(ua)) os = "ChromeOS";
  else if(/Mac OS X/.test(ua)) os = "macOS";
  else if(/Linux/.test(ua)) os = "Linux";
  if((os === "iOS" || os === "iPadOS") && (m = ua.match(/OS (\d+)[_\d]*/))) osVer = m[1];
 
  let browser = "Unknown";
  const pick = (re, name) => { const x = ua.match(re); return x ? `${name} ${x[1]}` : name; };
  if(/Edg\//.test(ua)) browser = pick(/Edg\/(\d+)/, "Edge");
  else if(/OPR\//.test(ua)) browser = pick(/OPR\/(\d+)/, "Opera");
  else if(/SamsungBrowser/.test(ua)) browser = pick(/SamsungBrowser\/(\d+)/, "Samsung Internet");
  else if(/CriOS/.test(ua)) browser = pick(/CriOS\/(\d+)/, "Chrome");
  else if(/FxiOS|Firefox/.test(ua)) browser = pick(/(?:FxiOS|Firefox)\/(\d+)/, "Firefox");
  else if(/Chrome\//.test(ua)) browser = pick(/Chrome\/(\d+)/, "Chrome");
  else if(/Safari\//.test(ua)) browser = pick(/Version\/(\d+)/, "Safari");
 
  try{   // Chrome on Android shares the real model name on request
    if(uad && uad.getHighEntropyValues){
      const v = await uad.getHighEntropyValues(["model", "platformVersion"]);
      if(v.model) model = v.model;
      if(os === "Android" && v.platformVersion) osVer = String(v.platformVersion).split(".")[0];
    }
  }catch(e){}
 
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const osText = osVer ? `${os} ${osVer}` : os;
  return {
    label: model || (type === "Desktop" ? `${os} computer` : `${os} ${type.toLowerCase()}`),
    model, os: osText, browser, type,
    screen: `${screen.width}×${screen.height}`,
    display: standalone ? "Installed app" : "Browser",
    lang: navigator.language || "", tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || ""
  };
}
 
function applyLogAccess(){ $("logMenuBtn").hidden = logEditor !== true; }
function setLogAccess(r){
  if(r && r.ok){
    logEditor = !!r.isEditor;
    store.set(LOG_FLAG_KEY, logEditor ? "1" : "0");
  }
  applyLogAccess();
  if(!lgView.hidden) renderLogView();
}
// Time on the app: one ping every 30 s while the tab is visible and the person has touched the screen in the last 3 minutes.
let logSid = "", logStart = 0, logActiveMin = 0, logPingTimer = 0;
async function logSignIn(){
  if(!LOG_URL) return;
  logSid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  logStart = Date.now(); logActiveMin = 0;
  setLogAccess(await logCall({ action: "visit", device: await deviceInfo(), sid: logSid }));
  clearInterval(logPingTimer);
  logPingTimer = setInterval(logPing, 30000);
}
function logPing(){
  if(!LOG_URL || !accessToken || !logSid) return;
  if(document.visibilityState !== "visible" || Date.now() - lastActive > 180000) return;
  logActiveMin += 0.5;   // 30 s of real use per ping
  logCall({ action: "ping", sid: logSid, mins: Math.ceil(logActiveMin) });
}
async function checkLogAccess(){
  if(!LOG_URL || !accessToken || logEditor !== null) return;
  setLogAccess(await logCall({ action: "me" }));
}
 
async function loadLog(){
  if(lgLoading) return;
  lgLoading = true; lgError = "";
  $("lgRefresh").classList.add("spinning");
  renderLogView();
  const r = await logCall({ action: "list" });
  lgLoading = false;
  $("lgRefresh").classList.remove("spinning");
  if(!r) lgError = "Couldn't reach the log service. Check your internet, then tap Refresh.";
  else if(!r.ok) lgError = r.error === "forbidden" ? "forbidden"
    : /bad_token|wrong_client|no_token/.test(r.error || "") ? "Your Google session is not accepted by the log service. Sign out and sign in again."
    : "Log service error: " + (r.error || "unknown");
  else { LOG_ROWS = r.rows || []; setLogAccess(r); }
  if(lgError === "forbidden"){ logEditor = false; store.set(LOG_FLAG_KEY, "0"); applyLogAccess(); }
  renderLogView();
}
 
const lgDay = d => d.toLocaleDateString("en-CA", { timeZone: LK_TZ });
const lgClock = d => d.toLocaleTimeString("en-GB", { timeZone: LK_TZ, hour: "2-digit", minute: "2-digit", hour12: true });
const lgDate = d => d.toLocaleDateString("en-GB", { timeZone: LK_TZ, day: "2-digit", month: "short", year: "numeric" });
function lgAgo(d){
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if(s < 60) return "just now";
  if(s < 3600) return Math.floor(s / 60) + " min ago";
  if(s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
const LG_ICONS = {
  Mobile:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  Tablet:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  Desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>'
};
const lgTag = access => `<span class="lg-tag ${access === "Editor" ? "editor" : access === "Viewer" ? "viewer" : "none"}">${esc(access || "—")}</span>`;
const lgMins = m => !m ? "" : m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min" : "");
const lgDevLine = r => [r.model || r.device, r.os, r.browser, r.display].filter(Boolean).map(String).join(" · ");
 
function renderLogView(){
  const out = $("lgList"), stats = $("lgStats");
  const msg = t => { stats.innerHTML = ""; out.innerHTML = `<div class="card"><div class="empty">${t}</div></div>`; };
  if(!LOG_URL) return msg("System Log is not set up yet. Add the Apps Script web app URL as LOG_URL in app.js (steps in system-log/SETUP.md).");
  if(logEditor === false) return msg("Only people with Add bill (Editor) access can see the System Log.");
  if(logEditor === null) return msg("Checking access…");
  if(!LOG_ROWS){
    if(lgError && lgError !== "forbidden") return msg(esc(lgError));
    if(!lgLoading) loadLog();
    return msg("Loading the log…");
  }
 
  const rows = LOG_ROWS.map(r => Object.assign({}, r, { d: new Date(r.t) })).filter(r => !isNaN(r.d));   // newest first
  const people = new Map();
  for(const r of rows){
    const p = people.get(r.email);
    if(p){ p.count++; p.mins += r.mins || 0; } else people.set(r.email, { email: r.email, access: r.access, count: 1, mins: r.mins || 0, last: r });
  }
  const today = lgDay(new Date()), weekAgo = Date.now() - 7 * 86400000;
  const nToday = rows.filter(r => lgDay(r.d) === today).length, nWeek = rows.filter(r => r.d.getTime() >= weekAgo).length;
  const stat = (cls, k, v, s) => `<div class="sv-stat ${cls}"><div class="k">${k}</div><div class="v num">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ""}</div>`;
  stats.innerHTML = `<div class="sv-stats">` +
    stat("main", "Sign-ins logged", fmtInt(rows.length), rows[0] ? `Latest: ${lgDate(rows[0].d)}, ${lgClock(rows[0].d)}` : "Nothing logged yet") +
    stat("", "People", fmtInt(people.size)) + stat("", "Time used", lgMins(rows.reduce((t, r) => t + (r.mins || 0), 0)) || "—") + stat("", "Today", fmtInt(nToday)) + `</div>`;
 
  const q = lgQuery.trim().toLowerCase();
  const hay = r => [r.email, r.device, r.model, r.os, r.browser, r.type, r.display, r.access].join(" ").toLowerCase();
  const note = lgError && lgError !== "forbidden" ? `<div class="lg-note">${esc(lgError)}</div>` : "";
  let body = "";
  if(lgTab === "people"){
    const list = [...people.values()].filter(p => !q || hay(p.last).includes(q));
    body = list.map(p => `<div class="lg-row"><div class="lg-ic">${esc((p.email[0] || "?").toUpperCase())}</div>` +
      `<div><div class="lg-email">${esc(p.email)}${lgTag(p.access)}</div><div class="lg-dev">${fmtInt(p.count)} sign-in${p.count === 1 ? "" : "s"} · ${esc(lgDevLine(p.last))}</div>${p.mins ? `<div class="lg-use">Total time ${lgMins(p.mins)}</div>` : ""}</div>` +
      `<div class="lg-when"><div class="lg-time">${lgClock(p.last.d)}</div><div class="lg-date">${lgDate(p.last.d)} · ${lgAgo(p.last.d)}</div></div></div>`).join("");
  } else {
    const list = rows.filter(r => !q || hay(r).includes(q));
    body = list.map(r => `<div class="lg-row"><div class="lg-ic" title="${esc(r.type || "")}">${LG_ICONS[r.type] || LG_ICONS.Desktop}</div>` +
      `<div><div class="lg-email">${esc(r.email)}${lgTag(r.access)}</div><div class="lg-dev">${esc(lgDevLine(r))}${r.screen ? " · " + esc(r.screen) : ""}</div>${r.mins ? `<div class="lg-use">Used ${lgMins(r.mins)}</div>` : ""}</div>` +
      `<div class="lg-when"><div class="lg-time">${lgClock(r.d)}</div><div class="lg-date">${lgDate(r.d)} · ${lgAgo(r.d)}</div></div></div>`).join("");
  }
  const empty = rows.length ? "Nothing matches your search." : "No sign-ins logged yet. They appear here after people sign in with Google.";
  out.innerHTML = note + `<section class="card" aria-label="${lgTab === "people" ? "People" : "Sign-ins"}">${body || `<div class="empty">${empty}</div>`}</section>`;
}
 
$("logMenuBtn").addEventListener("click", () => { toggleMenu(false); location.hash = "log"; });
$("lgBack").addEventListener("click", () => { location.hash = "dashboard"; });
$("lgRefresh").addEventListener("click", () => { if(logEditor === true) loadLog(); });
$("lgSearch").addEventListener("input", e => { lgQuery = e.target.value; renderLogView(); });
$("lgSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  lgTab = b.dataset.t;
  document.querySelectorAll("#lgSeg button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
  renderLogView();
});
applyLogAccess();
 
function route(){
  const hash = location.hash;
  if(typeof cqCloseModal === "function") cqCloseModal();
  if(hash === "#cheques" && !isOwner()){
    if(currentUserEmail){ location.replace("#dashboard"); return; }   // other account: never show
  }
  const chq = hash === "#cheques" && isOwner();
  const mid = chq ? "cheque" : "purchase", menuChanged = lastMenu && lastMenu !== mid;
  if(chq && (menuChanged || !cqSeen)){ cqPlay = true; cqSeen = true; }
  chqView.hidden = !chq; document.body.classList.toggle("on-cheque", chq);
  dashView.hidden = chq || hash === "#suppliers" || hash === "#sheets" || hash === "#log" || hash === "#cheques";
  svView.hidden = hash !== "#suppliers";
  sbView.hidden = hash !== "#sheets";
  lgView.hidden = hash !== "#log";
  // the sticky sheet tabs sit right under the header, whatever its height
  const hd = document.querySelector("header");
  if(hd) document.documentElement.style.setProperty("--hdr", hd.offsetHeight + "px");
  if(hash === "#suppliers") renderSupplierView();
  if(hash === "#sheets") renderSheetsView();
  if(hash === "#log") renderLogView();
  if(chq){ renderCheques(); loadCheques(false); }
  applyMenus();
  if(menuChanged){
    const el = chq ? chqView : [dashView, svView, sbView, lgView].find(x => x && !x.hidden);
    if(el){ el.classList.remove("pg-r", "pg-l"); void el.offsetWidth; el.classList.add(chq ? "pg-r" : "pg-l"); setTimeout(() => el.classList.remove("pg-r", "pg-l"), 500); }
  }
  lastMenu = mid;
  window.scrollTo(0, 0);
}
 
// ---------------------------------------------------------------------------
// Bottom menus (config-driven: add an entry here for a future menu)
// ---------------------------------------------------------------------------
const CHQ_SHEET_ID = "1RTjAwTUZ9wV-Kmnskx4TYJWI10p8u3g6Bc5XQiKWvN8";
// Who sees the Cheque menu. Empty list = every signed-in user. Add emails to restrict, e.g. ["hanoonelite@gmail.com"].
const CHQ_ALLOWED = [];
const CHQ_SKIP = ["chq rgstr", "date summary"];
const isOwner = () => !CHQ_ALLOWED.length || CHQ_ALLOWED.includes((currentUserEmail || "").trim().toLowerCase());
const MENUS = [
  { id: "purchase", label: "Purchase", home: "#dashboard", hashes: ["", "#dashboard", "#suppliers", "#sheets", "#log"], show: () => true,
    svg: `<svg class="nav-ic" viewBox="0 0 48 48" aria-hidden="true"><defs>
<linearGradient id="pbT" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE29A"/><stop offset="1" stop-color="#F5B33B"/></linearGradient>
<linearGradient id="pbL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6A93A"/><stop offset="1" stop-color="#E07F1B"/></linearGradient>
<linearGradient id="pbR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D9801E"/><stop offset="1" stop-color="#B85F0F"/></linearGradient>
<linearGradient id="pbTp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C8CFF"/><stop offset="1" stop-color="#3D4FE0"/></linearGradient></defs>
<ellipse cx="24" cy="44.5" rx="14" ry="2.4" fill="#000" opacity=".28"/>
<polygon points="8,16 24,24 24,42 8,34" fill="url(#pbL)"/><polygon points="24,24 40,16 40,34 24,42" fill="url(#pbR)"/><polygon points="24,8 40,16 24,24 8,16" fill="url(#pbT)"/>
<polygon points="29,10.5 35,13.5 19,21.5 13,18.5" fill="url(#pbTp)"/><polygon points="13,18.5 19,21.5 19,39.5 13,36.5" fill="#4457E8" opacity=".92"/>
<polyline points="8,16 24,8 40,16" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".9" stroke-linejoin="round"/>
<path d="M27 30.5l9-4.6" stroke="#fff" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/><path d="M27 33.5l9-4.6" stroke="#fff" stroke-opacity=".3" stroke-width="1.4" stroke-linecap="round"/></svg>` },
  { id: "cheque", label: "Cheque", home: "#cheques", hashes: ["#cheques"], show: isOwner,
    svg: `<svg class="nav-ic" viewBox="0 0 48 48" aria-hidden="true"><defs>
<linearGradient id="ckB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F6B4F"/><stop offset="1" stop-color="#143D2B"/></linearGradient>
<linearGradient id="ckG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE9A3"/><stop offset=".55" stop-color="#E8B730"/><stop offset="1" stop-color="#B8860B"/></linearGradient></defs>
<ellipse cx="24" cy="44.5" rx="16" ry="2.2" fill="#000" opacity=".28"/>
<rect x="4" y="15" width="40" height="25" rx="4" fill="#0C2A1D"/><rect x="4" y="12" width="40" height="25" rx="4" fill="url(#ckB)"/>
<rect x="4.6" y="12.6" width="38.8" height="23.8" rx="3.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1"/>
<rect x="8" y="16" width="5" height="17" rx="1.2" fill="#C9D3CE" opacity=".85"/>
<circle cx="21" cy="20" r="4.4" fill="url(#ckG)"/><circle cx="21" cy="20" r="2.7" fill="none" stroke="#9A6F08" stroke-opacity=".55" stroke-width=".8"/>
<path d="M17 28h14M17 31.5h9" stroke="#6FA487" stroke-width="1.7" stroke-linecap="round" opacity=".85"/>
<path d="M30 33c1.6-4 3-4.4 3.6-1.6.5 2 1.6 1.7 3-.9" fill="none" stroke="#E9F2EE" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
<g transform="translate(33 17) rotate(42)"><rect x="-2.3" y="-14" width="4.6" height="6" rx="1.6" fill="url(#ckG)"/><rect x="-2.3" y="-8.5" width="4.6" height="15" rx="1.2" fill="#E9EDE8"/><rect x="0.6" y="-8.5" width="1.7" height="15" fill="#9AA8A0" opacity=".55"/><polygon points="-2.3,6.5 2.3,6.5 0,12" fill="url(#ckG)"/></g></svg>` }
];
const visibleMenus = () => MENUS.filter(m => m.show());
function menuOf(hash){ return MENUS.find(m => m.hashes.includes(hash)) || MENUS[0]; }
function applyMenus(){
  const nav = $("bottomNav"), vis = visibleMenus();
  const on = vis.length > 0 && document.body.classList.contains("authed");
  nav.hidden = !on;
  document.body.classList.toggle("has-nav", on);
  const sig = vis.map(m => m.id).join();
  if(nav.dataset.sig !== sig){
    nav.dataset.sig = sig;
    nav.innerHTML = '<i class="nav-ind" aria-hidden="true"></i>' + vis.map(m => `<button type="button" data-m="${m.id}">${m.svg}<span>${m.label}</span></button>`).join("");
  }
  const cur = menuOf(location.hash).id, idx = Math.max(0, vis.findIndex(m => m.id === cur));
  nav.dataset.n = vis.length; nav.style.setProperty("--n", vis.length); nav.style.setProperty("--i", idx);
  nav.querySelectorAll("button").forEach(x => x.setAttribute("aria-current", String(x.dataset.m === cur)));
}
$("bottomNav").addEventListener("click", e => {
  const b = e.target.closest("button[data-m]"); if(!b) return;
  const m = MENUS.find(x => x.id === b.dataset.m);
  if(m && menuOf(location.hash).id !== m.id) location.hash = m.home.slice(1);
  else window.scrollTo(0, 0);
});

// ---------------------------------------------------------------------------
// Cheque module
// ---------------------------------------------------------------------------
let CHQ = null, chqLoading = false, chqTab = "overview", chqErr = "";
const chqView = $("chequeView");
const DAY = 86400000;
const todayMs = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); };
const fmtD = ms => ms == null ? "—" : new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const fmtDW = ms => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
const isoToMs = s => { if(!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const msToIso = ms => toLocalISODate(new Date(ms));
const numOf = v => typeof v === "number" && isFinite(v) ? v : null;
function chqDate(v){
  if(typeof v === "number") return serialToMs(v);
  if(typeof v === "string"){
    const m = v.trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if(m){ const d = new Date(+m[3], +m[2] - 1, +m[1]); if(d.getMonth() === +m[2] - 1) return d.getTime(); }
  }
  return null;
}
const txt = v => v == null ? "" : String(v).trim();
const MONTHS_L = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function tabMonth(name){
  const m = name.toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{4})/);
  return m && m[1] in MONTHS_L ? { y: +m[2], m: MONTHS_L[m[1]] } : null;
}
function bankFromTitle(t){
  t = t.toLowerCase();
  if(t.includes("amana")) return "Amana";
  if(t.includes("ndb")) return "NDB";
  if(t.includes("commercial") || t.includes("com bank")) return "Commercial";
  return t.replace(/chqs?/g, "").trim() || "Other";
}

// Safety net for a sheet whose locale read d/m as m/d: a numeric cheque date that falls outside the
// tab's month, but lands inside it when day and month are swapped, is swapped back.
function chqDateFix(v, tm){
  const ms = chqDate(v);
  if(ms == null || typeof v !== "number" || !tm) return ms;
  const o = new Date(ms);
  if(o.getFullYear() === tm.y && o.getMonth() === tm.m) return ms;
  const dA = o.getDate(), mA = o.getMonth() + 1;
  if(dA <= 12 && dA !== mA){
    const sw = new Date(o.getFullYear(), dA - 1, mA);
    if(sw.getFullYear() === tm.y && sw.getMonth() === tm.m) return sw.getTime();
  }
  return ms;
}
function parseChequeTab(name, rows, out, blocks){
  const tm = tabMonth(name);
  [[0, "Commercial"], [10, "Amana"]].forEach(([off, def]) => {
    let bank = def, cur = null;
    rows.forEach((r, i) => {
      const c = j => r[off + j];
      const t0 = txt(c(0));
      if(t0 && /chqs?\b/i.test(t0) && isNaN(+t0)){          // block title row
        bank = bankFromTitle(t0);
        cur = { tab: name, bank, total: numOf(c(8)), sum: 0, n: 0 };
        blocks.push(cur);
        return;
      }
      if(/^supplier/i.test(txt(c(1)))) return;                // header row
      const sup = txt(c(1)), amt = numOf(c(8)), no = txt(c(5));
      if(!sup && !no && !amt) return;
      if(!cur){ cur = { tab: name, bank, total: null, sum: 0, n: 0 }; blocks.push(cur); }
      const ty = txt(c(6));
      const rec = { id: out.length, ct: txt(c(2)), tab: name, tm, bank, s: sup || "(No name)", no, ty, cash: /cash/i.test(ty),
        d: chqDateFix(c(7), tm), w: chqDate(c(4)), a: amt, bal: numOf(c(3)), row: i + 1 };
      out.push(rec); cur.sum += amt || 0; cur.n++;
    });
  });
}

// ---- Chq Rgstr: invoices, credit terms and cheque status, grouped per supplier settlement ----
function regNum(v){
  if(typeof v === "number") return isFinite(v) ? v : null;
  const t = txt(v).replace(/^rs\.?/i, "").replace(/[,\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? +t : null;
}
const bankKey = b => { b = (b || "").toLowerCase(); return b.includes("com") ? "com" : b.includes("ama") ? "ama" : b.includes("ndb") ? "ndb" : b.slice(0, 3); };
const normName = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function parseRegister(rows){
  const groups = [], byNo = new Map(); let cur = null;
  rows.forEach((r, i) => {
    if(i < 2) return;
    const sup = txt(r[2]), inv = txt(r[7]), ia = regNum(r[8]), cno = txt(r[12]);
    if(sup){ cur = { sup, inv: [], chq: [], row: i + 1 }; groups.push(cur); }
    if(!cur) return;
    if(inv || ia != null) cur.inv.push({ no: inv, date: chqDate(r[4]), pm: txt(r[5]), terms: txt(r[6]), amt: ia, item: txt(r[3]), row: i + 1 });
    if(cno){
      const c = { no: cno, bank: txt(r[11]), amt: regNum(r[13]), date: chqDate(r[14]), written: chqDate(r[10]), ws: txt(r[9]), gs: txt(r[15]), rs: txt(r[16]), rem: txt(r[17]), row: i + 1, g: cur };
      cur.chq.push(c);
      if(!byNo.has(cno)) byNo.set(cno, []); byNo.get(cno).push(c);
    }
  });
  return { groups, byNo };
}
function matchRegister(r){
  const reg = CHQ && CHQ.reg; if(!reg || !r.no) return null;
  let c = reg.byNo.get(String(r.no)); if(!c || !c.length) return null;
  if(c.length > 1){
    const b = c.filter(x => bankKey(x.bank) === bankKey(r.bank)); if(b.length) c = b;
  }
  if(c.length > 1){
    const n = normName(r.s), s = c.filter(x => { const m = normName(x.g.sup); return m && n && (m.includes(n) || n.includes(m)); }); if(s.length) c = s;
  }
  if(c.length > 1){ const a = c.filter(x => x.amt === r.a); if(a.length) c = a; }
  return c[0];
}
function cqRegisterHtml(r){
  if(!CHQ.reg) return "";
  const m = matchRegister(r);
  if(!m) return `<div class="md-sec"><div class="md-sh"><span>Invoices · Chq Rgstr</span></div><p class="cq-note">No matching entry for cheque #${esc(r.no || "-")} in the Chq Rgstr tab.</p></div>`;
  const g = m.g, t0 = todayMs();
  const termsList = [...new Set(g.inv.map(x => x.terms).filter(Boolean))];
  const invTot = g.inv.reduce((a, x) => a + (x.amt || 0), 0), chqTot = g.chq.reduce((a, x) => a + (x.amt || 0), 0);
  const days = t => { const k = parseInt(t, 10); return isFinite(k) ? k : null; };
  const invHtml = g.inv.map(x => {
    const dd = x.date != null && days(x.terms) != null ? x.date + days(x.terms) * DAY : null;
    const late = dd != null && r.d != null ? Math.round((r.d - dd) / DAY) : null;
    return `<div class="md-inv"><div class="md-inv-t"><b>${esc(x.no || "No invoice no.")}</b><strong>${rs(x.amt)}</strong></div>
      <div class="md-inv-s">${x.date != null ? "Invoice " + fmtD(x.date) : "No invoice date"}</div>
      ${dd != null ? `<div class="md-inv-d">Due ${fmtD(dd)}${late != null ? ` <span class="${late > 0 ? "late" : "ok"}">${late > 0 ? late + " days after due" : late === 0 ? "on due date" : Math.abs(late) + " days before due"}</span>` : ""}</div>` : ""}</div>`;
  }).join("");
  const others = g.chq.filter(x => x !== m);
  const rec = no => CHQ.recs.find(z => z.no === String(no));
  const st = x => [x.ws && "Written " + x.ws, x.gs && "Given " + x.gs, x.rs && "Realized " + x.rs].filter(Boolean).join(" · ");
  return `<div class="md-sec"><div class="md-sh"><span>Invoices · Chq Rgstr</span><span>${g.inv.length} · ${rs(invTot)}</span></div>
    ${termsList.length ? `<div class="md-terms"><span>Credit terms</span><b>${esc(termsList.join(" / "))}</b></div>` : ""}
    ${invHtml || '<p class="cq-note">No invoice lines in the register for this cheque.</p>'}</div>`;
}
async function loadCheques(force){
  if(chqLoading) return;
  if(!accessToken) return;   // not signed in yet: enterDashboard() starts the load after sign-in
  if(CHQ && !force) return;
  chqLoading = true; chqErr = ""; renderCheques();
  try{
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${CHQ_SHEET_ID}`;
    const meta = await apiGet(`${base}?fields=sheets.properties.title`);
    const tabs = meta.sheets.map(s => s.properties.title).filter(n => !CHQ_SKIP.includes(n.trim().toLowerCase()) && tabMonth(n));
    const regTab = (meta.sheets.map(x => x.properties.title).find(n => n.trim().toLowerCase() === "chq rgstr")) || null;
    const qs = tabs.map(n => "ranges=" + encodeURIComponent(`'${n}'!A:S`)).concat(regTab ? ["ranges=" + encodeURIComponent(`'${regTab}'!A:R`)] : []).join("&");
    const data = await apiGet(`${base}/values:batchGet?${qs}&${API_OPTS}&fields=valueRanges(values)`);
    const recs = [], blocks = [];
    data.valueRanges.slice(0, tabs.length).forEach((vr, i) => parseChequeTab(tabs[i], vr.values || [], recs, blocks));
    recs.forEach(r => { r.dd = r.d; });
    let reg = null;
    try{ if(regTab && data.valueRanges[tabs.length]) reg = parseRegister(data.valueRanges[tabs.length].values || []); }catch(e){ reg = null; }
    CHQ = { recs, blocks, tabs, reg, regTab, at: Date.now(), banks: [...new Set(recs.map(r => r.bank))] };
  }catch(e){
    chqErr = e.status === 403 || e.status === 404
      ? "This Google account doesn't have access to the cheque sheet. Ask the owner to share it, then sign in again."
      : "Couldn't load the cheque sheet (" + (e.message || "network") + ").";
  }
  chqLoading = false; renderCheques();
}

const sumA = a => a.reduce((s, r) => s + (r.a || 0), 0);
const byDate = list => { const m = new Map(); list.forEach(r => { if(r.d == null) return; if(!m.has(r.d)) m.set(r.d, []); m.get(r.d).push(r); }); return [...m.entries()].sort((a, b) => a[0] - b[0]); };
const short = v => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "K" : String(Math.round(v));
const rs = n => n == null ? "—" : (Number.isInteger(n) ? "Rs. " + nf0.format(n) : fmtMoney(n));
const stat = (k, v, s, main) => `<div class="sv-stat${main ? " main" : ""}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
const relDay = (d, t0) => d === t0 ? "Today" : d === t0 + DAY ? "Tomorrow" : d > t0 ? "in " + Math.round((d - t0) / DAY) + " days" : Math.round((t0 - d) / DAY) + " days ago";
const bankTag = b => `<span class="cq-tag cq-${esc(b.toLowerCase().slice(0, 3))}">${esc(b)}</span>`;
function cqRow(r){
  return `<button type="button" class="cq-row" data-rid="${r.id}"><div class="cq-amt">${rs(r.a)}</div><div class="cq-main"><div class="cq-sup">${esc(r.s)}</div>
    <div class="cq-sub">${bankTag(r.bank)}${r.cash ? '<span class="cq-tag cq-cash">Cash</span>' : ""}<span>${r.no ? "#" + esc(r.no) : "No cheque no."}</span></div></div><svg class="cq-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`;
}
function cqDayCards(days, limit, t0){
  let shown = 0, html = "";
  for(const [d, rs_] of days){
    if(shown >= limit){ html += `<p class="cq-more">Showing the first ${limit} cheques. Narrow the filters to see the rest.</p>`; break; }
    const l = rs_.slice().sort((x, y) => (y.a || 0) - (x.a || 0));
    const dt = new Date(d);
    html += `<section class="cq-day${d < t0 ? " past" : ""}${d === t0 ? " today" : ""}"><div class="cq-dayhead"><div class="cq-dbadge"><b>${dt.getDate()}</b><span>${MON_S[dt.getMonth()]}</span></div><div class="cq-dinfo"><b>${dt.toLocaleDateString("en-GB", { weekday: "long" })}</b><em>${relDay(d, t0)} · ${l.length} cheque${l.length > 1 ? "s" : ""}</em></div><div class="cq-daytot"><span>Day total</span><b>${rs(sumA(l))}</b></div></div>${l.map(cqRow).join("")}</section>`;
    shown += l.length;
  }
  return html;
}
const cqPastOpenDef = () => false; let cqPastOpen = null;
function cqResultsHtml(list){
  const t0 = todayMs(), dated = list.filter(r => r.d != null), nodate = list.filter(r => r.d == null);
  const up = dated.filter(r => r.d >= t0), past = dated.filter(r => r.d < t0);
  if(!list.length) return '<div class="cq-empty"><b>No cheques found</b><span>Try a wider date range or clear the filters.</span></div>';
  const open = cqPastOpen == null ? !up.length : cqPastOpen;
  let h = "";
  if(up.length) h += `<div class="cq-sech up"><span class="cq-dot"></span><div><b>Upcoming</b><em>Nearest payment first</em></div><div class="cq-sechv">${rs(sumA(up))}<em>${up.length} cheque${up.length === 1 ? "" : "s"}</em></div></div>${cqDayCards(byDate(up), 200, t0)}`;
  if(past.length) h += `<button type="button" class="cq-sech past" data-past aria-expanded="${open}"><span class="cq-dot"></span><div><b>Passed</b><em>Most recent first</em></div><div class="cq-sechv">${rs(sumA(past))}<em>${past.length} cheque${past.length === 1 ? "" : "s"}</em></div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>${open ? cqDayCards(byDate(past).reverse(), 200, t0) : ""}`;
  if(nodate.length) h += `<div class="cq-sech"><span class="cq-dot"></span><div><b>No date</b><em>Fix in the sheet</em></div><div class="cq-sechv">${rs(sumA(nodate))}<em>${nodate.length} cheque${nodate.length === 1 ? "" : "s"}</em></div></div><section class="cq-day">${nodate.map(cqRow).join("")}</section>`;
  return h;
}
function cqPills(){
  const f = cqF, p = [];
  if(f.from || f.to) p.push(["range", (f.from ? fmtD(isoToMs(f.from)) : "Start") + " → " + (f.to ? fmtD(isoToMs(f.to)) : "End")]);
  if(f.min !== "" || f.max !== "") p.push(["amt", "Rs. " + (f.min !== "" ? nf0.format(+f.min) : "0") + " – " + (f.max !== "" ? nf0.format(+f.max) : "any")]);
  if(f.bank) p.push(["bank", f.bank]);
  if(f.q.trim()) p.push(["q", "“" + f.q.trim() + "”"]);
  return p.length ? `<div class="cq-pills">${p.map(([k, l]) => `<button type="button" class="cq-pill" data-rm="${k}" aria-label="Remove filter ${esc(l)}">${esc(l)}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`).join("")}</div>` : "";
}
const BANK_THEME = { com: { n: "Commercial Bank", m: "CB" }, ama: { n: "Amana Bank", m: "AB" }, ndb: { n: "NDB Bank", m: "NDB" } };
let cqSel = { 2026: new Date().getFullYear() === 2026 ? new Date().getMonth() : 0, 2027: 0 }, cqYear = new Date().getFullYear() >= 2027 ? 2027 : 2026;
const MON_S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_L = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function cqYearData(y){
  const v = Array(12).fill(0), c = Array(12).fill(0);
  CHQ.recs.forEach(r => { if(r.d == null) return; const d = new Date(r.d); if(d.getFullYear() === y){ v[d.getMonth()] += r.a || 0; c[d.getMonth()]++; } });
  return { v, c };
}
function cqDetail(y){
  const { v, c } = cqYearData(y), m = cqSel[y], tot = v.reduce((a, b) => a + b, 0);
  const mine = CHQ.recs.filter(r => r.d != null && new Date(r.d).getFullYear() === y && new Date(r.d).getMonth() === m);
  const split = CHQ.banks.map(b => ({ b, v: sumA(mine.filter(r => r.bank === b)) })).filter(x => x.v);
  return `<div class="cq-dm">${MON_L[m]} ${y}</div><div class="cq-dv" data-n="${v[m]}">${rs(v[m])}</div><div class="cq-dc2">${c[m] ? `<button type="button" class="cq-link" data-mfind="${y}-${m}">${c[m]} cheque${c[m] === 1 ? "" : "s"} ›</button>` : "No cheques"}${v[m] ? ` · ${Math.round(v[m] / tot * 100)}% of ${y}` : ""}</div>
    ${split.length ? `<div class="cq-split">${split.map(x => `<span>${bankTag(x.b)}<b>${rs(x.v)}</b></span>`).join("")}</div>` : ""}`;
}
function cqYearCard(){
  const y = cqYear, { v, c } = cqYearData(y), gmax = Math.max(...[2026, 2027].flatMap(Y => cqYearData(Y).v), 1), m = cqSel[y], tot = v.reduce((a, b) => a + b, 0), nowD = new Date();
  const bars = v.map((x, i) => `<button type="button" class="cq-bar${i === m ? " sel" : ""}${y === nowD.getFullYear() && i === nowD.getMonth() ? " now" : ""}${x ? "" : " zero"}" style="--k:${i}" data-y="${y}" data-m="${i}" aria-pressed="${i === m}" aria-label="${MON_L[i]} ${y}: ${rs(x)}"><i style="height:${x ? Math.max(5, x / gmax * 100) : 2}%"></i><span>${MON_S[i]}</span></button>`).join("");
  return `<section class="cq-card cq-year" id="cqYr"><div class="cq-yhead"><div><h3>Cheques by month</h3><p class="cq-note">Tap a bar for the full amount</p></div>
    <div class="cq-ysw" role="group" aria-label="Year"><i style="transform:translateX(${y === 2027 ? 100 : 0}%)"></i><button type="button" data-yr="2026" aria-pressed="${y === 2026}">2026</button><button type="button" data-yr="2027" aria-pressed="${y === 2027}">2027</button></div></div>
    <div class="cq-ytotrow"><span>${y} total</span><b data-n="${tot}">${rs(tot)}</b></div>
    <div class="cq-bars">${bars}</div><div class="cq-detail">${cqDetail(y)}</div></section>`;
}
function cqYearRefresh(replay){
  const card = $("cqYr"); if(!card) return;
  const t = document.createElement("div"); t.innerHTML = cqYearCard(); const n = t.firstElementChild;
  card.querySelector(".cq-ysw i").style.transform = n.querySelector(".cq-ysw i").style.transform;
  const nb = n.querySelectorAll(".cq-ysw button"); card.querySelectorAll(".cq-ysw button").forEach((b, i) => b.setAttribute("aria-pressed", nb[i].getAttribute("aria-pressed")));
  card.querySelector(".cq-ytotrow").innerHTML = n.querySelector(".cq-ytotrow").innerHTML;
  const bars = card.querySelector(".cq-bars"); bars.innerHTML = n.querySelector(".cq-bars").innerHTML;
  card.querySelector(".cq-detail").innerHTML = n.querySelector(".cq-detail").innerHTML;
  if(replay){ bars.classList.remove("regrow"); void bars.offsetWidth; bars.classList.add("regrow"); }
  countUp(card);
}
function countUp(root){
  if(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("[data-n]").forEach(el => {
    const to = +el.dataset.n; if(!to) return;
    const t0 = performance.now(), D = 850;
    (function f(t){ const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3); el.textContent = p < 1 ? rs(Math.round(to * e)) : rs(to); if(p < 1) requestAnimationFrame(f); })(t0);
  });
}
let cqPlay = false, cqSeen = false, lastMenu = null;
function cqIntro(){
  const b = $("cqBody");
  [...b.children].forEach((el, i) => el.style.setProperty("--i", i));
  b.classList.remove("anim"); void b.offsetWidth; b.classList.add("anim");
  countUp(b); clearTimeout(cqIntro.t); cqIntro.t = setTimeout(() => b.classList.remove("anim"), 1800);
}
function cqHero(mname, month, left){
  const tot = sumA(month), rest = sumA(left), done = tot - rest, pct = tot > 0 ? Math.round(done / tot * 100) : 0, C = 2 * Math.PI * 34;
  const dim = new Date(new Date(todayMs()).getFullYear(), new Date(todayMs()).getMonth() + 1, 0).getDate(), day = new Date(todayMs()).getDate();
  return `<div class="cq-hero"><div class="cq-hr"><svg viewBox="0 0 80 80" aria-hidden="true"><defs><linearGradient id="cqHg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE29A"/><stop offset="1" stop-color="#E2B43A"/></linearGradient></defs><circle cx="40" cy="40" r="34" class="cq-hrt"/><circle cx="40" cy="40" r="34" class="cq-hrp" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/></svg><b>${pct}%</b><small>cleared</small></div>
    <div class="cq-hm"><span>${esc(mname)}</span><strong><i data-n="${tot}">${rs(tot)}</i></strong><em>${month.length} cheques · day ${day} of ${dim}</em></div>
    <div class="cq-hf"><div class="p"><u></u><span>Passed</span><b>${rs(done)}</b></div><div class="u"><u></u><span>Upcoming</span><b>${rs(rest)}</b></div></div></div>`;
}
function cqOverview(){
  const { recs } = CHQ, t0 = todayMs(), n = new Date(t0);
  const ms = new Date(n.getFullYear(), n.getMonth(), 1).getTime(), me = new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime();
  const month = recs.filter(r => r.d >= ms && r.d < me), up = recs.filter(r => r.d >= t0);
  const w7 = recs.filter(r => r.d >= t0 && r.d < t0 + 7 * DAY), today = recs.filter(r => r.d === t0);
  const left = month.filter(r => r.d >= t0);
  const bankCards = CHQ.banks.map(b => {
    const mine = recs.filter(r => r.bank === b), m = mine.filter(r => r.d >= ms && r.d < me), u = mine.filter(r => r.d >= t0), w = mine.filter(r => r.d >= t0 && r.d < t0 + 7 * DAY);
    const mn = n.toLocaleDateString("en-GB", { month: "long" });
    const th = BANK_THEME[b.toLowerCase().slice(0, 3)] || { n: b, m: b.slice(0, 2).toUpperCase() };
    return `<button type="button" class="bk bk-${esc(b.toLowerCase().slice(0, 3))}" data-bank="${esc(b)}"><span class="bk-art" aria-hidden="true"></span>
      <span class="bk-top"><span class="bk-mono lg-${esc(b.toLowerCase().slice(0, 3))}" role="img" aria-label="${esc(th.n)}">${th.m}</span><span class="bk-name">${esc(th.n)}</span><span class="bk-go">View ›</span></span>
      <span class="bk-amt" data-n="${sumA(m)}">${rs(sumA(m))}</span><span class="bk-sub">${m.length} cheques in ${n.toLocaleDateString("en-GB", { month: "long" })}</span>
      <span class="bk-foot"><span>${mn} passed<b>${rs(sumA(m.filter(r => r.d < t0)))}</b></span><span>${mn} upcoming<b>${rs(sumA(m.filter(r => r.d >= t0)))}</b></span></span></button>`;
  }).join("");
  const days = byDate(up).slice(0, 8), dmx = Math.max(...days.map(([, r]) => sumA(r)), 1);
  const sup = new Map(); month.forEach(r => sup.set(r.s, (sup.get(r.s) || 0) + (r.a || 0)));
  const top = [...sup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6), tmx = top.length ? top[0][1] : 1;
  const mname = n.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return `<div class="cq-ov"><div class="sv-stats cq-stats">
    ${cqHero(mname, month, left)}
    ${stat("Today", fmtCompact(sumA(today)), today.length + " cheques")}
    ${stat("Next 7 days", fmtCompact(sumA(w7)), w7.length + " cheques")}
    ${stat("All upcoming", fmtCompact(sumA(up)), up.length + " cheques")}</div>
  <div class="bk-grid">${bankCards}</div>
  <section class="cq-card cq-days"><h3>Upcoming cheque days</h3><p class="cq-note">Tap a day to see its cheques</p>${days.map(([d, r]) => `<button type="button" class="cq-bl" data-go="${msToIso(d)}"><span class="cq-bl-l"><b>${fmtDW(d)}</b><em>${relDay(d, t0)} · ${r.length}</em></span><span class="cq-bl-v">${rs(sumA(r))}</span><i style="width:${sumA(r) / dmx * 100}%"></i></button>`).join("") || '<p class="cq-note">No upcoming cheques.</p>'}</section>
  <div class="cq-yr">${cqYearCard()}</div>
  <section class="cq-card cq-sup"><h3>Top suppliers this month</h3>${top.map(([s, v]) => `<div class="cq-bl static"><span class="cq-bl-l"><b>${esc(s)}</b></span><span class="cq-bl-v">${rs(v)}</span><i style="width:${v / tmx * 100}%"></i></div>`).join("") || '<p class="cq-note">Nothing this month.</p>'}</section></div>`;
}

let cqF = { from: "", to: "", min: "", max: "", bank: "", q: "", chip: "all" }, cqOpen = false;
const cqActive = () => ["from", "to", "min", "max", "bank"].filter(k => cqF[k] !== "").length;
function cqFinder(){
  const bankOpts = '<option value="">All banks</option>' + CHQ.banks.map(b => `<option value="${esc(b)}"${cqF.bank === b ? " selected" : ""}>${esc(b)}</option>`).join("");
  const chips = [["all", "All"], ["upcoming", "Upcoming"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["next", "Next month"], ["custom", "Custom"]];
  return `<div class="cq-search"><input type="search" id="cqQ" class="cq-in" placeholder="Search supplier / no." value="${esc(cqF.q)}" aria-label="Search">
    <select id="cqBank" class="cq-in cq-banksel" aria-label="Bank">${bankOpts}</select></div>
  <div class="cq-chips" id="cqChips" role="group" aria-label="Date range">${chips.map(([k, l]) => `<button type="button" class="chip${cqF.chip === k ? " active" : ""}" data-c="${k}">${l}</button>`).join("")}</div>
  ${cqF.chip === "custom" ? `<div class="cq-custom"><label class="field"><span class="field-label">From date</span><input type="date" id="cqFrom" class="cq-in" value="${cqF.from}"></label><label class="field"><span class="field-label">To date</span><input type="date" id="cqTo" class="cq-in" value="${cqF.to}"></label></div>` : ""}
  <div id="cqRes"></div>`;
}
function cqApplyChip(k){
  const t0 = todayMs(), n = new Date(t0), set = (a, b) => { cqF.from = a == null ? "" : msToIso(a); cqF.to = b == null ? "" : msToIso(b); };
  if(k === "today") set(t0, t0);
  else if(k === "week"){ const s = t0 - ((n.getDay() + 6) % 7) * DAY; set(s, s + 6 * DAY); }
  else if(k === "month") set(new Date(n.getFullYear(), n.getMonth(), 1).getTime(), new Date(n.getFullYear(), n.getMonth() + 1, 0).getTime());
  else if(k === "next") set(new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime(), new Date(n.getFullYear(), n.getMonth() + 2, 0).getTime());
  else if(k === "upcoming") set(t0, null);
  else if(k === "custom"){ if(!cqF.from && !cqF.to) set(new Date(n.getFullYear(), n.getMonth(), 1).getTime(), new Date(n.getFullYear(), n.getMonth() + 1, 0).getTime()); }
  else set(null, null);
  cqF.chip = k;
}
function cqFilterList(){
  const f = cqF, from = isoToMs(f.from), to = isoToMs(f.to), min = f.min === "" ? null : +f.min, max = f.max === "" ? null : +f.max, q = f.q.trim().toLowerCase();
  return CHQ.recs.filter(r =>
    (from == null || (r.d != null && r.d >= from)) && (to == null || (r.d != null && r.d <= to)) &&
    (min == null || (r.a || 0) >= min) && (max == null || (r.a || 0) <= max) &&
    (!f.bank || r.bank === f.bank) && (!q || r.s.toLowerCase().includes(q) || r.no.toLowerCase().includes(q)));
}
function cqRenderResults(){
  const list = cqFilterList(), t0 = todayMs();
  const up = list.filter(r => r.d != null && r.d >= t0), past = list.filter(r => r.d != null && r.d < t0);
  $("cqRes").innerHTML = cqPills() + cqResultsHtml(list);
}

let cqCal = null;
function cqCalendar(){
  const n0 = new Date(); if(!cqCal) cqCal = { y: n0.getFullYear(), m: n0.getMonth() };
  const { y, m } = cqCal, t0 = todayMs();
  const days = new Date(y, m + 1, 0).getDate(), lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const byD = new Map();
  CHQ.recs.forEach(r => { if(r.d == null) return; const d = new Date(r.d); if(d.getFullYear() === y && d.getMonth() === m){ const o = byD.get(d.getDate()) || { v: 0, c: 0 }; o.v += r.a || 0; o.c++; byD.set(d.getDate(), o); } });
  const vals = [...byD.entries()], mx = Math.max(1, ...vals.map(([, o]) => o.v)), tot = vals.reduce((a, [, o]) => a + o.v, 0), cnt = vals.reduce((a, [, o]) => a + o.c, 0);
  const busy = vals.sort((a, b) => b[1].v - a[1].v)[0];
  const keys = CHQ.recs.filter(r => r.d != null).map(r => { const d = new Date(r.d); return d.getFullYear() * 12 + d.getMonth(); }), kmin = Math.min(...keys), kmax = Math.max(...keys), k = y * 12 + m;
  let cells = "<i></i>".repeat(lead);
  for(let d = 1; d <= days; d++){
    const ts = new Date(y, m, d).getTime(), o = byD.get(d), wd = new Date(ts).getDay();
    cells += `<button type="button" class="cal-d${o ? " has" : ""}${ts === t0 ? " today" : ""}${wd === 0 || wd === 6 ? " wk" : ""}" style="--h:${o ? (0.14 + 0.86 * o.v / mx).toFixed(2) : 0};--k:${d}" ${o ? `data-day="${ts}" aria-label="${fmtDW(ts)}: ${rs(o.v)}, ${o.c} cheques"` : "disabled"}><b>${d}</b><em>${o ? short(o.v) : ""}</em></button>`;
  }
  return `<section class="cq-card cal-card"><div class="cal-head"><button type="button" class="cal-nav" data-cal="-1" aria-label="Previous month"${k <= kmin ? " disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>
    <div class="cal-title"><b>${MON_L[m]}</b><span>${y}</span></div>
    <button type="button" class="cal-nav" data-cal="1" aria-label="Next month"${k >= kmax ? " disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button></div>
    <div class="cal-sum"><div><span>Month total</span><b>${rs(tot)}</b></div><div><span>Cheques</span><b>${cnt}</b></div><div><span>Busiest day</span><b>${busy ? busy[0] + " " + MON_S[m] : "–"}</b></div></div>
    <div class="cal-wk">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<span>${x}</span>`).join("")}</div>
    <div class="cal-grid" id="calGrid">${cells}</div>
    <div class="cal-foot"><button type="button" class="cal-today" data-cal="today">Today</button><span>Tap a date for bank &amp; supplier details</span></div></section>`;
}
function cqCalMove(step){
  const n = new Date(), c = step === "today" ? { y: n.getFullYear(), m: n.getMonth() } : (() => { const d = new Date(cqCal.y, cqCal.m + step, 1); return { y: d.getFullYear(), m: d.getMonth() }; })();
  const dir = (c.y * 12 + c.m) >= (cqCal.y * 12 + cqCal.m) ? "pg-r" : "pg-l"; cqCal = c;
  const card = $("cqBody").querySelector(".cal-card"); if(!card) return;
  const t = document.createElement("div"); t.innerHTML = cqCalendar(); card.replaceWith(t.firstElementChild);
  const g = $("calGrid"); g.classList.add(dir); setTimeout(() => g.classList.remove(dir), 450);
}
const cqModal = $("cqModal");
function cqCloseModal(){ if(cqModal.hidden) return; const sh = cqModal.querySelector(".cq-sheet"); sh.style.transition = ""; sh.style.transform = ""; cqModal.classList.remove("open"); document.body.classList.remove("modal-open"); setTimeout(() => { cqModal.hidden = true; }, 220); if(cqModal._from) try{ cqModal._from.focus(); }catch(e){} }
function cqOpenDay(ts, from){
  cqModal._cur = { t: "day", ts };
  const list = CHQ.recs.filter(r => r.d === ts), tot = sumA(list), t0 = todayMs();
  const groups = CHQ.banks.map(b => ({ b, l: list.filter(r => r.bank === b).sort((x, y) => (y.a || 0) - (x.a || 0)) })).filter(g => g.l.length);
  $("cqModalBody").innerHTML = `<i class="md-grab" aria-hidden="true"></i><div class="md-h"><div><div class="md-date" id="cqMdTitle">${new Date(ts).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div><div class="md-rel">${relDay(ts, t0)}</div></div>
    <button type="button" class="md-x" id="cqMdX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="md-tot"><span>Total cheques</span><b>${rs(tot)}</b><em>${list.length} cheque${list.length > 1 ? "s" : ""} · ${list.length ? new Set(list.map(r => r.s)).size : 0} suppliers</em></div>
    <div class="md-banks">${groups.map(g => `<div class="md-bt bk-${esc(g.b.toLowerCase().slice(0, 3))}"><span>${esc((BANK_THEME[g.b.toLowerCase().slice(0, 3)] || { n: g.b }).n)}</span><b>${rs(sumA(g.l))}</b><em>${g.l.length} cheque${g.l.length > 1 ? "s" : ""}</em></div>`).join("")}</div>
    <div class="md-list">${groups.map(g => `<div class="md-sec"><div class="md-sh">${bankTag(g.b)}<span>${g.l.length} · ${rs(sumA(g.l))}</span></div>${g.l.map(r => `<button type="button" class="md-r md-btn" data-rid="${r.id}"><div><b>${esc(r.s)}</b><em>${r.cash ? "Cash" : r.no ? "#" + esc(r.no) : "No cheque no."}</em></div><strong>${rs(r.a)}</strong><svg class="cq-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`).join("")}</div>`).join("")}</div>
    <button type="button" class="md-find" data-find="${msToIso(ts)}">Open in Finder</button>`;
  cqShow(from);
}
function cqShow(from){
  const sh = cqModal.querySelector(".cq-sheet"); sh.style.transition = ""; sh.style.transform = ""; sh.scrollTop = 0;
  if(from) cqModal._from = from;
  if(cqModal.hidden){
    cqModal.hidden = false; document.body.classList.add("modal-open");
    requestAnimationFrame(() => { cqModal.classList.add("open"); const x = $("cqMdX"); if(x) x.focus({ preventScroll: true }); });
  }else{ const x = $("cqMdX"); if(x) x.focus({ preventScroll: true }); }
}
function rsWords(n){
  if(!isFinite(n)) return "";
  const O = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"], T = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = x => x < 20 ? O[x] : T[Math.floor(x / 10)] + (x % 10 ? " " + O[x % 10] : "");
  const three = x => (x >= 100 ? O[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " and " : "") : "") + (x % 100 ? two(x % 100) : "");
  const cents = Math.round(n * 100), rp = Math.floor(cents / 100), ps = cents % 100;
  if(!rp && !ps) return "Zero Only";
  const parts = []; let x = rp;
  [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]].forEach(([u, nm]) => { if(x >= u){ parts.push(three(Math.floor(x / u)) + " " + nm); x = x % u; } });
  if(x) parts.push(three(x));
  return (parts.join(" ") + (ps ? " and Cents " + two(ps) : "") + " Only").replace(/\s+/g, " ");
}
function ckDigits(ms){
  if(ms == null) return Array(8).fill("");
  const d = new Date(ms); return (String(d.getDate()).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0") + d.getFullYear()).split("");
}
function cqOpenCheque(id, from, prev){
  const r = CHQ.recs[id]; if(!r) return;
  cqModal._cur = { t: "chq", id };
  const t0 = todayMs(), key = r.bank.toLowerCase().slice(0, 3), th = BANK_THEME[key] || { n: r.bank, m: r.bank.slice(0, 2).toUpperCase() };
  const st = r.d == null ? ["No date", "nd"] : r.d >= t0 ? [r.d === t0 ? "Due today" : "Upcoming", "up"] : ["Passed", "ps"];
  const row = (k, v) => v ? `<div class="md-kv"><span>${k}</span><b>${v}</b></div>` : "";
  const others = CHQ.recs.filter(x => x.s === r.s && x.id !== r.id).sort((a, b) => { const ua = a.d >= t0, ub = b.d >= t0; return ua !== ub ? (ua ? -1 : 1) : ua ? a.d - b.d : b.d - a.d; }).slice(0, 5);
  $("cqModalBody").innerHTML = `<i class="md-grab" aria-hidden="true"></i>${prev ? `<button type="button" class="md-back" data-back><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>Back</button>` : ""}
    <div class="ck-wrap ck-${esc(key)}"><button type="button" class="md-x md-x-lt" id="cqMdX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="ck"><div class="ck-h"><span class="bk-mono lg-${esc(key)}" role="img" aria-label="${esc(th.n)}">${th.m}</span><span class="ck-bn">${esc(th.n)}<small>Cheque #${esc(r.no || "-")}</small></span><span class="ck-ac">A/C PAYEE ONLY</span></div>
        <div class="ck-dt"><span>DATE</span><span class="ck-d">${ckDigits(r.d).map((c, i) => `<i${i === 1 || i === 3 ? ' class="g"' : ""}>${c}</i>`).join("")}</span></div>
        <div class="ck-pay"><span>PAY</span><b id="cqMdTitle">${esc(r.s)}</b></div>
        <div class="ck-rs"><div class="ck-w"><em>RUPEES</em>${esc(rsWords(r.a))}</div><div class="ck-amt">${rs(r.a)}</div></div>
        <div class="ck-ft"><span class="ck-st ${st[1]}">${st[0]}</span><span class="ck-sg">AUTHORISED SIGNATURE</span></div>
        <div class="ck-mi">${esc(String(r.no || "").padStart(6, "0"))} · ${esc(th.m)}</div></div>
      <div class="ck-meta"><span>${r.d != null ? "<b>" + relDay(r.d, t0) + "</b>" : "No cheque date"}</span><span>${r.w != null ? "Written " + fmtD(r.w) : ""}</span></div></div>
    <div class="md-kvs">${row("Cheque date", r.d != null ? fmtD(r.d) + " · " + relDay(r.d, t0) : "Not set")}${row("Written date", r.w != null ? fmtD(r.w) : "")}${row("Cheque no.", r.no ? "#" + esc(r.no) : "Not set")}${row("Type", esc(r.ty))}${row("Bank", esc(r.bank))}${row("Supplier balance", r.bal != null ? rs(r.bal) : "")}${row("Contact", esc(r.ct))}${row("Sheet", esc(r.tab) + " · row " + r.row)}</div>
    ${cqRegisterHtml(r)}
    `;
  cqModal._prev = prev || null; cqShow(from);
}
function cqOpenBank(bank, from){
  cqModal._cur = { t: "bank", bank };
  const key = bank.toLowerCase().slice(0, 3), th = BANK_THEME[key] || { n: bank, m: bank.slice(0, 2).toUpperCase() };
  const t0 = todayMs(), n = new Date(t0), ms = new Date(n.getFullYear(), n.getMonth(), 1).getTime(), me = new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime();
  const mine = CHQ.recs.filter(r => r.bank === bank), mon = mine.filter(r => r.d >= ms && r.d < me), up = mine.filter(r => r.d >= t0), w7 = mine.filter(r => r.d >= t0 && r.d < t0 + 7 * DAY);
  const days = byDate(up).slice(0, 6);
  const sup = new Map(); mon.forEach(r => sup.set(r.s, (sup.get(r.s) || 0) + (r.a || 0)));
  const top = [...sup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const mm = new Map(); mine.forEach(r => { if(r.d == null) return; const d = new Date(r.d), k = d.getFullYear() * 12 + d.getMonth(); const o = mm.get(k) || { v: 0, c: 0 }; o.v += r.a || 0; o.c++; mm.set(k, o); });
  const mk = [...mm.keys()].sort((a, b) => a - b), mx = Math.max(1, ...[...mm.values()].map(o => o.v));
  $("cqModalBody").innerHTML = `<i class="md-grab" aria-hidden="true"></i>
    <div class="md-hero bk-${esc(key)}"><span class="bk-art" aria-hidden="true"></span><button type="button" class="md-x md-x-lt" id="cqMdX" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="bk-top"><span class="bk-mono lg-${esc(key)}" role="img" aria-label="${esc(th.n)}">${th.m}</span><span class="bk-name" id="cqMdTitle">${esc(th.n)}</span></div>
      <div class="md-hero-v">${rs(sumA(mon))}</div><div class="md-hero-s">${mon.length} cheques in ${n.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div></div>
    <div class="md-stats"><div><span>Next 7 days</span><b>${rs(sumA(w7))}</b><em>${w7.length} cheques</em></div><div><span>All upcoming</span><b>${rs(sumA(up))}</b><em>${up.length} cheque${up.length === 1 ? "" : "s"}</em></div><div><span>All time</span><b>${rs(sumA(mine))}</b><em>${mine.length} cheques</em></div></div>
    <div class="md-sec"><div class="md-sh"><span>Upcoming cheque days</span></div>${days.map(([d, r]) => `<button type="button" class="md-r md-btn" data-day="${d}"><div><b>${fmtDW(d)}</b><em>${relDay(d, t0)} · ${r.length} cheque${r.length > 1 ? "s" : ""}</em></div><strong>${rs(sumA(r))}</strong></button>`).join("") || '<p class="cq-note">No upcoming cheques.</p>'}</div>
    <div class="md-sec"><div class="md-sh"><span>Top suppliers this month</span></div>${top.map(([nm, v]) => `<div class="md-r"><div><b>${esc(nm)}</b></div><strong>${rs(v)}</strong></div>`).join("") || '<p class="cq-note">Nothing this month.</p>'}</div>
    <div class="md-sec"><div class="md-sh"><span>Month by month</span></div>${mk.map(k => { const o = mm.get(k), cur = k === n.getFullYear() * 12 + n.getMonth(); return `<div class="md-m${cur ? " cur" : ""}"><span>${MON_S[k % 12]} ${Math.floor(k / 12)}</span><i><u style="width:${o.v / mx * 100}%"></u></i><b>${short(o.v)}</b></div>`; }).join("")}</div>
    <button type="button" class="md-find" data-findbank="${esc(bank)}">Open ${esc(th.n)} cheques in Finder</button>`;
  cqShow(from);
}
cqModal.addEventListener("click", e => {
  if(e.target === cqModal || e.target.closest("#cqMdX")){ cqCloseModal(); return; }
  if(e.target.closest("[data-back]")){ const p = cqModal._prev; if(p && p.t === "day") cqOpenDay(p.ts); else if(p && p.t === "bank") cqOpenBank(p.bank); else cqCloseModal(); return; }
  const rd = e.target.closest("[data-rid]");
  if(rd){ const c = cqModal._cur; cqOpenCheque(+rd.dataset.rid, null, c && c.t !== "chq" ? c : null); return; }
  const dd = e.target.closest("[data-day]");
  if(dd){ cqOpenDay(+dd.dataset.day); return; }
  const fb = e.target.closest("[data-findbank]");
  if(fb){ cqApplyChip("month"); cqF.bank = fb.dataset.findbank; cqF.q = ""; chqTab = "finder"; cqPlay = true; cqCloseModal(); renderCheques(); window.scrollTo(0, 0); return; }
  const f = e.target.closest("[data-find]");
  if(f){ cqF = { from: f.dataset.find, to: f.dataset.find, min: "", max: "", bank: "", q: "", chip: "" }; chqTab = "finder"; cqCloseModal(); renderCheques(); window.scrollTo(0, 0); }
});
document.addEventListener("keydown", e => { if(e.key === "Escape") cqCloseModal(); });
// swipe down to close (only when the sheet is scrolled to the top)
{
  const sh = cqModal.querySelector(".cq-sheet"); let y0 = 0, t0 = 0, dy = 0, drag = false, ok = false;
  sh.addEventListener("touchstart", e => { y0 = e.touches[0].clientY; t0 = e.timeStamp; dy = 0; drag = false; ok = sh.scrollTop <= 0; }, { passive: true });
  sh.addEventListener("touchmove", e => {
    if(!ok) return;
    dy = e.touches[0].clientY - y0;
    if(dy > 6 && sh.scrollTop <= 0){ drag = true; e.preventDefault(); sh.style.transition = "none"; sh.style.transform = `translateY(${dy}px)`; cqModal.style.background = `rgba(5,8,8,${Math.max(0, .62 - dy / 700)})`; }
    else if(drag && dy <= 6){ sh.style.transform = ""; }
  }, { passive: false });
  const end = e => {
    if(!drag){ return; }
    drag = false; cqModal.style.background = "";
    const fast = dy > 60 && dy / Math.max(1, e.timeStamp - t0) > 0.6;
    if(dy > 110 || fast){ sh.style.transition = "transform .24s ease"; sh.style.transform = "translateY(105%)"; setTimeout(cqCloseModal, 200); }
    else{ sh.style.transition = "transform .25s cubic-bezier(.2,.9,.25,1.05)"; sh.style.transform = ""; }
  };
  sh.addEventListener("touchend", end); sh.addEventListener("touchcancel", end);
}

function cqIssues(){
  const out = [], { recs, blocks } = CHQ;
  recs.forEach(r => {
    if(r.d == null) out.push(["Cheque date missing", r]);
    else if(r.tm && (new Date(r.d).getFullYear() !== r.tm.y || new Date(r.d).getMonth() !== r.tm.m)) out.push(["Date outside tab month", r]);
    if(!r.no && !r.cash) out.push(["Cheque no. missing", r]);
    if(r.a == null) out.push(["Amount missing", r]);
  });
  const seen = new Map();
  recs.filter(r => r.no && !r.cash).forEach(r => { const k = r.bank + "|" + r.no; if(!seen.has(k)) seen.set(k, []); seen.get(k).push(r); });
  seen.forEach(a => { if(a.length > 1) a.forEach(r => out.push(["Duplicate cheque no.", r])); });
  const bad = blocks.filter(b => b.total != null && Math.abs(b.total - b.sum) > 1);
  const groups = {}; out.forEach(([k, r]) => (groups[k] = groups[k] || []).push(r));
  const names = Object.keys(groups), total = names.reduce((s, k) => s + groups[k].length, 0) + bad.length;
  let h = total ? `<div class="cq-alert warn"><b>${total} thing${total > 1 ? "s" : ""} to review</b><span>${fmtInt(recs.length)} rows checked across ${CHQ.tabs.length} month tabs.</span></div>` : `<div class="cq-alert ok"><b>Everything looks good</b><span>${fmtInt(recs.length)} rows checked across ${CHQ.tabs.length} month tabs.</span></div>`;
  if(bad.length) h += `<details class="cq-card cq-acc" open><summary>Tab total does not match rows <span>${bad.length}</span></summary>${bad.map(b => `<div class="cq-line"><span class="col">${esc(b.tab)} ${bankTag(b.bank)}<em>Sheet ${rs(b.total)} · rows ${rs(b.sum)}</em></span><b>${rs(b.sum - b.total)}</b></div>`).join("")}</details>`;
  names.forEach(k => {
    h += `<details class="cq-card cq-acc"><summary>${k} <span>${groups[k].length}</span></summary>${groups[k].slice(0, 40).map(r => `<div class="cq-line"><span class="col">${esc(r.s)}<em>${esc(r.tab)} · row ${r.row} · ${bankTag(r.bank)}</em></span><b>${rs(r.a)}</b></div>`).join("")}${groups[k].length > 40 ? `<p class="cq-note">+${groups[k].length - 40} more</p>` : ""}</details>`;
  });
  return h;
}


// ---------------------------------------------------------------------------
// Realized section: tick the cheques that passed in the bank statement.
// Ticking writes P (passed) to column Q of the Chq Rgstr tab, un-ticking writes O.
// ---------------------------------------------------------------------------
const RZ_IC = {
  pend: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rhG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE9A3"/><stop offset=".55" stop-color="#E8B730"/><stop offset="1" stop-color="#A9780A"/></linearGradient><linearGradient id="rhS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD66B"/><stop offset="1" stop-color="#E0902A"/></linearGradient></defs>
    <ellipse cx="24" cy="44.5" rx="12" ry="2" fill="#000" opacity=".28"/><path d="M13 9h22c0 9-5 12-8 15 3 3 8 6 8 15H13c0-9 5-12 8-15-3-3-8-6-8-15z" fill="#CFE3F5" fill-opacity=".34" stroke="#fff" stroke-opacity=".55" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M16 11h16c-.6 5-3.6 7.6-8 10-4.4-2.4-7.4-5-8-10z" fill="url(#rhS)"/><path d="M24 25l6.5 11.5c.4.9-.1 1.5-1 1.5H18.5c-.9 0-1.4-.6-1-1.5z" fill="url(#rhS)"/>
    <rect x="10" y="5.5" width="28" height="5" rx="2.5" fill="url(#rhG)"/><rect x="10" y="38.5" width="28" height="5" rx="2.5" fill="url(#rhG)"/><path d="M15 15c0 4 2 6 4 8" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`,
  due: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="rdR" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF9B7A"/><stop offset="1" stop-color="#D8412A"/></linearGradient><linearGradient id="rdF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E6E9EE"/></linearGradient></defs>
    <ellipse cx="24" cy="44.5" rx="13" ry="2" fill="#000" opacity=".28"/><circle cx="11" cy="11" r="5.5" fill="url(#rdR)"/><circle cx="37" cy="11" r="5.5" fill="url(#rdR)"/>
    <circle cx="24" cy="26" r="17.5" fill="url(#rdR)"/><circle cx="24" cy="26" r="13.5" fill="url(#rdF)"/><circle cx="24" cy="26" r="13.5" fill="none" stroke="#B23520" stroke-opacity=".35"/>
    <path d="M24 17.5V26l6 3.5" stroke="#C93A24" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24" cy="26" r="1.8" fill="#C93A24"/><path d="M14 16c2-2.4 4.6-3.8 7.4-4.2" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>`,
  ok: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="roG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8CF0BC"/><stop offset=".55" stop-color="#34B877"/><stop offset="1" stop-color="#17804F"/></linearGradient></defs>
    <ellipse cx="24" cy="44.5" rx="13" ry="2" fill="#000" opacity=".28"/><path d="M24 4l16 6v12c0 10-6.8 17-16 21C14.800 39 8 32 8 22V10z" fill="#0F5E3A"/><path d="M24 2.500l16 6v12c0 10-6.800 17-16 21C14.800 37.500 8 30.500 8 20.500v-12z" fill="url(#roG)"/>
    <path d="M24 2.500l16 6v3L24 5.500 8 11.500v-3z" fill="#fff" opacity=".4"/><path d="M15.500 21.500l6 6 11-12" stroke="#fff" stroke-width="4.200" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`
};
let rz = { st: "pending", bank: "", month: "", q: "", page: 1 };
const RZ_PAGE = 50;   // cheques per page
// Recently ticked: kept on this device (localStorage), newest first, so a tick that left the Pending list can still be found or undone
const RZ_LOG_KEY = "rz_recent_v1";
function rzLogGet(){ try{ const l = JSON.parse(localStorage.getItem(RZ_LOG_KEY) || "[]"); return Array.isArray(l) ? l : []; }catch(e){ return []; } }
function rzLogAdd(c, pass){
  try{
    const l = rzLogGet().filter(x => !(x.row === c.row && x.no === c.no));
    l.unshift({ row: c.row, no: c.no, pass: !!pass, at: Date.now() });
    localStorage.setItem(RZ_LOG_KEY, JSON.stringify(l.slice(0, 40)));
  }catch(e){}
}
const rzAgo = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.floor(m / 60) + " h ago" : new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }); };
const rzPassed = c => String(c.rs || "").trim().toUpperCase() === "P";
function rzAll(){
  const out = [];
  if(!CHQ || !CHQ.reg) return out;
  // some register rows have no bank: take it from the month tabs (same cheque no., amount first)
  const bm = new Map();
  CHQ.recs.forEach(r => { if(r.no && r.bank){ const k = String(r.no); if(!bm.has(k)) bm.set(k, []); bm.get(k).push(r); } });
  CHQ.reg.groups.forEach(g => g.chq.forEach(c => {
    if(!c.no || c.amt == null) return;
    if(!c.bank){ const l = bm.get(c.no); if(l && l.length){ const e = l.find(r => r.a === c.amt) || l[0]; c.bank = e.bank; c.bankFrom = "tab"; } }
    out.push(c);
  }));
  return out;
}
const rzMonthKey = ms => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
function rzView(){
  if(!CHQ.reg || !CHQ.regTab) return '<div class="cq-alert bad"><b>Chq Rgstr tab not found</b><span>The first tab of the cheque sheet must be named "Chq Rgstr".</span></div>';
  const all = rzAll();
  const banks = [...new Set(all.map(c => c.bank).filter(Boolean))].sort();
  const nowKey = rzMonthKey(todayMs());   // only the current month and months already gone
  const months = [...new Set(all.filter(c => c.date != null).map(c => rzMonthKey(c.date)))].filter(k => k <= nowKey).sort().reverse();
  const mName = k => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }); };
  const chips = [["pending", "Pending"], ["passed", "Passed"], ["recent", "Recent ticks"], ["all", "All"]];
  const ic = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2L17 17"/></svg>';
  return `<div id="rzSum" class="rz-sum"></div>
  <div class="rz-filters">
    <label class="rz-search">${ic}<input type="search" id="rzQ" placeholder="Search supplier, cheque no. or bank" value="${esc(rz.q)}" aria-label="Search" autocomplete="off"></label>
    <label class="rz-fld"><span>Bank</span><select id="rzBank" aria-label="Bank"><option value="">All banks</option>${banks.map(b => `<option value="${esc(b)}"${rz.bank === b ? " selected" : ""}>${esc(b)}</option>`).join("")}</select></label>
    <label class="rz-fld"><span>Month</span><select id="rzMonth" aria-label="Month"><option value="">All months</option>${months.map(k => `<option value="${k}"${rz.month === k ? " selected" : ""}>${mName(k)}</option>`).join("")}</select></label>
  </div>
  <div class="cq-chips" id="rzChips" role="group" aria-label="Status">${chips.map(([k, l]) => `<button type="button" class="chip${rz.st === k ? " active" : ""}" data-rzs="${k}">${l}</button>`).join("")}</div>
  <div id="rzRes"></div>`;
}
function rzRender(){
  const sum = $("rzSum"), res = $("rzRes"); if(!sum || !res) return;
  const t0 = todayMs(), q = rz.q.trim().toLowerCase();
  const base = rzAll().filter(c => (!rz.bank || c.bank === rz.bank) && (!rz.month || (c.date != null && rzMonthKey(c.date) === rz.month)) &&
    (!q || (c.g.sup + " " + c.no + " " + c.bank).toLowerCase().includes(q)));
  const pend = base.filter(c => !rzPassed(c)), pass = base.filter(rzPassed), due = pend.filter(c => c.date != null && c.date <= t0);
  const tot = l => l.reduce((s, c) => s + (c.amt || 0), 0);
  const card = (cls, l, n, v, note) => `<div class="rz-card ${cls}"><i class="rz-ic">${RZ_IC[cls]}</i><span>${l}</span><b>${rs(v)}</b><em>${fmtInt(n)} cheque${n === 1 ? "" : "s"}</em><p>${note}</p></div>`;
  const tp = tot(pend), tk = tot(pass), pct = tp + tk > 0 ? Math.round(tk / (tp + tk) * 100) : 0, C = 2 * Math.PI * 34;
  sum.innerHTML = `<div class="rz-hero"><div class="rz-ring"><svg viewBox="0 0 80 80" aria-hidden="true"><defs><linearGradient id="rzRg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8CF0BC"/><stop offset="1" stop-color="#2FA971"/></linearGradient></defs><circle cx="40" cy="40" r="34" class="rz-trk"/><circle cx="40" cy="40" r="34" class="rz-prg" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/></svg><b>${pct}%</b></div>
    <div class="rz-hl"><span>Realized in bank</span><strong>${rs(tk)}</strong><em>${tp > 0 ? rs(tp) + " still pending" : "All cheques realized"}${due.length ? ` · <u>${fmtInt(due.length)} overdue</u>` : ""}</em></div></div>
    <div class="rz-cards">${card("pend", "Pending", pend.length, tp, "Tick them once they clear.")}${card("ok", "Passed", pass.length, tk, "Cleared in the bank statement.")}</div>`;
  const logMap = new Map(); rzLogGet().forEach((x, i) => logMap.set(x.row + "|" + x.no, { at: x.at, pass: x.pass, i }));
  let list = rz.st === "pending" ? pend : rz.st === "passed" ? pass : rz.st === "recent" ? rzAll().filter(c => logMap.has(c.row + "|" + c.no)) : base;
  // order: today and past dates first, newest first (yesterday on top), then upcoming dates, nearest first, then undated
  const grp = c => c.date == null ? 2 : c.date <= t0 ? 0 : 1;
  list = list.slice().sort(rz.st === "recent" ? (x, y) => logMap.get(x.row + "|" + x.no).i - logMap.get(y.row + "|" + y.no).i
    : (x, y) => grp(x) - grp(y) || (grp(x) === 1 ? x.date - y.date : (y.date || 0) - (x.date || 0)));
  if(!list.length){ res.innerHTML = `<div class="rz-empty"><i>${RZ_IC.ok}</i><b>${rz.st === "pending" ? "All caught up" : "Nothing here"}</b><span>${rz.st === "pending" ? "No cheques waiting for the bank statement." : rz.st === "recent" ? "Cheques you tick on this phone show up here." : "Try another filter."}</span></div>`; return; }
  const pages = Math.max(1, Math.ceil(list.length / RZ_PAGE));
  if(rz.page > pages) rz.page = pages; if(rz.page < 1) rz.page = 1;
  const from = (rz.page - 1) * RZ_PAGE, shown = list.slice(from, from + RZ_PAGE);
  let lastKey = "", h = "";
  shown.forEach(c => {
    const gp = c.date == null ? 2 : c.date <= t0 ? 0 : 1;
    const k = gp + "|" + (c.date == null ? "No date" : new Date(c.date).toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
    if(rz.st !== "recent" && k !== lastKey){ lastKey = k; h += `<div class="rz-mh">${gp === 1 ? "Upcoming · " : ""}${k.split("|")[1]}</div>`; }
    const lg = logMap.get(c.row + "|" + c.no), tk2 = lg ? ` · <span class="rz-tk">${lg.pass ? "ticked" : "unticked"} ${rzAgo(lg.at)}</span>` : "";
    const p = rzPassed(c), od = !p && c.date != null && c.date <= t0, days = od ? Math.round((t0 - c.date) / DAY) : 0;
    h += `<label class="rz-row${p ? " done" : ""}${od ? " over" : ""}${c.busy ? " busy" : ""}"><input type="checkbox" class="rz-in" data-rzrow="${c.row}"${p ? " checked" : ""}${c.busy ? " disabled" : ""} aria-label="Passed in bank"><span class="rz-box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <span class="rz-main"><b>${esc(c.g.sup)}</b><em>#${esc(c.no)}${c.bank ? ` <i class="rz-bank ${bankKey(c.bank)}">${esc((BANK_THEME[bankKey(c.bank)] || { n: c.bank }).n.replace(" Bank", ""))}</i>` : ""}</em><small>${c.date != null ? fmtDW(c.date) + " " + new Date(c.date).getFullYear() : "No cheque date"}${od ? ` · <span class="rz-late">${days === 0 ? "due today" : days + " day" + (days > 1 ? "s" : "") + " ago"}</span>` : ""}${tk2}</small></span>
      <span class="rz-amt">${rs(c.amt)}</span></label>`;
  });
  if(pages > 1) h += rzPager(rz.page, pages, from + 1, from + shown.length, list.length);
  else if(list.length > 8) h += `<p class="cq-note">${fmtInt(list.length)} cheques</p>`;
  res.innerHTML = h;
}
function rzPager(cur, pages, a, b, total){
  const nums = [1];
  for(let i = cur - 1; i <= cur + 1; i++) if(i > 1 && i < pages) nums.push(i);
  if(pages > 1) nums.push(pages);
  let out = "", prev = 0;
  nums.forEach(n => { if(n - prev > 1) out += '<span class="rz-gap" aria-hidden="true">&hellip;</span>'; out += `<button type="button" class="rz-pg${n === cur ? " on" : ""}" data-rzp="${n}" aria-label="Page ${n}"${n === cur ? ' aria-current="page"' : ""}>${n}</button>`; prev = n; });
  const ch = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  return `<nav class="rz-pager" aria-label="Pages"><div class="rz-pgs"><button type="button" class="rz-pg nav" data-rzp="${cur - 1}" aria-label="Previous page"${cur <= 1 ? " disabled" : ""}>${ch("M12.5 4.5L7 10l5.5 5.5")}</button>${out}<button type="button" class="rz-pg nav" data-rzp="${cur + 1}" aria-label="Next page"${cur >= pages ? " disabled" : ""}>${ch("M7.5 4.5L13 10l-5.5 5.5")}</button></div><p>Showing <b>${fmtInt(a)}&ndash;${fmtInt(b)}</b> of <b>${fmtInt(total)}</b> cheques</p></nav>`;
}
async function rzSet(c, pass){
  const val = pass ? "P" : "O", prev = c.rs;
  let access = hasWriteScope() ? Promise.resolve() : requestWriteAccess();   // asked synchronously from the tap
  c.busy = true; c.rs = val; rzRender();
  try{
    await access;
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${CHQ_SHEET_ID}/values/`;
    const tab = "'" + CHQ.regTab + "'!";
    // the row must still hold this cheque, otherwise someone has changed the sheet since it was loaded
    const chk = await apiGet(`${base}${encodeURIComponent(tab + "M" + c.row)}?${API_OPTS}`);
    const cur = chk.values && chk.values[0] ? String(chk.values[0][0]).trim() : "";
    if(cur !== c.no){ c.rs = prev; toast("The sheet has changed. Refreshing, please tick again.", "error"); loadCheques(true); return; }
    await api(`${base}${encodeURIComponent(tab + "Q" + c.row)}?valueInputOption=RAW`, { values: [[val]] }, "PUT");
    rzLogAdd(c, pass);
    toast(pass ? "Marked as passed" : "Marked as pending");
  }catch(err){
    c.rs = prev;
    const code = err && err.status;
    toast(err === "popup_closed" ? "Permission window closed. Nothing was changed."
      : err === "scope_denied" || err === "access_denied" ? "Ticking needs permission to edit the Sheet. Tick the Google Sheets box when asked."
      : err === "popup_failed_to_open" ? "Your browser blocked Google's permission window. Allow pop-ups and try again."
      : code === 403 ? "You do not have edit access to the cheque sheet."
      : "Could not save to the sheet. Please try again.", "error");
  }finally{ c.busy = false; rzRender(); }
}
chqView.addEventListener("change", e => {
  const t = e.target;
  if(t.id === "rzBank"){ rz.bank = t.value; rz.page = 1; rzRender(); return; }
  if(t.id === "rzMonth"){ rz.month = t.value; rz.page = 1; rzRender(); return; }
  const r = t.closest && t.closest(".rz-in");
  if(r){ const c = rzAll().find(x => String(x.row) === r.dataset.rzrow); if(c && !c.busy) rzSet(c, r.checked); else r.checked = !r.checked; }
});
chqView.addEventListener("input", e => { if(e.target.id === "rzQ"){ rz.q = e.target.value; rz.page = 1; rzRender(); } });
chqView.addEventListener("click", e => {
  const pg = e.target.closest && e.target.closest("[data-rzp]");
  if(!pg || pg.disabled) return;
  rz.page = +pg.dataset.rzp; rzRender();
  const top = $("rzChips"); if(top) top.scrollIntoView({ behavior: "smooth", block: "start" });
});
chqView.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-rzs]"); if(!b) return; rz.st = b.dataset.rzs; rz.page = 1; document.querySelectorAll("#rzChips .chip").forEach(x => x.classList.toggle("active", x === b)); rzRender(); });

function renderCheques(){
  const body = $("cqBody");
  document.querySelectorAll("#cqSeg button").forEach(x => x.setAttribute("aria-selected", String(x.dataset.t === chqTab)));
  $("cqRefresh").classList.toggle("spin", chqLoading);
  if(chqLoading && !CHQ){ body.innerHTML = '<div class="cq-skel"><i></i><i></i><i></i></div>'; return; }
  if(chqErr && !CHQ){ body.innerHTML = `<div class="cq-alert bad"><b>Couldn't load</b><span>${esc(chqErr)}</span></div>`; return; }
  if(!CHQ){ body.innerHTML = ""; return; }
  $("cqUpdated").textContent = "Updated " + new Date(CHQ.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if(chqTab === "overview") body.innerHTML = cqOverview();
  else if(chqTab === "finder"){ body.innerHTML = cqFinder(); cqRenderResults(); const ac = body.querySelector("#cqChips .chip.active"); if(ac && ac.scrollIntoView) ac.scrollIntoView({ inline: "center", block: "nearest" }); }
  else if(chqTab === "calendar") body.innerHTML = cqCalendar();
  else { body.innerHTML = rzView(); rzRender(); }
  if(cqPlay){ cqPlay = false; cqIntro(); }
}
$("cqSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(!b) return; chqTab = b.dataset.t; cqPlay = true; renderCheques(); window.scrollTo(0, 0); });
$("cqRefresh").addEventListener("click", () => loadCheques(true));
chqView.addEventListener("click", e => {
  const t = e.target;
  const c = t.closest("#cqChips .chip");
  if(c){ cqApplyChip(c.dataset.c); cqPastOpen = null; renderCheques(); return; }
  const rw = t.closest("[data-rid]");
  if(rw){ cqOpenCheque(+rw.dataset.rid, rw); return; }
  const pst = t.closest("[data-past]");
  if(pst){ const was = pst.getAttribute("aria-expanded") === "true"; cqPastOpen = !was; cqRenderResults(); return; }
  const rm = t.closest("[data-rm]");
  if(rm){ const k = rm.dataset.rm; if(k === "range"){ cqF.from = ""; cqF.to = ""; } else if(k === "amt"){ cqF.min = ""; cqF.max = ""; } else cqF[k] = ""; cqF.chip = (cqF.from || cqF.to) ? "" : "all"; renderCheques(); return; }
  if(t.closest("#cqToggle")){ cqOpen = !cqOpen; renderCheques(); return; }
  if(t.closest("#cqClear")){ cqF = { from: "", to: "", min: "", max: "", bank: "", q: "", chip: "all" }; renderCheques(); return; }
  const yr = t.closest("[data-yr]");
  if(yr){ const y = +yr.dataset.yr; if(y !== cqYear){ cqYear = y; cqYearRefresh(true); } return; }
  const bar = t.closest(".cq-bar[data-y]");
  if(bar){ cqSel[+bar.dataset.y] = +bar.dataset.m; cqYearRefresh(false); return; }
  const yf = t.closest("[data-yfind]");
  if(yf){ const y = +yf.dataset.yfind; cqF = { from: y + "-01-01", to: y + "-12-31", min: "", max: "", bank: "", q: "", chip: "" }; chqTab = "finder"; cqPlay = true; renderCheques(); window.scrollTo(0, 0); return; }
  const mf = t.closest("[data-mfind]");
  if(mf){ const [y, m] = mf.dataset.mfind.split("-").map(Number); cqF = { from: msToIso(new Date(y, m, 1).getTime()), to: msToIso(new Date(y, m + 1, 0).getTime()), min: "", max: "", bank: "", q: "", chip: "" }; chqTab = "finder"; cqPlay = true; renderCheques(); window.scrollTo(0, 0); return; }
  const bk = t.closest("[data-bank]");
  if(bk){ cqOpenBank(bk.dataset.bank, bk); return; }
  const g = t.closest("[data-go]");
  if(g){ cqF = { from: g.dataset.go, to: g.dataset.go, min: "", max: "", bank: "", q: "", chip: "" }; chqTab = "finder"; renderCheques(); window.scrollTo(0, 0); return; }
  const cn = t.closest("[data-cal]");
  if(cn){ cqCalMove(cn.dataset.cal === "today" ? "today" : +cn.dataset.cal); return; }
  const dy = t.closest("[data-day]");
  if(dy){ cqOpenDay(+dy.dataset.day, dy); return; }
});
chqView.addEventListener("input", e => {
  const id = e.target.id;
  const fm = { cqFrom: "from", cqTo: "to", cqMin: "min", cqMax: "max", cqBank: "bank", cqQ: "q" };
  if(fm[id]){
    cqF[fm[id]] = e.target.value;
    const tg = $("cqToggle"); if(tg){ const na = cqActive(); tg.classList.toggle("on", !!na); tg.innerHTML = "Filters" + (na ? `<span>${na}</span>` : ""); }
    cqRenderResults(); return;
  }
});
cqApplyChip("all");
document.querySelectorAll("[data-year]").forEach(e => { e.textContent = new Date().getFullYear(); });
// swipe left/right on the calendar to change month
{
  let x0 = 0, y0 = 0, on = false;
  chqView.addEventListener("touchstart", e => { const g = e.target.closest(".cal-card"); on = !!g; if(g){ x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  chqView.addEventListener("touchend", e => {
    if(!on) return; on = false;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if(Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const btn = chqView.querySelector(`[data-cal="${dx < 0 ? 1 : -1}"]`);
    if(btn && !btn.disabled) cqCalMove(dx < 0 ? 1 : -1);
  }, { passive: true });
}


$("openSupBtn").addEventListener("click", () => { location.hash = "suppliers"; });
$("svBack").addEventListener("click", () => { location.hash = "dashboard"; });
window.addEventListener("hashchange", route);
 
$("svChips").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if(!c) return;
  svPeriod = c.dataset.p;
  document.querySelectorAll("#svChips .chip").forEach(x => x.classList.toggle("active", x === c));
  $("svCustom").hidden = svPeriod !== "custom";
  if(svPeriod === "custom" && !$("svFrom").value){
    const n = new Date();
    $("svFrom").value = toLocalISODate(new Date(n.getFullYear(), n.getMonth(), 1));
    $("svTo").value = toLocalISODate(n);
  }
  renderSupplierView();
});
["svFrom", "svTo"].forEach(id => {
  $(id).addEventListener("change", renderSupplierView);
  $(id).addEventListener("click", e => { try{ e.currentTarget.showPicker(); }catch(err){} });
});
 
// ---------------------------------------------------------------------------
// Add bill
// ---------------------------------------------------------------------------
const LEDGER_YEAR = 2026;   // the Jan…Dec month tabs hold this year's bills
class UserError extends Error{}
class DuplicateError extends Error{ constructor(info){ super("duplicate"); this.info = info; } }
 
const billDialog = $("billDialog");
const billCombo = createCombo($("billSupplierCombo"), {
  labelId: "billSupplierLabel", placeholder: "Search or add a supplier…", allowNew: true,
  onChange: () => { setFieldErr("Supplier", ""); onBillEdit(); if(billCombo.value) $("billAmount").focus(); }
});
let billSaving = false, dupConfirmedKey = "";
 
const dupKey = (supplier, invoice) => supplier.trim().toLowerCase() + "\u0001" + String(invoice).trim().toLowerCase();
 
function parseAmount(str){
  const t = String(str).replace(/rs\.?/i, "").replace(/[,\s]/g, "");
  if(!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100) / 100;
}
 
function setFieldErr(key, msg){
  const el = $("err" + key);
  el.textContent = msg;
  el.closest(".field").classList.toggle("invalid", !!msg);
}
 
function readBillForm(){
  // Strip control characters so nothing odd is ever written into the Sheet
  const supplier = billCombo.value.replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ").slice(0, 120);
  const invoice = $("billInvoice").value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  const amountRaw = $("billAmount").value.trim();
  const amount = parseAmount(amountRaw);
  const ms = parseLocalMs($("billDate").value);
  const d = ms === null || isNaN(ms) ? null : new Date(ms);
  const errs = {};
  if(!supplier) errs.Supplier = "Choose a supplier, or type a new one";
  if(!amountRaw) errs.Amount = "Enter the bill amount";
  else if(!(amount > 0)) errs.Amount = "Enter a valid amount, e.g. 12500 or 12,500.50";
  else if(amount >= 1e11) errs.Amount = "That amount looks too large — please check it";
  if(!invoice) errs.Invoice = "Enter the invoice number";
  if(!d) errs.Date = "Pick the bill date";
  else if(d.getFullYear() !== LEDGER_YEAR) errs.Date = `Month tabs are for ${LEDGER_YEAR} — pick a ${LEDGER_YEAR} date`;
  return { supplier, invoice, amount, d, errs, sale: $("billSale").checked };
}
 
// Live feedback while typing: destination tab, "new supplier" tag, duplicate reset
function onBillEdit(){
  const ms = parseLocalMs($("billDate").value);
  const d = ms === null || isNaN(ms) ? null : new Date(ms);
  $("billDest").innerHTML = $("billSale").checked
    ? `Saves to the <b>${SALE_TAB}</b> tab · columns A–D`
    : d && d.getFullYear() === LEDGER_YEAR
    ? `Saves to the <b>${MONTH_SHEETS[d.getMonth()]}</b> tab · columns A–D`
    : `Saves to the month tab of the bill date`;
  $("dateHint").textContent = d ? d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  document.querySelectorAll("#dateQuick .chip").forEach(c => {
    const t = new Date(today); t.setDate(t.getDate() - +c.dataset.days);
    c.classList.toggle("active", !!d && d.getTime() === t.getTime());
  });
  const name = billCombo.value;
  $("supplierHint").innerHTML = name && !SUPPLIERS.some(s => s.name === name)
    ? `<span class="tag">NEW</span> Not in your ledger yet — check the spelling before saving` : "";
  if(dupConfirmedKey && dupConfirmedKey !== dupKey(billCombo.value, $("billInvoice").value)){
    dupConfirmedKey = "";
    $("dupWarn").hidden = true;
    $("billSaveLabel").textContent = "Save bill";
  }
  $("formErr").textContent = "";
}
 
function showDuplicate(f, info){
  dupConfirmedKey = dupKey(f.supplier, f.invoice);
  $("dupWarn").innerHTML = `<b>Possible duplicate.</b> ${esc(f.supplier)} already has invoice <b>${esc(f.invoice)}</b>` +
    ` in the ${esc(info.tab)} tab (${fmtMoney(info.amount)}). Press <b>Save anyway</b> if this is a different bill.`;
  $("dupWarn").hidden = false;
  $("billSaveLabel").textContent = "Save anyway";
  $("dupWarn").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
 
function resetBillForm(keepContext){
  if(!keepContext){
    billCombo.set("", true);
    $("billDate").value = toLocalISODate(new Date());
    $("formOk").textContent = "";
  }
  $("billInvoice").value = "";
  $("billAmount").value = "";
  if(!keepContext) $("billSale").checked = false;
  ["Supplier", "Amount", "Invoice", "Date"].forEach(k => setFieldErr(k, ""));
  dupConfirmedKey = "";
  $("dupWarn").hidden = true;
  $("billSaveLabel").textContent = "Save bill";
  onBillEdit();
}
 
function isBillDirty(){ return !!(billCombo.value || $("billInvoice").value.trim() || $("billAmount").value.trim()); }
 
function openBillForm(){
  if(!accessToken) return;
  if(hasWriteScope()){ showBillForm(); return; }
  requestWriteAccess().then(showBillForm).catch(code => {
    toast(code === "popup_closed" ? "Permission window closed — no changes made."
        : code === "scope_denied" || code === "access_denied" ? "Adding bills needs permission to edit the Sheet. Tick the Google Sheets box when asked."
        : code === "popup_failed_to_open" ? "Your browser blocked Google's permission window. Allow pop-ups and try again."
        : "Couldn't get permission to edit the Sheet. Please try again.", "error");
  });
}
 
function showBillForm(){
  if(billDialog.open) return;
  resetBillForm(false);
  billDialog.showModal();
  // Desktop: jump straight into the supplier search. Touch: don't pop the keyboard uninvited.
  // (deferred so the click that opened the dialog doesn't immediately close the list again)
  if(matchMedia("(pointer: fine)").matches) setTimeout(() => billCombo.open(), 0); else billCombo.focus();
}
 
function closeBillForm(){ if(!billSaving) billDialog.close(); }
 
// iPhone keyboard: iOS doesn't shrink the page when the keyboard opens, so a bottom
// sheet would sit behind it. Lift the sheet above the keyboard and keep the field in view.
function fitSheetToKeyboard(){
  const vv = window.visualViewport;
  if(!vv || !billDialog.open || !matchMedia("(max-width: 679px)").matches){
    billDialog.style.marginBottom = ""; billDialog.style.maxHeight = ""; return;
  }
  const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);   // px covered by the keyboard
  billDialog.style.marginBottom = hidden ? hidden + "px" : "";
  billDialog.style.maxHeight = hidden ? (vv.height - 8) + "px" : "";
}
if(window.visualViewport){
  visualViewport.addEventListener("resize", fitSheetToKeyboard);
  visualViewport.addEventListener("scroll", fitSheetToKeyboard);
}
billDialog.addEventListener("focusin", e => {
  if(e.target.matches("input")) setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
});
 
function setSaving(on){
  billSaving = on;
  $("billSave").disabled = on;
  $("billSave").classList.toggle("loading", on);
  $("billCancel").disabled = on;
  if(on) $("billSaveLabel").textContent = "Saving…";
}
 
async function submitBill(e){
  e.preventDefault();
  if(billSaving) return;
  const f = readBillForm();
  ["Supplier", "Amount", "Invoice", "Date"].forEach(k => setFieldErr(k, f.errs[k] || ""));
  $("formErr").textContent = "";
  $("formOk").textContent = "";
  const firstErr = ["Supplier", "Amount", "Invoice", "Date"].find(k => f.errs[k]);
  if(firstErr){
    if(firstErr === "Supplier") billCombo.focus(); else $("bill" + firstErr).focus();
    return;
  }
  const key = dupKey(f.supplier, f.invoice);
  const force = dupConfirmedKey === key;
  if(!force){
    const dup = BILLS.find(b => dupKey(b.s, b.i) === key);
    if(dup){ showDuplicate(f, { tab: SHEETS[dup.k], amount: dup.a }); return; }
  }
 
  setSaving(true);
  let ok = false;
  try{
    const res = await saveBill(f, force);
    ok = true;
    // Show it on the dashboard immediately — no full reload needed
    BILLS.push({ s: f.supplier, i: f.invoice, a: f.amount, t: f.d.getTime(), k: f.sale ? SALE_K : 1 + f.d.getMonth(), r: -1 });
    setData(BILLS.slice());
    store.set(CACHE_KEY, JSON.stringify({ at: Date.now(), email: currentUserEmail, bills: BILLS }));
    const msg = `Saved ${fmtMoney(f.amount)} for ${f.supplier} → ${res.tab} tab, row ${res.row}`;
    if($("billAnother").checked){
      resetBillForm(true);           // keep supplier + date for fast batch entry
      $("formOk").textContent = "✓ " + msg;
      $("billAmount").focus();
    } else {
      billDialog.close();
      toast(msg, "success");
    }
  }catch(err){
    if(err instanceof DuplicateError){ showDuplicate(f, err.info); return; }
    if(err.status === 401){ billDialog.close(); lock("Your session expired. Please sign in again."); return; }
    $("formErr").textContent = billErrorMessage(err);
  }finally{
    setSaving(false);
    $("billSaveLabel").textContent = dupConfirmedKey && !ok ? "Save anyway" : "Save bill";
  }
}
 
function billErrorMessage(err){
  if(err instanceof UserError) return err.message;
  if(err.status === 403){
    if(/scope/i.test(err.detail)){ grantedScopes = ""; return "Edit permission is missing. Close this form, press Add bill again and allow Google Sheets access."; }
    return `${currentUserEmail || "This account"} can view the Sheet but not edit it. Ask the owner to give you Editor access, then try again.`;
  }
  if(err.status === 429) return "Google is rate-limiting requests. Wait a few seconds and try again.";
  if(err.stage === "write") return "The connection dropped while saving — the bill may or may not have been saved. Press Refresh on the dashboard and check before trying again.";
  if(!err.status) return "Couldn't reach Google. Check your internet connection and try again — nothing was saved.";
  return `Google Sheets returned an error (${err.status})${err.detail ? ": " + err.detail : ""}. Nothing was saved.`;
}
 
// Writes one bill into the first free row after the last bill of the month tab.
// Only A–D are touched (values + matching number formats), so formulas or notes
// in other columns stay intact. The tab is re-read right before writing so the
// row is correct even if someone else added a bill meanwhile.
async function saveBill(f, force){
  const tab = f.sale ? SALE_TAB : MONTH_SHEETS[f.d.getMonth()];
  const fmtFields = "sheets(properties(sheetId,gridProperties(rowCount)),data(rowData(values(userEnteredFormat(numberFormat)))))";
  let vals, meta;
  try{
    [vals, meta] = await Promise.all([
      apiGet(`${API}/values/${rangeFor(tab)}?${API_OPTS}&fields=values`),
      apiGet(`${API}?ranges=${encodeURIComponent(`'${tab}'!C:D`)}&fields=${encodeURIComponent(fmtFields)}`)
    ]);
  }catch(e){
    if(e.status === 400) throw new UserError(`There's no "${tab}" tab in the Sheet yet. Create it with the "Supplier Name" header row, then try again. Nothing was saved.`);
    throw e;
  }
 
  const rows = vals.values || [];
  const header = rows.findIndex(r => clean(r && r[0]).toLowerCase() === HEADER_MARKER);
  if(header < 0) throw new UserError(`The "${tab}" tab has no "Supplier Name" header row, so the bill can't be placed safely. Nothing was saved.`);
 
  const key = dupKey(f.supplier, f.invoice);
  let last = header;
  for(let i = header + 1; i < rows.length; i++){
    const r = rows[i] || [];
    const s = clean(r[0]);
    if(s || typeof r[2] === "number"){
      last = i;
      if(!force && dupKey(s, clean(r[1])) === key) throw new DuplicateError({ tab, amount: typeof r[2] === "number" ? r[2] : 0 });
    }
  }
  const target = last + 1;                               // 0-based row index to write
  const sheet = meta.sheets[0];
  const sheetId = sheet.properties.sheetId;
  const rowCount = sheet.properties.gridProperties.rowCount;
  const fmtRows = (sheet.data && sheet.data[0] && sheet.data[0].rowData) || [];
  // Copy the number format of the nearest bill above, so the new row looks like the rest
  const formatFrom = col => {
    for(let i = last; i > header; i--){
      const v = fmtRows[i] && fmtRows[i].values && fmtRows[i].values[col];
      if(v && v.userEnteredFormat && v.userEnteredFormat.numberFormat) return v.userEnteredFormat.numberFormat;
    }
    return null;
  };
  const amountFmt = formatFrom(0);
  const dateFmt = formatFrom(1) || { type: "DATE", pattern: "dd/mm/yyyy" };
  // Pure numbers are stored as numbers (like typing them in Sheets); anything else as text, never as a formula
  const invoiceValue = /^[1-9]\d{0,14}$/.test(f.invoice) ? { numberValue: Number(f.invoice) } : { stringValue: f.invoice };
  const serial = Date.UTC(f.d.getFullYear(), f.d.getMonth(), f.d.getDate()) / 86400000 + 25569;
  const cell = (col, values, fields) => ({ updateCells: { start: { sheetId, rowIndex: target, columnIndex: col }, rows: [{ values }], fields } });
 
  const requests = [];
  if(target >= rowCount) requests.push({ appendDimension: { sheetId, dimension: "ROWS", length: target - rowCount + 1 } });
  requests.push(cell(0, [
    { userEnteredValue: { stringValue: f.supplier } },
    { userEnteredValue: invoiceValue },
    { userEnteredValue: { numberValue: f.amount } }
  ], "userEnteredValue"));
  if(amountFmt) requests.push(cell(2, [{ userEnteredFormat: { numberFormat: amountFmt } }], "userEnteredFormat.numberFormat"));
  requests.push(cell(3, [{ userEnteredValue: { numberValue: serial }, userEnteredFormat: { numberFormat: dateFmt } }], "userEnteredValue,userEnteredFormat.numberFormat"));
 
  try{
    await api(`${API}:batchUpdate?fields=spreadsheetId`, { requests });
  }catch(e){
    e.stage = "write";
    throw e;
  }
  return { tab, row: target + 1 };
}
 
let toastTimer = 0;
function toast(msg, type){
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), type === "error" ? 6000 : 4000);
}
 
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
$("googleSignInBtn").addEventListener("click", signIn);
$("refreshBtn").addEventListener("click", () => loadAll(true));
$("addBillBtn").addEventListener("click", openBillForm);
$("addBillFab").addEventListener("click", openBillForm);
$("billForm").addEventListener("submit", submitBill);
$("billClose").addEventListener("click", closeBillForm);
$("billCancel").addEventListener("click", closeBillForm);
billDialog.addEventListener("cancel", e => { if(billSaving) e.preventDefault(); });           // Esc
billDialog.addEventListener("click", e => { if(e.target === billDialog && !isBillDirty()) closeBillForm(); }); // backdrop
billDialog.addEventListener("close", () => { COMBOS.forEach(c => c.close(false)); fitSheetToKeyboard(); });
["billInvoice", "billAmount", "billDate"].forEach(id => $(id).addEventListener("input", () => {
  setFieldErr(id.replace("bill", ""), "");
  onBillEdit();
}));
$("billSale").addEventListener("change", onBillEdit);
$("billAmount").addEventListener("blur", () => {
  const a = parseAmount($("billAmount").value);
  if(a > 0) $("billAmount").value = nf2.format(a);   // tidy to 12,500.00 once typed
});
$("billAmount").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); $("billInvoice").focus(); } });
$("dateQuick").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if(!c) return;
  const d = new Date(); d.setDate(d.getDate() - +c.dataset.days);
  $("billDate").value = toLocalISODate(d);
  setFieldErr("Date", "");
  onBillEdit();
});
// Open the calendar when the date box is clicked anywhere, not just on the small icon
["billDate", "dateFrom", "dateTo"].forEach(id => $(id).addEventListener("click", e => {
  try{ e.currentTarget.showPicker(); }catch(err){ /* older browsers: native behaviour */ }
}));
$("billDate").min = `${LEDGER_YEAR}-01-01`;
$("billDate").max = `${LEDGER_YEAR}-12-31`;
$("signOutBtn").addEventListener("click", e => { e.stopPropagation(); signOut(); });
 

// ---- Morning cheque alerts (phone notification, only for PUSH_EMAIL) ----
const PUSH_EMAIL = "hanoonelite@gmail.com";
const PUSH_PUBLIC_KEY = "BKZCN9Rbasaid6J6wosCooSAvZxRc5GmR6QJAIy6X_Gx1ayQTnry-UJfVG1ivvMYp30dDk2BqAEeHPH9TEbOq-g";
const pushOk = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const u8FromB64u = s => { const p = "=".repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function pushSub(){ try{ const r = await navigator.serviceWorker.ready; return await r.pushManager.getSubscription(); }catch(e){ return null; } }
async function pushRefreshUi(){
  const b = $("alertsMenuBtn"), t = $("alertsTestBtn"); if(!b || !t) return;
  const mine = pushOk() && !!currentUserEmail && currentUserEmail.toLowerCase() === PUSH_EMAIL;
  b.hidden = !mine; if(!mine){ t.hidden = true; return; }
  const on = !!(await pushSub()) && Notification.permission === "granted";
  const blocked = Notification.permission === "denied";
  b.querySelector(".mi-tx").textContent = blocked ? "Alerts blocked in browser settings" : on ? "Morning cheque alerts: ON" : "Morning cheque alerts";
  b.setAttribute("aria-checked", String(on)); b.disabled = blocked; t.hidden = !on;
}
async function pushToggle(){
  try{
    const sub = await pushSub();
    if(sub){
      await logCall({ action: "push_off", endpoint: sub.endpoint }); await sub.unsubscribe();
      toast("Morning alerts are off"); return;
    }
    const perm = await Notification.requestPermission();
    if(perm !== "granted"){ toast("Please allow notifications to get the morning alert", "error"); return; }
    const reg = await navigator.serviceWorker.ready;
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8FromB64u(PUSH_PUBLIC_KEY) });
    const res = await logCall({ action: "push_sub", sub: s.toJSON() });
    if(!res || !res.ok){ await s.unsubscribe(); toast(res && res.error === "not_allowed" ? "Alerts are not enabled for this login" : "Could not switch alerts on. Try again.", "error"); return; }
    toast("Morning alerts are on");
  }catch(e){ toast("This phone could not switch alerts on", "error"); }
  finally{ pushRefreshUi(); }
}
async function pushTest(){
  const res = await logCall({ action: "push_test" });
  toast(res && res.ok ? (res.sent ? "Test alert sent. It should arrive in a few seconds." : "Server could not reach this phone (codes " + ((res.codes || []).join(", ") || "none") + ")") : "Test failed", res && res.ok && res.sent ? undefined : "error");
}

const avatar = $("avatar"), menu = $("accountMenu");
function toggleMenu(open){
  menu.classList.toggle("open", open);
  if(open) pushRefreshUi();
  avatar.setAttribute("aria-expanded", String(open));
}
avatar.addEventListener("click", e => { if(!menu.contains(e.target)) toggleMenu(!menu.classList.contains("open")); });
avatar.addEventListener("keydown", e => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); toggleMenu(!menu.classList.contains("open")); } });
document.addEventListener("click", e => { if(!avatar.contains(e.target)) toggleMenu(false); });
document.addEventListener("keydown", e => { if(e.key === "Escape") toggleMenu(false); });
 
document.querySelector(".tabs").addEventListener("click", e => {
  const t = e.target.closest(".tab"); if(t) setMode(t.dataset.mode);
});
$("presetChips").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if(c) applyPreset(c.dataset.preset);
});
["dateFrom","dateTo"].forEach(id => $(id).addEventListener("change", () => {
  document.querySelectorAll("#presetChips .chip").forEach(c => c.classList.remove("active"));
  updateFinder();
}));
 
// Chart: event delegation (one listener, not one per bar) + hover tooltip
const chartEl = $("chart"), tip = $("tooltip");
chartEl.addEventListener("click", e => {
  const col = e.target.closest(".bar-col"); if(col) selectBar(+col.dataset.k);
});
chartEl.addEventListener("pointermove", e => {
  const col = e.target.closest(".bar-col");
  if(!col || e.pointerType === "touch"){ tip.classList.remove("show"); return; }
  const k = +col.dataset.k;
  const wrap = chartEl.parentElement.getBoundingClientRect(), r = col.getBoundingClientRect();
  const bar = col.firstElementChild.getBoundingClientRect();
  tip.innerHTML = `<b>${sheetLabel(k)}</b><span class="num">${fmtMoney(SHEET_SUMS[k])}</span> · ${fmtInt(SHEET_COUNTS[k])} bills`;
  const half = tip.offsetWidth / 2;
  const x = Math.min(Math.max(r.left + r.width / 2 - wrap.left, half), wrap.width - half);
  tip.style.left = x + "px";
  tip.style.top = (bar.top - wrap.top - 8) + "px";
  tip.classList.add("show");
});
chartEl.addEventListener("pointerleave", () => tip.classList.remove("show"));
 
// ---------------------------------------------------------------------------
// Install as an app (PWA)
// ---------------------------------------------------------------------------
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const BANNER_KEY = "ledger_install_banner_dismissed";
 
function showInstallOptions(){
  const can = !isStandalone() && (installPrompt || isIOS);
  $("installMenuBtn").hidden = !can;
  $("installLockBtn").hidden = !can;
  let dismissed = false;
  try{ dismissed = localStorage.getItem(BANNER_KEY) === "1"; }catch(e){}
  $("installBanner").hidden = !(can && !dismissed && matchMedia("(max-width: 679px)").matches);
}
 
async function installApp(){
  if(isIOS && !installPrompt){ $("iosDialog").showModal(); return; }
  if(!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if(outcome === "accepted") toast("Installing Elite Ledger… it will appear with your apps.", "success");
  showInstallOptions();
}
 
function dismissBanner(){
  try{ localStorage.setItem(BANNER_KEY, "1"); }catch(e){}
  $("installBanner").hidden = true;
}
 
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; showInstallOptions(); });
window.addEventListener("appinstalled", () => { installPrompt = null; showInstallOptions(); toast("Elite Ledger installed ✓", "success"); });
$("alertsMenuBtn").addEventListener("click", () => pushToggle());
$("alertsTestBtn").addEventListener("click", () => { toggleMenu(false); pushTest(); });
["installMenuBtn", "installLockBtn", "installBannerBtn"].forEach(id => $(id).addEventListener("click", () => { toggleMenu(false); installApp(); }));
$("installBannerClose").addEventListener("click", dismissBanner);
$("iosClose").addEventListener("click", () => $("iosDialog").close());
$("iosDialog").addEventListener("click", e => { if(e.target === $("iosDialog")) $("iosDialog").close(); });
showInstallOptions();
 
if("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
 
// ---------------------------------------------------------------------------
// Light / dark theme (initial theme is applied by theme.js before first paint)
// ---------------------------------------------------------------------------
const THEME_KEY = "ledger_theme";
const themeNow = () => document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
function applyTheme(t, save){
  document.documentElement.setAttribute("data-theme", t);
  if(save){ try{ localStorage.setItem(THEME_KEY, t); }catch(e){} }
  const label = t === "light" ? "Switch to dark mode" : "Switch to light mode";
  document.querySelectorAll(".theme-btn").forEach(b => { b.setAttribute("aria-label", label); b.title = label; });
  document.querySelectorAll(".menu-theme").forEach(b => b.setAttribute("aria-checked", String(t === "dark")));
}
document.querySelectorAll(".theme-btn, .menu-theme").forEach(b => b.addEventListener("click", () => applyTheme(themeNow() === "light" ? "dark" : "light", true)));
applyTheme(themeNow(), false);
// Until a choice is saved, follow the device setting live
try{
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", e => {
    let saved = null; try{ saved = localStorage.getItem(THEME_KEY); }catch(err){}
    if(saved !== "light" && saved !== "dark") applyTheme(e.matches ? "light" : "dark", false);
  });
}catch(e){}
 
{ const lf = document.querySelector(".lock-foot"); if(lf) lf.append(" · v10"); }
 
// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
applyPreset("thisMonth");
route();
 
{ // Explain an auto-lock on the sign-in screen
  const msg = store.get(LOCK_MSG_KEY);
  if(msg){ $("lockError").textContent = msg; store.del(LOCK_MSG_KEY); }
}
 
if(accessToken){
  $("lockScreen").classList.add("hidden");
  showAccount();
  // Instant paint from this session's data, then refresh in the background
  try{
    const c = JSON.parse(store.get(CACHE_KEY) || "null");
    if(c && Array.isArray(c.bills) && (!c.email || c.email === currentUserEmail)){
      setData(c.bills);
      setUpdated(new Date(c.at), true);
    }
  }catch(e){ store.del(CACHE_KEY); }
  if(!currentUserEmail) fetchUserEmail();
  loadAll(false);
  checkLogAccess();
}
