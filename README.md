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
