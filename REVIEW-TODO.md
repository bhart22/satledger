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
- [ ] Confirm dialogs act on stale render-time arrays; wallets matched by index
- [ ] View preferences (chart range, hide values, wallet chips) synced as data edits → spurious conflicts
- [~] Backup restore reuses the file's old `lastModified` (fixed: restores get a fresh stamp); weak validation of restored settings/fields (open)
- [x] Drive pull ignores quota failures but still advances the commit marker
- [x] Force Push leaves the queued push alive
- [x] Dirty marker with no Drive file is never resent on launch
- [x] `handleSignIn` empty-side branches ignore the dirty marker
- [x] Unparsed PATCH response stores empty seen-mtime → conflict check disabled
- [ ] Service worker caches error/redirect responses over the app shell; no network timeout; no update prompt
- [ ] No price shown when Coinbase spot fails at launch (fall back to latest cached close)
- [ ] Edit negative-balance check adds back old amount to the wrong wallet when the wallet changes
- [ ] Partial price fetch caches one unfetched day with a forward-filled price
- [ ] Prices before Coinbase's first candle are back-filled
- [x] CoinLedger import ignores fee currency

## Decisions needed
- [ ] Unrealized P&L values excluded coins at $0 cost (value includes them, basis doesn't)
- [ ] Rewards carry $0 cost basis but export as income at FMV
- [ ] Transfer with no destination: holdings subtract amount, charts subtract only fee — pick one rule (and consolidate the 5 copies of balance logic)
- [ ] Export "Date (UTC)" column is really local date

## Security
- [ ] Tighten CSP (needs build step to drop `unsafe-inline`/`unsafe-eval`/all-of-unpkg)
- [ ] Clickjacking: `frame-ancestors`/`X-Frame-Options` header or frame-buster
- [ ] Vault: old-passphrase ciphertext survives in recovery snapshot / Drive revisions; change-passphrase doesn't ask for current one
- [ ] Load Google Identity script only when sync is used
- [ ] Wallet names as plain-object keys (`__proto__`); CSV Date column unguarded; vault inputs lack `autocomplete`

## Performance / mobile / a11y
- [ ] Build step (esbuild) to drop in-browser Babel (~3 MB, ~2.5 s transform); boot watchdog can fire on slow phones
- [ ] iOS input zoom (<16px inputs); `viewport-fit=cover` missing
- [ ] Labels not linked to inputs; unnamed toggles; toast lacks `aria-live`; small touch targets
- [ ] Charts re-render on every keystroke in the transaction modal
- [ ] Form validation: future dates, empty wallet, Transfer to same/empty wallet
- [ ] manifest `start_url` absolute; `prefers-color-scheme` ignored; theme flash

## Feature ideas
- [ ] Undo delete toast
- [ ] Exchange CSV import presets
- [ ] Duplicate transaction (DCA)
- [ ] Keyboard shortcuts

## Tests to add
- [~] Cost basis / P&L / holdings tests (sell-from-pool unit tests + oversell browser test added; P&L, holdings, stats still untested)
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
