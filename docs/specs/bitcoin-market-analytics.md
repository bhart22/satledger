You are the lead software architect, senior frontend engineer, quantitative-market-data engineer, and Cloudflare developer working on an EXISTING Bitcoin transaction tracking application.

The existing application:

- is web-based
- is hosted using Cloudflare Workers
- allows the user to document Bitcoin transactions
- provides basic Bitcoin portfolio and transaction analytics
- exports transaction data into a format compatible with CoinLedger for tax reporting
- already contains the user's authoritative Bitcoin transaction history
- is already functional and must NOT be broken or unnecessarily rewritten

Your task is to DESIGN AND IMPLEMENT a new advanced Bitcoin market charting and quantitative-analysis module inside the existing application.

The experience should be comparable in usability to advanced charting tools found in products such as:

- Robinhood Advanced Charts
- TradingView
- Coinbase Advanced
- Kraken Pro
- professional market-analysis dashboards

Do NOT copy proprietary code, UI, branding, layouts, or indicator implementations.

The defining difference between this application and a generic Bitcoin chart is that the chart must understand and overlay the user's ACTUAL Bitcoin transaction history.

The system should allow the user to move between:

WHAT DID BITCOIN DO?

WHAT TRANSACTIONS DID I MAKE?

WHAT DID THE MARKET LOOK LIKE WHEN I MADE THEM?

HOW HAS MY BITCOIN POSITION CHANGED THROUGH TIME?

---

# FIRST RULE — INSPECT THE EXISTING PROJECT

Before writing significant code:

1. Inspect the entire existing repository.
2. Determine the frontend framework.
3. Determine routing.
4. Determine the Cloudflare Worker architecture.
5. Determine API structure.
6. Determine current storage/database.
7. Determine styling/component system.
8. Determine the Bitcoin transaction schema.
9. Determine transaction types currently supported.
10. Determine whether transactions are stored as BTC decimals, satoshis, strings, BigInt, or another precision-safe representation.
11. Determine whether historical Bitcoin price data already exists.
12. Determine authentication/security.
13. Determine current navigation.
14. Determine GitHub/deployment workflow.
15. Determine whether analytics utilities already exist.

Do NOT create duplicate transaction storage.

Do NOT alter the authoritative transaction schema unless there is a compelling architectural reason.

Do NOT replace working architecture unnecessarily.

Integrate with the existing project.

Document major architectural changes before implementing them.

---

# PRODUCT GOAL

Add an advanced Bitcoin market and personal quantitative analytics section.

Suggested navigation:

Dashboard

Transactions

Analytics

Market

Exports

Settings

Use the existing application's navigation conventions.

Potential route:

/market

or:

/analytics/market

The Market module should combine:

- professional candlestick charting
- historical Bitcoin market data
- technical indicators
- quantitative analytics
- personal transaction markers
- accumulation analysis
- market context at each transaction
- personal BTC balance history

---

# PRIMARY MARKET SCREEN

Create a responsive Market Analytics screen.

Suggested structure:

BTC / USD

Current Price

24h Change

Market Data Freshness

--------------------------------

TIME RANGE

1D
1W
1M
3M
6M
YTD
1Y
3Y
5Y
ALL

--------------------------------

CANDLE INTERVAL

1m
5m
15m
30m
1h
4h
1D
1W

Only expose intervals actually supported by the selected provider/data architecture.

--------------------------------

CHART CONTROLS

Candles

Linear / Log

Indicators

Show My Transactions

Fullscreen

--------------------------------

MAIN PRICE CHART

Candlesticks

Moving averages

Bollinger Bands

Average Acquisition Price

Personal transaction markers

--------------------------------

INDICATOR PANES

Volume

RSI

MACD

ATR

Historical Volatility

BTC Balance

--------------------------------

QUANTITATIVE SUMMARY

Market Metrics

Personal Activity

Accumulation Analytics

---

# CHARTING ENGINE

Prefer:

TradingView Lightweight Charts

unless inspection of the current project identifies a technically better choice.

Use the charting library directly.

Do NOT embed the full TradingView website/widget as the primary implementation.

Reasons include:

- full control over market data
- personal transaction overlays
- custom indicators
- application-specific analytics
- consistent styling
- provider independence
- mobile customization

Keep chart-specific implementation isolated enough that the rest of the domain logic is not tightly coupled to one chart library.

---

# MARKET DATA MODEL

Normalize external market data.

Example:

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

Use UTC internally.

Bitcoin trades:

24 hours per day

7 days per week

365 days per year

Do NOT implement stock-market session assumptions.

---

# MARKET DATA PROVIDER ABSTRACTION

Do NOT tightly couple the application to Coinbase, Kraken, CoinGecko, or another specific service.

Create:

MarketDataProvider

Example capabilities:

getCurrentPrice()

getCandles()

get24HourStats()

getAvailableIntervals()

getHistoricalRange()

optional subscribeRealtime()

Example:

interface MarketDataProvider {
    getCandles(request: CandleRequest): Promise<Candle[]>;
    getCurrentPrice(): Promise<PriceQuote>;
    get24HourStats(): Promise<MarketStats>;
}

Select an initial provider based on:

- reliability
- historical depth
- supported intervals
- rate limits
- API quality
- licensing/terms
- volume data quality
- whether authentication is required
- geographic availability

Document the provider decision.

Never expose provider credentials in frontend code.

---

# PROVIDER-INDEPENDENT ARCHITECTURE

Preferred flow:

UI
↓
Market Data Service
↓
MarketDataProvider
↓
External Provider

The UI should never parse provider-specific responses directly.

---

# MARKET DATA VALIDATION

Treat market data as untrusted external input.

Validate:

timestamp

open

high

low

close

volume

ordering

duplicates

missing values

finite numbers

For each candle verify where possible:

high >= open

high >= close

low <= open

low <= close

high >= low

Reject malformed data rather than silently feeding it into indicator calculations.

---

# TIME RANGE VS INTERVAL

These are separate concepts.

TIME RANGE:

1D

1W

1M

3M

6M

YTD

1Y

3Y

5Y

ALL

CANDLE INTERVAL:

1m

5m

15m

30m

1h

4h

1d

1w

Examples:

1 Month range
+
4-hour candles

5 Years
+
daily candles

Do not mix these concepts internally.

---

# SMART DEFAULT INTERVALS

Select sensible defaults.

Example:

1D
→ 5m / 15m

1W
→ 1h

1M
→ 4h

3M
→ 4h / 1d

1Y
→ 1d

5Y
→ 1d / 1w

ALL
→ 1w

These are defaults only.

Allow manual override when provider capability allows it.

Prevent unreasonable requests involving excessive candle counts.

---

# CANDLE AGGREGATION

Support aggregation where useful.

Example:

1h candles
→ 4h candles

Never create smaller-resolution candles from larger-resolution candles.

Aggregation:

OPEN
=
first open

HIGH
=
max high

LOW
=
min low

CLOSE
=
last close

VOLUME
=
sum

Use deterministic UTC buckets.

Unit test this logic.

---

# CORE CHART INTERACTION

Support:

horizontal pan

horizontal zoom

mouse wheel zoom

pinch-to-zoom

touch pan

crosshair

price scaling

time scaling

fit content

reset view

responsive resizing

fullscreen/expanded mode

Avoid chart gestures interfering unnecessarily with page scrolling.

---

# MOBILE-FIRST REQUIREMENT

Mobile is a first-class requirement.

Do not create a desktop chart that merely shrinks.

Mobile should support:

- pinch zoom
- touch panning
- touch transaction inspection
- touch candle inspection
- compact indicator controls
- bottom-sheet or drawer indicator settings
- horizontally scrollable toolbar where needed
- responsive pane sizing
- portrait mode
- landscape expanded-chart mode
- large enough touch targets
- no tooltip permanently blocking important data

On landscape mobile, maximize chart usefulness.

---

# CROSSHAIR / CANDLE INSPECTION

When hovering or touching a candle display:

Date

Time

Open

High

Low

Close

Absolute change

Percentage change

Volume

Enabled indicator values

Example:

Nov 14, 2026 03:00 UTC

O  $96,240
H  $97,110
L  $95,820
C  $96,880

+0.67%

SMA 50
$94,702

RSI 14
57.3

On mobile, use a compact persistent data area instead of relying solely on hover behavior.

---

# CURRENT PRICE

Display prominently:

Current BTC/USD

24-hour absolute change

24-hour percentage change

Last updated

Example:

$96,821.42

+$1,142.83

+1.19%

24H

Do not derive 24-hour statistics from arbitrary visible chart endpoints.

---

# PRICE SCALE

Support:

LINEAR

LOGARITHMIC

Remember preference.

Logarithmic mode is especially important for long-term Bitcoin history.

---

# CHART MODES

Initial:

CANDLESTICK

Architect for future:

LINE

AREA

Do not overbuild initially.

---

# VOLUME

Display volume where provider data is sufficiently reliable.

Volume should correspond to the currently selected candle interval.

Allow:

show/hide

If source is an individual exchange:

clearly understand that this is exchange-specific volume.

Do NOT label it global Bitcoin trading volume.

---

# TECHNICAL INDICATOR ARCHITECTURE

Indicators must be modular.

Create abstractions such as:

IndicatorDefinition

IndicatorInstance

IndicatorSettings

IndicatorCalculator

IndicatorResult

Example concept:

interface TechnicalIndicator {
    id: string;
    name: string;
    category: IndicatorCategory;
    calculate(
        candles: Candle[],
        settings: unknown
    ): IndicatorResult;
}

Avoid putting indicator formulas directly into React components.

---

# INDICATOR CATEGORIES

TREND

MOMENTUM

VOLATILITY

VOLUME

STATISTICAL

---

# INITIAL INDICATORS

Prioritize:

SMA

EMA

RSI

MACD

Bollinger Bands

ATR

Volume

Historical Volatility

Add more only after architecture is correct.

---

# SIMPLE MOVING AVERAGE

Implement SMA.

Default options:

20

50

100

200

Allow configurable period.

Display over price chart.

---

# EXPONENTIAL MOVING AVERAGE

Implement EMA.

Common defaults:

12

21

50

200

Allow configurable period.

---

# MOVING AVERAGE CROSSOVERS

Detect:

Golden Cross

Death Cross

generic configured crossover

Example:

SMA 50 crossing SMA 200

Treat as analytical events.

Do NOT label as guaranteed trade signals.

---

# RSI

Implement Relative Strength Index.

Default:

14 periods

Separate synchronized pane.

Reference levels:

70

50

30

Allow configuration.

---

# MACD

Default parameters:

12

26

9

Display:

MACD line

Signal line

Histogram

Separate synchronized pane.

---

# BOLLINGER BANDS

Default:

20-period SMA

2 standard deviations

Display:

upper band

middle band

lower band

Optionally calculate:

Band Width

%B

---

# ATR

Implement Average True Range.

Default:

14 periods

Use for volatility analytics.

---

# VWAP

Architect for VWAP.

Only enable where available OHLCV data makes the calculation meaningful.

Because Bitcoin trades continuously:

document exactly how VWAP reset periods are defined.

Do not display misleading VWAP values.

---

# HISTORICAL VOLATILITY

Implement rolling realized volatility.

Potential periods:

7

14

30

90

Document:

formula

return type

annualization method

---

# RETURNS

Calculate:

1D

7D

30D

90D

YTD

1Y

3Y

5Y

selected visible range

Support both:

simple returns

log returns

where useful.

Document which is used for each metric.

---

# DRAWDOWN

Calculate:

current drawdown

maximum drawdown for selected range

distance from previous ATH

distance from current/all-time high

---

# RANGE ANALYTICS

Provide:

range open

range close

range high

range low

range return

average daily return

median daily return

maximum drawdown

historical volatility

---

# QUANTITATIVE SUMMARY

Potential metrics:

Current Price

24h Change

Selected Range Return

Range High

Range Low

52-Week High

52-Week Low

All-Time High

Distance From ATH

SMA 50

Distance From SMA 50

SMA 200

Distance From SMA 200

RSI 14

ATR

30-Day Volatility

Maximum Drawdown

Current Drawdown

---

# INDICATOR TOGGLE PANEL

Example:

Indicators

TREND

☐ SMA 20
☑ SMA 50
☐ SMA 100
☑ SMA 200
☐ EMA

MOMENTUM

☑ RSI
☐ MACD

VOLATILITY

☐ Bollinger Bands
☐ ATR
☐ Historical Volatility

VOLUME

☑ Volume
☐ VWAP

Allow indicator settings.

---

# INDICATOR SETTINGS

Example:

SMA

Period:
50

Source:
Close

Display:
Overlay

Validate settings.

---

# INDICATOR PRESETS

Provide optional presets such as:

BASIC

SMA 50

SMA 200

Volume

MOMENTUM

RSI

MACD

LONG TERM BTC

SMA 200

RSI

Historical Volatility

Do not call them trading strategies.

---

# SYNCHRONIZED INDICATOR PANES

Indicators requiring separate scales should appear in synchronized panes.

Examples:

Price

Volume

RSI

MACD

ATR

BTC Balance

All panes share:

time range

pan

zoom

crosshair timestamp

---

# INDICATOR CALCULATION

Prefer local calculation from normalized candle data.

Advantages:

provider independence

consistent formulas

reproducibility

unit testing

historical analysis

Avoid provider-calculated technical indicators unless there is a compelling reason.

---

# MATHEMATICAL CORRECTNESS

Do not implement indicators approximately from memory.

For each quantitative calculation:

document formula

document initialization behavior

document defaults

document warm-up period

verify implementation against trusted reference values

write unit tests

Pay particular attention to differences in:

EMA initialization

RSI smoothing

MACD initialization

volatility annualization

drawdown calculations

---

# CURRENT CANDLE

The current candle may still be forming.

Make incomplete candle state clear.

Indicators calculated using it may change.

Do not present current candle values as finalized historical data.

---

# DATA FRESHNESS

Show:

last price update

last candle update

historical data status

If data becomes stale:

display stale state

Do not silently present old data as live.

---

# REAL-TIME ARCHITECTURE

Initial implementation may use polling.

Architect for possible later:

WebSocket ticker

live candle updates

incremental price updates

Keep transport abstraction separate from charting.

---

# CACHE ARCHITECTURE

Do not repeatedly hit market-data providers for identical historical requests.

Preferred flow:

Browser
↓
Cloudflare Worker
↓
Cache
↓
Market Provider

Use existing Cloudflare architecture appropriately.

Possible tools:

Cache API

KV

D1

Do not introduce infrastructure unnecessarily.

---

# HISTORICAL CANDLE STORAGE

If persistent candle storage is beneficial, use a normalized structure.

Example:

market_candles

symbol

currency

interval

timestamp

open

high

low

close

volume

provider

created_at

updated_at

Unique:

symbol
+
interval
+
timestamp

Do not store uncontrolled raw tick data unless explicitly required.

---

# CLOUDFARE CRON

If local historical storage is implemented:

use scheduled ingestion for appropriate completed candles.

Potential jobs:

refresh daily candles

refresh completed hourly candles

backfill gaps

verify history

Jobs must be:

idempotent

rate-limit aware

retry-safe

---

# BACKFILL

Implement safe historical backfill.

It should:

request provider-safe date chunks

respect rate limits

deduplicate

validate

resume safely

report failures

Do not hammer provider APIs.

---

# MISSING CANDLE DETECTION

Distinguish:

missing time-series candle

from

legitimate market price gap.

Bitcoin trades continuously, so unexpected missing intervals should be detectable.

---

# PUBLIC MARKET API

Follow the existing application's API conventions.

Potential routes:

GET /api/market/price

GET /api/market/stats

GET /api/market/candles

Validate:

symbol

interval

from

to

limit

Never allow arbitrary user-supplied URL fetching.

Do not turn market endpoints into an SSRF proxy.

---

# REQUEST MANAGEMENT

When changing:

range

interval

indicator configuration

quickly:

cancel or supersede stale requests.

Never allow a slower old response to overwrite newer chart state.

---

# LOADING STATES

Provide:

chart skeleton

loading history

updating

partial data

error states

Do not leave blank unexplained chart areas.

---

# URL STATE

Allow non-sensitive chart configuration in the URL.

Example:

/market?range=1y&interval=1d&sma=50,200&rsi=14

This enables:

refresh persistence

bookmarking

sharing chart configurations

Do NOT include private transaction information in query parameters.

---

# LOCAL PREFERENCES

Persist:

range

interval

enabled indicators

indicator settings

linear/log scale

transaction visibility

favorite preset

theme if not already globally handled

Use existing settings storage where appropriate.

Otherwise local storage is acceptable initially.

---

# PERSONAL TRANSACTION OVERLAY — CORE REQUIREMENT

The chart must integrate with the Bitcoin transaction history already stored by the application.

This is part of the FIRST production version.

Do NOT treat it as an optional future enhancement.

The goal is to visually and quantitatively correlate:

PERSONAL BITCOIN TRANSACTIONS

with

BITCOIN MARKET HISTORY

---

# TRANSACTION DATA SOURCE

Use the existing transaction records.

Do not duplicate transaction storage.

Create a chart-specific normalization layer only if required.

Example:

interface ChartTransaction {
    id: string;
    timestamp: number;
    type: TransactionType;
    btcAmount: string;
    usdAmount?: number;
    btcPrice?: number;
    priceSource?: PriceSource;
    source?: string;
    destination?: string;
    account?: string;
    notes?: string;
}

Use the application's actual transaction taxonomy.

Potential types may include:

BUY

SELL

REWARD

INCOME

TRANSFER_IN

TRANSFER_OUT

FEE

ADJUSTMENT

OTHER

Do not invent duplicate meaning if current transaction types already exist.

---

# BITCOIN PRECISION

Preserve the existing application's precision model.

Do NOT use ordinary JavaScript floating-point numbers as the authoritative representation of BTC/satoshi balances if the application currently uses:

satoshis

BigInt

decimal strings

decimal library

or another precision-safe method.

Chart visualization may convert quantities to numeric values for display where appropriate.

Accounting totals must remain exact.

---

# SHOW MY TRANSACTIONS

Add a primary chart toggle:

Show My Transactions

When enabled:

display personal transaction markers.

Default marker categories:

Purchases / Acquisitions

Sales / Disposals

Rewards / Income

Transfers hidden by default

Allow filtering.

---

# TRANSACTION MARKERS

Use distinct marker semantics.

Examples:

BUY / ACQUISITION
→ upward marker

SELL
→ downward marker

REWARD
→ reward icon

TRANSFER
→ optional neutral marker

Do not rely only on color.

Use:

shape

icon

label

or multiple distinguishing techniques.

---

# TRANSACTION PRICE

Position markers using transaction execution price where available.

Price source precedence:

1. Explicit stored transaction price.

2. USD value / BTC amount if mathematically valid.

3. Historical market lookup if transaction lacks price.

Track internally:

RECORDED

DERIVED_TRANSACTION_VALUE

HISTORICAL_MARKET_LOOKUP

UNKNOWN

Never silently present historical candle close as exact execution price.

---

# MULTIPLE TRANSACTIONS PER CANDLE

Support marker aggregation.

When zoomed out:

example:

5 acquisitions
0.034521 BTC

When clicked:

show individual entries.

When zoomed in:

show individual markers where practical.

Aggregation should respond to current zoom level.

---

# TRANSACTION DETAIL PANEL

Selecting a transaction marker should show:

Type

Date

Time

BTC Amount

Satoshis where useful

USD Value

Price Per BTC

Price Source

Account / Wallet

Source

Destination where relevant

Fees

Notes where appropriate

Provide:

View Transaction

which navigates to the application's authoritative transaction record.

Do NOT create a second independent transaction editor in the chart module.

---

# VIEW TRANSACTION ON CHART

From the existing transaction management interface:

add:

View on Chart

This should:

open Market Analytics

select an appropriate surrounding time range

center chart around transaction

highlight transaction

Optionally encode only the transaction ID in the URL if that fits existing security patterns.

Example concept:

/market?transaction=TX123

Do not place private transaction values directly in URL parameters.

---

# BIDIRECTIONAL NAVIGATION

Support:

Transaction
→ View on Chart

Chart Marker
→ View Transaction

This relationship is a core usability feature.

---

# MARKET CONTEXT AT TRANSACTION

For each relevant transaction calculate historical context using data known at that time.

Potential values:

BTC price

OHLC candle

SMA 20

SMA 50

SMA 200

EMA values

RSI 14

MACD

ATR

Bollinger Bands

Historical Volatility

Previous ATH

Drawdown From Previous ATH

Distance From SMA 50

Distance From SMA 200

Do NOT use future candles when calculating historical indicator state.

Avoid look-ahead bias.

---

# TRANSACTION CONTEXT PANEL

Example:

Bitcoin Acquisition

May 15, 2026
2:43 PM

Acquired:
0.00482000 BTC

Transaction Price:
$61,842

USD Value:
$298.08

MARKET CONTEXT

BTC:
$61,842

SMA 50:
$64,211
-3.69%

SMA 200:
$55,903
+10.62%

RSI 14:
37.2

Drawdown From Previous ATH:
-18.4%

30-Day Volatility:
...

Use factual analytics.

Do not label the transaction smart/good/bad.

---

# TRANSACTION FILTERS

Support:

Purchases

Rewards

Sales

Transfers

Fees where relevant

Potential advanced filters:

wallet

exchange

account

date range

transaction type

Use the actual application's fields.

---

# SELECTED RANGE PERSONAL SUMMARY

When transaction overlay is enabled:

show a summary for the currently selected time range.

Example:

MY ACTIVITY

Transactions:
18

BTC Acquired:
0.18420300 BTC

BTC Sold:
0.01000000 BTC

Net BTC Change:
+0.17420300 BTC

USD Invested:
$11,284

Average Acquisition Price:
$61,257

Do not count internal wallet transfers as acquisitions or disposals.

---

# WEIGHTED AVERAGE ACQUISITION PRICE

Calculate an analytical weighted average acquisition price where transaction data permits.

Conceptually:

sum(BTC acquired × acquisition price)
/
sum(BTC acquired)

Clearly label:

Average Acquisition Price

Do NOT label:

Tax Cost Basis

unless calculation uses the application's authoritative tax-lot methodology.

---

# AVERAGE ACQUISITION PRICE OVERLAY

Provide optional chart overlay:

Average Acquisition Price

Support:

CURRENT AVERAGE

and preferably:

HISTORICAL AVERAGE

Historical mode should display a step line showing how average acquisition price changed over time as acquisitions occurred.

Example:

Purchase 1
Average = $40,000

Purchase 2
Average = $43,250

Purchase 3
Average = $41,700

Sales should not arbitrarily alter this line unless methodology explicitly defines how.

Document the methodology.

---

# CURRENT PRICE VS AVERAGE ACQUISITION

Display:

Current BTC Price

Average Acquisition Price

Absolute Difference

Percentage Difference

Example:

BTC:
$96,821

Avg Acquisition:
$57,420

Difference:
+$39,401

+68.62%

Do NOT automatically call this taxable unrealized gain.

---

# BTC BALANCE HISTORY

Create an optional synchronized pane:

BTC Balance

Show cumulative holdings over time based on existing transactions.

Purchases:
increase

Rewards:
increase

Sales:
decrease

Spending:
decrease

Fees:
decrease where appropriate

Internal transfers:
net zero

Use existing transfer-linking logic where available.

Avoid double-counting transfers between the user's own wallets.

---

# ACCUMULATION BY PRICE RANGE

Create personal analytics such as:

BTC acquired below $25k

$25k-$50k

$50k-$75k

$75k-$100k

above $100k

Allow ranges to become configurable later.

Display:

BTC amount

percentage of acquisitions

USD value where available

---

# ACQUISITION DISTRIBUTION

Provide a histogram or table.

Example:

Price Range        BTC Acquired

$20k-$30k          0.08 BTC

$30k-$40k          0.14 BTC

$40k-$50k          0.23 BTC

$50k-$60k          0.18 BTC

$60k-$70k          0.31 BTC

$70k+              0.09 BTC

Do not overload the primary price chart.

---

# MOVING AVERAGE ACQUISITION ANALYTICS

Calculate:

BTC acquired below SMA 50

BTC acquired above SMA 50

BTC acquired below SMA 200

BTC acquired above SMA 200

BTC acquired while SMA 50 > SMA 200

BTC acquired while SMA 50 < SMA 200

Display:

BTC amount

transaction count

percentage of acquisition volume

These are descriptive analytics, not recommendations.

---

# RSI ACQUISITION ANALYTICS

Calculate:

BTC acquired when RSI < 30

RSI 30-50

RSI 50-70

RSI > 70

Display:

BTC amount

count

percentage

Use historically correct RSI values.

---

# DRAWDOWN AT ACQUISITION

For each acquisition calculate:

percentage below Bitcoin's previous all-time high at that point.

Example:

Acquisition price:
$52,000

Previous ATH:
$69,000

Drawdown:
-24.64%

Aggregate:

0-10%

10-20%

20-30%

30-40%

40-50%

50%+

Display BTC acquired in each drawdown bucket.

This is a particularly important personal analytics capability.

---

# HISTORICAL MARKET CONTEXT

Other useful acquisition context may include:

Historical volatility

ATR

Bollinger Band position

30-day price percentile

distance from SMA 200

distance from previous ATH

Do not calculate retrospective metrics using future data unless explicitly labeled as retrospective.

---

# PERSONAL TRANSACTION TIMELINE

Provide optional transaction list/timeline synchronized with chart.

Selecting transaction:

highlight marker

center chart where appropriate

Selecting marker:

highlight transaction row.

---

# PERSONAL ANALYTICS TABS

Potential structure:

MARKET

Candlestick chart
Indicators

MY ACTIVITY

Transactions
Accumulation
Average Acquisition
Balance History

QUANT

Returns
Volatility
Drawdown
Moving Average Context
RSI Analysis

Use tabs or another responsive layout.

Avoid displaying everything at once.

---

# PERSONAL ANALYTICS PRIVACY

Market data may be publicly cacheable.

Transaction data is private.

Separate:

PUBLIC MARKET DATA

from

AUTHENTICATED PERSONAL ANALYTICS

Do not send private transaction history from unauthenticated endpoints.

Enforce ownership server-side.

Never trust a user/account ID supplied by the browser as authorization.

---

# PERSONAL ANALYTICS API

If appropriate within the existing architecture:

GET /api/analytics/market-transactions

GET /api/analytics/acquisition-summary

GET /api/analytics/balance-history

GET /api/analytics/transaction-context/:id

Use current API conventions.

Authenticate all private routes.

---

# MARKET + TRANSACTION SERVICE ARCHITECTURE

Keep domains separate.

Preferred:

Transaction Service
+
Market Data Service
↓
Personal Market Analytics Service
↓
Chart / Quant UI

Do not put market-data provider calls directly inside chart components.

Do not put tax accounting logic inside market chart calculations.

---

# TAX ACCOUNTING BOUNDARY

This is critical.

The application already exports to CoinLedger.

Do NOT modify tax accounting logic unintentionally.

Market analytics may calculate:

average acquisition price

historical market value

percentage return

current market value

drawdown

market context

Do NOT automatically treat these values as:

IRS cost basis

tax lot basis

realized tax gain/loss

holding period

unless they come from the application's authoritative tax-accounting subsystem.

Keep:

MARKET ANALYTICS

separate from

TAX ACCOUNTING

---

# DATA EXPORT

Allow optional export of market analytics.

Example CSV:

timestamp

open

high

low

close

volume

SMA50

SMA200

RSI14

Do not mix this export with CoinLedger transaction export.

---

# QUANTITATIVE DATA TABLE

Provide optional tabular data.

Potential columns:

Date

Open

High

Low

Close

Change %

Volume

SMA 50

SMA 200

RSI

MACD

ATR

Enabled indicators can control additional columns.

---

# SECURITY

Never expose:

API keys

Cloudflare secrets

database credentials

authentication tokens

private transaction data

Validate:

API inputs

market-data provider responses

transaction IDs

authorization

Prevent:

SSRF

IDOR

XSS

unsafe URL fetching

---

# OBSERVABILITY

Log:

market provider failures

cache failures

invalid candles

indicator calculation errors

historical backfill errors

scheduled ingestion failures

personal analytics calculation failures

Do not unnecessarily log transaction details.

---

# TESTING

Create unit/integration tests for:

market normalization

candle validation

candle aggregation

timezone boundaries

SMA

EMA

RSI

MACD

Bollinger Bands

ATR

historical volatility

returns

drawdown

ATH calculations

missing candle detection

transaction normalization

BTC precision behavior

weighted acquisition price

balance history

transfer exclusion

transaction marker aggregation

market context at transaction

no-look-ahead calculations

authentication on personal endpoints

URL state

mobile controls

provider failure handling

---

# PERFORMANCE

Avoid unnecessary React rerenders.

Avoid recalculating all indicators on every UI event.

Use incremental chart updates where appropriate.

Memoize expensive calculations when useful.

Avoid one DOM component per transaction if chart-native rendering is available.

Aggregate transaction markers at low zoom levels.

Only add Web Workers if actual computation demands them.

Do not prematurely over-engineer.

---

# ACCESSIBILITY

Provide:

keyboard-accessible controls

labels

focus states

screen-reader-friendly summaries

high contrast

non-color-only transaction indicators

accessible data tables where useful

---

# VISUAL DESIGN

Use a professional quantitative-finance interface.

Avoid:

casino aesthetics

excessive flashing

gamified trading design

unnecessary red/green animation

The product should feel:

calm

technical

data-driven

professional

---

# INITIAL DEVELOPMENT PHASES

## PHASE 0 — EXISTING APPLICATION ANALYSIS

Inspect:

architecture

routes

storage

Cloudflare bindings

authentication

transaction model

precision model

UI system

deployment

Document integration plan.

## PHASE 1 — MARKET DATA

Implement:

MarketDataProvider

initial provider

Candle normalization

validation

current price

24h stats

historical candles

cache

error handling

## PHASE 2 — CORE CHART

Implement:

candlesticks

range selector

interval selector

zoom

pan

mobile pinch

crosshair

OHLC inspection

volume

linear/log scale

fullscreen

responsive layout

## PHASE 3 — CORE INDICATORS

Implement:

SMA

EMA

RSI

Volume

Then:

MACD

Bollinger Bands

ATR

Historical Volatility

## PHASE 4 — PERSONAL TRANSACTION OVERLAY

Implement:

transaction normalization

authenticated transaction retrieval

Show My Transactions

marker rendering

marker aggregation

transaction filters

transaction detail panel

View Transaction

View on Chart

market context at transaction

average acquisition price

average acquisition price overlay

BTC balance history

privacy validation

## PHASE 5 — PERSONAL QUANTITATIVE ANALYTICS

Implement:

BTC acquired by price range

acquisition distribution

BTC acquired above/below SMA 50

BTC acquired above/below SMA 200

RSI-at-acquisition distribution

drawdown-at-acquisition distribution

selected-range personal summary

price vs average acquisition

accumulation analytics

## PHASE 6 — DATA QUALITY / STORAGE

If necessary:

D1 candle cache

historical backfill

gap detection

Cron refresh

provider resilience

## PHASE 7 — ADVANCED ANALYTICS

Potential:

VWAP

Stochastic RSI

ROC

range-selection analysis

event markers

halving overlays

saved presets

comparison mode

## PHASE 8 — REAL TIME

Potential:

WebSockets

live ticker

current candle updates

Only implement when justified.

---

# FIRST PRODUCTION MILESTONE

The first production milestone must allow the user to:

1. Open Market Analytics.

2. See current BTC/USD price.

3. See 24-hour change.

4. View Bitcoin candlesticks.

5. Select:

1D

1W

1M

3M

6M

YTD

1Y

3Y

5Y

ALL

where available.

6. Select supported candle intervals.

7. Zoom.

8. Pan.

9. Pinch zoom on mobile.

10. Inspect OHLC values.

11. View volume.

12. Toggle linear/log scale.

13. Enable SMA.

14. Enable EMA.

15. Enable RSI.

16. Enable MACD.

17. Enable Bollinger Bands.

18. Enable ATR.

19. View synchronized indicator panes.

20. View range return.

21. View historical volatility.

22. View maximum drawdown.

23. View distance from SMA 50.

24. View distance from SMA 200.

25. Toggle Show My Transactions.

26. See acquisition markers.

27. See disposal markers.

28. See reward markers.

29. Hide transfers by default.

30. Filter transaction marker types.

31. Tap/click a transaction marker.

32. View BTC amount.

33. View USD amount where available.

34. View transaction price.

35. View transaction price source.

36. View historical SMA 50 at transaction.

37. View historical SMA 200 at transaction.

38. View historical RSI at transaction.

39. View drawdown from previous ATH at transaction.

40. Navigate from marker to transaction record.

41. Navigate from transaction record to chart.

42. View average acquisition price.

43. Toggle average acquisition price overlay.

44. View current price vs average acquisition price.

45. View cumulative BTC balance over time.

46. View selected-range BTC acquired.

47. View selected-range USD invested where available.

48. View BTC acquired above/below SMA 200.

49. View acquisitions by RSI range.

50. View acquisitions by drawdown range.

51. Handle overlapping transactions without marker clutter.

52. Preserve exact Bitcoin accounting precision.

53. Avoid double-counting transfers.

54. Keep transaction data private.

55. Keep CoinLedger export behavior unchanged.

56. Work cleanly on a Pixel/iPhone-sized display.

57. Work in mobile landscape.

58. Persist user chart preferences.

59. Gracefully handle unavailable market data.

60. Keep all existing transaction-tracking functionality working.

---

# FIRST TASK FOR THIS CODING SESSION

Before significant implementation:

1. Inspect the existing repository.

2. Document current architecture.

3. Identify frontend framework.

4. Identify Cloudflare Worker setup.

5. Identify bindings/storage.

6. Identify Bitcoin transaction schema.

7. Identify precision model.

8. Identify transfer handling.

9. Identify authentication.

10. Identify navigation.

11. Identify design system.

12. Identify existing price APIs.

13. Create:

docs/market-chart-architecture.md

docs/market-data.md

docs/technical-indicators.md

docs/personal-market-analytics.md

docs/transaction-overlay.md

docs/data-caching.md

docs/mobile-chart-ux.md

14. Identify ADRs.

15. Select chart library.

16. Select market-data provider.

17. Explain decisions.

18. Create MarketDataProvider abstraction.

19. Implement Candle model.

20. Implement validation.

21. Implement market API.

22. Implement caching.

23. Create Market page.

24. Implement candlesticks.

25. Implement range controls.

26. Implement interval controls.

27. Implement crosshair.

28. Implement mobile interactions.

29. Implement volume.

30. Implement SMA.

31. Implement EMA.

32. Implement RSI.

33. Implement synchronized panes.

34. Implement transaction normalization.

35. Implement Show My Transactions.

36. Implement transaction markers.

37. Implement marker detail.

38. Implement View on Chart.

39. Implement chart-to-transaction navigation.

40. Implement average acquisition price.

41. Implement transaction market-context calculations.

42. Write mathematical unit tests.

43. Write transaction-overlay tests.

44. Run lint.

45. Run TypeScript checks.

46. Run tests.

47. Run production build.

48. Fix errors before continuing.

Do not attempt every technical indicator at once.

Do not postpone the transaction overlay until the very end.

The distinguishing feature of this application is the combination of market analytics and personal Bitcoin history.

---

# CODING STANDARDS

Use TypeScript strict mode.

Avoid `any`.

Use runtime validation at external trust boundaries.

Keep these concerns separate:

market data

indicator calculations

personal transaction data

personal market analytics

chart rendering

tax accounting

Market-provider implementations must be replaceable.

Indicators should preferably be pure deterministic functions.

Use UTC internally.

Do not alter Bitcoin transaction precision.

Do not expose secrets.

Do not expose private transactions.

Use server-side authorization.

Do not silently swallow errors.

Use structured logs.

Document mathematical formulas.

Comment WHY rather than obvious WHAT.

Use existing project conventions where they are sound.

---

# AI DEVELOPMENT BEHAVIOR

You are operating directly inside the existing VS Code workspace.

Before modifying files:

inspect existing code

understand current architecture

preserve working functionality

Do not create duplicate infrastructure.

Do not create duplicate transaction storage.

Do not rewrite existing tax/export behavior.

Explain significant architectural decisions.

Maintain a roadmap.

Work incrementally.

After meaningful changes:

run lint

run TypeScript checks

run unit tests

run build

Fix errors before continuing.

When adding dependencies:

explain why

prefer mature packages

avoid unnecessary dependencies

lock versions

When implementing quantitative formulas:

verify

document

test

When calling market APIs:

respect rate limits

cache appropriately

validate responses

handle outages

never leak credentials

When combining transaction data and market data:

avoid look-ahead bias

preserve transaction precision

avoid transfer double-counting

preserve the canonical transaction source

---

# DEFINITION OF SUCCESS

Do not think:

"We are adding a Bitcoin chart."

Think:

"We are adding a personal Bitcoin quantitative-analysis workstation to an existing Bitcoin transaction ledger."

The architecture should become:

BITCOIN MARKET DATA
↓
OHLCV
↓
TECHNICAL INDICATORS
↓
MARKET CONTEXT

combined with:

PERSONAL TRANSACTION HISTORY
↓
ACQUISITIONS / DISPOSALS / REWARDS
↓
BTC BALANCE HISTORY

which produces:

PERSONAL BITCOIN ANALYTICS
↓
INTERACTIVE CANDLE CHART
↓
TRANSACTION OVERLAY
↓
MARKET CONTEXT AT EACH TRANSACTION
↓
ACCUMULATION ANALYTICS
↓
QUANTITATIVE ANALYSIS

The user should be able to answer:

What was Bitcoin doing?

Where did I buy?

Where did I sell?

Where did I earn rewards?

What was RSI when I acquired?

Was Bitcoin above or below its 200-day moving average?

How far had Bitcoin fallen from its previous all-time high?

How much BTC did I accumulate during major drawdowns?

What is my weighted average acquisition price?

How has that average changed over time?

How has my BTC balance accumulated over time?

Where does today's price sit relative to my acquisition history?

The product should not merely show where Bitcoin traded.

It should show where the user participated in Bitcoin's history.

Start by inspecting the existing project and designing the market-data, indicator, transaction-overlay, and personal-analytics architecture before implementing the first production milestone.