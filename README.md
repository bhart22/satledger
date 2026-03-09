# SatLedger

Live site: [satledger.com](https://satledger.com)

A personal Bitcoin portfolio tracker that runs entirely in your browser. No server, no backend, no signup — just a single HTML file.

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
- **Google Drive sync** — Optional backup and cross-device sync using Drive's appDataFolder (only this app can access it)
- **Inheritance vault** — Store encrypted notes (seed phrases, instructions) protected by a passphrase
- **Hide values** — One-click privacy toggle blurs all financial data (BTC price charts remain visible)
- **Export** — Full JSON backup/restore and CoinLedger-compatible CSV for tax reporting

### Interface
- **Light & dark themes** — Toggle in the sidebar
- **Responsive design** — Desktop sidebar with collapse, mobile hamburger drawer
- **Expandable charts** — Click any chart to view a larger modal version
- **Customizable settings** — Two-column masonry layout with chart visibility, ordering, MA line toggles, and more

## Tech Stack

- **React 18** with Babel in-browser transpilation
- **Single HTML file** — No build step, no bundler, no dependencies to install
- **SVG charts** — Custom-built charting with no library dependencies
- **Coinbase API** — Daily BTC-USD candles for historical price data
- **Google Identity Services** — OAuth for optional Drive sync
- **CSS custom properties** — Theming with light/dark mode

## Getting Started

1. Open `index.html` in any modern browser — that's it
2. Create your wallets in the **Wallets** tab
3. Log transactions in the **Transactions** tab
4. View your portfolio on the **Dashboard**

Or just open the dashboard to see sample charts previewing all available visualizations.

### Optional: Google Drive Sync

Click the **Sign in with Google** button in the header to enable cloud backup. Your data is stored in Google Drive's app-specific data folder — private and only accessible by SatLedger.

## Hosting

SatLedger is currently hosted at [satledger.com](https://satledger.com).

Since it's a single HTML file, you can also host it anywhere:
- GitHub Pages
- Any static file host
- Open locally from your filesystem

## Tips

If you find SatLedger useful, you can send a Bitcoin tip via the sidebar link:
- **Lightning:** thekidhitman@strike.me
- **On-chain:** `bc1qm0gqys4dkusan8y96c4j4gf05uep648eykq6a43mcwndg56dwvnsmavm5u`

## License

Personal project. All rights reserved.
