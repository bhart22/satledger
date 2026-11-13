// One-time backfill of usdValueAtReceipt on Reward rows that have none.
//
//   node tools/backfill-reward-usd.mjs <backup.json>                 dry run (default): prints a summary, writes nothing
//   node tools/backfill-reward-usd.mjs <backup.json> --apply         writes <backup>.backfilled.json next to it
//   node tools/backfill-reward-usd.mjs <backup.json> --apply --out X writes X instead
//   --prices <file.json>   a { "YYYY-MM-DD": close } map to use instead of fetching Coinbase
//
// The input file is never modified; restore the written copy through Settings → Import. Price
// source is the same as the app's: Coinbase Exchange BTC-USD daily close, by UTC day. Rows that
// already have a value, or whose source is "manual", are never touched, so running it twice
// changes nothing the second time.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadAppHelpers } from './lib/app-helpers.mjs';

const H = loadAppHelpers(['backfillRewardUsd', 'migrateRewardCategory', 'txInstant', 'dayKeyUTC',
  'addDaysUTC', 'fillDailyPriceGaps', 'numOr']);

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--prices');
if (!input || !existsSync(input)) {
  console.error('usage: node tools/backfill-reward-usd.mjs <backup.json> [--apply] [--out file] [--prices prices.json]');
  process.exit(2);
}
const apply = flag('--apply');

const backup = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(backup.transactions)) { console.error('not a tracker backup: no transactions array'); process.exit(2); }
const txs = backup.transactions;

// Days that need a price: every Reward with no value and no manual source
const needed = txs.filter(t => t && t.type === 'Reward' && t.usdValueSource !== 'manual'
  && !(String(t.usdValueAtReceipt ?? '').trim() !== '' && Number.isFinite(parseFloat(t.usdValueAtReceipt))))
  .map(t => H.txInstant(t)).filter(Number.isFinite).map(H.dayKeyUTC).sort();

async function fetchCloses(first, last) {
  const prices = {};
  for (let cursor = first; cursor <= last; cursor = H.addDaysUTC(cursor, 300)) {
    const end = H.addDaysUTC(cursor, 300);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${cursor}T00:00:00Z&end=${end}T00:00:00Z`;
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url, { headers: { 'User-Agent': 'btc-tracker-backfill' } });
      if (res.ok) break;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`Coinbase candles request failed: HTTP ${res.status}`);
    for (const [time, , , , close] of await res.json()) prices[H.dayKeyUTC(time * 1000)] = close;
  }
  return prices;
}

let prices = {};
if (needed.length) {
  const [first, last] = [needed[0], needed[needed.length - 1]];
  if (opt('--prices')) prices = JSON.parse(readFileSync(opt('--prices'), 'utf8'));
  else { console.log(`Fetching BTC-USD daily closes ${first} → ${last} from Coinbase…`); prices = await fetchCloses(first, last); }
  // Same gap handling as the app: a missing day takes the nearest known close
  prices = H.fillDailyPriceGaps(prices, first, last);
}

const { txs: filled, summary } = H.backfillRewardUsd(txs, prices);
console.log(apply ? 'APPLY' : 'DRY RUN (nothing written)');
console.log(`  rewards to fill:        ${summary.count}`);
console.log(`  total USD:              $${summary.totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`  date range:             ${summary.firstDate ?? '—'} → ${summary.lastDate ?? '—'}`);
console.log(`  already had a value:    ${summary.skippedHasValue}`);
console.log(`  manual (left alone):    ${summary.skippedManual}`);
console.log(`  no price for the date:  ${summary.skippedNoPrice}`);

if (!apply) { console.log('\nRe-run with --apply to write a backfilled copy.'); process.exit(0); }
if (filled === txs) { console.log('\nNothing to write.'); process.exit(0); }
const out = opt('--out') || input.replace(/\.json$/i, '') + '.backfilled.json';
if (existsSync(out)) { console.error(`\nrefusing to overwrite ${out}`); process.exit(1); }
writeFileSync(out, JSON.stringify({ ...backup, transactions: H.migrateRewardCategory(filled) }, null, 2));
console.log(`\nWrote ${out}`);
