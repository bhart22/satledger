# Technical Indicators

Part of the Market Analytics design; see `docs/market-analytics.md`.
Code lives in the helper region of `app.dev.html` as `const Indicators = { … }` and is tested by
`tools/test/market-indicators.mjs`.

Every formula the implementation uses is written here. If the code needs a rule that is not
on this page, the page is updated first.

---

## 1. Conventions

- Input is an array of candles `{ t, o, h, l, c, v }`, strictly ascending in `t`, already
  validated (`docs/market-data.md` §6).
- Indices are 0-based. `C[i]`, `H[i]`, `L[i]` are close, high and low of candle `i`.
- `N` is the period.
- Every indicator returns arrays **the same length as the input**, aligned by index. A position
  with no defined value holds `null`. Never `0`, never `NaN`.
- **Warm-up** is the number of leading `null` values.
- Values are full-precision Numbers. Rounding happens only when formatting for display.
- Indicators are pure: same input, same output, no I/O, no mutation of the input.
- Source is the close unless stated. A `source` setting (`close`, `open`, `high`, `low`,
  `hl2`, `ohlc4`) is accepted by SMA and EMA; default `close`.

Definition shape:

```js
{
  id: 'sma', name: 'Simple Moving Average', category: 'TREND',   // TREND | MOMENTUM | VOLATILITY | VOLUME | STATISTICAL
  placement: 'overlay' | 'pane',
  defaults: { period: 50, source: 'close' },
  presets: [20, 50, 100, 200] | null,
  series: ['sma'],                                   // output names, in order
  validate(settings) → settings | throws,
  warmup(settings) → { [seriesName]: number },       // per series: MACD's line and signal differ
  calculate(candles, settings, interval) → { [seriesName]: (number|null)[] },
}
```

`interval` is used only by historical volatility (annualization, §10), which requires it; the
others ignore it. Every public method validates its settings first, and none depends on `this`.
Definitions are listed in `Indicators.definitions` and looked up with `Indicators.get(id)`.

| id | Series | Placement |
|---|---|---|
| `sma` | `sma` | overlay |
| `ema` | `ema` | overlay |
| `rsi` | `rsi` | pane |
| `macd` | `macd`, `signal`, `histogram` | pane |
| `bollinger` | `upper`, `middle`, `lower`, `percentB`, `bandWidth` | overlay |
| `atr` | `atr` | pane |
| `volatility` | `volatility` | pane |

Settings validation: periods are integers (Numbers, not numeric strings) in `[2, 1000]`;
multipliers are finite and in `(0, 10]`; MACD requires `fast < slow`; RSI levels are in
`(0, 100)` with `oversold < overbought`. A missing key takes its default and a key the
definition does not know is dropped. `validate` throws on a bad value; invalid settings from a
URL or stored preferences go through `Indicators.resolveSettings(id, settings)`, which falls back
to the defaults rather than throwing in the UI.

## 2. Gaps

A provider gap (`docs/market-data.md` §12) breaks continuity. `calculate` receives the candles
as they are; the caller is responsible for segmentation:

- `Indicators.calculateSegmented(def, candles, settings, interval)` splits the series at every
  gap, runs `calculate` on each segment independently, and concatenates the results. Each
  segment therefore has its own warm-up.
- A gap is any pair of consecutive candles whose `t` differ by anything other than one interval.
- Aggregated candles flagged `partial` (a gap inside the bucket) end the segment before them and
  start a new one after them. The partial candle itself gets `null` in every series.
- Nothing is forward-filled.

## 3. The forming candle

- When the last candle is still forming, its indicator values are computed normally but are
  **provisional**: the readout marks them and they are not used for any historical statement.
- Transaction context (§13) never uses a forming candle.

## 4. SMA — simple moving average

Defaults: period 50. Offered presets 20, 50, 100, 200. Overlay.

```
SMA[i] = (C[i-N+1] + … + C[i]) / N        for i >= N-1
SMA[i] = null                              for i <  N-1
```

Warm-up: `N-1`.

Implementation may use a rolling sum. The rolling result must equal the direct sum to within
`1e-9` relative; the test compares both.

## 5. EMA — exponential moving average

Defaults: period 21. Offered presets 12, 21, 50, 200. Overlay.

```
k        = 2 / (N + 1)
EMA[N-1] = SMA[N-1]                                   (seed: simple average of the first N values)
EMA[i]   = C[i] * k + EMA[i-1] * (1 - k)              for i >= N
EMA[i]   = null                                       for i <  N-1
```

Warm-up: `N-1`. The seed is the SMA of the first `N` values, not the first value. This is the
only seeding method used anywhere in this module, including inside MACD.

## 6. RSI — Wilder's relative strength index

Defaults: period 14. Pane, fixed scale 0–100, reference lines at 70, 50, 30. The outer two are
the settings `overbought` (70) and `oversold` (30); the 50 line is fixed.

```
d[i]   = C[i] - C[i-1]                                for i >= 1
gain[i] = max(d[i], 0)
loss[i] = max(-d[i], 0)

Seed at i = N (uses the first N changes, d[1]..d[N]):
  avgGain[N] = (gain[1] + … + gain[N]) / N
  avgLoss[N] = (loss[1] + … + loss[N]) / N

Wilder smoothing for i > N:
  avgGain[i] = (avgGain[i-1] * (N-1) + gain[i]) / N
  avgLoss[i] = (avgLoss[i-1] * (N-1) + loss[i]) / N

RS[i]  = avgGain[i] / avgLoss[i]
RSI[i] = 100 - 100 / (1 + RS[i])
RSI[i] = 100            when avgLoss[i] == 0   (including when avgGain[i] is also 0)
RSI[i] = null           for i < N
```

Warm-up: `N`.

The `avgLoss == 0 → 100` rule, including the flat case, deliberately matches the existing
Dashboard implementation (`buildMovingAverageSeries`, which evaluates `rs = Infinity`).

### Compatibility with the Dashboard RSI

The Dashboard chart already shows a 14-day RSI computed by `buildMovingAverageSeries` in
`app.dev.html`, rounded to one decimal. The two must agree.

Test: extract `buildMovingAverageSeries` the same way `tools/test/moving-average.mjs` does, run
it and `Indicators` RSI(14) on the same daily close series (the fixture, and a random walk of
at least 2,000 points), and assert for every index that
`Number(newRsi[i].toFixed(1)) === dashboard[i].rsi14` and that both are `null`/absent at the
same indices. The same test asserts SMA(50) and SMA(200) against `ma50d` and `ma200d` after
rounding to two decimals.

`buildMovingAverageSeries` is not modified or replaced. Note that the Dashboard feeds it
gap-filled closes; on a series with provider gaps the two screens can differ, by design.

## 7. MACD

Defaults: fast 12, slow 26, signal 9. Pane with MACD line, signal line and histogram.

```
MACD[i]   = EMA_fast[i] - EMA_slow[i]                 for i >= slow-1, else null
Signal    = EMA of the MACD series with period `signal`, seeded with the SMA of the first
            `signal` defined MACD values
            → first value at i = slow - 1 + signal - 1
Hist[i]   = MACD[i] - Signal[i]                       where both are defined, else null
```

Both EMAs use §5 exactly (SMA seed). Warm-up: `slow-1` for the MACD line (25 by default),
`slow+signal-2` for signal and histogram (33 by default).

## 8. Bollinger Bands

Defaults: period 20, multiplier 2. Overlay with upper, middle and lower lines.

```
Mid[i]   = SMA_N[i]
σ[i]     = sqrt( Σ (C[j] - Mid[i])² / N )   over j = i-N+1 … i      (population standard deviation, divisor N)
Upper[i] = Mid[i] + m * σ[i]
Lower[i] = Mid[i] - m * σ[i]
```

Optional derived series, computed by the same call:

```
PercentB[i]  = (C[i] - Lower[i]) / (Upper[i] - Lower[i])       null when Upper == Lower
BandWidth[i] = (Upper[i] - Lower[i]) / Mid[i]
```

Warm-up: `N-1`. The divisor is `N`, not `N-1`; this is the conventional Bollinger definition
and differs on purpose from historical volatility (§10), which uses the sample deviation.

## 9. ATR — average true range

Defaults: period 14. Pane.

```
TR[0] = null
TR[i] = max( H[i] - L[i], |H[i] - C[i-1]|, |L[i] - C[i-1]| )       for i >= 1

ATR[N] = (TR[1] + … + TR[N]) / N                                    (seed: simple average of the first N true ranges)
ATR[i] = (ATR[i-1] * (N-1) + TR[i]) / N                             for i > N
ATR[i] = null                                                       for i < N
```

Warm-up: `N`. The first candle has no previous close, so it contributes no true range.

## 10. Historical (realized) volatility

Defaults: period 30. Offered presets 7, 14, 30, 90. Pane, shown as a percentage.

```
r[i]  = ln( C[i] / C[i-1] )                                         for i >= 1   (log returns)
mean  = ( r[i-N+1] + … + r[i] ) / N
s[i]  = sqrt( Σ (r[j] - mean)² / (N - 1) )   over j = i-N+1 … i     (sample standard deviation, divisor N-1)
HV[i] = s[i] * sqrt(P)                                              for i >= N
HV[i] = null                                                        for i <  N
```

Annualization factor `P` = number of intervals per year, using a 365-day year because Bitcoin
trades every day:

```
P = 365 * 86400 / intervalSeconds        → 365 for 1d, 8760 for 1h, 52.142857… for 1w
```

Return type: log returns. Result is a fraction (0.55 = 55 %). Warm-up: `N` (N returns need
N+1 closes). The "30-Day Volatility" summary figure is HV(30) on completed daily candles.

## 11. Returns

All on completed candles unless stated.

| Metric | Formula | Type |
|---|---|---|
| Selected range return | `lastClose / firstOpen - 1`, where `firstOpen` is the open of the first candle in the range | simple |
| 1D, 7D, 30D, 90D, 1Y, 3Y, 5Y | `P_now / C_daily(k days ago) - 1`, where `C_daily` is the close of the last completed daily candle at or before `now - k days` and `P_now` is the current price | simple |
| YTD | `P_now / C_daily(last completed day of the previous year) - 1` | simple |
| Average daily return (range) | arithmetic mean of `C[i]/C[i-1] - 1` over daily candles in the range | simple |
| Median daily return (range) | median of the same values; for an even count, the mean of the two middle values | simple |
| Volatility input | §10 | log |

`Indicators.returns.simple(a, b) = b / a - 1`; `Indicators.returns.log(a, b) = ln(b / a)`.
A metric whose reference candle is missing (before the earliest candle, or in a gap) is
`null` and displayed as "—". It is never approximated from a neighbouring candle.

Exact rules used by the code:

- `Indicators.returns.range(candles)` — the selected range return; `null` for no candles.
- `Indicators.returns.periods(daily, priceNow, nowSec)` → `{ 1D, 7D, 30D, 90D, 1Y, 3Y, 5Y, YTD }`.
  `k` is 1, 7, 30, 90, 365, 1095 and 1825 days (`Indicators.returns.PERIOD_DAYS`). The reference
  candle is the one with `t = bucketStart(now - k days, '1d') - 86400` — the last daily candle
  that had completed by the target time — looked up exactly; if that candle is absent the value
  is `null`. YTD uses the target `1 January 00:00 UTC` of the current year, i.e. the candle of
  31 December. Every value is `null` when `priceNow` is missing.
- `Indicators.returns.daily(candles)` → `{ average, median, count }`. Only pairs of consecutive
  daily candles exactly one day apart contribute; a pair across a gap is not a daily return.
  All `null` (count 0) when there are no pairs.

Range high and low are the maximum `h` and minimum `l` over the range
(`Indicators.extremes(candles)` → `{ high, highT, low, lowT }`, the first occurrence of each).
52-week high and low use daily candles over the trailing 365 days including the forming day; the
caller passes that slice.

## 12. Drawdown and all-time high

**Drawdown series (close-based), within a range:**

```
peak[i] = max( C[start] … C[i] )
DD[i]   = C[i] / peak[i] - 1                     (≤ 0)
Maximum drawdown for the range = min over i of DD[i]
```

The peak resets at the start of the selected range. Maximum drawdown is reported with the
dates of its peak and trough. `Indicators.drawdown(candles)` → `{ series, max }`, where `max` is
`{ value, peakIndex, troughIndex, peakT, troughT }` (the first trough reaching the minimum) or
`null` for no candles.

**All-time high (high-based):**

```
ATH(t) = max( seed, max of h over all daily candles whose bucket END <= t )
```

- The summary's high is `max(ATH(now), high of the forming day)`.
- "Current drawdown" and the distance from that high are the same number: `P_now / high - 1`.
- **What these figures are called depends on the seed — see "Labels" below.** The words
  "All-Time High" and "ATH" are used in this document for the formula; they appear in the UI
  only when the labelling rule allows.
- **Previous ATH at time `t`** is `ATH(t)` as defined above: only candles that had fully closed
  by `t`. This is the value used for a transaction (§13).

**ATH seed for history that predates the provider:**

The provider's daily history starts later than Bitcoin's price history. For a transaction
dated early in the provider's history, the true previous all-time high occurred before the
first available candle, and a maximum over available candles alone would be wrong.

```js
Indicators.ATH_SEED = { price: <USD>, date: 'YYYY-MM-DD', source: '<citation>' } | null
```

**Recorded seed (verified 2026-11-14, Phase 8):**

```js
Indicators.ATH_SEED = { price: 1163, date: '2013-11-30', source: 'Bitstamp BTC/USD daily OHLC …' }
Indicators.ATH_SEED_VERIFIED === true      // ATH_SEED !== null; only a verified seed may be in the code
```

- **Source.** Bitstamp's own trade record, read from the exchange's public daily OHLC endpoint
  `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400` (two requests of 1,000 days,
  starting 2011-08-01 and 2014-04-27). It returned every UTC day from 2011-08-18 (Bitstamp's
  first) to 2015-07-19 — 1,432 consecutive days with no gap. The highest `high` is **1163.00 on
  2013-11-30** (candle `1385769600`: open 1131.99, high 1163.00, low 1080.00, close 1119.52);
  next highest 1153.27 on 2013-12-04. Coinbase's first BTC-USD daily candle is 2015-07-20
  (`docs/market-data.md` §4), so the window is exactly "before the provider's history".
- **Corroboration.** Newsweek, "Bitcoin Price Passes $1,000 For First Time Since 2013"
  (newsweek.com/bitcoin-price-passes-1000-first-time-2013-537788): "the all-time high of $1,163
  that it reached on the Bitstamp exchange in late 2013".
- **Caveat recorded for the owner.** There is no single BTC-USD price. Other venues printed other
  highs that month — Mt. Gox about $1,242, at a premium that reflected its withdrawal problems;
  daily-close series peak lower (about $1,151 on 2013-12-04). The seed is the intraday high on
  one major USD exchange, which is the same kind of number as the provider's own highs (§12
  uses `h`, not closes). Before Bitstamp opened (August 2011) prices were far below it.
- **Tests.** `tools/test/market-indicators.mjs` asserts the value, date, frozen record and cited
  source, and the seeded calculation (applies from the end of 2013-11-30, stands while provider
  highs are below 1163, ignored once one exceeds it); `tools/test/market-personal.mjs` asserts
  the seed as the high for a 2014 transaction and not on its own day.

- At implementation time, the value, date and a citable source for the highest BTC-USD price
  reached before the provider's earliest daily candle are verified and recorded here and in
  the code comment. It must not be filled in from memory.
- The seed applies only when `seed.date` is earlier than the provider's earliest daily candle
  (`docs/market-data.md` §8). If the provider's history already covers that date, the seed is
  ignored.
- Once available highs exceed the seed, the seed has no further effect.
- The seed is also not used for a `T` before the end of its own day (`seedDay + 86400 > T`):
  using it there would be look-ahead.

`Indicators.previousAth(daily, T, { seed = ATH_SEED, earliestSec })` → `{ price, t, fromSeed }`
or `null` when no candle had closed by `T` and the seed does not apply. `T` is in UTC seconds.
`earliestSec` is the provider's verified earliest daily candle; when it is not passed, the first
candle given stands in for it. An invalid seed (non-positive price, date not `YYYY-MM-DD`) throws.

**Labels (approved decision).** `ATH_SEED` was `null` until Phase 8, which recorded the
verified seed above; the UI therefore uses the "Verified seed recorded" row of the table
below. A seed counts as verified
only when all three hold: its value and date come from an authoritative source cited in the
code comment and in this section; a test covers the seeded calculation; and the owner has been
told which source was used.

| State | Summary labels | Transaction context and buckets |
|---|---|---|
| No verified seed (default; Phases 3–7 and Phase 8 if verification fails) | "High since <date>", "Drawdown from High since <date>" | "High since <date>", "Drawdown from High since <date>" |
| Verified seed recorded | "All-Time High", "Distance from ATH", "Current Drawdown" | "Previous ATH", "Drawdown from Previous ATH" |

- `<date>` is the earliest **verified** provider daily candle date
  (`docs/market-data.md` §8), formatted mm/dd/yyyy. While earliest-candle discovery is still
  running, the figures show a loading state rather than a date that may move.
- Without a seed there is no way to tell from the candles alone which transactions are
  affected, so the relabelling applies to every ATH-based figure, not only to early ones.
- A single function, `Indicators.athLabels({ seedVerified, earliestSec })`, returns the label
  strings so the rule lives in one place and is unit-tested. It returns
  `{ loading, summaryHigh, summaryDistance, summaryDrawdown, contextHigh, contextDrawdown }`.
  Without a verified seed, `summaryDistance` and `summaryDrawdown` are both
  "Drawdown from High since <date>" (they are the same number). With no seed and no
  `earliestSec`, `loading` is `true` and every label is `null`. Only `seedVerified === true`
  counts as verified.
- A value is never presented as an all-time high without a verified seed.
- **Even with the seed, the high needs the whole daily history.** While the earliest candle is
  not verified and held, a maximum over a partial history plus the 2013 seed would be wrong
  (it would miss every later high not yet loaded), so the summary and the context show a
  loading state, not a number, until then.
- Phase 8 attempts the verification. If no authoritative source can be found, the seed stays
  `null`, the "High since" labels remain, and that outcome is reported to the owner. Phase 8
  can complete in either state; it cannot complete with an unverified seed in the code.

## 13. No look-ahead: values "at" a transaction

Any value presented as having been known when a transaction happened must be computable from
data that existed at that moment.

**Rule.** Let `T` be the transaction instant in UTC seconds (`txInstant(tx) / 1000`). The
context series is the **daily** candle series restricted to candles with

```
t + 86400 <= T          (the daily candle had fully closed at or before the transaction)
```

All context indicators are computed on that restricted series and the value at its **last**
index is reported. Equivalent and cheaper: compute the indicator once over all completed daily
candles and read index `k`, where `k` is the last index with `t[k] + 86400 <= T`. This is valid
only because every indicator on this page is causal — the value at index `k` depends only on
indices `<= k`. Any future indicator that is not causal must not be used for context.

Consequences:

- The daily candle of the transaction's own UTC day is never used: its close is in the future
  relative to the transaction.
- Legacy rows without a time of day sit at 12:00:00 UTC (`isNoonPlaceholder`). The same rule
  applies and yields the previous day's candle, which is correct for any time on that day.
- Context is always daily, whatever interval is on screen.
- The forming candle is never used.
- If index `k` is inside the indicator's warm-up, or the previous day (`dayStart(T) − 1 day`)
  is a provider gap, the value is `null` and shown as "—". On a gap every value is `null`,
  the high included (the missing day's high is unknown).
- A transaction before the provider's first candle has no indicator values; its high is the
  seed when the seed applies (§12), else `null`.
- **Loading, not a number:** until the earliest daily candle is verified and held, or when the
  previous day is later than the newest daily candle held, `contextAt` reports `status:
  'loading'` and no values. An EMA, Wilder average or high computed from a partial history is
  a different, wrong number.

Context values (`PersonalMarket.contextAt`, `docs/personal-market-analytics.md` §12):

| Value | Key | Definition |
|---|---|---|
| SMA 20 / 50 / 200 | `sma20`, `sma50`, `sma200` | §4 at index `k` |
| RSI 14 | `rsi14` | §6 at index `k` |
| MACD 12, 26, 9: line, signal, histogram | `macd`, `macdSignal`, `macdHist` | §7 at index `k` |
| ATR 14 | `atr14` | §9 at index `k` |
| Bollinger 20, 2: upper / mid / lower | `bbUpper`, `bbMiddle`, `bbLower` | §8 at index `k` |
| Bollinger position | `bbPosition` | `(price_tx − lower[k]) / (upper[k] − lower[k])`; `null` when the bands coincide |
| 30-day volatility | `hv30` | §10 with N = 30 at index `k` |
| Previous ATH (or "High since <date>") | `high`, `highT`, `highFromSeed` | §12 `ATH(T)` |
| Drawdown from previous ATH | `drawdownFromHigh` | `price_tx / ATH(T) - 1`; if `price_tx > ATH(T)` the value is positive and shown as "above previous ATH" |
| Distance from SMA 50 / 200 | `distSma50`, `distSma200` | `price_tx / SMA[k] - 1` |
| SMA 50 above SMA 200 | `sma50AboveSma200` | `SMA50[k] > SMA200[k]` |

EMA at the configured periods is not part of the first version's context (the Phase 8 scope
lists the values above); adding it is the same read at index `k`.

`price_tx` is the transaction's resolved price (`docs/personal-market-analytics.md` §3) when it
is a fact of the transaction: `RECORDED_UNIT_PRICE`, `DERIVED_TRANSACTION_VALUE` or
`REWARD_RECEIPT_VALUE`. When the source is `HISTORICAL_MARKET_LOOKUP` (that day's close — later
than the transaction, so not known at the time, as `docs/personal-market-analytics.md` §3
already says) or `UNKNOWN`, `price_tx` is `null` and every distance, the drawdown and the
Bollinger position are `null`. The market values themselves are still shown.

Anything computed with later data must be labelled "retrospective" in the UI. The first
version contains no retrospective metrics.

## 14. Reference and test methodology

File: `tools/test/market-indicators.mjs`, run by `npm test`. No test framework; same style as
the existing test files.

For every indicator, three independent checks:

1. **Naive oracle.** A second, deliberately simple implementation written in the test file
   directly from the formula on this page (nested loops, no rolling state). The production
   function must match it on the daily fixture and on seeded pseudo-random series, to within
   `1e-9` relative. This is the method `tools/test/moving-average.mjs` already uses.
2. **Hand-computed vector.** A short series (8–20 values) with the expected output worked out
   by hand from the formula and written into the test with the arithmetic shown in a comment.
   Covers the seed step and the first two smoothed steps of EMA, RSI, MACD signal and ATR.
3. **Published example.** Where a widely published worked example exists for the same
   definition (Wilder-smoothed RSI and ATR, SMA-seeded EMA and MACD, population-deviation
   Bollinger Bands), its input and expected output are added as a fixture with the source cited
   in the test. Values are copied from the source at implementation time, not from memory. If
   a published example uses a different definition (for example an EMA seeded with the first
   value), it is not used.

   Used (fixture `tools/test/fixtures/indicators-published.json`, read programmatically from
   the spreadsheets linked on each StockCharts ChartSchool page on 2026-11-14): RSI(14)
   (`cs-rsi.xls`), SMA(10) and EMA(10) (`cs-movavg.xls`), Bollinger Bands (20, 2) upper,
   middle and lower (`cs-bbands.xls`). All match to about `1e-16`. Not used: ChartSchool's ATR
   (`cs-atr.xls`) seeds with the first bar's high − low as a true range, which §9 does not; its
   Bollinger "BandWidth" column is upper − lower, not divided by the middle band; no MACD or
   historical-volatility spreadsheet was found.

Structural checks for every indicator:

- Output length equals input length.
- Exactly `warmup(settings)` leading `null` values, and no `null` after them on gap-free input.
- No `NaN`, no `Infinity`.
- Input array and its candles are unchanged (deep-frozen input).
- Empty input and input shorter than the warm-up return all-`null` arrays without throwing.
- **Causality:** for random `i`, changing every candle after `i` leaves outputs `0…i` identical.
- **Segmentation:** a series with a gap produces a fresh warm-up after the gap.

Specific checks:

- RSI and SMA compatibility with `buildMovingAverageSeries` (§6).
- RSI = 100 on a strictly rising series and on a flat series; RSI = 0 on a strictly falling series.
- Bollinger uses divisor `N`; historical volatility uses divisor `N-1` — a test where the two
  would differ.
- Annualization factor for `1d`, `1h`, `1w`.
- Drawdown: known peak and trough; monotonic rise gives 0.
- Previous ATH: excludes the transaction day's candle; seed applied before it is exceeded and
  ignored after; the recorded seed's value, date and source (Phase 8).
- `athLabels`: "High since <date>" wording when the seed is not verified; all-time-high
  wording only when it is; loading state when the earliest date is not yet known.
- Returns: each period against hand-computed values; `null` when the reference candle is missing.
- Settings validation: out-of-range and non-integer periods, `fast >= slow`.
