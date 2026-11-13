// Lot engine tests: ordering, HIFO/FIFO, transfers with fees, reward basis, long/short term.
import { loadAppHelpers } from '../lib/app-helpers.mjs';

const H = loadAppHelpers(['buildLots','isLongTerm','lotMethodFor','compareTx','migrateTxTimestamps',
  'txWalletDeltas','toSatsInt','backfillRewardUsd']);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
