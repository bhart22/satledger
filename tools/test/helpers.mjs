// Extracts the pure-JS helper region from app.html — everything between the React hook
// destructuring and the SVG Icons block — and exercises it. There is no JSX in that range, so
// it evaluates directly in node with no transpile step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/harness.mjs';

const html = readFileSync(join(REPO_ROOT, 'app.html'), 'utf8');
const lines = html.split(/\r?\n/);
const startIdx = lines.findIndex(l => l.includes('const { useState, useEffect'));
const endIdx = lines.findIndex(l => l.includes('─── SVG Icons'));
if (startIdx === -1 || endIdx === -1) throw new Error('could not locate helper region');

const src = lines.slice(startIdx + 1, endIdx).join('\n');

// localStorage / btoa / atob stubs so safeSetItem etc. can be defined and called
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const exported = ['normalizeDate','isRealDate','numOr','newTxId','ensureTxIds','toBase64',
  'fromBase64','canonicalTxType','renameWalletInTransactions','countWalletReferences',
  'fmtDate','todayLocal','fillDailyPriceGaps','safeSetItem','VALID_TX_TYPES',
  'addDaysUTC','listDaysUTC','toEpochDay','fromEpochDay','dayKeyUTC','rangeCutoff',
  'sellFromCostPool','parseCoinLedgerRows','nextCommitStamp','txEffectOnWallet',
  'txWalletDeltas','txPortfolioDelta','applyTxToCostPool','rewardPriceFor'];
const fn = new Function(`${src}\nreturn {${exported.join(',')}};`);
const H = fn();

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (cond, name) => eq(!!cond, true, name);

// ── normalizeDate ───────────────────────────────────────────────────────────
eq(H.normalizeDate('2024-01-05'), '2024-01-05', 'iso passthrough');
eq(H.normalizeDate('2024-01-05T00:00:00Z'), '2024-01-05', 'iso with time takes literal Y-M-D');
eq(H.normalizeDate('01/15/2024'), '2024-01-15', 'mm/dd/yyyy');
eq(H.normalizeDate('1/5/2024'), '2024-01-05', 'unpadded slash');
eq(H.normalizeDate('garbage'), '', 'garbage rejected (was: returned as-is)');
eq(H.normalizeDate('2024-02-31'), '', 'impossible date rejected');
eq(H.normalizeDate('2024-13-01'), '', 'month 13 rejected');
eq(H.normalizeDate(''), '', 'empty');
eq(H.normalizeDate(null), '', 'null');
eq(H.normalizeDate(undefined), '', 'undefined');
eq(H.normalizeDate('2025-3-5'), '2025-03-05', 'loose unpadded iso, no UTC shift');
eq(H.normalizeDate('March 5, 2025'), '2025-03-05', 'long form, no UTC shift');
eq(H.normalizeDate(20240105), '2024-01-05', 'numeric input coerced');

// fmtDate must never emit undefined for bad stored data
eq(H.fmtDate('garbage'), '—', 'fmtDate rejects garbage');
eq(H.fmtDate('01/15/2024'), '01/15/2024', 'fmtDate normalizes slash input');
eq(H.fmtDate('2024-01-15'), '01/15/2024', 'fmtDate mm/dd/yyyy output');
eq(H.fmtDate(''), '—', 'fmtDate empty');

// ── numOr ───────────────────────────────────────────────────────────────────
eq(H.numOr('1.5'), 1.5, 'numOr parses');
eq(H.numOr('abc'), 0, 'numOr NaN -> 0');
eq(H.numOr('abc', 42), 42, 'numOr custom fallback');
eq(H.numOr('Infinity', 7), 7, 'numOr rejects Infinity');
eq(H.numOr(undefined, null), null, 'numOr undefined -> null fallback');
eq(H.numOr('0'), 0, 'numOr zero is kept, not treated as missing');
eq(H.numOr('-3'), -3, 'numOr negative kept (validation is separate)');

// ── canonicalTxType ─────────────────────────────────────────────────────────
eq(H.canonicalTxType('buy'), 'Buy', 'lowercase buy');
eq(H.canonicalTxType('  SELL '), 'Sell', 'trim + case');
eq(H.canonicalTxType('Withdrawal'), 'Transfer', 'withdrawal synonym');
eq(H.canonicalTxType('Deposit'), 'Transfer', 'deposit synonym');
eq(H.canonicalTxType('Staking'), 'Reward', 'staking synonym');
eq(H.canonicalTxType('Frobnicate'), '', 'unknown rejected');
eq(H.canonicalTxType(''), '', 'empty rejected');
H.VALID_TX_TYPES.forEach(t => eq(H.canonicalTxType(t), t, `round-trip ${t}`));

// ── toBase64 / fromBase64 ───────────────────────────────────────────────────
const big = new Uint8Array(1_000_000);
for (let i = 0; i < big.length; i++) big[i] = i % 256;
let b64;
try { b64 = H.toBase64(big); ok(true, 'toBase64 handles 1MB (used to throw RangeError)'); }
catch (e) { fail++; console.error('FAIL toBase64 1MB threw: ' + e.message); }
if (b64) {
  const round = H.fromBase64(b64);
  eq(round.length, big.length, 'base64 round-trip length');
  ok(round.every((v, i) => v === big[i]), 'base64 round-trip bytes identical');
}
eq(H.toBase64(new Uint8Array([1,2,3])), Buffer.from([1,2,3]).toString('base64'), 'base64 matches node');

// ── ensureTxIds ─────────────────────────────────────────────────────────────
const withIds = [{id:'a'},{id:'b'}];
eq(H.ensureTxIds(withIds) === withIds, true, 'unchanged list returns same reference');
const missing = H.ensureTxIds([{date:'2024-01-01'},{date:'2024-01-02'}]);
ok(missing[0].id && missing[1].id, 'ids backfilled');
ok(missing[0].id !== missing[1].id, 'backfilled ids unique');
const dupes = H.ensureTxIds([{id:'x',n:1},{id:'x',n:2},{id:'x',n:3}]);
eq(new Set(dupes.map(t => t.id)).size, 3, 'duplicate ids de-collided');
eq(dupes.map(t => t.n), [1,2,3], 'de-collision preserves row data/order');
eq(H.ensureTxIds(null), [], 'ensureTxIds handles non-array');
const bulk = H.ensureTxIds(Array.from({length: 500}, () => ({})));
eq(new Set(bulk.map(t => t.id)).size, 500, '500 ids minted in one tick are all unique');

// ── renameWalletInTransactions ──────────────────────────────────────────────
const txs = [
  {id:'1', wallet:'Kraken', wallet2:''},
  {id:'2', wallet:'Kraken', wallet2:'Ledger'},
  {id:'3', wallet:'Ledger', wallet2:'Kraken'},
  {id:'4', wallet:'Other',  wallet2:''},
];
const renamed = H.renameWalletInTransactions(txs, 'Kraken', 'Kraken Pro');
eq(renamed.map(t => [t.wallet, t.wallet2]), [
  ['Kraken Pro',''], ['Kraken Pro','Ledger'], ['Ledger','Kraken Pro'], ['Other',''],
], 'rename rewrites both wallet and wallet2');
eq(renamed[3] === txs[3], true, 'untouched rows keep identity');
eq(H.renameWalletInTransactions(txs, 'Kraken', 'Kraken') === txs, true, 'no-op rename returns same ref');
eq(H.renameWalletInTransactions(txs, '', 'X') === txs, true, 'empty source is a no-op');
eq(H.countWalletReferences(txs, 'Kraken'), 3, 'countWalletReferences counts both fields');
eq(H.countWalletReferences(txs, 'Nope'), 0, 'countWalletReferences unknown');

// ── fillDailyPriceGaps ──────────────────────────────────────────────────────
const filled = H.fillDailyPriceGaps({'2024-01-02': 10, '2024-01-05': 20}, '2024-01-01', '2024-01-06');
eq(filled['2024-01-01'], 10, 'leading hole back-filled');
eq(filled['2024-01-03'], 10, 'interior hole forward-filled');
eq(filled['2024-01-04'], 10, 'interior hole forward-filled (2)');
eq(filled['2024-01-06'], 20, 'trailing hole forward-filled');

// ── epoch-day date helpers (rewritten for perf — verify semantics unchanged) ─
eq(H.addDaysUTC('2024-01-01', 1), '2024-01-02', 'addDays +1');
eq(H.addDaysUTC('2024-01-01', -1), '2023-12-31', 'addDays across year boundary');
eq(H.addDaysUTC('2024-02-28', 1), '2024-02-29', 'addDays into leap day');
eq(H.addDaysUTC('2024-02-29', 1), '2024-03-01', 'addDays out of leap day');
eq(H.addDaysUTC('2023-02-28', 1), '2023-03-01', 'addDays non-leap February');
eq(H.addDaysUTC('2024-12-31', 1), '2025-01-01', 'addDays new year');
eq(H.addDaysUTC('2024-01-01', 300), '2024-10-27', 'addDays +300 (the fetch window size)');
eq(H.addDaysUTC('2024-01-01', -1400), '2020-03-02', 'addDays -1400 (the 200-week lookback)');
// US DST transitions — the old setUTCDate version was UTC-safe and so must this one be
eq(H.addDaysUTC('2024-03-10', 1), '2024-03-11', 'addDays across US spring-forward');
eq(H.addDaysUTC('2024-11-03', 1), '2024-11-04', 'addDays across US fall-back');
// EU DST transitions
eq(H.addDaysUTC('2024-03-31', 1), '2024-04-01', 'addDays across EU spring-forward');
eq(H.addDaysUTC('2024-10-27', 1), '2024-10-28', 'addDays across EU fall-back');
eq(H.toEpochDay('1970-01-01'), 0, 'epoch day zero');
eq(H.fromEpochDay(0), '1970-01-01', 'epoch day zero round-trip');
eq(H.fromEpochDay(H.toEpochDay('2014-01-01')), '2014-01-01', 'epoch round-trip');
eq(H.listDaysUTC('2024-02-27', '2024-03-02'),
   ['2024-02-27','2024-02-28','2024-02-29','2024-03-01','2024-03-02'], 'listDays spans leap day');
eq(H.listDaysUTC('2024-01-01', '2024-01-01'), ['2024-01-01'], 'listDays single day inclusive');
eq(H.listDaysUTC('2024-01-02', '2024-01-01'), [], 'listDays reversed range is empty');
eq(H.listDaysUTC('2014-01-01', '2024-01-01').length, 3653, 'listDays 10-year span length');
// Every generated day must be a real calendar date and strictly increasing
const span = H.listDaysUTC('2023-12-20', '2024-03-15');
ok(span.every(d => H.isRealDate(d)), 'listDays emits only real dates');
ok(span.every((d,i) => i === 0 || d > span[i-1]), 'listDays is strictly increasing');
eq(H.dayKeyUTC(Date.UTC(2024,0,15,12,0,0)), '2024-01-15', 'dayKeyUTC from timestamp');

// ── rangeCutoff (extracted from three divergent copies) ─────────────────────
eq(H.rangeCutoff('All'), null, 'All => no cutoff');
eq(H.rangeCutoff(undefined), null, 'undefined => no cutoff (was 3 different defaults)');
eq(H.rangeCutoff('Custom', '2022-05-05'), '2022-05-05', 'Custom uses supplied date');
eq(H.rangeCutoff('Custom'), '2000-01-01', 'Custom falls back');
eq(H.rangeCutoff('YTD'), new Date().getFullYear() + '-01-01', 'YTD is Jan 1 this year');
eq(H.rangeCutoff('bogus'), null, 'unknown range => no cutoff');
ok(/^\d{4}-\d{2}-\d{2}$/.test(H.rangeCutoff('3M')), '3M shape');
ok(H.isRealDate(H.rangeCutoff('3M')), '3M is a real date');
ok(H.isRealDate(H.rangeCutoff('5Y')), '5Y is a real date');
ok(H.rangeCutoff('3M') > H.rangeCutoff('1Y'), '3M cutoff is later than 1Y');
ok(H.rangeCutoff('1Y') > H.rangeCutoff('5Y'), '1Y cutoff is later than 5Y');
ok(H.rangeCutoff('3M') < H.todayLocal(), '3M cutoff is in the past');

// ── todayLocal ──────────────────────────────────────────────────────────────
const d = new Date();
eq(H.todayLocal(), `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, 'todayLocal uses local parts');
ok(/^\d{4}-\d{2}-\d{2}$/.test(H.todayLocal()), 'todayLocal shape');

// ── sellFromCostPool ────────────────────────────────────────────────────────
{
  const r = H.sellFromCostPool(2, 100000, 1, 60000);
  eq([r.poolBtc, r.poolCost, r.realized], [1, 50000, 10000], 'sell half the pool at a profit');
  // Pool of 1 BTC @ $50k; sell 1.5 — the extra 0.5 came from an excluded buy
  const over = H.sellFromCostPool(1, 50000, 1.5, 90000);
  eq([over.poolBtc, over.poolCost], [0, 0], 'oversell empties the pool, never goes negative');
  eq(over.realized, 60000 - 50000, 'oversell: only the covered 1 BTC carries P&L');
  const empty = H.sellFromCostPool(0, 0, 0.5, 30000);
  eq([empty.poolBtc, empty.poolCost, empty.realized], [0, 0, 0], 'sell from an empty pool is a no-op');
  const neg = H.sellFromCostPool(-0.2, 0, 0.1, 5000);
  eq(neg.poolBtc, 0, 'a negative pool is clamped');
}

// ── parseCoinLedgerRows: export → import round trip ─────────────────────────
{
  // Rows exactly as exportCSV writes them (header removed)
  const rows = [
    ['2024-01-01 00:00:00','Kraken','USD','4000.00','BTC','0.1','USD','5.00','Trade','',''],
    ['2024-02-01 00:00:00','Kraken','BTC','0.05','','','BTC','0.0001','Withdrawal','Transfer to Ledger','abc123'],
    ['2024-02-01 00:00:00','Ledger','','','BTC','0.05','','','Deposit','Transfer from Kraken','abc123'],
    ['2024-03-01 00:00:00','Ledger','BTC','0.0002','','','','','Withdrawal','UTXO consolidation fee',''],
    ['2024-04-01 00:00:00','River','','','BTC','0.02','','','Deposit','from friend',''],
    ['2024-05-01 00:00:00','Kraken','BTC','0.01','USD','700.00','BTC','0.0001','Trade','',''],
  ];
  const { txs, bad } = H.parseCoinLedgerRows(rows);
  eq(bad, 0, 'CL: no bad rows');
  eq(txs.length, 5, 'CL: withdrawal+deposit pair collapses into one transfer');
  const t = txs[1];
  eq([t.type, t.wallet, t.wallet2, t.amount, t.fee, t.txhash, t.notes],
     ['Transfer','Kraken','Ledger','0.05','0.0001','abc123',''], 'CL: paired transfer restored with txhash');
  eq([txs[2].type, txs[2].fee, txs[2].wallet], ['Consolidation','0.0002','Ledger'], 'CL: consolidation restored');
  eq([txs[3].type, txs[3].wallet, txs[3].wallet2, txs[3].notes], ['Transfer','','River','from friend'], 'CL: lone deposit is an inflow');
  eq([txs[4].type, txs[4].fee], ['Sell','7.00'], 'CL: BTC trade fee converted to USD at the trade price');
  eq(txs[0].fee, '5.00', 'CL: USD trade fee kept');
  ok(txs.every(x => x.id), 'CL: ids assigned');
  eq(H.parseCoinLedgerRows([['bad']]).bad, 1, 'CL: short row counted as bad');
  // A USD fee on a withdrawal has no price to convert at — must not be read as BTC
  eq(H.parseCoinLedgerRows([['2024-01-01','A','BTC','0.1','','','USD','2.50','Withdrawal','','']]).txs[0].fee, '',
     'CL: fiat withdrawal fee is not stored as BTC');
}

// ── txEffectOnWallet ────────────────────────────────────────────────────────
{
  const sellA = { type:'Sell', wallet:'A', amount:'1' };
  eq(H.txEffectOnWallet(sellA, 'A'), -1, 'sell drains its own wallet');
  eq(H.txEffectOnWallet(sellA, 'B'), 0, 'sell from A has no effect on B (edit-check add-back bug)');
  const xfer = { type:'Transfer', wallet:'A', wallet2:'B', amount:'0.5', fee:'0.001' };
  eq(H.txEffectOnWallet(xfer, 'A'), -0.501, 'transfer source pays amount + fee');
  eq(H.txEffectOnWallet(xfer, 'B'), 0.5, 'transfer destination receives amount');
  eq(H.txEffectOnWallet({ type:'Buy', wallet:'A', amount:'2' }, 'A'), 2, 'buy credits');
  eq(H.txEffectOnWallet({ type:'Consolidation', wallet:'A', fee:'0.0002' }, 'A'), -0.0002, 'consolidation costs only its fee');
}

// ── shared balance rules ────────────────────────────────────────────────────
{
  const out = { type:'Transfer', wallet:'A', wallet2:'', amount:'1', fee:'0.001' };
  const inn = { type:'Transfer', wallet:'', wallet2:'B', amount:'0.5', fee:'0.001' };
  const internal = { type:'Transfer', wallet:'A', wallet2:'B', amount:'1', fee:'0.001' };
  eq(H.txWalletDeltas(out), [['A', -1.001]], 'outflow: only the source moves');
  eq(H.txWalletDeltas(inn), [['B', 0.5]], 'inflow: only the destination moves');
  eq(H.txWalletDeltas(internal, v => Math.round(Number(v||0)*1e8)), [['A', -100100000], ['B', 100000000]], 'deltas in sats');
  eq(H.txPortfolioDelta(out), -1.001, 'outflow leaves the portfolio (was: only the fee, in the charts)');
  eq(H.txPortfolioDelta(inn), 0.5, 'inflow joins the portfolio');
  eq(+H.txPortfolioDelta(internal).toFixed(8), -0.001, 'internal transfer costs only the fee');
  // The two views must agree whenever every end is named
  for (const t of [out, internal, { type:'Buy', wallet:'A', amount:'2' }, { type:'Sell', wallet:'A', amount:'1' }, { type:'Consolidation', wallet:'A', fee:'0.0003' }]) {
    const sum = H.txWalletDeltas(t).reduce((s, [, d]) => s + d, 0);
    eq(+sum.toFixed(8), +H.txPortfolioDelta(t).toFixed(8), `wallet deltas sum to portfolio delta (${t.type} ${t.wallet}→${t.wallet2||''})`);
  }

  const prices = { '2024-03-01': 60000 };
  eq(H.rewardPriceFor({ date:'2024-03-01' }, prices), 60000, 'reward valued at that day\'s close');
  eq(H.rewardPriceFor({ date:'2024-03-01', price:'55000' }, prices), 55000, 'an entered price wins');
  eq(H.rewardPriceFor({ date:'2010-01-01' }, prices), 0, 'no price known → 0, not NaN');

  let p = { btc:0, cost:0 };
  p = H.applyTxToCostPool(p, { type:'Buy', amount:'1', price:'50000', totalUsd:'50000', fee:'10' }, prices);
  eq([p.btc, p.cost], [1, 50010], 'buy adds coins and cost incl. USD fee');
  p = H.applyTxToCostPool(p, { type:'Reward', date:'2024-03-01', amount:'0.01' }, prices);
  eq([p.btc, +p.cost.toFixed(2)], [1.01, 50610], 'reward adds its market value as basis');
  const sold = H.applyTxToCostPool(p, { type:'Sell', amount:'0.01', price:'60000', totalUsd:'600' }, prices);
  ok(Math.abs(sold.realized - (600 - 50610 * 0.01 / 1.01)) < 1e-6, 'sell realizes against the average cost');
  const sent = H.applyTxToCostPool({ btc:2, cost:100000 }, out, prices);
  eq([+sent.btc.toFixed(8), sent.cost, sent.realized], [0.999, 50000, 0], 'outflow takes its share of basis, realizes nothing');
  eq(H.applyTxToCostPool({ btc:1, cost:50000 }, inn, prices), { btc:1, cost:50000, realized:0 }, 'inflow of unknown origin stays out of the pool');
  eq(H.applyTxToCostPool({ btc:1, cost:50000 }, internal, prices).cost, 50000, 'internal transfer keeps the basis');
}

// ── nextCommitStamp ─────────────────────────────────────────────────────────
{
  const future = new Date(Date.now() + 10 * 60000).toISOString();
  localStorage.setItem('btc-last-modified', future);
  ok(H.nextCommitStamp() > future, 'stamp after a fast-clock pull is still newer than it');
  localStorage.setItem('btc-last-modified', '2020-01-01T00:00:00.000Z');
  ok(Math.abs(Date.parse(H.nextCommitStamp()) - Date.now()) < 5000, 'normal case uses the current time');
  localStorage.setItem('btc-last-modified', 'garbage');
  ok(H.isRealDate(H.nextCommitStamp().slice(0,10)), 'unparseable stored stamp is ignored');
  localStorage.removeItem('btc-last-modified');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
