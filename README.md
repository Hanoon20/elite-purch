# Purchase Ledger

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
