// Lot engine tests: ordering, HIFO/FIFO, transfers with fees, reward basis, long/short term.
import { loadAppHelpers } from '../lib/app-helpers.mjs';

const H = loadAppHelpers(['buildLots','isLongTerm','lotMethodFor','compareTx','migrateTxTimestamps',
  'txWalletDeltas','toSatsInt','backfillRewardUsd','harvestLots','harvestCsv','harvestSummaryAll','harvestSummaryCsv',
  'lotMethodHistoryOf','appendLotMethodHistory','lotMethodAt','lotMethodSince']);

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (c, name) => eq(!!c, true, name);
const near = (a, b, name, eps = 1e-6) => ok(Math.abs(a - b) < eps, `${name} (got ${a}, want ${b})`);

let n = 0;
const T = (iso, o) => ({ id: 'x' + (++n), date: iso.slice(0, 10), datetimeUtc: iso, sequence: 1, wallet: '', wallet2: '',
  amount: '', price: '', fee: '', totalUsd: '', notes: '', txhash: '', excludeStats: false, ...o });
const buy = (iso, wallet, amount, usd, o = {}) => T(iso, { type: 'Buy', wallet, amount, totalUsd: String(usd), price: String(usd / amount), ...o });
const sell = (iso, wallet, amount, usd, o = {}) => T(iso, { type: 'Sell', wallet, amount, totalUsd: String(usd), price: String(usd / amount), ...o });
const xfer = (iso, from, to, amount, fee, o = {}) => T(iso, { type: 'Transfer', wallet: from, wallet2: to, amount, fee, ...o });
const reward = (iso, wallet, amount, o = {}) => T(iso, { type: 'Reward', wallet, amount, ...o });
const sats = b => Math.round(b * 1e8);
const lotsIn = (r, w) => r.lots.filter(l => l.wallet === w).sort((a, b) => a.order - b.order);

// ── purchase basis: USD spent plus USD fee ───────────────────────────────────
{
  const r = H.buildLots([buy('2024-01-01T10:00:00.000Z', 'A', '1', 40000, { fee: '25' })]);
  eq(r.lots.length, 1, 'one lot per buy');
  eq(r.lots[0].basisUsd, 40025, 'purchase basis = USD spent + USD fee');
  eq([r.lots[0].sats, r.lots[0].type, r.lots[0].platform, r.lots[0].estimated], [1e8, 'Buy', 'A', false], 'buy lot fields');
}

// ── reward basis ─────────────────────────────────────────────────────────────
{
  const prices = { '2024-02-01': 40000 };
  const withValue = reward('2024-02-01T09:00:00.000Z', 'A', '0.001', { usdValueAtReceipt: '12.34', usdValueSource: 'manual' });
  const backfilled = reward('2024-02-01T09:01:00.000Z', 'A', '0.001', { usdValueAtReceipt: '40.000000', usdValueSource: 'estimated_backfill' });
  const missing = reward('2024-02-01T09:02:00.000Z', 'A', '0.001');
  const noPrice = reward('2024-03-01T09:00:00.000Z', 'A', '0.001');
  const r = H.buildLots([withValue, backfilled, missing, noPrice], { prices });
  const [a, b, c, d] = lotsIn(r, 'A');
  eq([a.basisUsd, a.estimated], [12.34, false], 'reward basis comes from usdValueAtReceipt, not the market price');
  eq([b.basisUsd, b.estimated], [40, true], 'a backfilled value is used but flagged estimated');
  eq([c.basisUsd, c.estimated], [40, true], 'missing value falls back to the daily close and is flagged estimated');
  eq([d.basisUsd, d.estimated, d.noBasis], [0, true, true], 'no value and no price: kept, flagged estimated and no-basis');
  eq(a.rewardCategory, 'cash_back', 'reward lots carry a category');
}

// ── same-minute ordering: a sale before a rebuy uses the old lots ────────────
{
  const old = buy('2024-01-01T12:00:00.000Z', 'A', '1', 20000);
  const minute = '2024-06-01T15:30:00.000Z';
  const theSale = sell(minute, 'A', '1', 50000, { sequence: 1 });
  const theRebuy = buy(minute, 'A', '1', 60000, { sequence: 2 });
  // Array order deliberately puts the rebuy first: sequence, not position, must decide
  const r = H.buildLots([old, theRebuy, theSale]);
  const sold = r.disposals.filter(d => d.kind === 'sell');
  eq(sold.length, 1, 'one sale');
  near(sold[0].basisUsd, 20000, 'the sale consumed the OLD lot (HIFO would have taken the rebuy had it come first)');
  eq(lotsIn(r, 'A').map(l => l.basisUsd), [60000], 'only the rebuy lot remains');
  // and with the sequences swapped the rebuy IS available to the sale
  const r2 = H.buildLots([old, { ...theRebuy, sequence: 1 }, { ...theSale, sequence: 2 }]);
  near(r2.disposals.find(d => d.kind === 'sell').basisUsd, 60000, 'swap the sequence and HIFO takes the rebuy lot');
  eq(r.warnings, [], 'no shortfall warnings');
}

// ── HIFO vs FIFO ─────────────────────────────────────────────────────────────
{
  const txs = [
    buy('2023-01-01T00:00:00.000Z', 'A', '1', 10000),
    buy('2023-02-01T00:00:00.000Z', 'A', '1', 30000),
    buy('2023-03-01T00:00:00.000Z', 'A', '1', 20000),
    sell('2024-06-01T00:00:00.000Z', 'A', '1.5', 45000),
  ];
  const hifo = H.buildLots(txs);
  eq(hifo.disposals.map(d => [d.sats, Math.round(d.basisUsd)]), [[1e8, 30000], [0.5e8, 10000]], 'HIFO sells the $30k lot then half the $20k lot');
  eq(lotsIn(hifo, 'A').map(l => [l.sats, Math.round(l.basisUsd)]), [[1e8, 10000], [0.5e8, 10000]], 'HIFO remainder');
  const fifo = H.buildLots(txs, { methodFor: () => 'FIFO' });
  eq(fifo.disposals.map(d => [d.sats, Math.round(d.basisUsd)]), [[1e8, 10000], [0.5e8, 15000]], 'FIFO sells oldest first');
  near(hifo.disposals.reduce((n, d) => n + d.proceedsUsd, 0), 45000, 'proceeds are fully allocated');
  eq(H.lotMethodFor([{ name: 'A', lotMethod: 'FIFO' }, { name: 'B' }], 'A'), 'FIFO', 'per-wallet method setting');
  eq(H.lotMethodFor([{ name: 'A', lotMethod: 'FIFO' }, { name: 'B' }], 'B'), 'HIFO', 'defaults to HIFO');
  eq(H.lotMethodFor([{ name: 'A', lotMethod: 'LIFO' }], 'A'), 'HIFO', 'an unknown method falls back to HIFO');
  // methods are per wallet
  const mixed = H.buildLots([
    buy('2023-01-01T00:00:00.000Z', 'A', '1', 10000), buy('2023-02-01T00:00:00.000Z', 'A', '1', 30000),
    buy('2023-01-01T00:00:00.000Z', 'B', '1', 10000), buy('2023-02-01T00:00:00.000Z', 'B', '1', 30000),
    sell('2024-01-01T00:00:00.000Z', 'A', '1', 1), sell('2024-01-01T00:00:00.000Z', 'B', '1', 1, { sequence: 2 }),
  ], { methodFor: w => w === 'B' ? 'FIFO' : 'HIFO' });
  eq(mixed.disposals.map(d => [d.wallet, Math.round(d.basisUsd)]), [['A', 30000], ['B', 10000]], 'each wallet applies its own method');
}

// ── HIFO across a transfer with a fee ────────────────────────────────────────
{
  const L1 = buy('2023-01-01T00:00:00.000Z', 'A', '1', 10000, { platform: 'x' });
  const L2 = buy('2023-02-01T00:00:00.000Z', 'A', '1', 30000);
  const L3 = buy('2023-03-01T00:00:00.000Z', 'A', '0.5', 10000);          // $20k/BTC
  const move = xfer('2024-01-01T00:00:00.000Z', 'A', 'B', '1.2', '0.001');
  const r = H.buildLots([L1, L2, L3, move]);
  const a = lotsIn(r, 'A'), b = lotsIn(r, 'B');
  // HIFO ranking: L2 ($30k), L3 ($20k), L1 ($10k). 1.2 moves = all of L2 + 0.2 of L3; the fee burns the next 0.001 of L3.
  eq(b.map(l => [l.sats, l.acquiredAt, Math.round(l.basisUsd * 1e6) / 1e6, l.platform]),
    [[1e8, Date.parse('2023-02-01T00:00:00.000Z'), 30000, 'A'], [0.2e8, Date.parse('2023-03-01T00:00:00.000Z'), 4000, 'A']],
    'moved lots keep their acquisition datetime, basis and original platform');
  eq(a.map(l => [l.sats, Math.round(l.basisUsd * 1e6) / 1e6]), [[1e8, 10000], [sats(0.5) - sats(0.2) - sats(0.001), 5980]],
    'the sender keeps L1 whole and loses the moved sats AND the fee from L3');
  near(r.disposals.filter(d => d.kind === 'fee').reduce((n, d) => n + d.sats, 0), sats(0.001), 'the fee burned exactly 0.001 BTC', 0.5);
  // the engine and the balance rules agree
  const bal = {};
  for (const tx of [L1, L2, L3, move]) for (const [w, d] of H.txWalletDeltas(tx, H.toSatsInt)) bal[w] = (bal[w] || 0) + d;
  eq(r.balancesSats, bal, 'per-wallet balances match txWalletDeltas');
  // a later HIFO sale in B takes the $30k lot it received
  const r2 = H.buildLots([L1, L2, L3, move, sell('2024-03-01T00:00:00.000Z', 'B', '0.5', 40000)]);
  near(r2.disposals.find(d => d.kind === 'sell').basisUsd, 15000, 'HIFO in the receiving wallet uses the transferred lot and its original basis');
  eq(r2.disposals.find(d => d.kind === 'sell').longTerm, true, 'and the transferred lot keeps its acquisition date for long/short term');
  // transfer to no-one: coins leave, no gain
  const out = H.buildLots([buy('2023-01-01T00:00:00.000Z', 'A', '1', 10000), xfer('2023-06-01T00:00:00.000Z', 'A', '', '0.4', '0.001')]);
  eq(out.balancesSats, { A: sats(0.6) - sats(0.001) }, 'an outflow removes amount + fee');
  eq(out.disposals.filter(d => d.kind === 'out').length, 1, 'outflow is recorded, not as a sale');
  // inflow from outside: unknown basis
  const inn = H.buildLots([xfer('2023-06-01T00:00:00.000Z', '', 'B', '0.3', '')]);
  eq([inn.lots[0].noBasis, inn.lots[0].estimated, inn.balancesSats], [true, true, { B: sats(0.3) }], 'inflow from outside is a no-basis lot');
}

// ── shortfalls, adjustments, exclusions ──────────────────────────────────────
{
  const r = H.buildLots([buy('2023-01-01T00:00:00.000Z', 'A', '0.1', 1000), sell('2023-02-01T00:00:00.000Z', 'A', '0.3', 5000)]);
  eq(r.warnings.map(w => [w.wallet, w.shortfallSats]), [['A', sats(0.2)]], 'overselling is reported, not hidden');
  const adj = H.buildLots([reward('2023-01-01T00:00:00.000Z', 'A', '0.00000010', { usdValueAtReceipt: '1' }),
    reward('2023-01-02T00:00:00.000Z', 'A', '-0.00000001', { excludeStats: true })]);
  eq(adj.balancesSats, { A: 9 }, 'a negative reward correction removes sats from the lots');
  const ex = H.buildLots([buy('2023-01-01T00:00:00.000Z', 'A', '1', 10000, { excludeStats: true })]);
  eq([ex.lots[0].noBasis, ex.lots[0].basisUsd, ex.balancesSats], [true, 0, { A: 1e8 }], 'an excluded buy counts toward BTC but carries no basis');
}

// ── long term vs short term: more than one year ──────────────────────────────
{
  const acq = Date.parse('2023-03-10T08:00:00.000Z');
  ok(!H.isLongTerm(acq, Date.parse('2024-03-10T08:00:00.000Z')), 'exactly one year is still short term');
  ok(H.isLongTerm(acq, Date.parse('2024-03-10T08:00:00.001Z')), 'one millisecond past a year is long term');
  ok(!H.isLongTerm(acq, Date.parse('2023-12-31T00:00:00.000Z')), 'under a year is short term');
  ok(!H.isLongTerm(Date.parse('2024-02-29T00:00:00.000Z'), Date.parse('2025-02-28T23:59:59.000Z')), 'a leap-day acquisition rolls to 1 March');
}

// ── harvest view ─────────────────────────────────────────────────────────────
{
  const NOW = Date.parse('2026-11-13T00:00:00.000Z');
  const txs = [
    buy('2023-01-10T10:00:00.000Z', 'Bitkey', '1', 70000),                                   // $70k/BTC, long term
    buy('2026-05-01T10:00:00.000Z', 'Bitkey', '0.5', 40000),                                 // $80k/BTC, short term
    reward('2026-06-01T10:00:00.000Z', 'Bitkey', '0.001', { usdValueAtReceipt: '90', usdValueSource: 'estimated_backfill' }),  // $90k/BTC, estimated
    buy('2026-07-01T10:00:00.000Z', 'Bitkey', '1', 60000),                                   // exactly the price: not a loss
    buy('2026-07-02T10:00:00.000Z', 'Bitkey', '1', 30000),                                   // below the price
    buy('2026-08-01T10:00:00.000Z', 'Bitkey', '3', 900000, { excludeStats: true }),          // no basis: never listed
    buy('2024-01-01T10:00:00.000Z', 'Cold', '0.25', 20000),                                  // $80k/BTC, moves to Bitkey
    buy('2025-01-01T10:00:00.000Z', 'Cold', '1', 500000),                                    // other wallet, stays
    xfer('2024-02-01T10:00:00.000Z', 'Cold', 'Bitkey', '0.25', '', { sequence: 1 }),
  ];
  // HIFO in Cold would move the $500k lot, so make Cold FIFO to move the $80k one
  const built = H.buildLots(txs, { methodFor: w => w === 'Cold' ? 'FIFO' : 'HIFO' });
  const { rows, summary } = H.harvestLots(built.lots, { wallet: 'Bitkey', price: 60000, nowMs: NOW });
  eq(rows.map(r => r.basisPerBtc), [90000, 80000, 80000, 70000], 'sorted by cost per BTC, highest first; the lot AT the price and below it are left out');
  eq(rows.map(r => r.type), ['Reward', 'Buy', 'Buy', 'Buy'], 'lot type');
  eq(rows[1].platform, 'Cold', 'a transferred lot keeps its original platform');
  eq(rows[1].acquiredAt < rows[2].acquiredAt, true, 'equal cost: older lot first');
  eq(rows.map(r => r.longTerm), [false, true, false, true], 'LT/ST from the acquisition datetime (the transferred lot stays long term)');
  eq(rows.map(r => r.estimated), [true, false, false, false], 'estimated flag carries through');
  eq(rows.map(r => r.sats), [100000, 25000000, 50000000, 100000000], 'sats');
  eq(rows.map(r => r.runningSats), [100000, 25100000, 75100000, 175100000], 'running BTC total, in sats');
  eq(rows.map(r => Math.round(r.lossUsd * 100) / 100), [30, 5000, 10000, 10000], 'est. loss at the price');
  eq(summary, {
    lotCount: 4, totalSats: 175100000, totalBtc: 1.751, totalBasisUsd: 130090, totalLossUsd: 25030,
    longTerm: { lots: 2, sats: 125000000, lossUsd: 15000 }, shortTerm: { lots: 2, sats: 50100000, lossUsd: 10030 }, estimatedLots: 1,
  }, 'summary: lot count, BTC/sats, basis, loss split LT/ST');
  eq(H.harvestLots(built.lots, { wallet: 'Bitkey', price: 50000, nowMs: NOW }).summary.lotCount, 5, 'a lower price lists more lots (the no-basis lot still never appears)');
  eq(H.harvestLots(built.lots, { wallet: 'Bitkey', price: 0, nowMs: NOW }).rows, [], 'no price, no list');
  eq(H.harvestLots(built.lots, { wallet: 'Nowhere', price: 60000, nowMs: NOW }).summary.lotCount, 0, 'an empty wallet lists nothing');
  eq(H.harvestLots(built.lots, { wallet: 'Bitkey', price: 60000, nowMs: Date.parse('2024-01-10T10:00:00.000Z') }).rows.find(r => r.sats === 1e8 && r.basisPerBtc === 70000).longTerm, false,
    'long/short term is judged as of "now"');

  // CSV
  const csv = H.harvestCsv(rows, { wallet: 'Bitkey', price: 60000, generatedAtMs: NOW }).split('\r\n');
  eq(csv[0], '"Wallet: Bitkey","BTC price (USD): 60000.00","Generated (UTC): 2026-11-13 00:00:00"', 'header line: wallet, price, generated-at (UTC)');
  eq(csv[1].split('","').length, 11, 'column header row has the 11 columns');
  eq(csv.length, 2 + rows.length, 'one row per lot');
  eq(csv[2], '"2026-06-01 10:00:00","Bitkey","Reward","0.00100000","100000","90000.00","90.00","30.00","ST","0.00100000","yes"', 'a row: UTC acquired time, platform, type, BTC, sats, basis/BTC, basis, loss, term, running BTC, estimated');
  const evil = H.harvestCsv([{ ...rows[0], platform: '=HYPERLINK("x")' }], { wallet: 'Bitkey', price: 60000, generatedAtMs: NOW }).split('\r\n')[2];
  ok(evil.includes(`,"'=HYPERLINK(""x"")",`), 'a formula-looking platform name is neutralised in the CSV');
}

// ── total summary across wallets ─────────────────────────────────────────────
{
  const NOW2 = Date.parse('2026-11-13T00:00:00.000Z');
  const txs = [
    buy('2023-01-10T10:00:00.000Z', 'Bitkey', '1', 70000),       // $70k, long term, under water at 60k
    buy('2026-05-01T10:00:00.000Z', 'Bitkey', '0.5', 40000),     // $80k, short term
    buy('2026-07-02T10:00:00.000Z', 'Bitkey', '1', 30000),       // $30k: above water
    buy('2026-03-01T10:00:00.000Z', 'Gemini', '0.25', 20000),    // $80k, short term
    buy('2022-01-01T10:00:00.000Z', 'Strike', '1', 90000),       // $90k, long term
    buy('2026-08-01T10:00:00.000Z', 'Strike', '2', 900000, { excludeStats: true }),  // no basis
    buy('2024-01-01T10:00:00.000Z', 'Empty', '1', 80000),
    sell('2024-02-01T10:00:00.000Z', 'Empty', '1', 50000),       // empties the wallet
  ];
  const built = H.buildLots(txs, {});
  const sum = H.harvestSummaryAll(built.lots, { price: 60000, nowMs: NOW2, methodFor: () => 'HIFO' });
  eq(sum.wallets.map(w => w.wallet).sort(), ['Bitkey', 'Gemini', 'Strike'], 'only wallets that hold BTC are listed');
  eq(sum.wallets.map(w => w.wallet), ['Strike', 'Bitkey', 'Gemini'], 'biggest estimated loss first');
  // every wallet row equals what the single-wallet view reports for the same wallet
  for(const w of sum.wallets) {
    const one = H.harvestLots(built.lots, { wallet: w.wallet, price: 60000, nowMs: NOW2 }).summary;
    eq([w.lotCount, w.totalSats, w.totalBasisUsd, w.totalLossUsd, w.ltLossUsd, w.stLossUsd],
       [one.lotCount, one.totalSats, one.totalBasisUsd, one.totalLossUsd, one.longTerm.lossUsd, one.shortTerm.lossUsd], 'summary row matches the single-wallet harvest: ' + w.wallet);
  }
  const strike = sum.wallets.find(w => w.wallet === 'Strike');
  eq([strike.heldSats, strike.noBasisSats], [300000000, 200000000], 'held BTC includes the no-basis lot, and reports it separately');
  eq(strike.lotCount, 1, 'the no-basis lot is never counted as under water');
  eq(sum.total, {
    heldSats: 100000000 + 50000000 + 100000000 + 25000000 + 300000000, noBasisSats: 200000000,
    lotCount: 4, totalSats: 100000000 + 50000000 + 25000000 + 100000000,
    totalBasisUsd: 90000 + 70000 + 40000 + 20000, totalLossUsd: 30000 + 10000 + 10000 + 5000,
    ltLossUsd: 30000 + 10000, stLossUsd: 10000 + 5000,
    ltSats: 200000000, stSats: 75000000, estimatedLots: 0,
  }, 'total row: sums of the wallet rows (held, lots, BTC, basis, loss, LT/ST split)');
  eq(sum.total.ltLossUsd + sum.total.stLossUsd, sum.total.totalLossUsd, 'LT + ST loss equals the total loss');
  eq(H.harvestSummaryAll(built.lots, { price: 0, nowMs: NOW2 }).total.lotCount, 0, 'no price: nothing under water');
  eq(H.harvestSummaryAll([], { price: 60000, nowMs: NOW2 }).wallets, [], 'no lots: no wallets');
  eq(H.harvestSummaryAll([], { price: 60000, nowMs: NOW2 }).total.lotCount, 0, 'no lots: empty total');
  // the total row foots to the displayed wallet rows even when each rounds to a different cent
  const odd = H.buildLots([buy('2026-01-01T10:00:00.000Z', 'A', '0.00000003', 0.01), buy('2026-01-01T10:00:00.000Z', 'B', '0.00000003', 0.01),
    buy('2026-01-01T10:00:00.000Z', 'C', '0.00000003', 0.01)], {});
  const oddSum = H.harvestSummaryAll(odd.lots, { price: 1000, nowMs: NOW2 });
  near(oddSum.wallets.reduce((n, w) => n + w.totalLossUsd, 0), oddSum.total.totalLossUsd, 'total foots to the sum of the displayed wallet rows', 0.0051);

  // CSV
  const method = w => w === 'Bitkey' ? 'FIFO' : 'HIFO';
  const csv = H.harvestSummaryCsv(H.harvestSummaryAll(built.lots, { price: 60000, nowMs: NOW2, methodFor: method }), { price: 60000, generatedAtMs: NOW2 }).split('\r\n');
  eq(csv[0], '"Wallets: all","BTC price (USD): 60000.00","Generated (UTC): 2026-11-13 00:00:00"', 'summary CSV header line: scope, price, generated-at (UTC)');
  eq(csv[1].split('","').length, 11, 'summary CSV has the 11 columns');
  eq(csv.length, 2 + 3 + 1, 'one row per wallet plus the total row');
  eq(csv[csv.length - 1].startsWith('"Total"'), true, 'last row is the total');
  ok(csv.some(l => l.startsWith('"Bitkey","FIFO"')), 'each row carries its wallet disposal method');
  const evil = H.harvestSummaryCsv({ wallets: [{ ...sum.wallets[0], wallet: '=SUM(A1)' }], total: sum.total }, { price: 60000, generatedAtMs: NOW2 }).split('\r\n')[2];
  ok(evil.startsWith(`"'=SUM(A1)"`), 'a formula-looking wallet name is neutralised in the summary CSV');
}

// ── lot-method history: the dated standing order ────────────────────────────
{
  const D = s => Date.parse(s);
  eq(H.lotMethodSince({ name: 'A' }), null, 'no history: no "since" date');
  eq(H.lotMethodSince({ name: 'A', lotMethod: 'HIFO', lotMethodHistory: 'junk' }), null, 'a non-array history is ignored');
  const h1 = H.appendLotMethodHistory(undefined, 'HIFO', 'created', D('2025-01-05T10:00:00Z'));
  eq(h1, [{ method: 'HIFO', from: '2025-01-05T10:00:00.000Z', source: 'created' }], 'append to nothing starts a history');
  const h2 = H.appendLotMethodHistory(h1, 'FIFO', 'changed', D('2025-06-01T10:00:00Z'));
  eq(h1.length, 1, 'append never mutates the earlier history');
  const h3 = H.appendLotMethodHistory(h2, 'HIFO', 'changed', D('2026-02-01T10:00:00Z'));
  const w = { name: 'A', lotMethod: 'HIFO', lotMethodHistory: h3 };
  eq(H.lotMethodSince(w), D('2026-02-01T10:00:00Z'), '"since" is the start of the current unbroken run');
  eq(H.lotMethodAt(w, D('2025-01-01T00:00:00Z')), null, 'before the first entry, nothing is on record');
  eq(H.lotMethodAt(w, D('2025-03-01T00:00:00Z')), 'HIFO', 'method at a moment: the last entry at or before it');
  eq(H.lotMethodAt(w, D('2025-06-01T10:00:00Z')), 'FIFO', 'an entry is in force from its own instant');
  eq(H.lotMethodAt(w, D('2026-11-12T00:00:00Z')), 'HIFO', 'method at a recent moment');
  const confirmed = { ...w, lotMethodHistory: H.appendLotMethodHistory(h3, 'HIFO', 'confirmed', D('2026-11-14T10:00:00Z')) };
  eq(H.lotMethodSince(confirmed), D('2026-02-01T10:00:00Z'), 'a later confirmation of the same method keeps the earlier "since"');
  eq(H.lotMethodSince({ ...w, lotMethod: 'FIFO' }), null, 'a method changed without a record has no "since" date');
  eq(H.lotMethodSince({ name: 'A', lotMethodHistory: h1 }), D('2025-01-05T10:00:00Z'), 'a wallet with no lotMethod is HIFO by default');
  const shuffled = { name: 'A', lotMethod: 'HIFO', lotMethodHistory: [h3[2], { method: 'LIFO', from: '2025-02-01T00:00:00Z' }, h3[0], h3[1], { method: 'HIFO', from: 'bad' }] };
  eq(H.lotMethodHistoryOf(shuffled).map(e => e.method), ['HIFO', 'FIFO', 'HIFO'], 'history is read in time order, invalid entries dropped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
