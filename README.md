# Elite Colour World — Purchase Ledger

A single-file, live purchase dashboard that reads straight from a private Google Sheet, secured with Google Sign-In (read-only scope).

## Run / deploy
It's one static file (`index.html`). Host it anywhere static — e.g. **GitHub Pages** (Settings → Pages → deploy from branch, root).
Add the hosting origin (e.g. `https://<user>.github.io`) to **Authorized JavaScript origins** of the OAuth client in Google Cloud Console.

Access requires both: the Google account is a Test user on the OAuth consent screen **and** has Viewer access to the Sheet.

## Performance
- **1 request instead of 13** — all sheets fetched with `values:batchGet` (falls back to per-sheet if a tab is missing).
- **Instant repeat loads** — last data is cached in `sessionStorage` and painted immediately, then refreshed in the background.
- Data and user-email lookups run in parallel; preconnect hints for Google APIs; non-blocking font loading.
- All KPIs computed in a single pass; suppliers pre-indexed for fast finder lookups; no layout-thrashing text auto-fit loops (CSS container units instead).
- Token expiry tracked — expired sessions return to the sign-in screen instead of a reload loop.
- Supplier names are HTML-escaped.

## Add bill
**Add bill** (a button in the header on desktop, a floating button on phones) opens a form: Supplier (searchable, or add a new one), Amount, Invoice no., Bill date.

- The bill is saved in the **month tab of its date** (e.g. 15 Sep 2026 → `Sep`). Only 2026 dates are accepted (`LEDGER_YEAR`).
- It goes in the first free row after the last bill. Only **columns A–D** are written, and each new cell copies the number format of the bill above it. Other columns (formulas, notes) are never touched.
- The tab is re-read right before writing, and a matching supplier + invoice pair triggers a **duplicate warning**.
- Write permission is requested only the first time someone presses **Add bill**. Just viewing the dashboard stays read-only.

**One-time setup to enable saving:**
1. Google Cloud Console → *OAuth consent screen* → *Data access / Scopes*: add `https://www.googleapis.com/auth/spreadsheets`.
2. Everyone who adds bills needs **Editor** access on the Sheet. Viewers can still see the dashboard, and they get a clear message if they try to save.

## Install as an app
The dashboard is an installable web app (PWA) with the Elite Colour World icon.
- **Android / Chrome / Edge (phone or PC):** open the site and tap **Install**. The button is on the sign-in screen, in the account menu and on a banner on phones. Chrome's own "Install app" menu item also works.
- **iPhone / iPad:** open the site in **Safari → Share → Add to Home Screen**. The app shows these steps too.

Files: `manifest.webmanifest` (name, icon, colours), `sw.js` (service worker: caches only this site's own files; Google sign-in and Sheet data always come live from Google), `icons/`.

## Security
- **Who can see data:** only Google accounts on the OAuth *Test users* list **and** shared on the Sheet. Google enforces both checks. Keep the Sheet's *General access* set to **Restricted**.
- **Content-Security-Policy:** only `app.js` and Google's sign-in script can run, and data can only be sent to Google. No inline scripts.
- **Auto-lock:** after 30 minutes idle, or when the 1-hour Google session ends, the app wipes the token and the cached data and returns to sign-in.
- **No storage beyond the session:** the token and data live in `sessionStorage` (cleared when the tab or app closes). The service worker never caches Google data.
- **Can't be embedded:** the page blanks itself if loaded inside another site's frame.
- Supplier names are HTML-escaped, and values are written to the Sheet as plain values (never formulas).
