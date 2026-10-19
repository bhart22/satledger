# SatLedger

Live site: [satledger.com](https://satledger.com)

A personal Bitcoin portfolio tracker that runs entirely in your browser. No server, no backend, no signup — just a single HTML file.
<img width="1892" height="979" alt="screenshot example" src="https://github.com/user-attachments/assets/4a8d0ca5-8efb-4e50-929f-92e25a30bc6a" />

## Features

### Portfolio Tracking
- **Transaction types** — Buy, Sell, Transfer, Reward, and Consolidation
- **Multi-wallet support** — Track holdings across exchanges, hardware wallets, and cold storage
- **Wallet archiving** — Archive inactive wallets without losing historical data
- **Exclude from stats** — Flag specific transactions to exclude from cost basis calculations

### Dashboard & Charts
- **Accumulated BTC** — Total holdings over time with BTC price overlay
- **Average Cost Basis** — Running average cost per BTC with current price reference line
- **USD Holdings Value** — Portfolio value using daily BTC closes from Coinbase
- **DCA Tracker** — Buy amounts over time as a bar chart
- **Realized vs Unrealized P&L** — Profit & loss with break-even reference line
- **Cumulative Fee Burn** — Total BTC lost to network fees (Transfer/Consolidation only)
- **Reward Income** — Cumulative staking and earn rewards
- **Monthly Summary** — Monthly buy volume bar chart
- **BTC Price & Moving Averages** — 50-day, 200-day, and 200-week MAs with toggleable lines
- **Sample charts** — Preview all visualizations with sample data before adding transactions
- **Chart controls** — Reorder, show/hide, and expand any chart; date range filters (3M, 6M, 1Y, 5Y, YTD, All, Custom)

### Data & Privacy
- **100% client-side** — All data stored in browser localStorage
- **Google Drive sync** — Optional backup and cross-device sync using Drive's appDataFolder (only this app can access it). A recovery snapshot is kept before anything replaces local data, and can be downloaded or restored from **Export → Recovery Snapshot**. If both devices changed independently, you're asked which copy to keep rather than one silently winning
- **Inheritance vault** — Store encrypted notes (seed phrases, instructions) protected by a passphrase (AES-256-GCM, PBKDF2-SHA256 at 600k iterations)
- **Hide values** — One-click privacy toggle blurs all financial data (BTC price charts remain visible)
- **Export** — Full JSON backup/restore and CoinLedger-compatible CSV for tax reporting
- **Hardened delivery** — Content-Security-Policy, version-pinned CDN scripts with Subresource Integrity, OAuth tokens kept in sessionStorage only

### Interface
- **Light & dark themes** — Toggle in the sidebar
- **BTC or sats display** — Show amounts in bitcoin or satoshis (Settings → Display Unit)
- **Responsive design** — Desktop sidebar, mobile bottom navigation and hamburger drawer
- **Keyboard & screen reader support** — All dialogs trap focus, close on Escape, and restore focus; charts and icon-only controls carry accessible names
- **Expandable charts** — Click any chart to view a larger modal version
- **Customizable settings** — Two-column masonry layout with chart visibility, ordering, MA line toggles, and more
- **Offline support** — Service worker caches the app and its dependencies, so it loads without a connection (live prices still need network)

- **Crash recovery** — If the app fails to start or a render throws, you get a page with a "Download my data" button rather than a blank screen

## Tech Stack

- **React 18** from version-pinned CDN scripts with SRI
- **Single HTML file** — `app.dev.html` runs as-is (in-browser Babel); `npm run build` compiles it into the deployed `app.html`
- **SVG charts** — Custom-built charting with no library dependencies
- **Coinbase API** — Daily BTC-USD candles for historical price data
- **Google Identity Services** — OAuth for optional Drive sync
- **CSS custom properties** — Theming with light/dark mode

### Tests & optional tooling

**Edit `app.dev.html`, never `app.html`.** `app.dev.html` is the source and runs as-is in a browser
(JSX is transpiled in-page by Babel), so day-to-day editing still needs no build. `app.html` is
generated from it by `npm run build`: esbuild compiles the JSX ahead of time, so visitors skip the
~3 MB Babel download and the multi-second transpile on every cold start, and the CSP can pin
`script-src` to hashes instead of allowing `'unsafe-eval'`/`'unsafe-inline'`. The build also writes
`version.json`, which lets open tabs offer a reload after a deploy. Commit `app.html` and
`version.json` with every change; `npm test` fails if they are stale.

```bash
npm install          # devDependencies only

npm run build        # app.dev.html → app.html + version.json (commit both)
npm run check        # parse the JSX block (a syntax error = blank page, so check first)
npm test             # check + build is current + pure-function tests (balances, cost basis, CSV, MA oracle)
npm run test:browser # end-to-end smoke test in headless Chrome (SATLEDGER_PAGE=app.dev.html for the source)
npm run test:sw      # service worker behind Cloudflare-style redirects, online and offline
npm run test:all     # everything

npm run images       # regenerate the small logo variants from the full-res masters
npm run qr           # regenerate the Tip Jar QR PNGs (re-run if a tip address changes)
```

`npm test` needs no browser and takes a couple of seconds. It extracts the pure helpers
straight out of `app.dev.html`, so there is no duplicated copy to drift, and it keeps the original
naive moving-average implementation as an oracle to prove the fast version returns identical
numbers. `npm run test:browser` drives real Chrome over the DevTools protocol — no Puppeteer —
and skips cleanly if no browser is installed (set `CHROME_PATH` to point at one).

## Getting Started

1. Open `index.html` (or `app.dev.html`) in any modern browser — that's it
2. Create your wallets in the **Wallets** tab
3. Log transactions in the **Transactions** tab
4. View your portfolio on the **Dashboard**

Or just open the dashboard to see sample charts previewing all available visualizations.

### Optional: Google Drive Sync

Click the **Sign in with Google** button in the header to enable cloud backup. Your data is stored in Google Drive's app-specific data folder — private and only accessible by SatLedger.

## Hosting

SatLedger is currently hosted at [satledger.com](https://satledger.com).

It deploys automatically: Cloudflare Pages publishes the repository root from GitHub on every push
to `main`, with no build command (the built `app.html` is committed). `_headers` sets the HTTP
headers a `<meta>` tag can't, notably `frame-ancestors 'none'`. Pages also redirects `/app.html`
to `/app`; the service worker is written for that, and `npm run test:sw` covers it.

Since it's a static site, you can also host it anywhere:
- GitHub Pages
- Any static file host
- Open locally from your filesystem

### Deploying updates

Pages are served network-first by the service worker, so content changes to `app.html`/`index.html` propagate on the next load automatically. However, if you change the caching logic **or the precache list** in `sw.js`, bump the `CACHE_NAME` constant (e.g. `satledger-v2` → `satledger-v3`) so the new worker evicts the old cache on activation.

The precache list is split into `CRITICAL_URLS` (atomic — if these can't be fetched the install *should* fail) and `OPTIONAL_URLS` (added individually, so one blocked CDN can't silently disable offline support altogether).

## Tips

If you find SatLedger useful, you can send a Bitcoin tip via the sidebar link:
- **Lightning:** thekidhitman@strike.me
- **On-chain:** `bc1qm0gqys4dkusan8y96c4j4gf05uep648eykq6a43mcwndg56dwvnsmavm5u`

## License

Personal project. All rights reserved.
