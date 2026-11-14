# Mobile Chart UX

Part of the Market Analytics design; see `docs/market-analytics.md`.

Mobile is a first-class target. The reference sizes are a 360–430 px wide phone in portrait and
the same device in landscape. The existing app switches to its mobile layout at
`window.innerWidth <= 768` (`isMobileViewport`) and that breakpoint is reused.

---

## 1. Bottom navigation

Today the bar renders every `NAV_ITEMS` entry (seven, or six with the Vault hidden) at equal
width, already down to a 0.58 rem label at 480 px. An eighth item does not fit.

Changes:

- `NAV_ITEMS` order becomes: Dashboard, **Market**, Transactions, Wallets, Harvest, Vault,
  Export, Settings. Market is second in the sidebar, the drawer and the bottom bar.
- Market uses a chart-style icon added to the existing `Icon` set (a simple candlestick or
  line glyph drawn in the same stroke style).
- The bottom bar becomes horizontally scrollable:
  - `overflow-x: auto`, `overflow-y: hidden`, `flex-wrap: nowrap`,
    `-webkit-overflow-scrolling: touch`, `overscroll-behavior-x: contain`.
  - Scrollbar hidden (`scrollbar-width: none` and the WebKit pseudo-element).
  - Items stop shrinking: `flex: 0 0 auto` with a minimum width of 64 px and the existing
    minimum height (50 px). Labels return to a readable size (at least 0.625 rem).
  - `scroll-snap-type: x proximity`; items `scroll-snap-align: center`.
  - When the content overflows, a fade on the trailing edge signals that more items exist. The
    fade must not intercept touches (`pointer-events: none`).
- **Active item scrolls into view.** An effect keyed on `tab` calls
  `scrollIntoView({ inline: 'center', block: 'nearest', behavior })` on the active button, where
  `behavior` is `'auto'` on first render and under `prefers-reduced-motion`, otherwise
  `'smooth'`. This covers navigation from the drawer, a hash change, "View on Chart" and
  "View Transaction".
- The pill-shaped variant used at narrow widths keeps its rounded container; the scroll area is
  the inner row.
- Safe-area inset at the bottom is preserved.
- Existing `aria-label="Primary"`, `aria-current="page"` and per-item labels are unchanged.
- Keyboard: items remain buttons in DOM order; focusing an off-screen item scrolls it into view
  (native behaviour — do not suppress it).

The existing browser tests that click bottom-nav items must still pass.

## 2. Market screen layout — portrait

Top to bottom, inside the normal page scroll:

1. **Price header** — BTC / USD, current price, 24 h change (absolute and percent), freshness.
   One or two lines; wraps rather than truncating the price.
2. **Range row** — `1D 1W 1M 3M 6M YTD 1Y 3Y 5Y ALL`, horizontally scrollable, selected item
   scrolled into view.
3. **Toolbar** — interval selector, Linear/Log, Indicators, My Transactions, Expand.
   Horizontally scrollable, single row, never wraps onto a second line.
4. **Readout** — the persistent data area (§3).
5. **Chart** — price pane plus up to two indicator panes (§6).
6. **Tabs below the chart** — Market summary, My Activity. One visible at a time.

The chart never sits under a floating element. The page's bottom padding accounts for the
bottom navigation so the last table row is reachable.

## 3. Persistent readout

Hover does not exist on touch, and a tooltip that follows the finger hides the candle being
inspected. So:

- A fixed-height block directly above the chart shows the inspected candle. It is always
  present, so the layout does not jump when inspection starts or stops.
- Idle: it shows the most recent candle (marked "forming" if it is).
- While inspecting: date and time (UTC), O, H, L, C, change and percent change versus the
  previous close, volume, and one value per enabled indicator.
- Contents wrap into at most three short lines on a 360 px screen; indicator values beyond
  what fits are reachable by horizontal scroll within the block.
- Numbers use tabular figures so the block does not shimmer as values change.
- No floating tooltip is drawn over the chart on touch devices. On desktop the same readout is
  used; a pointer-following tooltip is optional and must not cover the crosshair candle.
- The readout is `aria-live="off"`; a separate visually hidden summary is described in §9.

When a transaction marker is selected, the readout shows a one-line summary of the marker
(category, count, BTC) and the detail opens as a bottom sheet (§7).

## 4. Touch, pan and zoom

| Gesture | Result |
|---|---|
| One-finger horizontal drag on the chart | Pan in time |
| One-finger vertical drag on the chart | **Scrolls the page** |
| Two-finger pinch | Zoom the time axis around the pinch midpoint |
| Tap | Select the candle (updates the readout); tap a marker to select it |
| Long press (≈ 350 ms) then drag | Crosshair inspection mode: horizontal and vertical movement both move the crosshair, page scroll is suppressed until release |
| Double tap | Fit content / reset view |
| Drag on the price scale | Scale the price axis (kept enabled; double tap on it resets auto-scale) |

Implementation notes:

- The chart container uses `touch-action: pan-y` so the browser handles vertical page scrolling
  and the library receives horizontal drags and pinches. In crosshair inspection mode and in
  the expanded overlay it switches to `touch-action: none`.
- The library's own vertical-touch-drag handling is disabled in the normal (inline) mode so it
  does not fight page scroll; it is enabled in the expanded overlay.
- Mouse-wheel zoom on desktop requires the pointer to be over the chart. Wheel events scroll
  the page unless the chart has been clicked or focused, so a page scroll that passes over the
  chart is not hijacked.
- Reset and Fit are also buttons in the toolbar; gestures are never the only way.
- Panning past the left edge triggers loading of older candles
  (`docs/market-data.md` §7) with a small "loading history" indicator at the edge.

## 5. Toolbar behaviour

- All controls are at least 44 × 44 CSS px with at least 8 px between targets.
- Interval selector: a compact button showing the current interval that opens a short list.
  Intervals not allowed for the range are shown disabled with the reason.
- Linear/Log: a two-state toggle with `aria-pressed`.
- Indicators: opens the bottom sheet (§7). A small count badge shows how many are enabled.
- My Transactions: a toggle; a long press or adjacent chevron opens the filter sheet.
- Expand: opens the full-bleed chart (§8).
- The row scrolls horizontally; the selected range and the active controls are scrolled into
  view on mount.

## 6. Panes

- Price pane is always present; volume is drawn in the lower band of the price pane, not as a
  separate pane.
- Separate panes: RSI, MACD, ATR, Historical Volatility, BTC Balance.
- **Portrait phone: at most two separate panes at once.** Enabling a third in the sheet either
  is prevented with a short explanation or replaces the oldest, with the choice made explicit
  ("Replace RSI?"). Desktop and the expanded landscape view allow up to four.
- Heights in portrait: price pane about 55 % of the chart height with no extra panes; with one
  pane 68 / 32; with two 56 / 22 / 22. Total chart height is
  `clamp(320px, 62vh, 560px)`.
- Each pane has a small title and the current value at its top-left, and a close button.
- All panes share time range, pan, zoom and crosshair.

## 7. Bottom sheets

Used on mobile for: indicator selection and settings, transaction filters, marker member list,
transaction detail.

- Built on the existing `Modal` / `useModalA11y` so focus trapping, Escape, focus restore and
  the reference-counted body scroll lock are inherited. A `.mkt-sheet` style anchors it to the
  bottom with rounded top corners and a maximum height of 85 vh; its content scrolls inside.
- Dismiss by the close button, the backdrop, Escape, or a downward drag on the handle.
- Indicator sheet: grouped by category (Trend, Momentum, Volatility, Volume). Each row is a
  switch; a chevron opens that indicator's settings (period, source, multiplier) inline.
  Numeric inputs use `inputMode="numeric"` and validate on blur; an invalid value shows the
  message and is not applied.
- Changes apply immediately; there is no separate Save.
- On desktop the same content renders as a popover or side panel rather than a sheet.
- Transaction detail sheet: the fields listed in `docs/personal-market-analytics.md` §11, with
  "View Transaction" as the primary action.

## 8. Landscape and expanded chart

- "Expand" opens a full-viewport overlay (built on the existing `ExpandedChartOverlay`
  behaviour: Escape closes, focus is restored).
- On a phone in landscape, the Market tab shows a prompt-free automatic layout: the chart
  fills the viewport height minus a single compact toolbar row; the price header collapses
  into that row; the bottom navigation is hidden while the overlay is open.
- Up to four panes are allowed in the expanded view.
- The readout becomes a single line overlaid at the top-left of the price pane, on a
  translucent background, positioned so it never covers the most recent candles (it sits at
  the left while the latest data is at the right).
- Rotating the device while expanded keeps the overlay open and resizes the chart.
- Closing the overlay returns to the same range, interval and scroll position.
- The Fullscreen API is not required; the overlay is a fixed-position element. If the
  Fullscreen API is used as an enhancement, its absence or rejection must not break Expand.

## 9. Resizing

- The adapter observes its container with a `ResizeObserver` and resizes the chart, throttled
  to one update per animation frame.
- Orientation change, sidebar collapse, the on-screen keyboard opening, and switching between
  inline and expanded modes all go through the same path.
- The visible time range is preserved across a resize.
- A zero-size container (tab hidden) does not create or resize the chart; the chart is created
  when the container first has a size.
- The observer is disconnected in `destroy()`.

## 10. Accessibility

- Every control is a real `button`, `input` or `select`, reachable by keyboard, with a visible
  focus ring using the app's existing focus style.
- Toggles expose `aria-pressed` or are `role="switch"` with `aria-checked`.
- Range and interval groups are `role="radiogroup"` with roving `tabindex` and arrow-key
  movement.
- The chart container has `role="img"` and an `aria-label` that states what is shown, for
  example: "BTC/USD daily candles, 1 year. Last close $96,880, range return +41.2 %. 12 of your
  transactions are marked."
- When the chart has focus: Left/Right move the crosshair one candle; Shift+Left/Right move ten;
  `+`/`−` zoom; Home/End jump to the first and last candle; Enter opens the marker on the
  current candle if there is one; Escape leaves inspection.
- A visually hidden live region (`aria-live="polite"`) announces the inspected candle after
  keyboard movement, throttled so it does not flood.
- Transaction markers are distinguished by shape and text as well as colour
  (`docs/personal-market-analytics.md` §9). Up and down candles differ in fill (hollow versus
  solid) as well as colour, or the theme provides a colour-blind-safe pair.
- Contrast: text and essential lines meet 4.5:1 against the chart background in both themes;
  grid lines are exempt.
- Every data table below the chart is a real `<table>` with header cells and a caption.
- A "View as table" control lists the user's markers in the visible range as an accessible
  list with the same "View Transaction" action, so nothing is reachable only through the canvas.
- `prefers-reduced-motion` disables animated transitions and smooth scrolling.
- No flashing, pulsing or animated price colour changes.
- Sheets and the expanded overlay trap focus and restore it on close (inherited).

## 11. Markers on touch devices

- Hit area around a marker is at least 44 × 44 px regardless of its drawn size. Where two hit
  areas overlap, the nearer marker centre wins.
- Tap a single marker: it is highlighted, the readout shows its summary, and the detail sheet
  opens.
- Tap an aggregated marker: a sheet lists its members; tapping one opens its detail.
- Tapping empty chart space clears the selection.
- A selected marker stays highlighted while its sheet is open and after "View on Chart".
- Markers never show a persistent label that covers candles; the count is the only text.
- Pinch-zooming changes the bucket size, so aggregated markers separate as the user zooms in
  and merge as they zoom out.
- Marker selection does not start a pan: a touch that moves less than 8 px is a tap.

## 12. States on small screens

Every state has a compact representation that fits the chart area without scrolling:

| State | Presentation |
|---|---|
| Library loading | Skeleton with the pane outline |
| Library failed to load | Message and Retry button |
| Loading history | Skeleton candles; on later loads a thin progress line at the top of the pane |
| Updating | Small spinner in the freshness line |
| Partial | Banner: "Some history could not be loaded" with Retry |
| Stale | Badge with age next to the price and in the freshness line |
| Offline with cache | Cached chart with "Offline — showing saved data from <time>" |
| Offline without cache | Message; the rest of the app remains usable |
| No transactions | Market chart works; My Activity shows an empty state |

## 13. Manual check list for the phase that completes mobile work

Portrait and landscape, on one Android-sized and one iPhone-sized viewport:

- Bottom bar scrolls; Market is second; switching to Settings from the drawer scrolls the bar.
- Vertical swipe starting on the chart scrolls the page.
- Horizontal swipe pans; pinch zooms; long-press inspects; double tap fits.
- Readout never covers candles and does not jump.
- Two panes maximum in portrait; four in expanded landscape.
- Indicator sheet opens, traps focus, closes by drag, backdrop and button.
- Marker tap opens detail; aggregated marker lists members; "View Transaction" opens the
  existing edit dialog; "View on Chart" from a transaction row lands on the marker.
- Rotation while expanded keeps state.
- Hide-values blurs personal figures and leaves the chart visible.
- Light and dark themes both legible.
- Labels fit at 360 px: "Average Acquisition Price" and "Drawdown from High since <date>" wrap
  or use the full line; they are not abbreviated to a different term (never "Avg Cost",
  "Cost Basis" or "ATH" without a verified seed — see `docs/market-analytics.md` §9 and
  `docs/technical-indicators.md` §12).

Touch behaviour in §4 (`touch-action`, disabling the library's vertical drag, long-press
inspection) assumes capabilities of the chart library that are verified at the start of
Phase 4. If the pinned version behaves differently, this document is corrected before the
mobile work is implemented.
