# Personal Market Analytics

Part of the Market Analytics design; see `docs/market-analytics.md`.
Code lives in the helper region of `app.dev.html` as `const PersonalMarket = { … }` and is
tested by `tools/test/market-personal.mjs`.

This module joins the user's transactions to market history. It is analytics only. It is not
tax accounting, and it must not be wired into the tax paths in either direction.

---

## 1. The canonical records

Transactions live in `localStorage['btc-tx-v2']` and in `App` state. That is the only copy.

- `PersonalMarket` functions receive the `transactions` array as an argument and return new
  objects. They never mutate a transaction, the array, or a wallet.
- Nothing derived from transactions is persisted: not to `localStorage`, not to IndexedDB, not
  to Drive.
- No field is added to the transaction schema. `BACKUP_SCHEMA_VERSION` stays 2.
- Callers pass the full transaction list. Like the Dashboard charts, the Market view is not
  filtered by the active-wallet selection unless the user applies a Market wallet filter (§10).

Stored transaction fields (all amounts are decimal **strings**):

```
id, date (UTC day), datetimeUtc (ISO), sequence (int), type, wallet, wallet2,
amount, price, fee, totalUsd, notes, txhash, excludeStats,
usdValueAtReceipt, usdValueSource, rewardCategory        (Reward rows)
```

Types: `Buy`, `Sell`, `Transfer`, `Reward`, `Consolidation`. There are no other types and none
are added.

## 2. Normalization

`PersonalMarket.toChartTransactions(transactions, { candlesDaily, nowSec })` returns
`{ items, skipped: { noTime, badType } }`: `items` holds one object per usable transaction,
sorted with `compareTx`:

```js
{
  id,                    // the transaction's own id — the only link back
  tSec,                  // floor(txInstant(tx) / 1000)
  dateOnly,              // true when isNoonPlaceholder(tx): the time of day was never recorded
  category,              // 'ACQUISITION' | 'DISPOSAL' | 'REWARD' | 'TRANSFER_INTERNAL' | 'SENT' | 'RECEIVED' | 'FEE_ONLY'
  type,                  // original type, unchanged
  sats,                  // toSatsInt(tx.amount)
  feeSats | feeUsd,      // see §4 — the fee unit depends on the type
  price,                 // resolved USD per BTC, or null
  priceSource,           // §3
  usdValueSource,        // Reward with REWARD_RECEIPT_VALUE: the row's usdValueSource, else ''
  usdValue,              // §3, or null
  allIn,                 // §3 all-in per-BTC figure, or null
  excludeStats,          // copied
  wallet, wallet2,       // copied
}
```

- Rows with no finite instant (`txInstant` not finite) are skipped and counted in `noTime`; a
  type outside the five is skipped and counted in `badType`.
- `candlesDaily` supplies the daily closes for `HISTORICAL_MARKET_LOOKUP`. Only completed
  candles are used: one flagged `partial`, or (when `nowSec` is given) one whose day has not
  ended, is the forming candle and its close is not that day's close.
- A Transfer naming neither wallet is `TRANSFER_INTERNAL`, because `txPortfolioDelta` treats it
  as fee-only.
- `dateOnly` rows are positioned by day. On an intraday chart they attach to the first candle
  of their UTC day and the detail panel shows "Time not recorded" instead of 12:00.
- `notes` and `txhash` are not copied; the detail panel reads them from the original record
  by id when it is opened.

## 3. `price`, `totalUsd` and `fee` — actual repository semantics

Established by reading the transaction form, the CoinLedger importer, the cost pool, the lot
engine and the CoinLedger exporter in `app.dev.html`. Re-verified against the code on
2026-11-14 at the start of Phase 6: unchanged.

**Buy and Sell**

- The form couples three fields: editing `amount` or `price` sets
  `totalUsd = (amount × price).toFixed(2)`; editing `totalUsd` sets
  `price = (totalUsd / amount).toFixed(2)`.
- `fee` is a **separate USD amount**. It is not inside `totalUsd`.
  - Buy basis everywhere is `totalUsd + fee` (`applyTxToCostPool`, `buildLots`).
  - Sell proceeds everywhere are `totalUsd − fee`.
  - The CoinLedger export writes `totalUsd` as the USD amount and `fee` in its own column.
- So `totalUsd` is the **pre-fee trade value**, and `price` is the **pre-fee unit price**.
- Either field can be blank on imported rows. Existing code reads the value as
  `numOr(tx.totalUsd, amount × price)`.
- `price` and `totalUsd / amount` can differ slightly: each is rounded to cents when derived
  from the other, and imported rows may carry independent values.
- CoinLedger import: `totalUsd` is the USD leg of the Trade row and `price` is that divided by
  the BTC amount. Whether that USD leg was itself net or gross of exchange fees depends on the
  file the user imported; the app cannot tell and treats it as pre-fee.

**Reward**

- `usdValueAtReceipt` (string, 6 decimals) is the USD value when received.
  `usdValueSource` is `manual`, `price_lookup` (daily close at receipt) or `estimated_backfill`.
- `price` is not shown on the form for rewards but can exist on older rows.
- Existing code already treats rewards two ways: the lot engine uses `usdValueAtReceipt`, then a
  price lookup; the cost pool uses `tx.price`, then the daily close (`rewardPriceFor`). Neither
  is changed.

**Transfer and Consolidation**

- `fee` is in **BTC** (network fee). `price` and `totalUsd` are unused.
- Consolidation `amount` is optional and informational; only the fee affects balances.

### PriceSource model

```js
PersonalMarket.PRICE_SOURCE = {
  RECORDED_UNIT_PRICE:        'recorded_unit_price',
  DERIVED_TRANSACTION_VALUE:  'derived_transaction_value',
  REWARD_RECEIPT_VALUE:       'reward_receipt_value',
  HISTORICAL_MARKET_LOOKUP:   'historical_market_lookup',
  UNKNOWN:                    'unknown',
};
```

Resolution, first match wins:

| Type | Order | Source | `price` | UI label |
|---|---|---|---|---|
| Buy, Sell | 1 | `RECORDED_UNIT_PRICE` | `tx.price` when `> 0` | "Recorded price (before fees)" |
| Buy, Sell | 2 | `DERIVED_TRANSACTION_VALUE` | `totalUsd / amount` when both `> 0` | "Implied price: total ÷ amount (before fees)" |
| Reward | 1 | `REWARD_RECEIPT_VALUE` | `usdValueAtReceipt / amount` when `hasUsdValue(tx)` and amount `> 0` | "Value at receipt" plus the `USD_VALUE_SOURCE_LABELS` text for `usdValueSource` |
| Reward | 2 | `RECORDED_UNIT_PRICE` | `tx.price` when `> 0` | "Recorded price" |
| Any of the above | last | `HISTORICAL_MARKET_LOOKUP` | close of the daily candle for the transaction's UTC day | "Estimated from that day's closing price" |
| Transfer, Consolidation | — | `HISTORICAL_MARKET_LOOKUP` | same daily close, used only to place an optional marker | "Day's closing price (for reference)" |
| — | — | `UNKNOWN` | `null` | "Price unknown" |

Rules:

- The phrase "execution price" is not used anywhere. `price` and `totalUsd / amount` are
  pre-fee unit prices; the UI says "before fees".
- The detail panel also shows, for Buy and Sell with a fee, the **all-in** figure:
  Buy `(totalUsd + fee) / amount`, labelled "Cost per BTC including fees"; Sell
  `(totalUsd − fee) / amount`, labelled "Net per BTC after fees".
- `usdValue`: Buy/Sell `numOr(tx.totalUsd, amount × price)` (the same expression the rest of
  the app uses); Reward `usdValueAtReceipt`, else `amount × price`, else `amount ×` the day's
  close (the same order as §7's `usdIn`, so the panel and the average never disagree; the row's
  `priceSource` says it is an estimate); otherwise `null`. A value that is not positive is
  `null`, never $0, so a stored `usdValueAtReceipt` of `0` is not a receipt value and
  resolution falls through to the next source.
- `HISTORICAL_MARKET_LOOKUP` uses the same-day daily close. That close is later than the
  transaction, so it is an **estimate of value**, clearly labelled, and is never described as
  the price the user got. It is used for marker placement and reward valuation only, never as
  an input to the "known at the time" context in §12.
- A marker whose source is `HISTORICAL_MARKET_LOOKUP` or `UNKNOWN` is drawn in a distinct,
  translucent style so that estimated positions are distinguishable without reading the panel,
  is never placed at an exact price, and the readout says "position estimated" when it is
  selected. (Phase 7: the pinned Lightweight Charts 5.3.0 markers plugin fills every shape and
  has no outline-only option, so "hollow" is realised as a translucent fill.)
- When the daily candle is missing, the source is `UNKNOWN`.

## 4. BTC precision

- Every BTC quantity inside `PersonalMarket` is an **integer number of satoshis**, obtained
  with the existing `toSatsInt` (`Math.round(numOr(v) × 1e8)`).
- Sums, differences and bucket totals are integer arithmetic. JavaScript integers are exact to
  2^53, far above 21 million BTC in satoshis.
- Conversion to BTC happens once, at display, through `fmtBTC`.
- Floats are permitted for: USD values, prices, percentages and chart coordinates. The balance
  pane converts satoshis to a float BTC value for plotting only.
- No rounding of a stored amount, and no write-back.
- Ratios (percentage of acquisitions, weighted averages) divide satoshi integers and USD
  floats at the end; the satoshi totals they are built from remain exact.

## 5. Classification and transfers

Derived from the existing balance rules; no second rule set.

| Transaction | Category | Marker by default | Counts as acquired | Counts as disposed |
|---|---|---|---|---|
| Buy | `ACQUISITION` | shown | yes | — |
| Sell | `DISPOSAL` | shown | — | yes |
| Reward | `REWARD` | shown | yes (reward) | — |
| Transfer, both wallets named | `TRANSFER_INTERNAL` | hidden | no | no |
| Transfer, source wallet only | `SENT` | hidden | no | no |
| Transfer, destination wallet only | `RECEIVED` | hidden | no | no |
| Consolidation | `FEE_ONLY` | hidden | no | no |

- **Internal transfers** move BTC between the user's own wallets. They are never an acquisition
  or a disposal. Their only portfolio effect is the network fee leaving.
- `SENT` reduces the balance by amount + fee and `RECEIVED` increases it by the amount, exactly
  as `txPortfolioDelta` defines. Neither is a sale or a purchase: no price was agreed, so they
  are excluded from acquired, sold and USD-invested totals and from Average Acquisition Price.
- `excludeStats` rows: counted in balance history and shown as markers, but excluded from
  Average Acquisition Price, USD invested and every acquisition bucket. This mirrors how the
  Dashboard treats the flag.

## 6. Balance history

`PersonalMarket.balanceHistory(transactions)` → `[{ tSec, sats }]`, a step series.

- Iterate transactions in `compareTx` order. For each, add
  `txPortfolioDelta(tx, toSatsInt)` to a running integer.
- `txPortfolioDelta` gains an optional second parameter `toUnits` (default `numOr`), mirroring
  `txWalletDeltas`. This is the only edit to existing accounting code permitted by this
  feature, and existing calls must return identical values.
- Result of the existing rules, restated: Buy and Reward `+amount`; Sell `−amount`;
  Consolidation `−fee`; Transfer internal `−fee`; Transfer sent `−(amount + fee)`; Transfer
  received `+amount`.
- All transactions count, including `excludeStats` rows and rows with a blank wallet, as the
  Dashboard's accumulated-BTC chart does.
- Same-instant transactions are collapsed to the last value at that instant.
- `balanceHistory(transactions, { wallets })`: with a wallet list, the balance of just those
  wallets, summed from `txWalletDeltas(tx, toSatsInt)` — used when a wallet filter is active
  (§10). An internal transfer between two listed wallets then costs only the fee.
- `balanceBefore(history, tSec)` is the balance after every transaction with `tSec` strictly
  earlier; `balanceAtBuckets(history, bucketTimes, interval)` is the resampling below.
- For the chart, the series is resampled to candle buckets: the value at a bucket is the
  balance after the last transaction with `tSec < bucket end`.
- Invariant tested: the final value equals the sum of `txWalletDeltas(tx, toSatsInt)` over all
  named wallets when every transaction names its wallets.

## 7. Average Acquisition Price

An analytical measure: what the user's acquired BTC cost, or was worth, per BTC when it came in.

```
AAP = Σ usdIn(tx) / ( Σ sats(tx) / 1e8 )        over included acquisitions with a known usdIn
```

`PersonalMarket.avgAcquisition(transactions, { candlesDaily, nowSec, include, feeMode, fromSec, upToSec, wallets })`
returns `{ price, sats, usd, count, estimated, skipped: { unknownValue, excluded, nonPositive } }`.
`price` is `null` when nothing is included. `estimated` counts rewards valued from the day's
close; `nonPositive` counts rows whose amount is zero or negative (a holdings fix is not an
acquisition).

| Option | Default | Meaning |
|---|---|---|
| `include` | `['Buy', 'Reward']` | Which types count |
| `feeMode` | `'include'` | `'include'`: Buy `usdIn = totalUsd + fee`. `'exclude'`: Buy `usdIn = totalUsd` |
| `upToSec` | none | Only transactions at or before this instant (for the historical step line and for ranges) |
| `fromSec` | none | Only transactions at or after this instant (ranges) |
| `wallets` | none | Only rows whose `wallet` or `wallet2` is listed (the §10 wallet filter) |

**Approved definition.** Average Acquisition Price is the default call: purchases **including
applicable acquisition fees**, plus rewards at their USD value at receipt. It represents the
economic amount spent, or value received, to acquire the BTC.

**Average Purchase Price** is a separate, future metric: purchases only, at their pre-fee
price, with no fees and no rewards. It is exactly
`avgAcquisition(transactions, { include: ['Buy'], feeMode: 'exclude' })` and is exposed in code
as the named preset `PersonalMarket.AVG_PRESETS.PURCHASE_PRICE` beside
`PersonalMarket.AVG_PRESETS.ACQUISITION_PRICE`. It is tested in Phase 6 but has no UI in the
first version. The two names are never used interchangeably.

`usdIn` per type:

- **Buy:** `numOr(tx.totalUsd, amount × price)`, plus `fee` when `feeMode` is `'include'`.
  With the default this equals the basis the cost pool and the lot engine assign to a buy.
- **Reward:** the USD value at receipt — `usdValueAtReceipt` when present; else
  `amount × tx.price` when `price > 0`; else `amount ×` the same-day daily close
  (`HISTORICAL_MARKET_LOOKUP`, counted in the result as `estimated`). This is the economic
  value at which the BTC entered the portfolio.
- A row with no determinable `usdIn` is left out of **both** numerator and denominator and
  counted in `skipped.unknownValue`. It is never included at $0, which would drag the average
  down.

Always excluded: `excludeStats` rows, Sell, every Transfer, Consolidation.

**Sales do not change it.** The measure describes acquisitions only. Selling half the stack
leaves it where it was. This is the main difference from the Dashboard's Average Cost.

Extensibility: the function is written as "select rows by `include`, map each to
`{ sats, usdIn }` through a per-type table, reduce". Average Purchase Price, a rewards-only
figure or a per-wallet figure is a different argument, not different code. The first version's
UI shows Average Acquisition Price only.

**Historical step line.** `PersonalMarket.avgAcquisitionSeries(transactions, opts)` returns
`[{ tSec, price }]`, one point per included acquisition, holding the running average after that
acquisition. Acquisitions sharing one instant give a single point holding the value after the
last of them, because a chart series cannot hold two values at one time. Drawn as a step line. A "current only" mode draws one horizontal line at the
latest value. Sales and transfers produce no step.

**Current price versus Average Acquisition Price.** Shown as:
current price, Average Acquisition Price, "Difference" in USD, and "Difference" in percent
(`price_now / AAP − 1`). The words gain, loss, profit and unrealized are not used.

### How the four terms differ

| | Average Acquisition Price | Average Purchase Price (future) | Dashboard Average Cost | Tax-Lot Cost Basis |
|---|---|---|---|---|
| Code | `avgAcquisition`, default options | `avgAcquisition`, `PURCHASE_PRICE` preset | `applyTxToCostPool` | `buildLots` |
| Purpose | Market analytics | Market analytics | Portfolio P&L view | Harvest / tax-lot accounting |
| Purchase fees | Included | Excluded | Included | Included |
| Rewards | Included at receipt value | Excluded | Included | Included as lots |
| Sells | No effect | No effect | Remove basis proportionally | Consume specific lots (HIFO/FIFO per wallet) |
| Outflow transfers | No effect | No effect | Remove basis proportionally | Per lot engine rules |
| Network fees burned | No effect | No effect | Raise the average of what remains | Per lot engine rules |
| Reward valuation order | `usdValueAtReceipt`, `tx.price`, daily close | — | `tx.price`, then daily close | `usdValueAtReceipt`, then lookup |
| Scope | Whole portfolio | Whole portfolio | Whole portfolio | Per wallet |

Tested relationship: for a history containing only Buys and Rewards whose reward values are
given by `tx.price` (so the valuation orders agree), Average Acquisition Price equals the cost
pool's `cost / btc` — the reconciliation the fee-inclusive definition was chosen to preserve.
With any Sell present the two differ, and a test asserts that as well so nobody "fixes" it.
Average Purchase Price is lower than or equal to Average Acquisition Price on a buys-only
history with fees, and a test asserts that too.

Help text shown beside the label is specified in `docs/market-analytics.md` §9.

## 8. Selected-range summary ("My Activity")

For the visible or selected range `[fromSec, toSec)`:

| Line | Definition |
|---|---|
| Transactions | Count of `ACQUISITION`, `DISPOSAL` and `REWARD` rows in range |
| BTC Acquired | Σ sats of `ACQUISITION` |
| BTC from Rewards | Σ sats of `REWARD` |
| BTC Sold | Σ sats of `DISPOSAL` |
| Net BTC Change | balance at `toSec` − balance at `fromSec` (from §6, so fees and outside transfers are reflected) |
| USD Invested | Σ `usdIn` of `ACQUISITION` rows with a known value (fees included) |
| Average Acquisition Price (range) | `avgAcquisition` restricted to the range |

`PersonalMarket.rangeSummary(transactions, { fromSec, toSec, candlesDaily, nowSec, filters })`
returns `{ transactions, acquiredSats, rewardSats, soldSats, netSats, usdInvested,
usdInvestedSkipped, avgAcquisition, netIncludesOther }`. Category and wallet filters (§10)
apply to every line; with a wallet filter, Net BTC Change uses that wallet set's balance
history.

Internal transfers appear in none of these lines. If Net BTC Change differs from
acquired + rewards − sold, a footnote reads "Includes network fees and transfers to or from
untracked wallets".

## 9. Marker aggregation

`PersonalMarket.aggregateMarkers(chartTxs, { interval, filters, maxMarkers, fromSec, toSec })`:

1. Apply filters (§10).
2. Key each transaction by `(Candles.bucketStart(tSec, interval), marker group)`. The marker
   group is the category, except that the four transfer-like categories (internal, sent,
   received, fee-only) form one group, `TRANSFER`: they share one shape and one filter. A
   `dateOnly` row on an intraday interval is keyed by its UTC day's first candle.
3. One marker per key: `{ t, category, count, sats, ids[], estimated, price }` where `estimated` is
   true if any member's source is `HISTORICAL_MARKET_LOOKUP` or `UNKNOWN`, and `price` is the
   member's resolved price when `count` is 1 (for exact-price placement), else `null`.
4. If the number of markers in the visible range exceeds `maxMarkers` (default 300), re-key
   with a bucket of `k ×` the interval, doubling `k` until it fits. Widened buckets stay on the
   interval's grid (Monday-anchored for `1w`), so every marker time is a candle time.

Because the key uses the displayed interval, zooming in (a smaller interval) separates markers
and zooming out merges them.

Marker semantics — never colour alone:

| Category | Shape | Position | Text |
|---|---|---|---|
| ACQUISITION | arrow up | below bar | count if > 1 |
| DISPOSAL | arrow down | above bar | count if > 1 |
| REWARD | circle | below bar | "R", or "R×n" |
| Transfers / fee-only (when enabled) | square | above bar | "T" |

Where the pinned chart library can place a marker at an exact price, a single (non-aggregated)
marker with a known price is placed at that price. Aggregated markers and markers of unknown
price use the above/below-bar positions.

Selecting a marker with `count > 1` opens a list of its members (type, date, amount); selecting
one opens the detail panel.

## 10. Filters

Stored in `settings.market.personal` as
`{ showTx, purchases, sales, rewards, transfers, wallets, avgLine, balancePane }` (normalized by
`normalizeMarketPrefs`; never written to the URL hash). `avgLine` is `'off'` (default),
`'current'` or `'historical'`; `balancePane` defaults to off.

- `showTx` (master toggle, "Show My Transactions", default on).
- Category toggles: Purchases (on), Sales (on), Rewards (on), Transfers (off — covers
  internal, sent, received and consolidation fee rows).
- Wallet filter: optional list of wallet names; a transaction matches if `wallet` or `wallet2`
  is listed. Uses the existing wallet list. Default: all.

Filters affect markers and the selected-range summary. They do not affect the balance pane or
the portfolio-wide Average Acquisition Price line unless a wallet filter is active, in which
case both are labelled with the scope (the Dashboard's "scope-badge" pattern).

## 11. Navigation between chart and ledger

**View on Chart** (Transactions tab, each row's action group, desktop table and mobile card):

- Calls a handler in `App` that stores `{ id }` in React state (`marketFocusTx`) and switches
  to the Market tab.
- `MarketView` reads the focus request, chooses a range that surrounds the transaction
  (the smallest of `1M`, `3M`, `1Y`, `5Y`, `ALL` in which the transaction is at least 20 % from
  either edge, with that range's default interval; every range ends now, so a recent
  transaction is near the right edge of all of them — then the smallest range in which it is at
  least 20 % from the start is used, else `ALL`), scrolls to it, enables "Show My
  Transactions" and the transaction's category if they were off for this view, highlights the
  marker and opens the detail panel. Then it clears the focus request.
- The id is never placed in the URL. Candle requests remain page-aligned
  (`docs/market-data.md` §7), so the request pattern does not disclose the transaction time.

**View Transaction** (detail panel):

- Switches to the Transactions tab and calls the existing `handleEdit(tx)` with the original
  record, opening the existing dialog. The Market module contains no editor.
- If the transaction no longer exists (deleted or replaced by a sync), the panel closes with a
  toast.

**Detail panel contents:** type; date and time (`fmtTxDate`, or "Time not recorded"); BTC amount
and satoshis; USD value; price per BTC with its source label (§3); all-in per-BTC figure when a
fee exists; wallet, and destination wallet for transfers; fee with its unit; notes; then the
market context block (§12). Personal figures honour the hide-values toggle.

## 12. Historical context at a transaction

`PersonalMarket.contextAt(chartTx, dailyCandles, indicatorCache)` returns the values listed in
`docs/technical-indicators.md` §13, using exactly the rule defined there:

- Only daily candles with `t + 86400 <= tSec` are visible to the calculation.
- The transaction's own day and every later candle are never used.
- `dateOnly` rows follow the same rule.
- Each value may be `null` (warm-up, gap, unknown price) and is then shown as "—".

`indicatorCache` holds each daily indicator series computed once over all completed daily
candles; `contextAt` reads index `k`. Valid because every indicator used is causal.

The panel presents facts only. It does not grade the transaction: no "good", "bad", "smart",
"early", "late", and no colour implying a verdict.

## 13. Acquisition analytics

All are descriptive. All take the acquisition set of §7 (`include`, default Buy + Reward,
excluding `excludeStats`) and report, per bucket: BTC (from satoshis), transaction count, share
of acquired BTC, and USD where known. Each also reports an "Unknown" bucket for rows whose
classifying value is `null`; the buckets plus Unknown always sum exactly to the total satoshis.

| Analytic | Classifier (from §12 context) | Buckets |
|---|---|---|
| By price range | resolved `price` | `< 25k`, `25–50k`, `50–75k`, `75–100k`, `≥ 100k` (boundaries in a constant, lower bound inclusive) |
| Versus SMA 50 | `price` vs `SMA50[k]` | below, at or above |
| Versus SMA 200 | `price` vs `SMA200[k]` | below, at or above |
| Trend state | `SMA50[k]` vs `SMA200[k]` | 50 above 200, 50 below 200 |
| RSI at acquisition | `RSI14[k]` | `< 30`, `30–50`, `50–70`, `≥ 70` |
| Drawdown at acquisition | `price / ATH(T) − 1` | `0–10 %`, `10–20 %`, `20–30 %`, `30–40 %`, `40–50 %`, `≥ 50 %` below previous ATH; "above previous ATH" as its own bucket |

- Drawdown buckets use the magnitude of the negative value; lower bound inclusive.
- Labels follow `docs/technical-indicators.md` §12: until an ATH seed is verified, the
  classifier is "Drawdown from High since <date>" and the top bucket is "above that high".
  "Previous ATH" wording is used only with a verified seed.
- These tables live in a "My Activity" section below the chart, not on the price chart.

## 14. Privacy rules

- No request to any host contains a transaction id, amount, wallet, note, or a time derived
  from a transaction.
- The URL hash carries only chart configuration.
- Nothing personal is cached outside the existing transaction storage.
- No personal value is logged.
- Personal figures in the Market view are blurred by the existing hide-values toggle; the
  candle chart itself stays visible.
- With no transactions, the Market tab is a plain market chart; personal sections show an
  empty state. Sample-mode data from the Dashboard is not reused here.

## 15. Tests (Node, `tools/test/market-personal.mjs`)

- **Read-only:** every function called with deep-frozen transactions and candles; no throw, no
  change.
- **Normalization:** each type; unusable instant skipped; `dateOnly` detection; ordering by
  `compareTx` including same-instant `sequence`.
- **PriceSource:** each row of the §3 table; blank `price` with `totalUsd`; both blank;
  reward with and without `usdValueAtReceipt`; missing daily candle → `UNKNOWN`; all-in figures.
- **Precision:** sums of many 1-satoshi and 8-decimal amounts are exact; a case where float
  summation of the same amounts is not exact.
- **Transfers:** internal transfer changes balance by exactly `−fee` satoshis and appears in no
  acquired/sold total; sent and received change balance but not acquired/sold.
- **Balance history:** final value matches wallet-delta sum; `excludeStats` rows counted;
  `txPortfolioDelta` with default argument returns the same floats as before the change.
- **Average Acquisition Price:** hand-computed three-purchase example with fees; rewards
  included by default; the `PURCHASE_PRICE` preset excludes rewards and fees through the same
  function; `feeMode` both ways; unknown-value rows skipped
  from numerator and denominator; `excludeStats` excluded; a Sell leaves it unchanged; equality
  with the cost pool on a buys-and-rewards-only history; inequality once a Sell is added.
- **Step series:** one point per acquisition, values match running hand computation.
- **Aggregation:** same bucket and category merge; different categories do not; smaller
  interval separates; `maxMarkers` coarsening; filters; `estimated` flag.
- **Context / no look-ahead:** changing every candle on or after the transaction's day leaves
  the context identical; own-day candle unused; `dateOnly` rows; warm-up and gap → `null`.
- **Buckets:** boundaries inclusive on the lower side; Unknown bucket; buckets sum to the total
  in satoshis exactly.
- **Privacy:** the service's generated request windows for a "View on Chart" focus are all
  page-aligned and none equals or is centred on the transaction time.
