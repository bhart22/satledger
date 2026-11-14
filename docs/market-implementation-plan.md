# Market Analytics — Implementation Plan

Dependency-ordered phases for building the Market feature. Read `CLAUDE.md` and
`docs/market-analytics.md` first; the other design documents are referenced per phase.

## How to use this plan

- **One phase per session.** Do not start the next phase in the same change. Do not combine phases.
- **Work on a branch.** Pushing to `main` deploys the site. Use `market/phase-N-<slug>`; merge
  to `main` only when the phase's acceptance criteria are met and the owner agrees.
- **Source of truth is `app.dev.html`.** Never edit `app.html` or `version.json`; run
  `npm run build` and commit both outputs with the source change.
- **Pure logic goes in the helper region** (between `const { useState, useEffect` and
  `─── SVG Icons`). No JSX and no DOM access at definition time there.
- **Never modify** `exportCSV`, `applyTxToCostPool`, `buildLots`, `harvestLots`,
  `sellFromCostPool`, `rewardPriceFor`, `backfillRewardUsd`, `buildMovingAverageSeries`.
- **Commit style:** subject line, then prose paragraphs explaining the change and the
  reasoning. No bullet lists in commit messages.
- If the code and a design document disagree, stop and update the document (or ask) before
  writing code around the disagreement.
- "Commands that must pass" are run at the end of the phase, in the order given, with no
  failures. `npm run test:browser` and `npm run test:sw` exit 0 with a "skipping" message when
  no Chrome or Edge is found; **a skip is not a pass** — set `CHROME_PATH` and run them for real.

Status of each phase is tracked by ticking its heading here when it is merged.

| Phase | Title | UI visible to users |
|---|---|---|
| 0 | Safety net / golden CoinLedger export test | No |
| 1 | Candle model, validation, aggregation, gaps, range/interval rules | No |
| 2 | MarketData provider + IndexedDB store | No |
| 3 | Technical indicators | No |
| 4 | Market UI / chart foundation | Yes — Market tab appears |
| 5 | Indicator overlays/panes + preferences | Yes |
| 6 | PersonalMarket core | No |
| 7 | Personal transaction overlay UI | Yes |
| 8 | Historical transaction context + quantitative acquisition analytics | Yes |
| 9 | Mobile/accessibility/offline/hardening | Yes |

---

## ✅ Phase 0 — Safety net / golden CoinLedger export test

**Objective.** Lock the current CoinLedger CSV output byte-for-byte before any Market code
exists, so every later phase can prove it did not change tax export behaviour. This is a hard
safety requirement.

**Exact scope.**
- Add a fixed input fixture `tools/test/fixtures/coinledger-golden-input.json`: wallets and
  transactions covering every export branch — Buy and Sell with and without a fee; Buy with
  blank `totalUsd` (falls back to amount × price); Transfer with both wallets, source only and
  destination only, with and without a BTC fee; Consolidation with and without a fee; Reward
  with and without `usdValueAtReceipt`; an `excludeStats` row; a legacy row at the 12:00 UTC
  placeholder and a row with a real time; two rows at the same instant with different
  `sequence`; notes and wallet names beginning with `=`, `+`, `-`, `@`; a note containing a
  comma, a double quote and a newline; rows in two calendar years; an amount with 8 decimals
  and one with trailing zeros.
- Add `tools/test/fixtures/coinledger-golden.csv`: the output the **current, unmodified** app
  produces for that fixture for "all years", plus a second golden for one year filter.
- Add a `[CoinLedger export is unchanged]` section to `tools/test/browser.mjs`: seed
  `localStorage` with the fixture, reload, capture the CSV, compare to the golden as exact
  text (including CRLF line endings).
- Capture method: before triggering the export, replace `URL.createObjectURL` in the page with
  a wrapper that stores the `Blob`; trigger the export through the UI (Export tab → the
  CoinLedger "all" card, and the per-year card); read the stored blob with `blob.text()`.
  `downloadBlob` is not modified.
- The golden is generated once by running the current app, then **read by a human** against
  the fixture before being committed. The test must fail if the golden file is missing; it must
  not regenerate it.
- No change to `app.dev.html`.

**Likely files/sections affected.** `tools/test/browser.mjs`; two new files under
`tools/test/fixtures/`. Nothing else.

**Dependencies.** None.

**Tests required.** The new browser section. Deliberately break it once locally (change one
character of the golden) to confirm it fails, then restore.

**Acceptance criteria.**
1. `git diff --stat` shows no change to `app.dev.html`, `app.html`, `version.json`, `sw.js`.
2. The fixture exercises every branch of `exportCSV` listed above.
3. The golden CSV matches the app's output exactly for "all years" and for one year filter.
4. A one-character change to either golden makes `npm run test:browser` fail.
5. The test passes against both `app.html` and `SATLEDGER_PAGE=app.dev.html`.
6. All pre-existing tests pass.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
SATLEDGER_PAGE=app.dev.html npm run test:browser
```

**Explicit stop point.** Stop after the golden test is committed on its branch. Do not add
any Market code, constants, navigation entries or documentation edits beyond ticking this phase.

---

## ✅ Phase 1 — Candle model, validation, aggregation, gaps, range/interval rules

**Objective.** A pure, tested `Candles` namespace that every later phase builds on.

**Exact scope.** Implement, per `docs/market-data.md` §1–2, §5–6, §9–12:
- `Candles.INTERVALS`, `Candles.RANGES`, `MAX_VIEW_CANDLES`, `MAX_NATIVE_CANDLES`.
- `normalizeRow`, `validate`, `bucketStart` (including Monday-anchored weeks), `isComplete`.
- `aggregate` with the `partial` flag and the downsampling refusal.
- `findGaps`.
- `rangeStart`, `defaultInterval`, `allowedIntervals`, `pageBounds` / `pagesFor`.
- Create `tools/test/market-data.mjs` and add it to the `test` script in `package.json`.
- Add the fixture `tools/test/fixtures/btc-usd-1d.json` (a real slice of provider daily
  candles, at least 400 consecutive days, fetched once and committed).

No fetch, no IndexedDB, no UI, no navigation entry.

**Likely files/sections affected.** `app.dev.html` helper region — new
`// ─── Market: Candles ───` section placed immediately before `─── SVG Icons`;
`tools/test/market-data.mjs` (new); `tools/test/fixtures/btc-usd-1d.json` (new);
`package.json`; generated `app.html`, `version.json`.

**Dependencies.** Phase 0.

**Tests required.** The "Normalization", "Validation", "Bucketing", "Aggregation", "Gaps",
"Range rules" and "Paging" items of `docs/market-data.md` §20.

**Acceptance criteria.**
1. `Candles` is defined in the helper region and loadable through the existing extraction
   (`tools/lib/app-helpers.mjs` pattern) with no JSX and no DOM access at definition time.
2. Every OHLC inequality, non-finite value, non-positive price, misaligned timestamp and
   duplicate is rejected with a reason; output is strictly ascending.
3. Weekly buckets start Monday 00:00 UTC, verified for a known date and across a year boundary.
4. `aggregate` matches hand-computed values for 15m→30m, 1h→4h and 1d→1w, flags partial
   buckets, and throws when asked to produce a smaller interval.
5. `allowedIntervals` reproduces every worked example in `docs/market-data.md` §10, including
   the `1d` exception.
6. Generated page windows are always page-aligned.
7. The real-data fixture passes validation with zero rejections.
8. No existing behaviour changes: the app renders as before and the golden export test passes.
9. No name is added to the helper region's top-level scope other than `Candles`.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when `Candles` and its tests are committed. Do not write a
provider, a store, or any component.

---

## ✅ Phase 2 — MarketData provider + IndexedDB store

**Objective.** Fetch, page, cache and serve validated candles, with no UI.

**Exact scope.** Per `docs/market-data.md` §3–4, §7–8, §14–19:
- **Verification gate — do this first, before any provider code.** Recalled Coinbase
  behaviour is not authoritative. Against current official Coinbase documentation (and a
  manual browser request for CORS and history), verify: supported candle granularities;
  maximum candles per request; returned row and column ordering; product stats endpoint
  behaviour; historical availability and what an out-of-range request returns; rate limits;
  CORS behaviour. Update `docs/market-data.md` wherever verified behaviour differs — including
  the interval table, page size, caps and earliest-candle discovery — and add the dated
  "Verified" note with URLs. Commit the documentation correction before the implementation.
- `MarketData.createCoinbaseProvider({ fetchImpl })` implementing the interface.
- `MarketData.providers` registry and `MarketData.createMarketDataService({ provider, store, now, sleep })`
  with: paging, the 4-request concurrency limit, retry/backoff, supersede tokens and abort,
  cache-first reads, the "newest two buckets" refresh, derived-interval assembly, partial
  results, earliest-candle discovery, and the resumable daily backfill.
- `MarketData.createMemoryStore()` (in the helper region; used by tests and as the fallback).
- `MarketCandleStore` (component zone): IndexedDB `satledger-market` v1 with stores `candles`,
  `coverage`, `meta`; same interface as the memory store; falls back to memory on any failure.
- Extend `tools/test/market-data.mjs`.

No UI, no navigation entry, nothing calls the service yet.

**Likely files/sections affected.** `app.dev.html` helper region — new
`// ─── Market: Data ───`; component zone — new `// ─── Market: Candle store ───`;
`tools/test/market-data.mjs`; `docs/market-data.md` (corrections only); generated outputs.

**Dependencies.** Phase 1.

**Tests required.** The "Provider" and "Service" items of `docs/market-data.md` §20, all with a
fake `fetchImpl`, an injected clock and the memory store. No test performs real network I/O.
One browser check that `MarketCandleStore` round-trips a few candles in headless Chrome and
that the app still boots when `indexedDB.open` is made to fail.

**Acceptance criteria.**
0. `docs/market-data.md` carries a dated "Verified" note with documentation URLs covering all
   seven verification items, and no remaining [verify] marker contradicts the code.
1. Provider maps rows by the verified column order and returns ascending, validated candles.
2. A second identical view request performs zero fetches for completed pages.
3. 429 and 5xx are retried with backoff and honour `Retry-After`; other 4xx are not retried.
4. A failed page leaves a partial result, is not recorded in `coverage`, and is retried on the
   next load.
5. A response belonging to a superseded token never reaches the caller.
6. Earliest candle is discovered from the provider (two consecutive empty older pages) and
   stored in `meta`; no product-level date constant is consulted to decide where `ALL` begins.
7. Backfill resumes from its saved position and writing the same page twice is harmless.
8. No request window is ever anything other than a page-aligned window.
9. With IndexedDB unavailable, the memory fallback is used and nothing throws.
10. No transaction data is passed to, or reachable from, any `MarketData` function.
11. The golden export test passes.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when the provider, service and store are committed and tested.
Do not add a Market tab or load a chart library.

---

## ✅ Phase 3 — Technical indicators

**Objective.** A pure, documented, tested `Indicators` namespace.

**Exact scope.** Per `docs/technical-indicators.md` §1–12, §14:
- The definition registry and `calculateSegmented`.
- SMA, EMA, RSI (Wilder), MACD, Bollinger Bands (with %B and band width), ATR, historical
  volatility.
- `Indicators.returns` (simple, log, period returns, average and median daily return),
  `Indicators.drawdown`, `Indicators.previousAth` with `ATH_SEED` support, and
  `Indicators.athLabels`. `ATH_SEED` is `null` in this phase; seeded behaviour is tested with
  a seed passed in as an argument, not by setting the constant.
- Settings validation.
- Create `tools/test/market-indicators.mjs` and add it to the `test` script.

No UI. The Dashboard's `buildMovingAverageSeries` is not touched.

**Likely files/sections affected.** `app.dev.html` helper region — new
`// ─── Market: Indicators ───`; `tools/test/market-indicators.mjs` (new); `package.json`;
generated outputs.

**Dependencies.** Phase 1.

**Tests required.** Everything in `docs/technical-indicators.md` §14: naive oracle,
hand-computed vector and (where one with the same definition exists) a cited published example
for each indicator; structural checks; causality; segmentation; Dashboard RSI and SMA
compatibility.

**Acceptance criteria.**
1. Each indicator's output matches its naive oracle within `1e-9` relative on the fixture and
   on seeded random series.
2. Each indicator has at least one hand-computed vector with the arithmetic shown in the test.
3. Warm-up counts equal the documented values (SMA `N-1`, EMA `N-1`, RSI `N`, MACD line
   `slow-1`, signal `slow+signal-2`, Bollinger `N-1`, ATR `N`, volatility `N`).
4. No output contains `NaN`, `Infinity` or `0` standing in for "undefined".
5. RSI(14) rounded to one decimal equals the Dashboard's `rsi14` at every index of the test
   series; SMA(50) and SMA(200) rounded to two decimals equal `ma50d` and `ma200d`.
6. Causality test passes for every indicator.
7. Bollinger uses divisor `N`; volatility uses divisor `N-1` and a 365-day year.
8. Inputs are never mutated (deep-frozen input).
9. `docs/technical-indicators.md` describes every formula the code uses; any deviation found
   while implementing is resolved in the document first.
10. The golden export test passes.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when `Indicators` and its tests are committed. Do not draw
anything.

---

## ✅ Phase 4 — Market UI / chart foundation

**Objective.** A working Market tab: live price header, candlesticks, volume, range and
interval selection, zoom/pan, crosshair readout, log scale, expanded view. No indicators yet,
no personal data.

**Exact scope.**
- **Verification gate — do this first, before any chart code.** Recalled library behaviour is
  not authoritative. From the official Lightweight Charts repository and documentation,
  verify: current stable version; the standalone browser build and its global name; pane
  APIs; series marker APIs; whether a marker can be placed at an exact price; the logarithmic
  scale API; touch behaviour relevant to `docs/mobile-chart-ux.md` §4 (vertical drag, pinch,
  long press); licence; NOTICE requirements; attribution requirements. Record the findings and
  the exact version in `docs/market-analytics.md` §7. If the API requires a change to the
  planned `ChartAdapter` surface or to the mobile gesture design, update
  `docs/market-analytics.md` and `docs/mobile-chart-ux.md` **before** implementing, and commit
  that documentation change first.
- **Chart library:** vendor the verified version's standalone production build as
  `vendor/lightweight-charts-<x.y.z>.standalone.production.js`; commit the upstream `LICENSE`
  and `NOTICE` under `vendor/`; implement the attribution that version's licence requires.
  Verify the library runs under the app's CSP (no `eval`).
- `loadChartLibrary()` (lazy, single shared promise, error state with retry).
- `createChartAdapter` with: `setCandles`, `updateLast`, `setVolume`, `setScale`,
  `setVisibleRange`, `fit`, `scrollToTime`, `onCrosshair`, `onVisibleRange`, `setTheme`,
  `resize`, `destroy` (`docs/market-analytics.md` §7). Overlay, pane and marker methods may be
  stubs until Phases 5 and 7.
- `MarketView`: price header (current price from existing `btcPrice`; 24 h change from
  `get24HourStats`; freshness line), range row, toolbar (interval, Linear/Log, Expand),
  persistent readout, chart, loading/partial/stale/error/offline states
  (`docs/mobile-chart-ux.md` §12), forming-candle handling, older-history loading on pan.
- Its own `ErrorBoundary`.
- Navigation: add `{ key:'market', label:'Market', icon:… }` as the **second** `NAV_ITEMS`
  entry; add the icon; make the mobile bottom navigation horizontally scrollable with the
  active item scrolled into view (`docs/mobile-chart-ux.md` §1).
- Routing: tab detection compares `location.hash.slice(1).split('?')[0]` in both the initial
  state and the `hashchange` listener; the tab-sync effect must not strip a `?…` suffix while
  the tab is `market`.
- Start the daily backfill after the first view loads.
- `sw.js`: add the vendored file to `OPTIONAL_URLS`; bump `CACHE_NAME`.
- Hook the service to the real store and provider.

Not in scope: indicators, preferences persistence beyond in-memory state, URL parameters,
transactions.

**Likely files/sections affected.** `app.dev.html` — `<style>` (`.mkt-*`, bottom-nav rules),
`Icon`, `NAV_ITEMS`, component zone (`Market: Chart adapter`, `Market: View`), `App` (tab
state, hash handling, `tab==='market'` branch, bottom-nav effect); `vendor/` (new); `sw.js`;
`tools/test/browser.mjs`; `tools/test/sw.mjs` if the precache change needs coverage;
`docs/market-analytics.md` (pinned version); generated outputs.

**Dependencies.** Phases 1 and 2. (Phase 3 is not required but should already be merged.)

**Tests required.** New browser sections, with Coinbase requests intercepted through the
DevTools `Fetch` domain and answered from fixtures (no test hook in production code, no real
network):
- Market tab opens from sidebar, bottom nav and `#market`.
- Candles render (the chart container has non-zero size and the adapter reports the expected
  candle count through a test-readable DOM attribute such as `data-candles`).
- Changing range and interval issues only page-aligned requests and updates the count.
- Rapid range changes: the final state reflects the last selection.
- Log toggle, Expand and close.
- Provider failure → error state with Retry; stale state after advancing the clock.
- Library load failure → error state; the rest of the app still works.
- Bottom nav: Market is second; activating the last item scrolls it into view.
- Leaving and re-entering the tab ten times leaves exactly one chart instance.
- All pre-existing sections, including the golden export test, pass.

**Acceptance criteria.**
1. Exact chart-library version pinned in the filename and recorded in the architecture
   document; `LICENSE` and `NOTICE` committed; attribution requirement met and described in
   the commit message.
2. `tools/build.mjs` is unchanged and `npm run build` succeeds; no CSP directive is loosened.
3. Market tab shows current price, 24 h change from the stats endpoint, candles and volume
   labelled "Volume (Coinbase)".
4. All ten ranges are selectable; only allowed intervals are enabled; defaults match the table.
5. Zoom, pan, fit and reset work with mouse and keyboard; the crosshair updates the readout
   with date/time (UTC), O, H, L, C, change and volume.
6. The forming candle is visually distinct and labelled.
7. Every state in `docs/mobile-chart-ux.md` §12 has a visible representation; there is no
   blank chart area in any of them.
8. `ALL` uses the provider-discovered earliest candle.
9. Tab switches do not leak chart instances, observers or listeners.
10. A throw inside `MarketView` shows the Market error boundary and leaves other tabs usable.
11. Bottom navigation scrolls horizontally, Market is second, the active item is in view.
12. Existing hash navigation for every other tab behaves as before.
13. `npm run test:sw` passes with the new precache entry and cache name.
14. The golden export test passes.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
npm run test:sw
```

**Explicit stop point.** Stop when the Market tab shows a working candle chart. Do not add
indicators, saved preferences, URL parameters or transaction markers.

---

## Phase 5 — Indicator overlays/panes + preferences

**Objective.** Indicators on the chart, a quantitative summary, and preferences that persist
per device and in the URL.

**Exact scope.**
- Adapter: implement `setOverlay`/`removeOverlay` and `setPane`/`removePane` with synchronized
  time range, pan, zoom and crosshair.
- Indicators UI: toggle panel grouped by category; settings (period, source, multiplier) with
  validation; SMA (20/50/100/200 and custom), EMA (12/21/50/200 and custom), Bollinger Bands as
  overlays; RSI, MACD, ATR, Historical Volatility as panes; Volume show/hide.
- Readout shows each enabled indicator's value at the crosshair; provisional values on the
  forming candle are marked.
- Quantitative summary (Market tab below the chart): selected range return, range high/low,
  52-week high/low, "High since <date>" and "Drawdown from High since <date>" (labels come
  from `Indicators.athLabels`; all-time-high wording is not used until a seed is verified in
  Phase 8), SMA 50 and SMA 200 with distance,
  RSI 14, ATR, 30-day volatility, maximum and current drawdown — all from `Indicators`.
- Indicator computation memoized by (candle series identity, settings); recomputed only when
  either changes, not on crosshair or UI events.
- Preferences: `normalizeMarketPrefs`; `settings.market` with a `SETTINGS_TYPE_GUARDS` entry;
  `'market'` added to `DEVICE_VIEW_SETTING_KEYS`.
- URL state: `parseMarketHash` / `formatMarketHash` for
  `#market?range=1y&interval=1d&scale=log&sma=50,200&ema=21&rsi=14&macd=12,26,9&bb=20,2&atr=14&hv=30&vol=1`.
  URL values override stored preferences on load; invalid values fall back silently; the hash
  is updated with `history.replaceState`.

Not in scope: transactions, VWAP, crossover events, presets, data table, CSV export.

**Likely files/sections affected.** `app.dev.html` — helper region (`Market: Preferences`),
`SETTINGS_TYPE_GUARDS`, `DEVICE_VIEW_SETTING_KEYS`, `Market: Chart adapter`, `Market: View`,
`<style>`; `tools/test/helpers.mjs` or `market-data.mjs` (preference and hash functions);
`tools/test/browser.mjs`; generated outputs.

**Dependencies.** Phases 3 and 4.

**Tests required.**
- Node: `normalizeMarketPrefs` drops wrong-typed and out-of-range values; hash round-trip;
  hostile hash input (very long, wrong types, unknown keys) yields defaults.
- Browser: enabling each indicator adds its overlay or pane; panes follow pan and zoom;
  preferences survive a reload; a hash with parameters configures the chart; **toggling an
  indicator does not set `btc-pending-push` and does not change `btc-last-modified`**; summary
  values match values computed in the test from the same fixture.

**Acceptance criteria.**
1. SMA, EMA and Bollinger render as overlays; RSI, MACD, ATR and Historical Volatility render
   in synchronized panes that share time range, pan, zoom and crosshair.
2. Indicator values in the readout equal `Indicators` output for the crosshair candle.
3. No indicator formula exists outside the `Indicators` namespace.
4. Summary figures use the definitions in `docs/technical-indicators.md` §11–12; unavailable
   values show "—". The strings "All-Time High" and "ATH" do not appear in the UI; the high is
   labelled "High since <earliest verified provider date>".
5. Range, interval, scale, enabled indicators and their settings persist across reloads on the
   same device.
6. Changing any Market preference causes no Drive push, no dirty marker and no change to the
   commit stamp; `withoutViewSettings` removes `market`.
7. A settings object with a malformed `market` value (from Drive or a backup) does not throw.
8. URL parameters configure the view and never contain personal data.
9. Crosshair movement does not recompute indicators (verified by a counter in the test or by
   inspection of the memo dependencies).
10. The golden export test and all earlier tests pass.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when indicators, summary, preferences and URL state work. Do not
read transactions in any Market code.

---

## Phase 6 — PersonalMarket core

**Objective.** The pure join between transactions and market data, fully tested, with no UI.

**Exact scope.** Per `docs/personal-market-analytics.md` §1–9:
- **First, re-verify** §3 of that document (the semantics of `price`, `totalUsd` and `fee`)
  against the current code, and correct the document if the code has changed.
- `PersonalMarket.PRICE_SOURCE`, `toChartTransactions`, price resolution and all-in figures.
- Add the optional `toUnits` parameter to `txPortfolioDelta` (default `numOr`). No other change
  to existing accounting code.
- `balanceHistory`, `avgAcquisition` (with `include`, `feeMode`, `upToSec`),
  `PersonalMarket.AVG_PRESETS` (`ACQUISITION_PRICE` = Buy + Reward, fees included;
  `PURCHASE_PRICE` = Buy only, fees excluded — the future Average Purchase Price, tested here,
  no UI), `avgAcquisitionSeries`, `rangeSummary`, `aggregateMarkers`, filter application.
- Create `tools/test/market-personal.mjs` and add it to the `test` script.

No UI, no component reads these functions yet.

**Likely files/sections affected.** `app.dev.html` helper region — `txPortfolioDelta`
(signature only) and new `// ─── Market: Personal ───`; `tools/test/market-personal.mjs` (new);
`tools/test/helpers.mjs` (assert unchanged default behaviour of `txPortfolioDelta`);
`package.json`; `docs/personal-market-analytics.md` (corrections only); generated outputs.

**Dependencies.** Phases 1 and 3.

**Tests required.** `docs/personal-market-analytics.md` §15, items: read-only, normalization,
PriceSource, precision, transfers, balance history, Average Acquisition Price, step series,
aggregation.

**Acceptance criteria.**
1. Every function runs on deep-frozen input without throwing and without mutation.
2. `PriceSource` resolution matches the table in §3; nothing in code or strings calls
   `totalUsd / amount` an execution price.
3. All BTC totals are integer satoshis; a test demonstrates exactness where float addition of
   the same amounts is inexact.
4. An internal transfer changes the balance by exactly `−fee` satoshis and contributes to no
   acquired, sold or invested total.
5. `txPortfolioDelta(tx)` with one argument returns the same values as before for every case
   in the existing helper tests.
6. Average Acquisition Price includes purchase fees and includes rewards at receipt value;
   the `PURCHASE_PRICE` preset yields Average Purchase Price (no fees, no rewards) through the
   same function; unknown-value rows are left out of numerator and denominator; a Sell does
   not change either result. The four terms of `docs/market-analytics.md` §9 are used exactly
   in code comments and test names.
7. On a buys-and-rewards-only history the default result equals the cost pool's
   `cost / btc`; with a Sell added they differ, and a test asserts both.
8. `exportCSV`, `applyTxToCostPool` and `buildLots` are textually unchanged
   (`git diff` shows no hunk inside them).
9. Marker aggregation merges by bucket and category, separates at smaller intervals and
   respects `maxMarkers`.
10. The golden export test and all earlier tests pass.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when `PersonalMarket` core and its tests are committed. Do not
render markers.

---

## Phase 7 — Personal transaction overlay UI

**Objective.** The user's transactions on the chart, with navigation both ways.

**Exact scope.**
- Adapter: `setMarkers`, `onMarkerClick`; exact-price placement where the pinned library
  supports it, otherwise above/below bar.
- "Show My Transactions" toggle; category filters (Purchases, Sales, Rewards on; Transfers
  off); wallet filter.
- Marker rendering with the shape/text semantics of `docs/personal-market-analytics.md` §9;
  hollow style for estimated positions; zoom-aware aggregation.
- Marker selection: member list for aggregated markers; detail panel
  (`docs/personal-market-analytics.md` §11) without the market-context block (Phase 8).
- **View Transaction:** switches to the Transactions tab and calls the existing `handleEdit`.
- **View on Chart:** a new action in each transaction row (desktop table and mobile card);
  focus request held in `App` state; `MarketView` centres, highlights and opens the panel.
- Average Acquisition Price: figure, help text (exact wording in
  `docs/market-analytics.md` §9), overlay with Current and Historical (step) modes, and the
  "current price versus Average Acquisition Price" block labelled "Difference".
- BTC Balance pane from `balanceHistory`.
- "My Activity" selected-range summary.
- Hide-values applies to all personal figures.
- Extend `settings.market` with `showTx`, category filters, wallet filter, `avgLine` mode,
  `balancePane`.

Not in scope: market context at a transaction, acquisition buckets.

**Likely files/sections affected.** `app.dev.html` — `Market: Chart adapter`, `Market: View`,
`normalizeMarketPrefs`, `App` (focus state, handlers passed to `MarketView`, the two
transaction-row action groups), `Icon` (one icon for "View on Chart"), `<style>`;
`tools/test/browser.mjs`; generated outputs.

**Dependencies.** Phases 5 and 6.

**Tests required.** Browser sections on a seeded fixture:
- Markers appear for buys, sells and rewards; transfers hidden by default and shown when
  enabled; filters work.
- Several transactions in one candle show one marker with a count; a smaller interval
  separates them.
- Selecting a marker opens the panel with amount, USD value, price and the correct source label.
- "View Transaction" opens the existing edit dialog for that transaction.
- "View on Chart" from a row lands on the Market tab with that marker highlighted; the URL
  contains no transaction id; every intercepted candle request is page-aligned.
- Average Acquisition Price shown equals a value computed in the test; the help text is present;
  the strings "cost basis", "gain" and "loss" do not occur in the Market tab's text.
- Balance pane's final value equals total holdings.
- Hide-values blurs personal figures and leaves the chart visible.
- With no transactions, the Market tab works and personal sections show an empty state.
- Golden export test passes.

**Acceptance criteria.**
1. Acquisition, disposal and reward markers are distinguishable by shape and text, not colour
   alone; estimated positions are visibly different.
2. Transfers are hidden by default and, when shown, are never counted as acquired or sold.
3. Overlapping transactions aggregate without clutter and expand on selection or zoom.
4. The detail panel shows BTC, satoshis, USD value, price, price source, wallet(s), fee and notes.
5. Navigation works in both directions and uses the existing editor; the Market module
   contains no transaction form.
6. No transaction id, amount, wallet or transaction-derived time appears in the URL or in any
   network request (asserted over all intercepted requests).
7. "Average Acquisition Price" is the only label used; its help text matches the specified
   wording; the difference block uses "Difference".
8. The historical step line changes only at acquisitions.
9. Balance history is internally integer satoshis and matches holdings.
10. Editing or deleting a transaction updates markers and figures without reload.
11. No transaction-derived data is written to IndexedDB or to any new `localStorage` key.
12. The golden export test and all earlier tests pass.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when the overlay, navigation, Average Acquisition Price and
balance pane work. Do not add context values or bucket tables.

---

## Phase 8 — Historical transaction context + quantitative acquisition analytics

**Objective.** What the market looked like at each transaction, and how the user's
acquisitions distribute across market conditions — with no look-ahead.

**Exact scope.**
- **ATH seed verification — do this first.** Find the highest BTC-USD price before the
  provider's earliest verified daily candle, with its date, from an authoritative source that
  can be cited. Only if such a source is found: record value, date and source in
  `Indicators.ATH_SEED`, in the code comment and in `docs/technical-indicators.md` §12; add a
  test covering the seeded calculation with that value; tell the owner which source was used.
  That, and only that, switches the labels to "All-Time High" / "Previous ATH". If no
  authoritative source is found, leave the seed `null`, keep "High since <date>" and
  "Drawdown from High since <date>" everywhere, and report that outcome to the owner. Never
  enter a value from memory.
- `PersonalMarket.contextAt` and the daily indicator cache
  (`docs/technical-indicators.md` §13; `docs/personal-market-analytics.md` §12).
- Market-context block in the transaction detail panel: SMA 20/50/200, RSI 14, MACD, ATR,
  Bollinger position, 30-day volatility, previous ATH, drawdown from it, distance from SMA 50
  and SMA 200.
- `PersonalMarket.bucketAcquisitions` and the tables of
  `docs/personal-market-analytics.md` §13: by price range, versus SMA 50, versus SMA 200, trend
  state, RSI ranges, drawdown ranges — each with BTC, count, share and an Unknown bucket.
- A "My Activity" section holding the range summary and these tables as accessible `<table>`s.
- Context waits for the daily backfill; while incomplete, affected values show a loading state,
  not a wrong number.

**Likely files/sections affected.** `app.dev.html` — helper region (`Market: Personal`,
`Indicators.ATH_SEED`), `Market: View`, `<style>`; `tools/test/market-personal.mjs`;
`tools/test/market-indicators.mjs`; `tools/test/browser.mjs`;
`docs/technical-indicators.md` (seed record); generated outputs.

**Dependencies.** Phases 3, 6 and 7.

**Tests required.** `docs/personal-market-analytics.md` §15 items "Context / no look-ahead" and
"Buckets"; `docs/technical-indicators.md` §14 previous-ATH and seed checks; a browser check that
the panel shows context values equal to values computed in the test from the fixture, and that
the tables' totals equal acquired BTC.

**Acceptance criteria.**
1. For every context value, replacing all candles on or after the transaction's UTC day with
   arbitrary data leaves the value unchanged (automated test, all values).
2. The transaction's own daily candle and the forming candle are never read by `contextAt`.
3. Legacy date-only rows produce context from the previous completed day.
4. Warm-up, gaps and unknown prices yield "—", never zero or a neighbouring value.
5. The high used for context comes only from fully closed candles (plus a verified seed if
   one exists). All-time-high wording appears only when the seed is verified from a cited
   authoritative source and covered by a test; otherwise every such label reads
   "High since <earliest verified provider date>" / "Drawdown from High since <date>", in the
   summary, the context panel and the drawdown buckets.
6. Each bucket table sums exactly, in satoshis, to total acquired BTC including the Unknown
   bucket; boundaries are lower-inclusive.
7. Buckets exclude `excludeStats` rows, sells and all transfers.
8. Nothing in the UI grades a transaction or presents an indicator state as a recommendation.
9. The ATH seed's value, date and source are recorded in code and documentation, or its
   absence is explicitly reported.
10. The golden export test and all earlier tests pass.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
```

**Explicit stop point.** Stop when context and bucket analytics are complete. Do not begin
mobile polish, VWAP, presets, exports or any item from the deferred list.

---

## Phase 9 — Mobile/accessibility/offline/hardening

**Objective.** Bring the feature to release quality on phones, for keyboard and screen-reader
users, and offline; then document and version it.

**Exact scope.**
- Mobile: everything in `docs/mobile-chart-ux.md` not already done — bottom sheets for
  indicators, filters and detail; two-pane limit in portrait; landscape and expanded layout;
  `touch-action` handling and long-press inspection; 44 px targets; readout layout at 360 px.
- Accessibility: `docs/mobile-chart-ux.md` §10 — roles, labels, keyboard control of the chart,
  live region, "View as table", contrast in both themes, reduced motion.
- Offline and resilience: cached chart with offline banner; library precached; stale badges;
  IndexedDB-unavailable path; "Clear cached market data" in Settings.
- Performance: no indicator recomputation on UI events; marker aggregation under load
  (2,000 transactions); chart creation deferred until the container has a size.
- Documentation: update `README.md` (feature list, tech stack, attribution), `CLAUDE.md`
  (Market sections, helper-region namespaces, vendor file, IndexedDB), and tick this plan.
- Version: bump `APP_VERSION` and the footer in `index.html` together.
- `sw.js`: bump `CACHE_NAME` again if the precache list or caching logic changed in this phase.

Not in scope: anything on the deferred list (`docs/market-analytics.md` D16), real-time
WebSocket transport, additional providers.

**Likely files/sections affected.** `app.dev.html` — `<style>`, `Market: View`,
`Market: Chart adapter`, Settings tab (clear-cache control), `APP_VERSION`; `index.html`;
`sw.js`; `README.md`; `CLAUDE.md`; `tools/test/browser.mjs`; `tools/test/sw.mjs`; generated
outputs.

**Dependencies.** Phases 4, 5, 7 and 8.

**Tests required.**
- Browser at a 390 × 844 viewport and at 844 × 390: bottom nav scroll and active-item
  visibility; toolbar scroll; sheet open/close and focus trap; pane limit; expanded layout.
- Browser keyboard: chart focus, arrow movement updates the live region, Enter opens a marker,
  Escape exits.
- Browser offline: with cached candles and the network disabled, the chart renders with the
  offline banner; with no cache, a message renders and other tabs work.
- Service worker: vendored library served from cache offline; `/app` still loads offline.
- Load: 2,000 synthetic transactions render markers within the marker cap and the tab stays
  responsive (time a range change in the test and fail above a generous threshold).
- The manual check list in `docs/mobile-chart-ux.md` §13, performed and noted in the commit
  message or PR description.
- Full regression: every earlier section, including the golden export test.

**Acceptance criteria.**
1. Every item in `docs/mobile-chart-ux.md` §13 is checked in portrait and landscape.
2. A vertical swipe that starts on the chart scrolls the page.
3. Pinch zoom, touch pan, long-press inspection and marker taps work without a floating
   tooltip covering data.
4. Every Market control is operable by keyboard with a visible focus indicator; the chart is
   navigable by keyboard; no information is available only through the canvas.
5. Contrast requirements are met in light and dark themes.
6. Offline with cache shows saved data marked as such; offline without cache shows a message;
   in neither case is old data presented as live.
7. With IndexedDB unavailable the feature works for the session.
8. "Clear cached market data" empties `satledger-market` and nothing else.
9. `APP_VERSION` and the `index.html` footer match.
10. `README.md` and `CLAUDE.md` describe the feature, the vendored library and its
    attribution, and the new test files.
11. All 60 items of the specification's first production milestone are either satisfied or
    listed as deliberately changed in `docs/market-analytics.md` §1–2.
12. `npm run test:all` passes with a real browser (not skipped).
13. The golden export output is byte-identical to Phase 0.
14. Every pre-existing feature — Dashboard, Transactions, Wallets, Harvest, Vault, Export,
    Settings, Drive sync — behaves as before.

**Commands that must pass.**
```
npm run check
npm test
npm run build
npm run test:browser
npm run test:sw
npm run test:all
```

**Explicit stop point.** Stop when the feature is merged and the version is bumped. Deferred
items (VWAP, crossover events, presets, data table, market CSV export, synchronized timeline,
purchase-only average in the UI, real-time transport, additional providers) each need their
own approved plan before any work starts.

---

## Open items carried by this plan

| Item | Resolved in |
|---|---|
| Coinbase: granularities, page limit, row order, stats endpoint, historical availability, rate limits, CORS | Phase 2 verification gate |
| Lightweight Charts: version, standalone build, pane and marker APIs, exact-price markers, log scale, touch behaviour, licence, NOTICE, attribution | Phase 4 verification gate |
| `price` / `totalUsd` / `fee` semantics still as documented | Phase 6 (re-verify first) |
| ATH seed value, date and authoritative source | Phase 8 verification; "High since <date>" labels until then |

Decided and closed: Average Acquisition Price includes purchase fees and rewards at receipt
value; Average Purchase Price is a reserved future metric; single-file architecture; mobile
navigation; provider-derived `ALL`. No owner decision is outstanding for Phase 0.
