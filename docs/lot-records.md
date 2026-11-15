# Lot identification records

Status: phases 1–3 of 4 built. Plan: lot-method history → engine records → capture on save,
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

## When records are made

- **On save** (`commitTransaction`): a new Sell or outgoing Transfer gets its record from a
  replay of the list it is saved into (`source: 'save'`). On an edit, a fresh record is appended
  (`source: 'edit'`, or `'save'` if the row had none) only when its picks differ from the latest;
  earlier records are kept as they are. Records are read from the live row, never from the
  form, so an edit can't rewrite them. Duplicating a row does not copy them.
- **Backfill** (Harvest → "Record past lots"): rows with no record get one dated now
  (`source: 'backfill'`), built in one replay by `lotRecordsFor`. Rows with a record are never
  touched. Imported rows and rows completed in the Fix Transfers wizard arrive without records
  and are picked up here.
- **Timeliness** is judged from the dates, not the source: `isLotRecordTimely` says "at the
  time" when `recordedAt` is within 36 hours of the transaction, otherwise the UI says
  "recorded later". A row logged days after the trade is honest about it.
- Editing an *earlier* transaction can change what a later row would pick. That later row's
  record is not rewritten; the change shows up as drift.

## Drift

`compareLotRecord(saved, fresh)` returns `match` when the same lots in the same sats were taken
(basis compared to the cent), otherwise `differs` with `added` and `removed`. Drift means later
edits to the ledger changed what the engine would pick, and the saved record no longer agrees
with the current data. Records are never rewritten to hide that.
