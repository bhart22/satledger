# Review follow-up tracker

Findings from the full-project review on 2026-10-18. `[x]` done, `[~]` partly done, `[ ]` open.

## Fix first — data loss / wrong numbers
- [x] 1. Edit made while a Drive push is in flight is dropped (pending marker cleared by the older push)
- [x] 2. Drive HTTP errors treated as "no file" → overwrite or duplicate file (`findFile`/`pull` ignore `r.ok`, no `orderBy`)
- [x] 3. Two open tabs overwrite each other (no `storage` listener)
- [x] 4. Clock skew drops a dirty local edit on launch (timestamp check runs before dirty check; non-monotonic stamps)
- [x] 5. Cost basis goes negative when a sell exceeds the cost-basis pool (chart + stats)
- [x] 6. CoinLedger re-import: Deposit rows become outflows; TxHash read from wrong column
- [x] 7. Search crashes when `amount` is stored as a number

## Should fix
- [x] Sync silently stops after the ~1h token expiry while UI says Synced
- [x] Disconnect: no-op without a live token; when it runs it wipes seen-mtime so reconnect can't detect conflicts
- [x] Confirm dialogs act on stale render-time arrays; wallets matched by index
- [x] View preferences (chart range, hide values, wallet chips) synced as data edits → spurious conflicts
- [x] Backup restore reuses the file's old `lastModified`; weak validation of restored settings/fields (type guards in normalizeSettings, field coercion, vault shape check, 4 MB cap)
- [x] Drive pull ignores quota failures but still advances the commit marker
- [x] Force Push leaves the queued push alive
- [x] Dirty marker with no Drive file is never resent on launch
- [x] `handleSignIn` empty-side branches ignore the dirty marker
- [x] Unparsed PATCH response stores empty seen-mtime → conflict check disabled
- [x] Service worker caches error/redirect responses over the app shell; no network timeout; no update prompt
- [x] No price shown when Coinbase spot fails at launch (fall back to latest cached close)
- [x] Edit negative-balance check adds back old amount to the wrong wallet when the wallet changes
- [x] Partial price fetch caches one unfetched day with a forward-filled price
- [x] Prices before Coinbase's first candle are back-filled
- [x] CoinLedger import ignores fee currency

## Decisions needed
- [x] Unrealized P&L values excluded coins at $0 cost → decided: P&L only on coins with a cost basis; break-even uses the same pool
- [x] Rewards carry $0 cost basis → decided: basis = market value on the day (entered price, else that day's close)
- [x] Transfer with no destination → decided: outflow everywhere (pro-rata basis out, no realized P&L); balance rules consolidated into txWalletDeltas / txPortfolioDelta / applyTxToCostPool
- [ ] Export "Date (UTC)" column is really local date

## Security
- [ ] Tighten CSP (needs build step to drop `unsafe-inline`/`unsafe-eval`/all-of-unpkg)
- [~] Clickjacking: frame-buster added; an HTTP `frame-ancestors 'none'` header is still the stronger fix if the host allows it
- [~] Vault: snapshot copy now replaced on change/delete and the UI says old backups and Drive revisions remain; change-passphrase still doesn't ask for the current one
- [x] Load Google Identity script only when sync is used
- [x] Wallet names as plain-object keys (`__proto__`); CSV Date column unguarded; vault inputs lack `autocomplete`

## Performance / mobile / a11y
- [ ] Build step (esbuild) to drop in-browser Babel (~3 MB, ~2.5 s transform); boot watchdog can fire on slow phones
- [x] iOS input zoom (<16px inputs). `viewport-fit=cover` deliberately not added: without it iOS already keeps content out of the unsafe areas
- [~] Labels linked, toggles named, toast `aria-live` done; small touch targets and initial focus on Date still open
- [x] Charts re-render on every keystroke in the transaction modal (DashboardCharts memoised, stable updateSettings)
- [x] Form validation: future dates, empty wallet, Transfer to same/empty wallet
- [x] manifest `start_url` absolute; `prefers-color-scheme` ignored; theme flash

## Feature ideas
- [ ] Undo delete toast
- [ ] Exchange CSV import presets
- [ ] Duplicate transaction (DCA)
- [ ] Keyboard shortcuts

## Tests to add
- [x] Cost basis / P&L / holdings tests (shared balance-rule unit tests, oversell + excluded-P&L browser checks)
- [x] CoinLedger export → import round-trip

## Progress log
- **2026-10-18** (uncommitted): fixed items 1–7, plus the token-expiry, Disconnect, quota-on-pull,
  Force Push, missing-file, sign-in empty-branch, unparsed-PATCH and fee-currency items. New tests:
  `sellFromCostPool`, `parseCoinLedgerRows` round trip and `nextCommitStamp` (unit); numeric search,
  cross-tab write, oversell and edit-during-in-flight-push (browser). Each new browser check was
  confirmed to fail against the pre-fix `app.html`.
  - Behaviour change: on first sign-in from a device that already has unsynced local data, while
    Drive also has data, the Sync Conflict dialog now appears instead of silently picking by clock.
  - Not covered by automated tests: Drive error handling (#2), launch/sign-in ordering (#4) and
    Disconnect. These need a mocked Drive or a manual two-device check.
- **2026-10-19**: `d3cd16c` pushed (the items above). Second batch: stale confirm dialogs and
  index-matched wallet edits (now live refs + match by id), view-only settings kept per device
  (`DEVICE_VIEW_SETTING_KEYS`: chartRange, chartRangeCustom, hideValues, dashboardWalletFilter),
  service worker (only clean 200s are cached, 4 s network timeout, cache bumped to v4), an
  ETag-based "new version available" prompt, last-known price fallback, negative-balance check on
  edits, price history (fixed the off-by-one day; data now starts at Coinbase's first candle,
  2015-07-20), restore validation, and the small security items. New tests: `txEffectOnWallet`
  (unit); view settings stay local and malformed settings (browser). Both browser checks fail on
  the pre-fix code.
- **2026-10-19**: `dde93fd` pushed (second batch). Third batch: the Google sign-in script now loads
  only when sync is on or a Sign in button is hovered, focused or touched; frame-buster;
  theme applied before first paint, following the OS when there's no saved choice; 16px inputs on
  mobile (stops iOS zoom); relative manifest URLs; form rules (no future dates, wallet required,
  transfer needs two different wallets); all 20 form labels linked to their controls; toggles named;
  vault snapshot copy replaced on passphrase change and delete. New browser checks: label wiring,
  future-date and same-wallet refusal.
