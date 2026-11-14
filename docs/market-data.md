# Market Data

Part of the Market Analytics design; see `docs/market-analytics.md` for context and decisions.
All code described here lives in the helper region of `app.dev.html` (`Candles`, `MarketData`)
except `MarketCandleStore`, which uses IndexedDB and lives in the component zone.

Items marked **[verify]** were recalled during design. They are **not authoritative**.

**Verification gate — first task of Phase 2, before any provider code.** Check each of the
following against current official Coinbase documentation (and, for CORS and history, a manual
request from a browser), then correct this document wherever the verified behaviour differs:

1. Supported candle granularities.
2. Maximum candles per request.
3. Returned row ordering and column order.
4. Product stats endpoint: URL, fields, and what "24 hour" means there.
5. Historical availability: how far back each granularity goes and what an out-of-range
   request returns (empty array, error, or clamped data) — earliest-candle discovery (§8)
   depends on this.
6. Rate limits for unauthenticated requests.
7. CORS behaviour of every endpoint used, from the production origin.

Record the date of verification and the documentation URLs in a short "Verified" note at the
end of §4. If a verified fact changes the interval table, the page size, the caps or the
discovery method, update §2, §7, §8 and §10 before implementing.

---

## 1. Candle model

```js
// t: bucket start, UTC, integer seconds. Prices and volume are finite Numbers.
{ t, o, h, l, c, v }        // v may be null when the provider gives no volume
```

- UTC everywhere. No local-time or session logic; Bitcoin trades continuously.
- A candle covers `[t, t + intervalSeconds)`.
- A candle is **complete** when `t + intervalSeconds <= now`. Otherwise it is **forming**.

## 2. Intervals

```js
Candles.INTERVALS = {
  '1m':  { seconds: 60,     native: true  },
  '5m':  { seconds: 300,    native: true  },
  '15m': { seconds: 900,    native: true  },
  '30m': { seconds: 1800,   native: false, from: '15m' },
  '1h':  { seconds: 3600,   native: true  },
  '4h':  { seconds: 14400,  native: false, from: '1h'  },
  '1d':  { seconds: 86400,  native: true  },
  '1w':  { seconds: 604800, native: false, from: '1d'  },
};
```

- `native` is per provider; the table above is the Coinbase mapping. The provider reports its
  native set through `getAvailableIntervals()` and the service derives the rest.
- Coinbase native granularities are 60, 300, 900, 3600, 21600 and 86400 seconds **[verify]**.
  The 6-hour granularity is not exposed in the UI.
- A derived interval is only ever built from a smaller one. Never the reverse.

## 3. MarketDataProvider interface

```js
{
  id: 'coinbase',
  label: 'Coinbase',                      // used in the volume label and freshness line
  symbol: 'BTC-USD',
  getAvailableIntervals(),                // → ['1m','5m','15m','1h','1d'] (native only)
  maxCandlesPerRequest,                   // 300 for Coinbase [verify]
  getCandles({ interval, startSec, endSec, signal }),   // → Candle[] ascending, validated
  getCurrentPrice({ signal }),            // → { price, at }
  get24HourStats({ signal }),             // → { open, high, low, last, volume, at }
  getHistoricalRange({ interval }),       // → { earliestSec | null, hintSec | null }
}
```

Rules:

- `getCandles` requests a native interval only and a window of at most `maxCandlesPerRequest`
  buckets. `endSec` is exclusive.
- The provider converts the raw response into the candle model and nothing else. Paging,
  caching, retry and aggregation belong to the service.
- A provider is constructed with its dependencies: `createCoinbaseProvider({ fetchImpl })`.
- A provider never receives anything derived from the user's transactions.
- Provider credentials: none are used. A provider that needs a secret cannot be added to this
  application without a server, and is out of scope.

`subscribeRealtime` is not part of the first version. The transport is polling (§15).

## 4. Initial provider: Coinbase Exchange

Chosen because:

- No API key and no authentication.
- CORS-enabled and already called from the browser by the existing app.
- `api.coinbase.com` and `api.exchange.coinbase.com` are already in the CSP `connect-src` and
  in the service worker's `NETWORK_ONLY_HOSTS`, so no header or worker change is needed.
- Same source as the Dashboard's daily closes, so the two screens agree.
- Deep daily history for BTC-USD and exchange volume per candle.

Endpoints **[verify]**:

| Purpose | Request |
|---|---|
| Candles | `GET https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=<s>&start=<ISO>&end=<ISO>` |
| 24 h stats | `GET https://api.exchange.coinbase.com/products/BTC-USD/stats` |
| Spot price | `GET https://api.coinbase.com/v2/prices/BTC-USD/spot` (already polled by `fetchPrice`) |

Candle rows arrive as arrays `[time, low, high, open, close, volume]`, newest first
**[verify]**. The existing historical-price code reads index 4 as the close, which is
consistent with this order. The provider maps by position and then sorts ascending.

Limitations to state in the UI or docs:

- Volume is Coinbase's own volume, not global Bitcoin volume.
- Buckets with no trades are omitted from the response rather than returned empty.
- History begins at the provider's first candle (§8).

## 5. Normalization

For each raw row:

1. Require an array of at least 5 entries (6 when volume is present).
2. Coerce each field with `Number()`. Reject the row unless every price is finite and `> 0`,
   `time` is a finite integer, and volume (if present) is finite and `>= 0`.
3. Build `{ t, o, h, l, c, v }` with `t` in seconds.
4. Require `t % intervalSeconds === 0`. A misaligned bucket is rejected.

`Candles.normalizeRow(row, interval, order)` returns `{ candle }` or `{ reason }`. `order` maps
fields to column positions and defaults to `Candles.ROW_ORDER` (the Coinbase order above,
pending verification). Blank strings, `null` and booleans are not coerced to numbers.
`Candles.parseRows(rows, interval, order)` normalizes every row and then validates (§6),
returning the same shape as `validate` with the reject limit measured over the raw row count.

## 6. Validation

`Candles.validate(candles, interval)` returns
`{ valid: Candle[], rejected: [{ row, reason }], overRejectLimit }`. `overRejectLimit` is true
when more than `Candles.REJECT_LIMIT` (5 %) of the input was rejected. Valid candles are new
`{ t, o, h, l, c, v }` objects (`v` defaults to `null`); the input is never mutated.

Per candle, reject unless all hold:

- `h >= o`, `h >= c`, `l <= o`, `l <= c`, `h >= l`
- all prices finite and `> 0`
- `t` aligned to the interval

Across the series:

- Sort ascending by `t`.
- Duplicates (same `t`): keep the last occurrence in response order, count the rest as
  rejected with reason `duplicate`.
- The output is strictly ascending in `t`. The chart library requires this.

Rejected rows are dropped, counted and reported once per request through `console.warn` with
counts and reasons only. Malformed data is never repaired, clamped or interpolated. If more
than 5 % of a page is rejected, the page is treated as failed (partial state) rather than used.

## 7. Paging strategy

Pages are fixed and interval-aligned so that requests reveal nothing about a transaction time:

```
pageSpan  = maxCandlesPerRequest * intervalSeconds
pageIndex = floor(tSec / pageSpan)
page      = [pageIndex * pageSpan, (pageIndex + 1) * pageSpan)
```

- A view needing `[from, to)` requests every page that intersects it, newest first.
  `Candles.pagesFor(fromSec, toSec, interval, perPage)` returns them as
  `{ index, startSec, endSec }`; `pageSpan`, `pageIndex` and `pageBounds` give the same
  arithmetic. `perPage` is the provider's `maxCandlesPerRequest`. Only native intervals have
  pages.
- The service never issues a request whose bounds are not page boundaries.
- Concurrency: at most 4 requests in flight. Pages are queued newest first so the visible
  right edge fills in first.
- Panning left requests the next older page when the visible range comes within one screen
  width of the oldest loaded candle.

## 8. `ALL` and the earliest available candle

The earliest candle is a property of the provider and the interval. It is **not** a product
constant.

- `getHistoricalRange({ interval })` returns `{ earliestSec, hintSec }`.
  - `earliestSec` is the verified earliest bucket if known, otherwise `null`.
  - `hintSec` is an optional, provider-supplied starting guess. The Coinbase provider may use
    the existing `BTC_USD_FIRST_CANDLE_DAY` constant as its hint. It is only a hint.
- Discovery: the daily backfill (§17) walks pages backwards. When two consecutive pages older
  than the oldest known candle return no candles, the oldest candle held is recorded as
  `earliestSec` for that provider and interval in the `meta` store, with the time verified.
- The record is re-verified if older than 90 days, and is discarded when the provider id changes.
- `ALL` means `[earliestSec for '1d', now)`. Until discovery completes, `ALL` shows what is
  loaded with a "loading history" state.
- For intraday intervals, the earliest candle is discovered the same way but only on demand.
- Swapping provider changes `ALL` automatically; nothing else in the app refers to the date.

## 9. Range and interval rules

Ranges: `1D 1W 1M 3M 6M YTD 1Y 3Y 5Y ALL`. Range and interval are separate values everywhere in
the code and in stored preferences.

Range start (UTC): `1D` = now − 24 h; `1W` = now − 7 d; `1M`/`3M`/`6M` = same day-of-month N
calendar months back (clamped to month length); `YTD` = Jan 1 00:00 UTC of the current year;
`1Y`/`3Y`/`5Y` = N calendar years back; `ALL` = §8.

Default interval per range:

| Range | Default | Range | Default |
|---|---|---|---|
| 1D | 5m | YTD | 1d |
| 1W | 1h | 1Y | 1d |
| 1M | 4h | 3Y | 1d |
| 3M | 4h | 5Y | 1d |
| 6M | 1d | ALL | 1w |

An interval is offered for a range only if it passes both caps (§10) and
`intervalSeconds < rangeSeconds`. `Candles.allowedIntervals(range, now, earliestSec)` returns the
list; the UI disables the rest with a short reason. If a stored or URL-supplied interval is not
allowed for the range, the range default is used. `Candles.resolveInterval(range, requested, now,
earliestSec)` applies this; if the default itself is not allowed (only possible for `YTD` in the
first hours of 1 January) it returns the largest allowed interval below the default.

All `Candles` functions take `now` as UTC seconds from the caller; nothing reads a clock. Before
the earliest candle is discovered, `rangeStart('ALL', …)` returns `null` and
`allowedIntervals('ALL', …)` returns `['1d', '1w']`.

When the user changes range, the interval switches to the new range's default unless the
current interval is allowed and was chosen explicitly for that range in this session.

## 10. Request caps

```js
Candles.MAX_VIEW_CANDLES   = 3000;   // candles displayed for the selected range
Candles.MAX_NATIVE_CANDLES = 9000;   // native candles that must be fetched to build them (30 pages)
```

- `displayed = ceil(rangeSeconds / intervalSeconds)` must be `<= MAX_VIEW_CANDLES`.
- `native = ceil(rangeSeconds / nativeSourceSeconds)` must be `<= MAX_NATIVE_CANDLES`.
- **Exception:** `1d` is exempt from both caps, for any range including `ALL`. Full daily
  history is required anyway for weekly candles, long moving averages, previous ATH and
  transaction context. The exemption is from the caps only: like every interval, `1d` must
  still be shorter than the range, so `1D` does not offer it.
- Panning beyond the selected range loads at most one further page per pan gesture.

Worked examples: `1D@1m` 1,440 displayed — allowed. `1W@1m` 10,080 — not allowed. `1Y@4h` 2,190
displayed from 8,760 native — allowed. `3Y@4h` 26,280 native — not allowed. `6M@1h` 4,380
displayed — not allowed.

## 11. UTC bucket rules and aggregation

`Candles.bucketStart(tSec, interval)`:

- All intervals except `1w`: `tSec - (tSec % intervalSeconds)`.
- `1w`: weeks start **Monday 00:00:00 UTC**. The Unix epoch was a Thursday, so
  `weekStart = tSec - ((tSec - 345600) mod 604800)` using a non-negative modulo, where 345600 is
  Monday 1970-01-05 00:00:00 UTC.

`Candles.aggregate(candles, targetInterval, sourceInterval)`:

- Throws if `target.seconds <= source.seconds` or the target is not a whole multiple of the
  source (for `1w` from `1d`, 7×).
- Group source candles by `bucketStart(t, target)`. For each group in ascending order:
  `o` = first open, `h` = max high, `l` = min low, `c` = last close, `v` = sum of volumes
  (`null` if every source volume is `null`).
- An aggregated candle carries `partial: true` when it has fewer source candles than expected
  for a completed bucket (a gap inside it). Partial completed candles are shown but excluded
  from indicator input (§13).
- The newest aggregated bucket is forming if its end is in the future. The signature is
  `aggregate(candles, target, source, { nowSec })`: a forming bucket is flagged `partial` only
  when source buckets that have already started are missing. Without `nowSec` every bucket is
  judged as completed. A `partial` source candle makes its target candle `partial`.

## 12. Gap detection

`Candles.findGaps(candles, interval, { fromSec, toSec, isFetched })` returns
`[{ fromSec, toSec, missing, kind }]` for each run of expected bucket starts with no candle,
over the buckets that intersect `[fromSec, toSec)` (default: first to last candle).
`isFetched(bucketT)` reports whether that bucket's page is in `coverage`; `kind` is `'provider'`
when it is (or when no `isFetched` is given) and `'not_fetched'` otherwise. A run never mixes
the two kinds.

Two different conditions must not be confused:

| Condition | Meaning | How it is known |
|---|---|---|
| **Not fetched** | The page has not been requested or its request failed | The page is absent from `coverage` (§14) |
| **Provider gap** | The page was fetched successfully and the bucket is absent | The page is in `coverage` and the bucket is missing |

A legitimate price gap (one candle opening away from the previous close) is not a missing
candle and is not flagged.

Behaviour:

- Provider gaps are stored as absence. Nothing is forward-filled, interpolated or invented.
- The chart shows the gap as empty space.
- Indicator input: a gap splits the series. See `docs/technical-indicators.md` §2.
- Gap count for the visible range is shown in the data-freshness line when non-zero.

## 13. Volume

- Label: "Volume (Coinbase)". Never "Bitcoin volume" or "global volume". The label comes from
  `provider.label`.
- Volume always corresponds to the selected interval (summed for derived intervals).
- Show/hide is a preference. If a provider returns no volume, the control is disabled.

## 14. IndexedDB: `satledger-market`

Version 1. Opened lazily by `MarketCandleStore.open()`.

| Store | Key | Value | Purpose |
|---|---|---|---|
| `candles` | `[provider, symbol, interval, t]` | `{ provider, symbol, interval, t, o, h, l, c, v }` | Completed native candles |
| `coverage` | `[provider, symbol, interval, pageIndex]` | `{ …key, fetchedAt, complete }` | Which pages have been fetched; `complete` is true when the page ended before `fetchedAt` |
| `meta` | `key` (string) | `{ key, value, at }` | `earliest:<provider>:<symbol>:<interval>`, `schema`, last backfill position |

Interface (same for the in-memory fallback):

```js
store.getCandles({ provider, symbol, interval, fromSec, toSec })   // → Candle[] ascending
store.putCandles({ provider, symbol, interval, candles })
store.getCoverage({ provider, symbol, interval, fromPage, toPage })
store.putCoverage({ provider, symbol, interval, pageIndex, fetchedAt, complete })
store.getMeta(key) / store.putMeta(key, value)
store.clear()
```

Rules:

- Only **completed, validated, native** candles are written.
- Derived intervals are never stored.
- Every operation resolves; a failed transaction logs a warning and behaves as a cache miss.
- If `indexedDB.open` fails or is unavailable, an in-memory store is used for the session.
- A future schema change increments the version and, in `onupgradeneeded`, drops and recreates
  the stores. The data is a cache and is always safe to discard.
- "Clear cached market data" in Settings calls `store.clear()`.

## 15. Caching behaviour

- A page marked `complete` is never refetched.
- A page not marked `complete` (it contains the present) is refetched when the newest stored
  candle in it is older than one interval, and at most once per interval.
- On every load of a view, the newest two buckets are refetched regardless, to correct a
  final candle that was stored moments before its close.
- Read path: IndexedDB → render → network for what is missing → merge → render.
- Service worker: Coinbase hosts are network-only and are not cached by `sw.js`. That stays.

## 16. Stale data and the forming candle

Freshness line shows: last price update, last candle update, and history status.

| Item | Stale when |
|---|---|
| Current price | `now - priceUpdatedAt > 180 s` (the poll interval is 60 s) |
| Candles | `now - end of newest completed candle > 2 × intervalSeconds` |
| 24 h stats | `now - stats.at > 300 s` |

- A stale item is shown with a visible "stale" marker and its age. Old data is never presented
  as live.
- Offline: cached candles render with a stale banner; the price header shows the last known
  price with its age (the app already keeps `btc-last-spot`).

Forming candle:

- The newest bucket is built from the provider's latest candle if present, then updated from
  the 60 s spot poll: `c = price`, `h = max(h, price)`, `l = min(l, price)`. Volume is not
  updated between candle fetches.
- It is drawn with a distinct style and labelled "forming" in the readout.
- It is never written to IndexedDB.
- Indicator values that include it are marked provisional in the readout
  (`docs/technical-indicators.md` §3).
- 24-hour change comes only from `get24HourStats()`, never from candles on screen.

## 17. Retry, backoff and supersede

Retry (per request, same shape as the existing `fetchWithRetry`):

- Up to 3 attempts. Retry on network error, HTTP 429 and HTTP 5xx. Do not retry other 4xx.
- Delay starts at 1 s and doubles, plus up to 250 ms of jitter. A `Retry-After` header, if
  present and numeric, replaces the delay.
- Each request has a 15 s timeout through its `AbortController`.
- A 429 pauses the whole queue for the delay, not only the failed request.

Supersede:

- `service.loadView({ range, interval })` increments a token and aborts the previous view's
  controller.
- Every awaited step checks the token before writing state. A response belonging to an older
  token is discarded, even if it succeeded. Its candles may still be written to the cache.
- Leaving the Market tab aborts in-flight view requests. The background backfill pauses.

Failure outcome: pages that succeeded are kept and shown; the view enters the `partial` state
with a retry control. A failed page is not recorded in `coverage`, so the next load retries it.

Rate limits: Coinbase's public limit is per IP **[verify]**. With 4 concurrent requests and the
caps in §10 the feature stays far below any plausible limit; the design does not depend on the
exact number.

## 18. Historical backfill

Purpose: hold the full daily history, which weekly candles, SMA 200, previous ATH and
transaction context all require.

- Starts on first open of the Market tab, after the visible view has loaded.
- Walks daily pages from newest to oldest, one request at a time, with a 250 ms pause between
  requests.
- Resumable: the last completed page index is kept in `meta`; a reload continues from there.
- Idempotent: writes are keyed by `[provider, symbol, interval, t]`, so a repeated page
  overwrites identical rows.
- Stops when the earliest candle is discovered (§8) or after 3 consecutive failures. Failures
  surface as "history incomplete" in the freshness line, with retry.
- Pauses when the tab is hidden or the Market tab is not active.
- Intraday intervals are never backfilled beyond what a view requests.

The existing Dashboard price history (`btc-price-history-v1`) keeps its own fetch and is not
changed or replaced by this backfill.

## 19. Replacing the provider

To add or switch provider:

1. Write `createXProvider({ fetchImpl })` implementing §3, with its own interval table.
2. Register it in `MarketData.providers` and select it by id.
3. Add its hosts to the CSP `connect-src` in `app.dev.html` and to `NETWORK_ONLY_HOSTS` in
   `sw.js`.
4. Nothing else changes: cache keys include the provider id, so data from two providers never
   mixes; `ALL`, the volume label and the interval list follow the provider.

Indicators and personal analytics consume only the candle model and never know which provider
produced it.

## 20. Tests (Node, `tools/test/market-data.mjs`)

- Normalization: valid row, short row, non-numeric, non-finite, zero and negative prices,
  misaligned timestamp.
- Validation: each OHLC inequality, duplicates, unordered input, strict ascending output,
  the 5 % rejection threshold.
- Bucketing: every interval at a boundary and one second either side; weekly anchoring across
  a year boundary and for a known Monday; a timestamp before 1970-01-05.
- Aggregation: 15m→30m, 1h→4h, 1d→1w values; partial bucket flag; refusal to downsample;
  volume `null` handling.
- Gaps: none, single, run, at edges; not-fetched versus provider gap.
- Range rules: default interval for each range; allowed sets match the worked examples in §10;
  the `1d` exception; invalid stored interval falls back.
- Paging: page boundaries; a transaction-shaped window never appears in a generated request.
- Provider with fake `fetchImpl`: row order mapping, newest-first input sorted ascending.
- Service with fake provider and in-memory store: cache hit avoids fetch; missing pages
  fetched; 429 then success; 4xx not retried; partial result kept; superseded response
  discarded; earliest-candle discovery after two empty pages; backfill resumes.
- Fixture `tools/test/fixtures/btc-usd-1d.json`: a real slice of provider daily candles passes
  validation unchanged.
