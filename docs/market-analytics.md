# Market Analytics — Architecture

Status: approved design, not yet implemented. Written 2026-11-14 against app version 4.3.

This is the primary architecture document for the Market feature described in
`docs/specs/bitcoin-market-analytics.md`. Where this document and the specification disagree,
**this document wins**: the specification was written for a different kind of application.

Companion documents:

| Document | Covers |
|---|---|
| `docs/market-data.md` | Provider interface, Coinbase, candles, validation, IndexedDB, caching |
| `docs/technical-indicators.md` | Exact formulas, warm-up, no-look-ahead, test method |
| `docs/personal-market-analytics.md` | Transaction overlay, price sources, averages, context, buckets |
| `docs/mobile-chart-ux.md` | Phone layout, touch, navigation, accessibility |
| `docs/market-implementation-plan.md` | Phases 0–9 with acceptance criteria and stop points |

---

## 1. Repository reality versus the specification's assumptions

| Specification assumes | This repository |
|---|---|
| Cloudflare Workers with API routes | Static site on Cloudflare Pages. No Worker, no `functions/`, no wrangler config. Pages publishes the repo root with no build command |
| D1 / KV / R2 / Cache API / Cron | None. All data is in the browser's `localStorage`; optional sync to the user's own Google Drive appDataFolder |
| Server-side authentication and per-user ownership | No accounts and no server. Transactions never leave the browser except to the user's Drive |
| TypeScript strict mode, lint, typecheck | Plain JS and JSX in one file, `app.dev.html`, which must run unbuilt through in-browser Babel. No TypeScript, no linter. The nearest check is `npm run check` (JSX parse) |
| Path routes such as `/market?range=1y` | Hash tabs (`#dashboard`, `#harvest`) matched exactly against `NAV_ITEMS` |
| CI/CD pipeline | None. Pushing to `main` deploys. `app.html` and `version.json` are committed build output |
| A market-data backend to build | The browser already calls Coinbase directly: spot price every 60 s and daily candles in 300-day windows |

Consequences:

- Every "Worker", "API route", "D1", "Cron", "authenticated endpoint", "IDOR" and "SSRF" requirement
  in the specification is **not applicable** and is not built.
- "Run typecheck" means `npm run check`.
- The privacy requirement is restated in §7: it is about what leaves the browser, not about
  server-side authorization.

## 2. Decisions made in this review

| # | Decision | Reason |
|---|---|---|
| D1 | No server component of any kind | Coinbase's public market API is CORS-enabled and already in use. A proxy would be the first server in a product whose README promises none |
| D2 | Keep the single-file `app.dev.html` architecture. No module system, no refactor | Project owner's decision. ES modules also fail on `file://`, which the README supports |
| D3 | No TypeScript | It would break "`app.dev.html` runs as-is" |
| D4 | Coinbase Exchange is the initial provider, behind a `MarketDataProvider` interface | No key, CORS, already allowed by the CSP, and the same source the Dashboard uses |
| D5 | Candles are cached in IndexedDB, never `localStorage` | Intraday history would compete for quota with the authoritative transactions |
| D6 | TradingView Lightweight Charts, self-hosted under `vendor/`, loaded lazily, exact version pinned at implementation time | `script-src 'self'` already covers it; no build or CSP change; works offline |
| D7 | The earliest candle for `ALL` is provider-derived, not a product constant | Project owner's adjustment 1. See `docs/market-data.md` §8 |
| D8 | Three cost concepts are kept distinct in code and UI (§9) | Project owner's adjustment 2 |
| D9 | `PriceSource` reflects actual `price` / `totalUsd` / `fee` semantics; `totalUsd / amount` is never called an execution price | Project owner's adjustment 3. See `docs/personal-market-analytics.md` §3 |
| D10 | Average Acquisition Price = purchases **including acquisition fees** plus rewards at their USD value at receipt. The calculation is configurable (`include`, `feeMode`) so a separate future metric, Average Purchase Price, needs no rewrite | Project owner's decision. With no sales it reconciles with Dashboard Average Cost |
| D18 | Until a pre-provider all-time-high seed is verified from an authoritative source and covered by a test, nothing is labelled "All-Time High"; the labels are "High since <date>" and "Drawdown from High since <date>" | Project owner's decision. See `docs/technical-indicators.md` §12 |
| D19 | Recalled provider and library behaviour is not authoritative. Phase 2 begins by verifying Coinbase against its official documentation; Phase 4 begins by verifying Lightweight Charts. The design documents are corrected before code is written | Project owner's decision |
| D11 | Mobile bottom navigation becomes horizontally scrollable; Market is second; the active item scrolls into view | Project owner's adjustment 7 |
| D12 | A golden CoinLedger CSV regression test exists before any Market code | Hard safety requirement |
| D13 | Market preferences are per-device view settings, excluded from Drive sync | Otherwise each indicator toggle queues a push and can raise a sync conflict |
| D14 | Routing is `#market?range=…&interval=…`; no transaction data in the URL | Matches existing hash routing; privacy |
| D15 | Transaction context always uses completed daily candles | No look-ahead; independent of the interval on screen |
| D16 | Cut from the first milestone: VWAP, crossover events, presets, the quantitative data table, market CSV export, synchronized timeline | The specification's 60-item milestone is too large for a deploy-on-push repository |
| D17 | Work happens on a branch; `main` receives merges at phase boundaries | Pushing to `main` deploys |

## 3. Functionality being reused

All of these exist today in `app.dev.html`. Market code calls them and does not reimplement them.

| Existing | Used for |
|---|---|
| `compareTx`, `txInstant`, `isNoonPlaceholder`, `dayKeyUTC`, `normalizeDate` | Ordering and timing of transactions |
| `txPortfolioDelta`, `txWalletDeltas` | Balance semantics (the single source of balance rules) |
| `toSatsInt` | Integer-satoshi accumulation |
| `hasUsdValue`, `USD_VALUE_SOURCE_LABELS` | Reward receipt value and its provenance |
| `numOr`, `fmtBTC`, `fmtUSD`, `fmtTxDate`, `btcUnit` | Parsing and display |
| `btcPrice`, `priceUpdatedAt`, `fetchPrice` (60 s poll) | Current price and its freshness |
| The `fetchWithRetry` pattern in the historical price effect | Retry and backoff shape for the provider |
| `normalizeSettings`, `SETTINGS_TYPE_GUARDS`, `DEVICE_VIEW_SETTING_KEYS`, `updateSettings` | Storing preferences |
| `Modal`, `useModalA11y`, `ExpandedChartOverlay`, `InfoTip`, `ErrorBoundary` | Dialogs, expanded chart, help text, crash containment |
| `handleEdit` | "View Transaction" opens the existing edit dialog; no second editor |
| `values-hidden` class | Hide-values toggle applies to personal numbers in the Market view |
| CSS custom properties | Light and dark chart themes |
| `tools/test/lib/harness.mjs`, the helper-region extraction | Node and headless-Chrome tests |

Left untouched: `btc-price-history-v1` (the gap-filled daily close map), `buildMovingAverageSeries`,
`DashboardCharts`, `SVGChart`, `exportCSV`, `applyTxToCostPool`, `buildLots`, `harvestLots`.

## 4. Feature architecture

```
                    ┌──────────────────────────── helper region (pure, Node-testable) ─┐
 Coinbase ──fetch──▶│ MarketData  ──▶ Candles ──▶ Indicators                            │
                    │      │              │            │                                │
                    │      │              └────────────┼──▶ PersonalMarket ◀── transactions (read-only)
                    └──────┼───────────────────────────┼──────────┼─────────────────────┘
                           ▼                           ▼          ▼
                  MarketCandleStore (IndexedDB)      MarketView (React)
                                                         │
                                                    ChartAdapter ──▶ Lightweight Charts
```

Rules of the arrows:

- `Candles` and `Indicators` know nothing about transactions.
- `PersonalMarket` reads transactions and candles and returns new derived objects. It never writes.
- `MarketView` never parses a provider response and never computes an indicator formula.
- Only `ChartAdapter` touches the chart library.
- Nothing in this feature calls or is called by `exportCSV`, `applyTxToCostPool` or `buildLots`.

## 5. Single-file implementation strategy

Everything is added to `app.dev.html`. The file has three relevant zones:

1. **Helper region** — between the line containing `const { useState, useEffect` and the
   `─── SVG Icons` marker. Tests slice this region out and evaluate it in Node, so code here
   must be plain JS with no JSX and no DOM access at definition time.
2. **Component zone** — after the icons, before `function App()`.
3. **`App`** — state, navigation and the render tree.

New sections, each introduced by a `// ─── Market: <name> ───` banner in the existing style:

| Zone | Section | Global name |
|---|---|---|
| Helper region (end, just before `─── SVG Icons`) | Market: Candles | `const Candles = { … }` |
| Helper region | Market: Data | `const MarketData = { … }` |
| Helper region | Market: Indicators | `const Indicators = { … }` |
| Helper region | Market: Personal | `const PersonalMarket = { … }` |
| Helper region | Market: Preferences | `normalizeMarketPrefs`, `parseMarketHash`, `formatMarketHash` |
| Component zone | Market: Candle store | `MarketCandleStore` |
| Component zone | Market: Chart adapter | `createChartAdapter` |
| Component zone | Market: View | `function MarketView(props)` and small child components |
| `App` | Navigation, hash parsing, `tab==='market'` branch, row action | — |
| `<style>` | Market CSS, prefixed `.mkt-` | — |

Conventions:

- The helper region is one flat scope with roughly 150 names. New pure code is exposed through the
  four namespace objects above so it cannot collide. Private helpers live inside an IIFE that
  returns the object.
- Functions that perform I/O take their dependency as a parameter (`fetchImpl`, `now`, `store`)
  so Node tests can supply fakes.
- Do not rename or move the two helper-region marker lines.
- Never edit `app.html` or `version.json`; run `npm run build` and commit both.

## 6. Namespace responsibilities

**`Candles`** — the candle model `{ t, o, h, l, c, v }` (`t` = bucket start, UTC seconds), interval
table, validation, aggregation, gap detection, UTC bucket arithmetic, range and interval rules,
request caps. No I/O. Specified in `docs/market-data.md`.

**`MarketData`** — the `MarketDataProvider` interface, `createCoinbaseProvider({ fetchImpl })`, the
provider registry, and `createMarketDataService({ provider, store, now })` which does paging,
caching, retry, supersede tokens and backfill. Specified in `docs/market-data.md`.

**`Indicators`** — a registry of definitions `{ id, name, category, defaults, validate, warmup,
calculate }` plus `returns`, `drawdown` and `previousAth` helpers. Pure functions over arrays.
Specified in `docs/technical-indicators.md`.

**`PersonalMarket`** — normalization of transactions for the chart, price-source resolution,
balance history, Average Acquisition Price, marker aggregation, context at a transaction,
acquisition buckets. Read-only over its inputs. Specified in `docs/personal-market-analytics.md`.

## 7. ChartAdapter

`createChartAdapter(container, { theme })` wraps Lightweight Charts and is the only code that
references the library's global. `MarketView` talks to it through this surface:

| Method | Purpose |
|---|---|
| `setCandles(candles, { formingIndex })` | Main candlestick series; the forming candle is styled distinctly |
| `updateLast(candle)` | Incremental update of the forming candle |
| `setVolume(points \| null)` | Volume histogram in the price pane's lower band |
| `setOverlay(id, points, style)` / `removeOverlay(id)` | Lines on the price pane: SMA, EMA, Bollinger, average acquisition |
| `setPane(id, series[], opts)` / `removePane(id)` | A synchronized pane: RSI, MACD, ATR, volatility, BTC balance |
| `setMarkers(markers)` | Transaction markers on the candle series |
| `setScale('linear' \| 'log')` | Price scale mode |
| `setVisibleRange(from, to)`, `fit()`, `scrollToTime(t)` | Navigation |
| `onCrosshair(cb)`, `onVisibleRange(cb)`, `onMarkerClick(cb)` | Events, delivered as plain data |
| `setTheme(theme)`, `resize()` | Theme change and container resize |
| `destroy()` | Removes the chart, its `ResizeObserver` and all listeners |

Rules:

- The adapter receives and emits plain arrays and objects. No library type crosses the boundary.
- Loading: a `loadChartLibrary()` function injects one `<script src="vendor/…">` tag on first
  open of the Market tab and resolves a shared promise. A load failure renders an error state
  with a retry button, never a blank area.
- `MarketView` creates the adapter in an effect and calls `destroy()` in its cleanup.
- Version: at implementation time, verify the current stable release, pin the exact version in
  the vendored filename (`vendor/lightweight-charts-<x.y.z>.standalone.production.js`), commit
  the upstream `LICENSE` and `NOTICE` beside it, and satisfy the attribution requirement
  (keep the library's attribution logo enabled, or add the required notice and link to the
  page). Do not reference an unpinned major version anywhere.

## 8. IndexedDB architecture

Database `satledger-market`, version 1, opened lazily on first Market use. Full structure is in
`docs/market-data.md` §12. Principles:

- Holds only public market data. It is not synced to Drive, not included in backups and not
  touched by reset-of-transactions flows other than an explicit "Clear cached market data".
- Only native provider intervals are stored; derived intervals are computed on read.
- If IndexedDB is unavailable (private browsing, blocked storage), the store falls back to an
  in-memory map with the same interface and the UI shows no error.
- Opening or upgrading the database must never block or delay the rest of the app.

## 9. Terminology — four different numbers

These are not interchangeable and must never share a label. Use exactly these terms in code
comments, documentation, tests and UI.

| Term | Where | Definition | Changes when you sell? |
|---|---|---|---|
| **Average Acquisition Price** | Market tab | Purchases including applicable acquisition fees, plus rewards at their USD value at receipt, divided by the BTC acquired. `PersonalMarket.avgAcquisition` with default options | No |
| **Average Purchase Price** | Not shown in the first version; reserved | Purchases only, at their pre-fee price: no fees, no rewards. The same function with `{ include: ['Buy'], feeMode: 'exclude' }` | No |
| **Dashboard Average Cost** | Dashboard (existing) | Average-cost pool, `applyTxToCostPool`. Sells and outflows remove basis proportionally; burned network fees raise it | Yes |
| **Tax-Lot Cost Basis** | Harvest (existing) | Per-wallet lots, `buildLots`, HIFO or FIFO per wallet | Yes, by lot |

With no sales, no outflow transfers and no burned network fees, Average Acquisition Price
reconciles with Dashboard Average Cost (given matching reward valuations). That is a tested
property, not a reason to share code or a label.

Requirements:

- The Market tab shows "Average Acquisition Price" only. The words "cost basis", "tax",
  "gain", "loss", "realized" and "unrealized" do not appear in the Market tab.
- "Average Purchase Price" is not used for anything until that metric is built; it must never
  be used as a synonym for Average Acquisition Price.
- The difference between current price and Average Acquisition Price is labelled
  "Difference", not gain.
- An `InfoTip` beside Average Acquisition Price reads:
  "An analytical weighted average of what your BTC cost to acquire — purchases at what you
  paid including fees, rewards at their USD value when received. Sales do not change it. It is
  not tax cost basis; see Harvest for tax lots and the Dashboard for Average Cost."
- "Dashboard Average Cost" is this documentation's name for the existing Dashboard figure.
  Existing Dashboard and Harvest UI labels are not renamed by this feature.

## 10. Transaction and accounting boundary

- **No duplicate storage.** Transactions stay in `btc-tx-v2` and in `App` state. Market code
  receives the array as a prop and derives view objects in memory. Nothing transaction-derived
  is written to IndexedDB or `localStorage`.
- **No new transaction fields.** `BACKUP_SCHEMA_VERSION` stays 2.
- **Do not modify** `exportCSV`, `applyTxToCostPool`, `buildLots`, `harvestLots`,
  `sellFromCostPool`, `rewardPriceFor` or `backfillRewardUsd` for this feature.
- **Balance semantics** come from `txPortfolioDelta` / `txWalletDeltas`. The one permitted change
  is adding an optional `toUnits` parameter to `txPortfolioDelta` (default `numOr`), mirroring
  the parameter `txWalletDeltas` already has, so satoshi accumulation uses the same rules.
  Existing callers must behave identically; `tools/test/helpers.mjs` proves it.
- **BTC totals** accumulate as integer satoshis via `toSatsInt`. Floats are used only for chart
  coordinates and USD prices.
- **Internal transfers** (both wallets named) are net-zero for the portfolio apart from the
  network fee, and are never counted as acquisitions or disposals.
- `PersonalMarket` functions are tested with deep-frozen input to prove they do not mutate.

## 11. Privacy boundary

- Market requests carry only: product symbol, granularity, and a time window.
- Time windows are **interval-aligned fixed pages** (`docs/market-data.md` §6), never a window
  centred on, starting at or ending at a transaction time.
- The URL hash may contain range, interval, scale and indicator settings. It never contains a
  transaction id, amount, wallet name or date derived from a transaction.
- "View on Chart" passes the transaction id through React state.
- Market preferences are stored under `settings.market`, guarded in `SETTINGS_TYPE_GUARDS`, and
  listed in `DEVICE_VIEW_SETTING_KEYS` so they are not pushed to Drive.
- No transaction detail is written to the console, even under `btc-debug`.
- Personal figures in the Market view honour the hide-values toggle.

## 12. Loading and caching strategy (summary)

1. Read the requested window from IndexedDB and render immediately if anything is there.
2. Fetch only missing pages, plus the most recent two buckets.
3. Completed candles are immutable and cached indefinitely; the forming candle is never stored.
4. Each change of range or interval gets a new token and `AbortController`; a late response
   from a superseded request is discarded.
5. At most 4 requests in flight; 429 and 5xx retry with backoff.
6. Full daily history is backfilled in the background on first Market use, because weekly
   candles, SMA 200, previous ATH and transaction context all need it.
7. The forming candle is updated from the existing 60 s spot poll.
8. States shown: skeleton, loading history, updating, partial, stale, error. Never a blank area.

Details: `docs/market-data.md`.

## 13. Mobile architecture (summary)

- Bottom navigation scrolls horizontally; Market is second; the active item scrolls into view.
- A persistent readout above the chart replaces hover tooltips.
- Toolbar scrolls horizontally; indicator settings open in a bottom sheet.
- At most two indicator panes in portrait.
- Landscape and "expand" use a full-bleed overlay.
- Vertical drags scroll the page; horizontal drags pan the chart; pinch zooms.

Details: `docs/mobile-chart-ux.md`.

## 14. Files

Created:

- `vendor/lightweight-charts-<x.y.z>.standalone.production.js`, `vendor/LICENSE-lightweight-charts`, `vendor/NOTICE-lightweight-charts`
- `tools/test/market-data.mjs`, `tools/test/market-indicators.mjs`, `tools/test/market-personal.mjs`
- `tools/test/fixtures/btc-usd-1d.json`, `tools/test/fixtures/coinledger-golden-input.json`, `tools/test/fixtures/coinledger-golden.csv`

Modified:

- `app.dev.html` (and generated `app.html`, `version.json`)
- `sw.js` (precache the vendor file; bump `CACHE_NAME`)
- `package.json` (`test` script runs the three new test files)
- `tools/test/browser.mjs` (golden export test; Market sections)
- `README.md`, `CLAUDE.md`, `index.html` (version footer at release)

Not modified: `_headers`, the CSP `connect-src` (Coinbase hosts are already allowed),
`tools/build.mjs`, `manifest.json`.

## 15. Important risks

| Risk | Mitigation |
|---|---|
| Pushing to `main` deploys unfinished work | Branch per phase; merge at phase boundaries; Market tab appears only from Phase 4 |
| Regressing CoinLedger export | Phase 0 golden test, re-run in every later phase |
| `localStorage` quota pressure on authoritative data | Candles only in IndexedDB |
| Each preference change triggering a Drive push or conflict | `market` in `DEVICE_VIEW_SETTING_KEYS`; browser test asserts `btc-pending-push` is not set |
| Chart instance leaking across tab switches | `destroy()` in effect cleanup; `ResizeObserver` disconnected |
| A throw in the Market view blanking the whole app | Dedicated `ErrorBoundary` around `MarketView` |
| Coinbase omitting candles for buckets with no trades | Gap detection; gaps are never forward-filled for indicators |
| Look-ahead in "at the time" values | Single completed-daily-candle rule; tests mutate later candles and assert no change |
| Wrong "previous ATH" before the provider's first candle | Documented seed, or "unavailable" (`docs/technical-indicators.md` §12) |
| Three similar averages confusing the user | §9 labels and help text |
| Legacy rows with no time of day misplaced on intraday charts | "Date only" handling (`docs/personal-market-analytics.md` §2) |
| In-browser Babel slower as the file grows by roughly 3,000 lines | Affects `app.dev.html` only; the deployed build is precompiled |
| Library licence obligations | Pinned version; `LICENSE`, `NOTICE` and attribution committed in Phase 4 |
| Service worker serving a stale shell after the precache list changes | Bump `CACHE_NAME` in the phase that changes the list |

## 16. Facts to verify at implementation time

These were recalled, not checked against live documentation, during the design review. They
are not authoritative. Each is verified against the official source at the start of the phase
named, and the design documents are corrected **before** code is written.

| When | What | Document to correct |
|---|---|---|
| Start of Phase 2 | Coinbase: supported candle granularities; maximum candles per request; returned row ordering; product stats endpoint behaviour; historical availability; rate limits; CORS behaviour | `docs/market-data.md` |
| Start of Phase 4 | Lightweight Charts: current stable version; standalone browser build; pane APIs; series marker APIs; exact-price marker capability; logarithmic scale API; touch behaviour relevant to `docs/mobile-chart-ux.md`; licence; NOTICE requirements; attribution requirements | This document §7 (and the `ChartAdapter` surface if the API requires it), `docs/mobile-chart-ux.md` |
| Phase 8 | Pre-provider all-time-high seed: value, date, authoritative source, test | `docs/technical-indicators.md` §12 |
