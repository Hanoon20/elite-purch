"use strict";
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
const SHEETS = ["2025", ...MONTH_SHEETS];
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
const CACHE_KEY = "ledger_cache_v5";     // last loaded data, for instant paint
const LOCK_MSG_KEY = "ledger_lock_msg";  // reason shown on the sign-in screen after an auto-lock
const IDLE_LOCK_MINUTES = 30;            // lock and wipe the data after this long without activity

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

function showSignInError(code){
  $("lockError").textContent = (code === "access_denied" || code === "popup_closed")
    ? "Sign-in cancelled. Try again."
    : "⚠️ Access blocked — this Google account isn't authorized for this dashboard. Contact the admin to be added as a Test user + Sheet viewer.";
}

function signIn(){
  if(!tokenClient) return;
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
  [TOKEN_KEY, EMAIL_KEY, CACHE_KEY].forEach(store.del);
  accessToken = null;
  location.reload();
}

// Drops the session and every copy of the ledger data (memory, page, storage),
// then reloads to a clean sign-in screen that explains why.
function secureLock(message){
  [TOKEN_KEY, CACHE_KEY].forEach(store.del);
  accessToken = null;
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
      }
    }
  }catch(e){ /* non-fatal */ }
}

function showAccount(){
  const email = currentUserEmail || "";
  $("accountEmail").textContent = email || "Google account";
  $("avatarLetter").textContent = (email[0] || "?").toUpperCase();
  $("avatar").classList.add("show");
  document.body.classList.add("authed");
}

function enterDashboard(){
  $("lockScreen").classList.add("hidden");
  showAccount();
  // Data and email lookups run in parallel — nothing waits on the other
  if(!currentUserEmail) fetchUserEmail();
  loadAll(false);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
// Bill shape (compact for speed + cache size): {s: supplier, i: invoice, a: amount, t: local-midnight ms | null, k: sheet index}
let BILLS = [];
let BY_SUPPLIER = new Map();   // supplier -> bills[]

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
    out.push({ s: s || "(Unnamed)", i: clean(r[1]), a, t: serialToMs(r[3]), k });
  }
}

class HttpError extends Error{ constructor(status, detail){ super(detail || "HTTP " + status); this.status = status; this.detail = detail || ""; } }

async function api(url, body){
  const opts = { headers: { Authorization: `Bearer ${accessToken}` }, referrerPolicy: "no-referrer", cache: "no-store" };
  if(body){ opts.method = "POST"; opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if(!res.ok){
    let detail = "";
    try{ detail = (await res.json()).error.message || ""; }catch(e){}
    throw new HttpError(res.status, detail);
  }
  return res.json();
}
const apiGet = url => api(url);
const rangeFor = name => encodeURIComponent(`'${name}'!A:D`);

// One batched request for all 13 sheets, asking Google for only the cell values
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
  for(const b of bills){
    let arr = BY_SUPPLIER.get(b.s);
    if(!arr) BY_SUPPLIER.set(b.s, arr = []);
    arr.push(b);
  }
  // Paint on the next frame so input stays responsive
  requestAnimationFrame(() => { render(); if(!svView.hidden) renderSupplierView(); });
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

  renderChart(now);
  renderTopSuppliers();
  renderSupplierOptions(bySup);
  updateFinder();
}

function renderChart(now){
  const max = Math.max(1, ...SHEET_SUMS);
  if(selectedSheet < 0){
    // Default to the current month's sheet in the current year, else the latest sheet with data
    selectedSheet = now.getFullYear() === 2025 ? 0 : 1 + now.getMonth();
    if(!SHEET_COUNTS[selectedSheet]){
      for(let k = SHEETS.length - 1; k >= 0; k--) if(SHEET_COUNTS[k]){ selectedSheet = k; break; }
    }
  }
  $("chart").innerHTML = SHEETS.map((s, k) => {
    const h = (SHEET_SUMS[k] / max * 100).toFixed(1);
    return `<button class="bar-col${k === selectedSheet ? " sel" : ""}" type="button" role="listitem" data-k="${k}"
      aria-label="${s}: ${fmtMoney(SHEET_SUMS[k])}"><div class="bar" style="height:${h}%;animation-delay:${k*25}ms"></div></button>`;
  }).join("");
  $("chartLabels").innerHTML = SHEETS.map((s, k) => `<span class="${k === selectedSheet ? "sel" : ""}">${s}</span>`).join("");
  showDetail(selectedSheet);
}

function showDetail(k){
  const total = SHEET_SUMS.reduce((a, b) => a + b, 0) || 1;
  $("detailName").textContent = k === 0 ? "2025 archive" : `${MONTH_SHEETS[k-1]} 2026`;
  $("detailVal").textContent = fmtMoney(SHEET_SUMS[k] || 0);
  $("detailSub").textContent = `${fmtInt(SHEET_COUNTS[k] || 0)} bills · ${((SHEET_SUMS[k] || 0) / total * 100).toFixed(1)}% of total`;
}

function selectBar(k){
  selectedSheet = k;
  document.querySelectorAll("#chart .bar-col").forEach((el, i) => el.classList.toggle("sel", i === k));
  document.querySelectorAll("#chartLabels span").forEach((el, i) => el.classList.toggle("sel", i === k));
  showDetail(k);
}

let topPeriod = "all";

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

function route(){
  const onSupplier = location.hash === "#suppliers";
  dashView.hidden = onSupplier;
  svView.hidden = !onSupplier;
  if(onSupplier) renderSupplierView();
  window.scrollTo(0, 0);
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
  return { supplier, invoice, amount, d, errs };
}

// Live feedback while typing: destination tab, "new supplier" tag, duplicate reset
function onBillEdit(){
  const ms = parseLocalMs($("billDate").value);
  const d = ms === null || isNaN(ms) ? null : new Date(ms);
  $("billDest").innerHTML = d && d.getFullYear() === LEDGER_YEAR
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
    BILLS.push({ s: f.supplier, i: f.invoice, a: f.amount, t: f.d.getTime(), k: 1 + f.d.getMonth() });
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
  const tab = MONTH_SHEETS[f.d.getMonth()];
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

const avatar = $("avatar"), menu = $("accountMenu");
function toggleMenu(open){
  menu.classList.toggle("open", open);
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
  tip.innerHTML = `<b>${k === 0 ? "2025 archive" : MONTH_SHEETS[k-1] + " 2026"}</b><span class="num">${fmtMoney(SHEET_SUMS[k])}</span> · ${fmtInt(SHEET_COUNTS[k])} bills`;
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
["installMenuBtn", "installLockBtn", "installBannerBtn"].forEach(id => $(id).addEventListener("click", () => { toggleMenu(false); installApp(); }));
$("installBannerClose").addEventListener("click", dismissBanner);
$("iosClose").addEventListener("click", () => $("iosDialog").close());
$("iosDialog").addEventListener("click", e => { if(e.target === $("iosDialog")) $("iosDialog").close(); });
showInstallOptions();

if("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

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
}
