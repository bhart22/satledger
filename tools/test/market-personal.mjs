// PersonalMarket core (docs/personal-market-analytics.md §1–10, §15; plan Phase 6): the join
// between transactions and market data, run straight out of app.dev.html's helper region.
// Average Acquisition Price, Average Purchase Price, Dashboard Average Cost and Tax-Lot Cost
// Basis are four different numbers; the tests below use those names exactly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppHelpers } from '../lib/app-helpers.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const { PersonalMarket: PM, Candles: C, txWalletDeltas, applyTxToCostPool, toSatsInt, numOr } =
  loadAppHelpers(['PersonalMarket', 'Candles', 'txWalletDeltas', 'applyTxToCostPool', 'toSatsInt', 'numOr']);
const SRC = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');
const S = PM.PRICE_SOURCE;

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (c, name) => eq(!!c, true, name);
const near = (a, b, name) => ok(a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1), `${name} (${a} ≈ ${b})`);
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const clone = o => JSON.parse(JSON.stringify(o));
const D = 86400;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const iso = sec => new Date(sec * 1000).toISOString();

// A transaction as storage holds it: decimal strings, date = the UTC day of datetimeUtc.
let nextId = 0;
const tx = (type, atSec, f = {}) => ({
  id: f.id || `t${++nextId}`, date: iso(atSec).slice(0, 10), datetimeUtc: iso(atSec), sequence: f.sequence ?? 1,
  type, wallet: f.wallet ?? 'A', wallet2: f.wallet2 ?? '', amount: f.amount ?? '', price: f.price ?? '',
  fee: f.fee ?? '', totalUsd: f.totalUsd ?? '', notes: f.notes ?? '', txhash: f.txhash ?? '', excludeStats: !!f.excludeStats,
  ...(f.usdValueAtReceipt !== undefined ? { usdValueAtReceipt: f.usdValueAtReceipt, usdValueSource: f.usdValueSource || 'manual' } : {}),
});
const noon = (y, mo, d) => utc(y, mo, d, 12);

// Daily candles for 2024: close = 40000 + 100 × day index.
const DAILY = deepFreeze(Array.from({ length: 366 }, (_, i) => {
  const c = 40000 + 100 * i;
  return { t: utc(2024, 1, 1) + i * D, o: c, h: c + 50, l: c - 50, c, v: 1 };
}));
const closeOn = (y, mo, d) => DAILY.find(k => k.t === utc(y, mo, d)).c;
const rowsOf = (txs, opts = {}) => PM.toChartTransactions(txs, { candlesDaily: DAILY, ...opts }).items;
const byId = (rows, id) => rows.find(r => r.id === id);

// ── Scope ───────────────────────────────────────────────────────────────────
{
  const a = SRC.indexOf('// ─── Market: Personal');
  ok(a > SRC.indexOf('// ─── Market: Preferences') && a < SRC.indexOf('// ─── SVG Icons'), 'Market: Personal is inside the helper region');
  const section = SRC.slice(a, SRC.indexOf('\n// ─── ', a + 1));
  eq([...section.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]), ['PersonalMarket'],
    'the section declares only PersonalMarket at top level');
  const code = section.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
  eq(code.match(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|btc-tx|\bthis\b|console\./g), null,
    'no storage, network, logging or `this`');
  eq(code.match(/execution/gi), null, 'nothing calls a price an "execution" price');
  eq(code.match(/applyTxToCostPool|buildLots|exportCSV|sellFromCostPool|rewardPriceFor/g), null,
    'PersonalMarket does not call into tax or cost-pool code');
  ok(Object.isFrozen(PM) && Object.isFrozen(PM.PRICE_SOURCE) && Object.isFrozen(PM.AVG_PRESETS.ACQUISITION_PRICE.include), 'namespace and constants are frozen');
  eq(PM.PRICE_SOURCE, { RECORDED_UNIT_PRICE: 'recorded_unit_price', DERIVED_TRANSACTION_VALUE: 'derived_transaction_value',
    REWARD_RECEIPT_VALUE: 'reward_receipt_value', HISTORICAL_MARKET_LOOKUP: 'historical_market_lookup', UNKNOWN: 'unknown' }, 'PRICE_SOURCE values');
}

// A representative history used by several sections.
const HISTORY = deepFreeze([
  tx('Buy', utc(2024, 2, 1, 9, 30), { id: 'b1', amount: '0.5', price: '40000', totalUsd: '20000', fee: '100', notes: 'n1', txhash: 'h1' }),
  tx('Reward', noon(2024, 2, 3), { id: 'r1', amount: '0.01', usdValueAtReceipt: '600.000000', usdValueSource: 'price_lookup' }),
  tx('Transfer', utc(2024, 2, 5, 8), { id: 'x1', wallet: 'A', wallet2: 'B', amount: '0.2', fee: '0.0001' }),
  tx('Sell', utc(2024, 3, 1, 15), { id: 's1', wallet: 'B', amount: '0.1', price: '50000', totalUsd: '5000', fee: '10' }),
  tx('Transfer', utc(2024, 3, 2, 1), { id: 'x2', wallet: 'A', wallet2: '', amount: '0.05', fee: '0.0002' }),
  tx('Transfer', utc(2024, 3, 3, 1), { id: 'x3', wallet: '', wallet2: 'C', amount: '0.03', fee: '' }),
  tx('Consolidation', utc(2024, 3, 4, 1), { id: 'c1', wallet: 'B', amount: '', fee: '0.00005' }),
  tx('Buy', utc(2024, 4, 1, 10), { id: 'b2', wallet: 'C', amount: '0.25', price: '', totalUsd: '12500', fee: '50' }),
  tx('Buy', utc(2024, 4, 2, 10), { id: 'bx', amount: '1', price: '30000', totalUsd: '30000', excludeStats: true }),
]);

// ── Read-only ───────────────────────────────────────────────────────────────
{
  const frozen = deepFreeze(clone(HISTORY));
  const before = JSON.stringify(frozen);
  let threw = null;
  try {
    const { items } = PM.toChartTransactions(frozen, { candlesDaily: DAILY });
    deepFreeze(items);
    PM.priceSourceLabel(items[0]); PM.allInLabel(items[0]);
    PM.applyFilters(items, deepFreeze({ transfers: true, wallets: ['A'] }));
    PM.normalizeFilters(deepFreeze({ wallets: ['A'] }));
    const h = PM.balanceHistory(frozen); deepFreeze(h);
    PM.balanceHistory(frozen, { wallets: deepFreeze(['A']) });
    PM.balanceBefore(h, utc(2024, 3, 1)); PM.balanceAtBuckets(h, deepFreeze([utc(2024, 3, 1)]), '1d');
    PM.avgAcquisition(frozen, { candlesDaily: DAILY });
    PM.avgAcquisition(frozen, deepFreeze({ ...PM.AVG_PRESETS.PURCHASE_PRICE }));
    PM.avgAcquisitionSeries(frozen, { candlesDaily: DAILY });
    PM.rangeSummary(frozen, deepFreeze({ fromSec: utc(2024, 1, 1), toSec: utc(2025, 1, 1), candlesDaily: DAILY, filters: { wallets: ['A'] } }));
    PM.aggregateMarkers(items, { interval: '1h', filters: { transfers: true }, maxMarkers: 2 });
  } catch (e) { threw = e; }
  eq(threw && String(threw), null, 'every function runs on deep-frozen transactions and candles without throwing');
  eq(JSON.stringify(frozen), before, 'and changes nothing');
  for (const bad of [undefined, null, 5, 'x', {}]) {
    let t = null;
    try { PM.toChartTransactions(bad); PM.balanceHistory(bad); PM.avgAcquisition(bad); PM.avgAcquisitionSeries(bad); PM.rangeSummary(bad); PM.aggregateMarkers(bad); }
    catch (e) { t = e; }
    eq(t && String(t), null, `non-array input (${JSON.stringify(bad)}) is an empty history, not a throw`);
  }
}

// ── Normalization (§2) ──────────────────────────────────────────────────────
{
  const { items, skipped } = PM.toChartTransactions(HISTORY, { candlesDaily: DAILY });
  eq(items.map(r => [r.id, r.category]), [['b1', 'ACQUISITION'], ['r1', 'REWARD'], ['x1', 'TRANSFER_INTERNAL'], ['s1', 'DISPOSAL'],
    ['x2', 'SENT'], ['x3', 'RECEIVED'], ['c1', 'FEE_ONLY'], ['b2', 'ACQUISITION'], ['bx', 'ACQUISITION']], 'each type classified');
  eq(skipped, { noTime: 0, badType: 0 }, 'nothing skipped');
  const b1 = byId(items, 'b1');
  eq(Object.keys(b1).sort(), ['allIn', 'category', 'dateOnly', 'excludeStats', 'feeSats', 'feeUsd', 'id', 'price', 'priceSource',
    'sats', 'tSec', 'type', 'usdValue', 'usdValueSource', 'wallet', 'wallet2'].sort(), 'row fields; notes and txhash are not copied');
  eq([b1.tSec, b1.sats, b1.feeUsd, b1.feeSats, b1.dateOnly], [utc(2024, 2, 1, 9, 30), 50000000, 100, null, false], 'buy row: instant, sats, USD fee');
  const x1 = byId(items, 'x1');
  eq([x1.feeSats, x1.feeUsd, x1.wallet, x1.wallet2], [10000, null, 'A', 'B'], 'transfer row: BTC fee in sats');
  eq(byId(items, 'r1').dateOnly, true, 'a 12:00:00 UTC row is date-only');
  eq(byId(items, 'bx').excludeStats, true, 'excludeStats copied');
  eq(PM.toChartTransactions([tx('Transfer', utc(2024, 1, 2), { id: 'n', wallet: '', wallet2: '', amount: '1', fee: '0.1' })]).items[0].category,
    'TRANSFER_INTERNAL', 'a transfer naming neither wallet only loses its fee, as txPortfolioDelta says');

  const odd = PM.toChartTransactions([
    { id: 'nt', type: 'Buy', amount: '1', date: '', datetimeUtc: 'garbage' },
    null, 7,
    tx('Swap', utc(2024, 1, 2), { id: 'bt', amount: '1' }),
    tx('Buy', utc(2024, 1, 2), { id: 'ok', amount: '1', price: '1' }),
  ]);
  eq([odd.items.map(r => r.id), odd.skipped], [['ok'], { noTime: 3, badType: 1 }], 'rows with no instant and unknown types are skipped and counted');

  const t = utc(2024, 5, 5, 10);
  const same = PM.toChartTransactions([
    tx('Buy', t, { id: 'q3', sequence: 3, amount: '1' }), tx('Buy', t + 60, { id: 'q4', amount: '1' }),
    tx('Buy', t, { id: 'q1', sequence: 1, amount: '1' }), tx('Buy', t, { id: 'q2', sequence: 2, amount: '1' }),
    tx('Buy', t - 1, { id: 'q0', sequence: 9, amount: '1' }),
  ]).items.map(r => r.id);
  eq(same, ['q0', 'q1', 'q2', 'q3', 'q4'], 'ordered by compareTx: instant, then sequence');
  const legacy = { id: 'lg', type: 'Buy', amount: '1', date: '2024-03-10' };   // no datetimeUtc at all
  const lr = PM.toChartTransactions([legacy]).items[0];
  eq([lr.tSec, lr.dateOnly], [noon(2024, 3, 10), false], 'a legacy row with only `date` sits at 12:00 UTC');
}

// ── PriceSource (§3) ────────────────────────────────────────────────────────
{
  const day = utc(2024, 6, 10, 14), close = closeOn(2024, 6, 10);
  const r = rowsOf([
    tx('Buy',  day, { id: 'p1', amount: '0.5', price: '61000', totalUsd: '30600' }),
    tx('Buy',  day, { id: 'p2', amount: '0.5', price: '', totalUsd: '30600' }),
    tx('Buy',  day, { id: 'p3', amount: '0.5', price: '', totalUsd: '' }),
    tx('Sell', day, { id: 'p4', amount: '0.25', price: '0', totalUsd: '15000' }),
    tx('Reward', day, { id: 'p5', amount: '0.001', usdValueAtReceipt: '62.500000', usdValueSource: 'estimated_backfill' }),
    tx('Reward', day, { id: 'p6', amount: '0.001', price: '63000' }),
    tx('Reward', day, { id: 'p7', amount: '0.001' }),
    tx('Transfer', day, { id: 'p8', wallet: 'A', wallet2: 'B', amount: '1', fee: '0.0001' }),
    tx('Consolidation', day, { id: 'p9', fee: '0.0001' }),
    tx('Reward', day, { id: 'p10', amount: '0.001', usdValueAtReceipt: '0', usdValueSource: 'manual' }),
  ]);
  const pick = id => { const x = byId(r, id); return [x.priceSource, x.price, x.usdValue]; };
  eq(pick('p1'), [S.RECORDED_UNIT_PRICE, 61000, 30600], 'Buy: recorded price wins; usdValue = totalUsd');
  eq(pick('p2'), [S.DERIVED_TRANSACTION_VALUE, 61200, 30600], 'Buy, blank price: totalUsd ÷ amount, labelled derived');
  eq(pick('p3'), [S.HISTORICAL_MARKET_LOOKUP, close, null], 'Buy, both blank: the day\'s close places it; its value stays unknown');
  eq(pick('p4'), [S.DERIVED_TRANSACTION_VALUE, 60000, 15000], 'Sell, price 0: derived from total');
  eq(pick('p5'), [S.REWARD_RECEIPT_VALUE, 62500, 62.5], 'Reward with usdValueAtReceipt: value at receipt');
  eq(pick('p6'), [S.RECORDED_UNIT_PRICE, 63000, 63], 'Reward with only a price: recorded price');
  eq(pick('p7'), [S.HISTORICAL_MARKET_LOOKUP, close, close * 0.001], 'Reward with neither: the day\'s close, flagged by its source');
  eq(pick('p8'), [S.HISTORICAL_MARKET_LOOKUP, close, null], 'Transfer: close for reference, no value');
  eq(pick('p9')[0], S.HISTORICAL_MARKET_LOOKUP, 'Consolidation: close for reference');
  eq(pick('p10'), [S.HISTORICAL_MARKET_LOOKUP, close, close * 0.001], 'a stored $0 receipt value is not a price; falls through');

  const off = PM.toChartTransactions([tx('Buy', utc(2023, 6, 10), { id: 'u', amount: '1' }), tx('Reward', utc(2023, 6, 10), { id: 'u2', amount: '1' })],
    { candlesDaily: DAILY }).items;
  eq(off.map(x => [x.priceSource, x.price, x.usdValue]), [[S.UNKNOWN, null, null], [S.UNKNOWN, null, null]], 'missing daily candle → UNKNOWN');
  const formingDay = utc(2024, 6, 10);
  eq(rowsOf([tx('Reward', day, { amount: '1' })], { nowSec: formingDay + 3600 })[0].priceSource, S.UNKNOWN,
    'the forming daily candle is not that day\'s close');
  eq(PM.toChartTransactions([tx('Reward', day, { amount: '1' })], { candlesDaily: [{ ...DAILY[0], t: formingDay, partial: true }] }).items[0].priceSource,
    S.UNKNOWN, 'a candle flagged partial is not used');

  // All-in figures
  const fees = rowsOf([
    tx('Buy', day, { id: 'f1', amount: '0.5', price: '60000', totalUsd: '30000', fee: '150' }),
    tx('Sell', day, { id: 'f2', amount: '0.5', price: '60000', totalUsd: '30000', fee: '150' }),
    tx('Buy', day, { id: 'f3', amount: '0.5', price: '60000', totalUsd: '30000', fee: '' }),
  ]);
  eq([byId(fees, 'f1').allIn, PM.allInLabel(byId(fees, 'f1'))], [60300, 'Cost per BTC including fees'], 'Buy all-in: (totalUsd + fee) ÷ amount');
  eq([byId(fees, 'f2').allIn, PM.allInLabel(byId(fees, 'f2'))], [59700, 'Net per BTC after fees'], 'Sell all-in: (totalUsd − fee) ÷ amount');
  eq([byId(fees, 'f3').allIn, PM.allInLabel(byId(fees, 'f3'))], [null, null], 'no fee, no all-in figure');

  // Labels
  const L = id => PM.priceSourceLabel(byId(r, id));
  eq(L('p1'), 'Recorded price (before fees)', 'label: recorded');
  eq(L('p2'), 'Implied price: total ÷ amount (before fees)', 'label: derived');
  eq(L('p5'), 'Value at receipt (estimated (backfilled from the daily close))', 'label: reward receipt + its USD value source');
  eq(L('p6'), 'Recorded price', 'label: reward recorded');
  eq(L('p7'), "Estimated from that day's closing price", 'label: lookup');
  eq(L('p8'), "Day's closing price (for reference)", 'label: transfer lookup');
  eq(PM.priceSourceLabel(off[0]), 'Price unknown', 'label: unknown');
}

// ── Precision (§4) ──────────────────────────────────────────────────────────
{
  const tenths = Array.from({ length: 10 }, (_, i) => tx('Buy', utc(2024, 1, 1) + i, { amount: '0.1', price: '1' }));
  const floatSum = tenths.reduce((s, t) => s + numOr(t.amount), 0);
  ok(floatSum !== 1, `float addition of ten 0.1 BTC is inexact (${floatSum})`);
  const h = PM.balanceHistory(tenths);
  eq(h[h.length - 1].sats, 100000000, 'the same amounts in satoshis sum to exactly 1 BTC');
  eq(PM.avgAcquisition(tenths).sats, 100000000, 'Average Acquisition Price totals are exact satoshis');

  const ones = Array.from({ length: 5000 }, (_, i) => tx('Reward', utc(2024, 1, 1) + i, { amount: '0.00000001', usdValueAtReceipt: '0.000400' }));
  const hs = PM.balanceHistory(ones);
  eq(hs[hs.length - 1].sats, 5000, '5,000 one-satoshi rewards sum to exactly 5,000 sats');
  const eights = ['0.12345678', '0.87654321', '1.00000001', '20999999.99999999'].map((a, i) => tx('Buy', utc(2024, 1, 1) + i, { amount: a, price: '1' }));
  eq(PM.balanceHistory(eights).at(-1).sats, 12345678 + 87654321 + 100000001 + 2099999999999999, '8-decimal amounts sum exactly, up to 21M BTC');
  ok(PM.balanceHistory(eights).every(p => Number.isInteger(p.sats)) && rowsOf(eights).every(r => Number.isInteger(r.sats)), 'every BTC quantity is an integer');
}

// ── Transfers (§5) ──────────────────────────────────────────────────────────
{
  const base = tx('Buy', utc(2024, 1, 10), { id: 'tb', wallet: 'A', amount: '1', price: '40000', totalUsd: '40000' });
  const internal = tx('Transfer', utc(2024, 1, 11), { id: 'ti', wallet: 'A', wallet2: 'B', amount: '0.6', fee: '0.00012345' });
  const h = PM.balanceHistory([base, internal]);
  eq(h.map(p => p.sats), [100000000, 100000000 - 12345], 'internal transfer changes the balance by exactly −fee satoshis');
  const all = { purchases: true, sales: true, rewards: true, transfers: true };
  const sum = PM.rangeSummary([base, internal], { fromSec: utc(2024, 1, 11), toSec: utc(2024, 1, 12), filters: all });
  eq([sum.transactions, sum.acquiredSats, sum.rewardSats, sum.soldSats, sum.usdInvested, sum.netSats], [0, 0, 0, 0, 0, -12345],
    'an internal transfer is in no acquired, sold or invested total');
  eq(PM.avgAcquisition([base, internal]).sats, 100000000, 'nor in Average Acquisition Price');

  const sent = tx('Transfer', utc(2024, 1, 12), { wallet: 'A', wallet2: '', amount: '0.1', fee: '0.0001' });
  const recv = tx('Transfer', utc(2024, 1, 13), { wallet: '', wallet2: 'B', amount: '0.2', fee: '' });
  const h2 = PM.balanceHistory([base, sent, recv]);
  eq(h2.map(p => p.sats), [100000000, 89990000, 109990000], 'sent: −(amount + fee); received: +amount');
  const s2 = PM.rangeSummary([base, sent, recv], { fromSec: utc(2024, 1, 12), toSec: utc(2024, 2, 1), filters: all });
  eq([s2.acquiredSats, s2.soldSats, s2.usdInvested, s2.netSats, s2.netIncludesOther], [0, 0, 0, 9990000, true],
    'sent and received move the balance but are neither acquired nor sold');
}

// ── Balance history (§6) ────────────────────────────────────────────────────
{
  const h = PM.balanceHistory(HISTORY);
  const named = HISTORY.filter(t => !(t.type === 'Transfer' && !t.wallet && !t.wallet2));
  const walletSum = HISTORY.flatMap(t => txWalletDeltas(t, toSatsInt)).reduce((s, [, d]) => s + d, 0);
  eq(h.at(-1).sats, walletSum, 'final balance equals the sum of wallet deltas in satoshis');
  eq(named.length, HISTORY.length, '(every fixture row names its wallets)');
  eq(h.at(-1).sats, 50000000 + 1000000 - 10000 - 10000000 - 5020000 + 3000000 - 5000 + 25000000 + 100000000,
    'final balance by hand: excludeStats rows count');
  ok(h.every((p, i) => !i || p.tSec > h[i - 1].tSec), 'strictly increasing instants');

  const t = utc(2024, 7, 1, 10);
  const same = PM.balanceHistory([tx('Buy', t, { amount: '1', sequence: 1 }), tx('Sell', t, { amount: '0.4', sequence: 2 }), tx('Buy', t + 1, { amount: '0.1' })]);
  eq(same, [{ tSec: t, sats: 60000000 }, { tSec: t + 1, sats: 70000000 }], 'same-instant rows collapse to the value after the last');

  eq([PM.balanceBefore(same, t), PM.balanceBefore(same, t + 1), PM.balanceBefore(same, t + 2), PM.balanceBefore([], t)],
    [0, 60000000, 70000000, 0], 'balanceBefore counts rows strictly before the instant');
  const day = utc(2024, 7, 1);
  eq(PM.balanceAtBuckets(same, [day - D, day, day + D], '1d'), [{ t: day - D, sats: 0 }, { t: day, sats: 70000000 }, { t: day + D, sats: 70000000 }],
    'resampled: the balance at the end of each bucket');
  eq(PM.balanceAtBuckets(same, [utc(2024, 7, 1, 9), utc(2024, 7, 1, 10)], '1h').map(p => p.sats), [0, 70000000], 'intraday buckets');

  // Wallet scope uses txWalletDeltas
  const scoped = PM.balanceHistory(HISTORY, { wallets: ['A'] });
  const aSum = HISTORY.flatMap(t => txWalletDeltas(t, toSatsInt)).reduce((s, [w, d]) => w === 'A' ? s + d : s, 0);
  eq(scoped.at(-1).sats, aSum, 'a wallet-scoped history equals that wallet\'s deltas');
  const ab = PM.balanceHistory([tx('Buy', utc(2024, 1, 1), { amount: '1' }), tx('Transfer', utc(2024, 1, 2), { wallet: 'A', wallet2: 'B', amount: '0.5', fee: '0.001' })], { wallets: ['A', 'B'] });
  eq(ab.at(-1).sats, 99900000, 'a transfer between two scoped wallets costs only the fee');
}

// ── Average Acquisition Price (§7) ──────────────────────────────────────────
// Hand computation, three purchases with fees:
//   0.50 BTC, $20,000 + $100 fee  →  $20,100
//   0.25 BTC, $12,500 + $50 fee   →  $12,550
//   0.25 BTC, $7,500  + $25 fee   →  $7,525
//   Average Acquisition Price = 40,175 / 1.00 = $40,175
//   Average Purchase Price    = 40,000 / 1.00 = $40,000
// With a 0.01 BTC reward worth $600 at receipt: (40,175 + 600) / 1.01 = $40,371.287128...
{
  const buys = [
    tx('Buy', utc(2024, 2, 1), { id: 'a1', amount: '0.5', price: '40000', totalUsd: '20000', fee: '100' }),
    tx('Buy', utc(2024, 3, 1), { id: 'a2', amount: '0.25', price: '50000', totalUsd: '12500', fee: '50' }),
    tx('Buy', utc(2024, 4, 1), { id: 'a3', amount: '0.25', price: '30000', totalUsd: '7500', fee: '25' }),
  ];
  const reward = tx('Reward', utc(2024, 5, 1), { id: 'a4', amount: '0.01', usdValueAtReceipt: '600.000000' });
  const r3 = PM.avgAcquisition(buys);
  eq([r3.price, r3.sats, r3.usd, r3.count], [40175, 100000000, 40175, 3], 'Average Acquisition Price: three purchases including fees');
  eq(PM.avgAcquisition(buys, { feeMode: 'exclude' }).price, 40000, 'feeMode exclude: pre-fee');
  const r4 = PM.avgAcquisition([...buys, reward]);
  near(r4.price, 40775 / 1.01, 'Average Acquisition Price includes rewards at receipt value by default');
  eq(r4.count, 4, '...counting the reward');
  const app = PM.avgAcquisition([...buys, reward], PM.AVG_PRESETS.PURCHASE_PRICE);
  eq([app.price, app.count], [40000, 3], 'Average Purchase Price (PURCHASE_PRICE preset): no fees, no rewards, same function');
  eq(PM.AVG_PRESETS.PURCHASE_PRICE, { include: ['Buy'], feeMode: 'exclude' }, 'PURCHASE_PRICE preset');
  eq(PM.AVG_PRESETS.ACQUISITION_PRICE, { include: ['Buy', 'Reward'], feeMode: 'include' }, 'ACQUISITION_PRICE preset is the default');
  eq(PM.avgAcquisition([...buys, reward], PM.AVG_PRESETS.ACQUISITION_PRICE), r4, 'the ACQUISITION_PRICE preset equals the default call');
  ok(app.price <= r4.price && PM.avgAcquisition(buys, PM.AVG_PRESETS.PURCHASE_PRICE).price <= r3.price,
    'Average Purchase Price ≤ Average Acquisition Price on a history with fees');

  const unknown = tx('Buy', utc(2024, 4, 15), { id: 'a5', amount: '0.5', price: '', totalUsd: '' });
  const ru = PM.avgAcquisition([...buys, unknown]);
  eq([ru.price, ru.sats, ru.skipped.unknownValue], [40175, 100000000, 1], 'an unknown-value row is out of numerator and denominator');
  const rewardNoValue = tx('Reward', utc(2023, 1, 1), { amount: '0.5' });   // before the candles: no lookup
  eq(PM.avgAcquisition([...buys, rewardNoValue], { candlesDaily: DAILY }).skipped.unknownValue, 1, 'a reward with no value at all is skipped, not $0');
  const rewardLookup = tx('Reward', utc(2024, 5, 2, 8), { amount: '0.01' });
  const rl = PM.avgAcquisition([...buys, rewardLookup], { candlesDaily: DAILY });
  near(rl.price, (40175 + 0.01 * closeOn(2024, 5, 2)) / 1.01, 'a reward with no value uses the day\'s close');
  eq(rl.estimated, 1, '...and is counted as estimated');

  const excluded = tx('Buy', utc(2024, 4, 20), { amount: '1', price: '1000', totalUsd: '1000', excludeStats: true });
  const re = PM.avgAcquisition([...buys, excluded]);
  eq([re.price, re.skipped.excluded], [40175, 1], 'excludeStats rows are excluded');

  const sell = tx('Sell', utc(2024, 4, 10), { amount: '0.5', price: '70000', totalUsd: '35000', fee: '20' });
  eq(PM.avgAcquisition([...buys, sell]).price, 40175, 'a Sell does not change Average Acquisition Price');
  eq(PM.avgAcquisition([...buys, sell], PM.AVG_PRESETS.PURCHASE_PRICE).price, 40000, 'nor Average Purchase Price');
  const transfers = [tx('Transfer', utc(2024, 4, 11), { wallet: 'A', wallet2: '', amount: '0.1', fee: '0.001' }),
    tx('Transfer', utc(2024, 4, 12), { wallet: '', wallet2: 'A', amount: '0.1' }), tx('Consolidation', utc(2024, 4, 13), { fee: '0.001' })];
  eq(PM.avgAcquisition([...buys, ...transfers]).price, 40175, 'transfers and consolidations do not change it');

  eq(PM.avgAcquisition(buys, { upToSec: utc(2024, 3, 1) }).price, (20100 + 12550) / 0.75, 'upToSec is inclusive');
  eq(PM.avgAcquisition(buys, { fromSec: utc(2024, 3, 1) }).price, (12550 + 7525) / 0.5, 'fromSec is inclusive');
  eq(PM.avgAcquisition(buys, { wallets: ['Z'] }).price, null, 'no included rows → null, not 0 or NaN');
  eq(PM.avgAcquisition([]).price, null, 'empty history → null');
  eq(PM.avgAcquisition([...buys, tx('Buy', utc(2024, 4, 2), { amount: '-0.00000001', price: '1' })]).skipped.nonPositive, 1,
    'a negative holdings-fix row is not an acquisition');
  eq(PM.avgAcquisition(buys, { include: ['Buy', 'Sell', 'Transfer'] }).count, 3, 'include cannot add Sell or Transfer');

  // Reconciliation with Dashboard Average Cost — rewards valued by tx.price so both valuation
  // orders agree.
  const pool = (txs, prices = {}) => {
    let p = { btc: 0, cost: 0 };
    for (const t of txs) if (!t.excludeStats) p = applyTxToCostPool(p, t, prices);
    return p.cost / p.btc;
  };
  const priced = [...buys, tx('Reward', utc(2024, 5, 1), { amount: '0.01', price: '61000' }), tx('Reward', utc(2024, 6, 1), { amount: '0.002', price: '66000' })];
  near(PM.avgAcquisition(priced).price, pool(priced), 'buys and rewards only: Average Acquisition Price = Dashboard Average Cost (cost ÷ btc)');
  const withSell = [...priced, tx('Sell', utc(2024, 6, 5), { amount: '0.5', price: '70000', totalUsd: '35000', fee: '20' }),
    tx('Buy', utc(2024, 6, 10), { amount: '0.2', price: '65000', totalUsd: '13000', fee: '30' })];
  const aapSell = PM.avgAcquisition(withSell).price, poolSell = pool(withSell);
  ok(Math.abs(aapSell - poolSell) > 1, `with a Sell they differ by design (Average Acquisition Price ${aapSell.toFixed(2)} vs Dashboard Average Cost ${poolSell.toFixed(2)})`);
  near(aapSell, (40175 + 610 + 132 + 13030) / 1.212, '...and Average Acquisition Price is still the acquisitions-only figure');
}

// ── Step series (§7) ────────────────────────────────────────────────────────
{
  const txs = [
    tx('Buy', utc(2024, 2, 1), { amount: '0.5', totalUsd: '20000', fee: '100' }),
    tx('Sell', utc(2024, 2, 15), { amount: '0.2', totalUsd: '9000' }),
    tx('Reward', utc(2024, 3, 1), { amount: '0.01', usdValueAtReceipt: '600' }),
    tx('Transfer', utc(2024, 3, 5), { wallet: 'A', wallet2: 'B', amount: '0.1', fee: '0.0001' }),
    tx('Buy', utc(2024, 4, 1), { amount: '0.25', totalUsd: '12500', fee: '50' }),
    tx('Buy', utc(2024, 4, 3), { amount: '1', totalUsd: '1', excludeStats: true }),
  ];
  const s = PM.avgAcquisitionSeries(txs);
  eq(s.map(p => p.tSec), [utc(2024, 2, 1), utc(2024, 3, 1), utc(2024, 4, 1)], 'one point per included acquisition; sales and transfers produce no step');
  const expected = [20100 / 0.5, 20700 / 0.51, 33250 / 0.76];
  s.forEach((p, i) => near(p.price, expected[i], `step ${i} equals the running hand computation`));
  near(s.at(-1).price, PM.avgAcquisition(txs).price, 'the last step equals the current value');
  const t = utc(2024, 8, 1);
  const same = PM.avgAcquisitionSeries([tx('Buy', t, { amount: '1', totalUsd: '100', sequence: 1 }), tx('Buy', t, { amount: '1', totalUsd: '300', sequence: 2 })]);
  eq(same, [{ tSec: t, price: 200 }], 'acquisitions at one instant give one point, after the last of them');
  eq(PM.avgAcquisitionSeries(txs, PM.AVG_PRESETS.PURCHASE_PRICE).length, 2, 'the PURCHASE_PRICE preset steps only at purchases');
}

// ── Range summary (§8) ──────────────────────────────────────────────────────
// [02-01, 04-02) holds b1, r1, x1, s1, x2, x3, c1 and b2 (04-01 10:00, wallet C); bx (04-02) is out.
{
  const from = utc(2024, 2, 1), to = utc(2024, 4, 2);
  const s = PM.rangeSummary(HISTORY, { fromSec: from, toSec: to, candlesDaily: DAILY });
  eq([s.transactions, s.acquiredSats, s.rewardSats, s.soldSats], [4, 75000000, 1000000, 10000000],
    'counts and sums by category over the half-open range, every wallet');
  const h = PM.balanceHistory(HISTORY);
  eq(s.netSats, PM.balanceBefore(h, to) - PM.balanceBefore(h, from), 'Net BTC Change from the balance history');
  eq(s.netIncludesOther, true, 'fees and outside transfers flagged for the footnote');
  near(s.usdInvested, 20100 + 12550, 'USD Invested: known purchases with fees');
  near(s.avgAcquisition.price, (20100 + 600 + 12550) / 0.76, 'range Average Acquisition Price');
  const plain = PM.rangeSummary([tx('Buy', utc(2024, 1, 5), { amount: '1', totalUsd: '1' })], { fromSec: utc(2024, 1, 1), toSec: utc(2024, 2, 1) });
  eq(plain.netIncludesOther, false, 'no footnote when net = acquired + rewards − sold');
  const noBuys = PM.rangeSummary(HISTORY, { fromSec: from, toSec: to, filters: { purchases: false } });
  eq([noBuys.acquiredSats, noBuys.usdInvested, noBuys.avgAcquisition.count], [0, 0, 1], 'category filters apply to the summary');
  const walletA = PM.rangeSummary(HISTORY, { fromSec: from, toSec: to, filters: { wallets: ['B'] } });
  eq([walletA.soldSats, walletA.acquiredSats], [10000000, 0], 'the wallet filter applies to the summary');
  eq(walletA.netSats, PM.balanceBefore(PM.balanceHistory(HISTORY, { wallets: ['B'] }), to) - PM.balanceBefore(PM.balanceHistory(HISTORY, { wallets: ['B'] }), from),
    'with a wallet filter, Net BTC Change is that wallet\'s');
}

// ── Filters (§10) ───────────────────────────────────────────────────────────
{
  eq(PM.normalizeFilters(undefined), { purchases: true, sales: true, rewards: true, transfers: false, wallets: null }, 'defaults');
  eq(PM.normalizeFilters({ purchases: 'no', transfers: 1, wallets: ['A', 5, '', 'A', 'B'] }),
    { purchases: true, sales: true, rewards: true, transfers: false, wallets: ['A', 'B'] }, 'wrong types fall back; wallet list cleaned');
  const rows = rowsOf(HISTORY);
  eq(PM.applyFilters(rows).map(r => r.id), ['b1', 'r1', 's1', 'b2', 'bx'], 'default: transfers hidden');
  eq(PM.applyFilters(rows, { transfers: true }).map(r => r.id), rows.map(r => r.id), 'transfers shown when enabled (internal, sent, received, fee-only)');
  eq(PM.applyFilters(rows, { purchases: false, rewards: false }).map(r => r.id), ['s1'], 'category toggles');
  eq(PM.applyFilters(rows, { transfers: true, wallets: ['B'] }).map(r => r.id), ['x1', 's1', 'c1'], 'wallet filter matches wallet or wallet2');
}

// ── Marker aggregation (§9) ─────────────────────────────────────────────────
{
  const d = utc(2024, 3, 10);
  const rows = rowsOf([
    tx('Buy', d + 3600, { id: 'm1', amount: '0.1', price: '50000' }),
    tx('Buy', d + 7200, { id: 'm2', amount: '0.2', price: '51000' }),
    tx('Sell', d + 7300, { id: 'm3', amount: '0.05', price: '52000' }),
    tx('Reward', d + 9000, { id: 'm4', amount: '0.001' }),
    tx('Transfer', d + 9500, { id: 'm5', wallet: 'A', wallet2: 'B', amount: '0.1', fee: '0.0001' }),
    tx('Transfer', d + 9600, { id: 'm6', wallet: 'A', wallet2: '', amount: '0.1', fee: '0.0001' }),
    tx('Buy', d + 12 * 3600, { id: 'm7', amount: '0.3' }),   // 12:00 UTC: date-only, no price
  ]);
  const daily = PM.aggregateMarkers(rows, { interval: '1d' });
  eq(daily.map(m => [m.t, m.category, m.count, m.sats, m.ids]), [
    [d, 'ACQUISITION', 3, 60000000, ['m1', 'm2', 'm7']],
    [d, 'REWARD', 1, 100000, ['m4']],
    [d, 'DISPOSAL', 1, 5000000, ['m3']],
  ], 'same bucket and category merge; different categories do not; transfers hidden by default');
  eq([daily[0].estimated, daily[1].estimated, daily[2].estimated], [true, true, false], 'estimated when any member\'s price is a lookup or unknown');
  eq([daily[0].price, daily[1].price, daily[2].price], [null, closeOn(2024, 3, 10), 52000], 'a single-member marker carries its price for exact placement');

  const hourly = PM.aggregateMarkers(rows, { interval: '1h' });
  eq(hourly.filter(m => m.category === 'ACQUISITION').map(m => [m.t, m.ids]),
    [[d, ['m7']], [d + 3600, ['m1']], [d + 7200, ['m2']]], 'a smaller interval separates them; the date-only row attaches to its day\'s first candle');

  const withT = PM.aggregateMarkers(rows, { interval: '1d', filters: { transfers: true } });
  eq(withT.filter(m => m.category === 'TRANSFER').map(m => [m.count, m.ids]), [[2, ['m5', 'm6']]], 'transfers, when shown, are one marker group');
  eq(PM.aggregateMarkers(rows, { interval: '1d', filters: { wallets: ['Z'] } }), [], 'wallet filter');
  eq(PM.aggregateMarkers(rows, { interval: '1d', fromSec: d + D, toSec: d + 2 * D }), [], 'markers outside [fromSec, toSec) are dropped');

  // maxMarkers coarsening
  const many = rowsOf(Array.from({ length: 100 }, (_, i) => tx('Buy', utc(2024, 1, 1, 6) + i * D, { amount: '0.01', price: '1' })));
  ok(PM.aggregateMarkers(many, { interval: '1d' }).length === 100, '100 daily buys → 100 markers under the default cap');
  const capped = PM.aggregateMarkers(many, { interval: '1d', maxMarkers: 30 });
  ok(capped.length <= 30 && capped.length >= 15, `maxMarkers 30 → ${capped.length} markers`);
  eq(capped.reduce((s, m) => s + m.count, 0), 100, 'coarsening keeps every transaction');
  eq(capped.reduce((s, m) => s + m.sats, 0), 100000000, '...and every satoshi');
  ok(capped.every(m => C.bucketStart(m.t, '1d') === m.t), 'coarse markers sit on daily candle times');
  const weekly = PM.aggregateMarkers(many, { interval: '1w', maxMarkers: 5 });
  ok(weekly.length <= 5 && weekly.every(m => C.bucketStart(m.t, '1w') === m.t), 'weekly coarsening stays on Monday candle times');
  const tiny = PM.aggregateMarkers(rowsOf(HISTORY), { interval: '1h', filters: { transfers: true }, maxMarkers: 1 });
  ok(tiny.length >= 1 && tiny.length <= 4, `an unreachable cap still terminates (${tiny.length} markers)`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
