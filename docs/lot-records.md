# Lot identification records

Status: phases 1–2 of 4 built. Plan: lot-method history → engine records → capture on save,
view and backfill → drift check and export.

## Why

Under the per-wallet rules in force since 2025, HIFO is valid only as specific identification
made no later than the sale or transfer. For a self-custody wallet, the owner's own records are
the evidence. SatLedger can recompute lots at any time, but a recomputation is not a record of
what was identified at the time. This feature makes the app keep that record.

## Data

Both live as fields on objects that already sync, so they go through save, Drive sync, backups,
restores and the pre-sync snapshot with no new storage key and no `BACKUP_SCHEMA_VERSION` bump.
No transaction is copied anywhere.

- `wallet.lotMethodHistory`: append-only `{ method, from: ISO, source }`, where `source` is
  `created`, `changed` (only when the method actually changes) or `confirmed` (the Harvest tab's
  "Record lot methods" button, for wallets with no dated record). `lotMethod` remains the setting
  the engine reads. Helpers: `lotMethodHistoryOf`, `appendLotMethodHistory`, `lotMethodAt`,
  `lotMethodSince`.
- `tx.lotRecords` (phase 3): append-only records on Sell and outgoing Transfer rows, built by
  `lotRecordFor`:

```
{ v: 1, recordedAt: ISO, source: 'save'|'edit'|'backfill', txAt: ISO, wallet, method,
  priceUsd, shortSats?,
  lots: [{ k: 'sell'|'move'|'out'|'fee', o: originTxId, a: acquiredAtMs, s: sats,
           b: basisUsd, lt: longTerm, e?: estimated, nb?: noBasis }] }
```

Lots are named by `originTxId` + `acquiredAt`. Lot ids (`L<n>`) are renumbered on every replay
and must never be stored.

## Lot engine changes

This feature lifts the Market plan's "never modify `buildLots`" rule, for these additions only:

- Every disposal carries `originTxId`, `platform` and `lotType` of its source lot.
- A Transfer with a destination records its moved slices as kind **`'move'`**. A move is not a
  disposal: anything summing proceeds, basis or gains must skip it, because internal wallet
  transfers are never acquisitions or disposals.

`buildLots`' `lots` and `balancesSats` output is unchanged.

## Drift

`compareLotRecord(saved, fresh)` returns `match` when the same lots in the same sats were taken
(basis compared to the cent), otherwise `differs` with `added` and `removed`. Drift means later
edits to the ledger changed what the engine would pick, and the saved record no longer agrees
with the current data. Records are never rewritten to hide that.
