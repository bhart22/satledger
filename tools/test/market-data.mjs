// Market data tests (docs/market-data.md §20): the Candles namespace — normalization,
// validation, UTC bucketing, aggregation, gaps, range/interval rules and paging — plus the real
// Coinbase daily fixture. Runs the code straight out of app.dev.html's helper region.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppHelpers } from '../lib/app-helpers.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const { Candles: C, MarketData: MD } = loadAppHelpers(['Candles', 'MarketData']);

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (c, name) => eq(!!c, true, name);
const throws = (f, name) => { try { f(); fail++; console.error(`FAIL ${name}: did not throw`); } catch { pass++; } };
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const H = 3600, D = 86400, W = 7 * D;

// 2024-01-01 00:00 UTC is a Monday and a multiple of every interval up to a day.
const B = utc(2024, 1, 1);
ok(new Date(B * 1000).getUTCDay() === 1 && B % D === 0, 'anchor B is a Monday at a day boundary');

// ── Scope: each Market section adds exactly one name to the helper region ────
{
  const src = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');
  const sectionOf = banner => { const a = src.indexOf(banner); return src.slice(a, src.indexOf('\n// ─── ', a + 1)); };
  const topLevel = s => [...s.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  eq(topLevel(sectionOf('// ─── Market: Candles')), ['Candles'], 'Market: Candles section declares only Candles at top level');
  const data = sectionOf('// ─── Market: Data');
  eq(topLevel(data), ['MarketData'], 'Market: Data section declares only MarketData at top level');
  ok(src.indexOf('// ─── Market: Data') < src.indexOf('// ─── SVG Icons'), 'Market: Data is inside the helper region');
  ok(Object.isFrozen(C) && Object.isFrozen(C.INTERVALS) && Object.isFrozen(C.INTERVALS['1w']), 'Candles and its tables are frozen');
  ok(Object.isFrozen(MD), 'MarketData is frozen');
  // No transaction data is reachable from MarketData: it names no transaction state or storage.
  const code = data.replace(/^\s*\/\/.*$/gm, '');
  eq(code.match(/\btransactions?\b|\btxs?\b|btc-tx|localStorage|sessionStorage|wallets?\b|settings\b/gi), null,
    'MarketData code references no transactions, wallets, settings or localStorage');
}

// ── Interval table ───────────────────────────────────────────────────────────
{
  eq(C.INTERVAL_KEYS, ['1m','5m','15m','30m','1h','4h','1d','1w'], 'interval keys ascending');
  eq(C.INTERVAL_KEYS.map(C.intervalSeconds), [60, 300, 900, 1800, 3600, 14400, 86400, 604800], 'interval seconds');
  eq(C.INTERVAL_KEYS.filter(k => C.INTERVALS[k].native), ['1m','5m','15m','1h','1d'], 'native set (Coinbase mapping)');
  eq(['30m','4h','1w'].map(k => C.INTERVALS[k].from), ['15m','1h','1d'], 'derived intervals and their sources');
  ok(C.INTERVAL_KEYS.every(k => C.INTERVALS[k].native || C.intervalSeconds(C.INTERVALS[k].from) < C.intervalSeconds(k)), 'derived only from smaller');
  eq(C.RANGES, ['1D','1W','1M','3M','6M','YTD','1Y','3Y','5Y','ALL'], 'ranges');
  eq([C.MAX_VIEW_CANDLES, C.MAX_NATIVE_CANDLES], [3000, 9000], 'caps');
  throws(() => C.intervalSeconds('2h'), 'unknown interval throws');
  throws(() => C.intervalSeconds('constructor'), 'prototype key is not an interval');
}

// ── Normalization ────────────────────────────────────────────────────────────
{
  const n = (row, iv = '1h') => C.normalizeRow(row, iv);
  // Coinbase order [time, low, high, open, close, volume]
  eq(n([B, 90, 110, 100, 105, 12.5]), { candle: { t: B, o: 100, h: 110, l: 90, c: 105, v: 12.5 } }, 'valid row mapped by position');
  eq(n([String(B), '90', '110', '100', '105', '0']), { candle: { t: B, o: 100, h: 110, l: 90, c: 105, v: 0 } }, 'numeric strings coerced; zero volume allowed');
  eq(n([B, 90, 110, 100, 105]), { candle: { t: B, o: 100, h: 110, l: 90, c: 105, v: null } }, '5-entry row → volume null');
  eq(n([B, 90, 110, 100]).reason, 'short_row', 'short row');
  eq(n({ t: B }).reason, 'not_array', 'non-array row');
  eq(n([B, 'abc', 110, 100, 105]).reason, 'price', 'non-numeric price');
  eq(n([B, '', 110, 100, 105]).reason, 'price', 'blank price is not 0');
  eq(n([B, null, 110, 100, 105]).reason, 'price', 'null price is not 0');
  eq(n([B, 90, NaN, 100, 105]).reason, 'price', 'NaN price');
  eq(n([B, 90, Infinity, 100, 105]).reason, 'price', 'infinite price');
  eq(n([B, 0, 110, 100, 105]).reason, 'price', 'zero price');
  eq(n([B, -90, 110, 100, 105]).reason, 'price', 'negative price');
  eq(n([B + 0.5, 90, 110, 100, 105]).reason, 'time', 'fractional time');
  eq(n([Infinity, 90, 110, 100, 105]).reason, 'time', 'infinite time');
  eq(n(['', 90, 110, 100, 105]).reason, 'time', 'blank time is not 0');
  eq(n([B, 90, 110, 100, 105, -1]).reason, 'volume', 'negative volume');
  eq(n([B, 90, 110, 100, 105, 'x']).reason, 'volume', 'non-numeric volume');
  eq(n([B + 60, 90, 110, 100, 105]).reason, 'misaligned', 'misaligned hourly timestamp');
  eq(n([B + 60, 90, 110, 100, 105], '1m').candle?.t, B + 60, 'same timestamp is aligned for 1m');
  eq(C.normalizeRow([105, 100, B, 110, 90], '1h', { t: 2, o: 1, h: 3, l: 4, c: 0 }).candle,
    { t: B, o: 100, h: 110, l: 90, c: 105, v: null }, 'custom column order');
  throws(() => C.normalizeRow([B, 1, 1, 1, 1], 'bogus'), 'normalizeRow rejects unknown interval');
}

// ── Validation ───────────────────────────────────────────────────────────────
{
  const k = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });
  const reason = x => C.validate([x], '1h').rejected[0]?.reason ?? null;
  eq(reason(k(B, 100, 110, 90, 105)), null, 'good candle passes');
  eq(reason(k(B, 100, 110, 100, 110)), null, 'touching bounds pass (h = c, l = o)');
  eq(reason(k(B, 111, 110, 90, 105)), 'high_below_open', 'h >= o enforced');
  eq(reason(k(B, 100, 110, 90, 111)), 'high_below_close', 'h >= c enforced');
  eq(reason(k(B, 89, 110, 90, 105)), 'low_above_open', 'l <= o enforced');
  eq(reason(k(B, 100, 110, 90, 89)), 'low_above_close', 'l <= c enforced');
  eq(reason(k(B, 100, 80, 90, 105)), 'high_below_low', 'h >= l enforced');
  eq(reason(k(B, NaN, 110, 90, 105)), 'price', 'NaN rejected');
  eq(reason(k(B, 100, Infinity, 90, 105)), 'price', 'Infinity rejected');
  eq(reason(k(B, 100, 110, 0, 105)), 'price', 'zero rejected');
  eq(reason(k(B, 100, 110, -90, 105)), 'price', 'negative rejected');
  eq(reason(k(B, '100', 110, 90, 105)), 'price', 'string price in a candle rejected (normalize first)');
  eq(reason(k(B + 1, 100, 110, 90, 105)), 'misaligned', 'misaligned rejected');
  eq(reason(k(B, 100, 110, 90, 105, -2)), 'volume', 'negative volume rejected');
  eq(reason(null), 'not_object', 'null rejected');
  eq(C.validate([{ t: B, o: 100, h: 110, l: 90, c: 105 }], '1h').valid[0].v, null, 'missing volume becomes null');

  // duplicates: last occurrence in input order wins; unordered input; strictly ascending output
  const input = deepFreeze([k(B + 2 * H, 1, 2, 1, 2), k(B, 1, 1, 1, 1), k(B + H, 3, 3, 3, 3), k(B, 5, 5, 5, 5), k(B + 2 * H, 7, 7, 7, 7)]);
  const r = C.validate(input, '1h');
  eq(r.valid.map(x => [x.t - B, x.o]), [[0, 5], [H, 3], [2 * H, 7]], 'duplicates keep the last occurrence; output sorted');
  eq(r.rejected.map(x => [x.row.t - B, x.row.o, x.reason]), [[0, 1, 'duplicate'], [2 * H, 1, 'duplicate']], 'earlier duplicates reported');
  ok(r.valid.every((x, i) => i === 0 || x.t > r.valid[i - 1].t), 'strictly ascending');
  ok(r.valid[0] !== input[3], 'valid candles are fresh objects, not the input');
  eq(C.validate([], '1h'), { valid: [], rejected: [], overRejectLimit: false }, 'empty input');
  eq(C.validate(null, '1h').valid, [], 'non-array input → nothing');

  // the 5 % threshold, measured over raw rows
  const rows = Array.from({ length: 20 }, (_, i) => [B + i * H, 90, 110, 100, 105, 1]);
  const oneBad = rows.map((x, i) => i === 3 ? [x[0], 0, 110, 100, 105] : x);
  const twoBad = oneBad.map((x, i) => i === 7 ? [x[0] + 1, 90, 110, 100, 105] : x);
  const p1 = C.parseRows(oneBad, '1h'), p2 = C.parseRows(twoBad, '1h');
  eq([p1.valid.length, p1.rejected.length, p1.overRejectLimit], [19, 1, false], 'exactly 5 % rejected is still usable');
  eq([p2.valid.length, p2.rejected.length, p2.overRejectLimit], [18, 2, true], 'over 5 % rejected → page failed');
  eq(p2.rejected.map(x => x.reason), ['price', 'misaligned'], 'reasons from normalization');
  const dupRows = [...rows, rows[0]];
  eq(C.parseRows(dupRows, '1h').rejected.map(x => x.reason), ['duplicate'], 'duplicates counted by parseRows');
  eq(C.parseRows(deepFreeze([...rows].reverse().map(x => [...x])), '1h').valid.map(x => x.t), rows.map(x => x[0]), 'newest-first rows come out ascending');
}

// ── Bucketing ────────────────────────────────────────────────────────────────
{
  for (const iv of C.INTERVAL_KEYS) {
    const s = C.intervalSeconds(iv);
    eq([C.bucketStart(B, iv), C.bucketStart(B + 1, iv), C.bucketStart(B - 1, iv), C.bucketStart(B + s - 1, iv), C.bucketStart(B + s, iv)],
      [B, B, B - s, B, B + s], `${iv}: boundary, +1 s, −1 s, end−1 s, next`);
  }
  // weekly: Monday 00:00 UTC
  const mon = utc(2024, 6, 10); // a known Monday
  ok(new Date(mon * 1000).getUTCDay() === 1, '2024-06-10 is a Monday');
  eq([C.bucketStart(mon, '1w'), C.bucketStart(utc(2024, 6, 16, 23, 59, 59), '1w'), C.bucketStart(utc(2024, 6, 13, 12), '1w')],
    [mon, mon, mon], 'week of a known Monday (Mon, Sun 23:59:59, Thu)');
  eq(C.bucketStart(mon - 1, '1w'), utc(2024, 6, 3), 'Sunday before → previous Monday');
  // across a year boundary: Thu 2020-12-31 and Sun 2021-01-03 are in the week of Mon 2020-12-28
  eq([C.bucketStart(utc(2020, 12, 31, 18), '1w'), C.bucketStart(utc(2021, 1, 3, 23, 59, 59), '1w'), C.bucketStart(utc(2021, 1, 4), '1w')],
    [utc(2020, 12, 28), utc(2020, 12, 28), utc(2021, 1, 4)], 'weekly bucket across 2020→2021');
  // before the 1970-01-05 anchor (epoch was a Thursday)
  eq(C.bucketStart(345600, '1w'), 345600, 'anchor Monday 1970-01-05 is its own week start');
  eq([C.bucketStart(0, '1w'), C.bucketStart(-1, '1w'), C.bucketStart(345599, '1w')], [-259200, -259200, -259200],
    'epoch, 1969-12-31 23:59:59 and 1970-01-04 23:59:59 → Monday 1969-12-29');
  eq(C.bucketStart(-1, '1h'), -3600, 'non-negative modulo before 1970');
  // completeness
  eq([C.isComplete(B, '1h', B + H - 1), C.isComplete(B, '1h', B + H), C.isComplete(B, '1w', B + W)], [false, true, true], 'isComplete');
}

// ── Aggregation ──────────────────────────────────────────────────────────────
{
  const k = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
  // 15m → 30m (hand-computed)
  const q = 900;
  const src15 = deepFreeze([k(B, 100, 110, 95, 105, 1), k(B + q, 105, 120, 100, 115, 2), k(B + 2 * q, 115, 118, 90, 92, null), k(B + 3 * q, 92, 99, 91, 98, 0.5)]);
  eq(C.aggregate(src15, '30m', '15m'), [k(B, 100, 120, 95, 115, 3), k(B + 1800, 115, 118, 90, 98, 0.5)],
    '15m→30m: o first, h max, l min, c last, v sum ignoring null');

  // 1h → 4h: a full bucket, then a bucket with one hour missing (partial)
  const src1h = deepFreeze([
    k(B, 10, 12, 9, 11, 1), k(B + H, 11, 15, 10, 14, 1), k(B + 2 * H, 14, 14, 8, 9, 1), k(B + 3 * H, 9, 10, 9, 10, 1),
    k(B + 4 * H, 10, 11, 10, 11, 2), k(B + 6 * H, 11, 13, 11, 12, 2), k(B + 7 * H, 12, 12, 7, 8, 2),
  ]);
  eq(C.aggregate(src1h, '4h', '1h'), [k(B, 10, 15, 8, 10, 4), { ...k(B + 4 * H, 10, 13, 7, 8, 6), partial: true }],
    '1h→4h values and partial flag for a gap inside a completed bucket');

  // 1d → 1w: Sun 2023-12-31 alone (partial week), then Mon..Sun 2024-01-01..07 (full)
  const days = [k(B - D, 50, 55, 45, 52, 7)];
  const week = [[52, 60, 50, 58], [58, 59, 40, 41], [41, 45, 41, 44], [44, 70, 43, 69], [69, 69, 60, 61], [61, 66, 61, 65], [65, 68, 62, 63]];
  week.forEach(([o, h, l, c], i) => days.push(k(B + i * D, o, h, l, c, i + 1)));
  eq(C.aggregate(deepFreeze(days), '1w', '1d'), [{ ...k(B - W, 50, 55, 45, 52, 7), partial: true }, k(B, 52, 70, 40, 63, 28)],
    '1d→1w: Monday-anchored weeks; 1 of 7 days → partial');

  // volume null only when every source volume is null
  eq(C.aggregate([k(B, 1, 1, 1, 1, null), k(B + q, 1, 1, 1, 1, null)], '30m', '15m')[0].v, null, 'all-null volume → null');
  eq(C.aggregate([k(B, 1, 1, 1, 1, null), k(B + q, 1, 1, 1, 1, 0)], '30m', '15m')[0].v, 0, 'one zero volume → 0');

  // forming bucket: not partial when every source bucket that has started is present
  const forming = [k(B, 10, 12, 9, 11, 1), k(B + H, 11, 15, 10, 14, 1)];
  eq(C.aggregate(forming, '4h', '1h', { nowSec: B + H + 60 })[0].partial, undefined, 'forming bucket with all started hours → not partial');
  eq(C.aggregate(forming, '4h', '1h', { nowSec: B + 3 * H + 60 })[0].partial, true, 'forming bucket missing a started hour → partial');
  eq(C.aggregate(forming, '4h', '1h')[0].partial, true, 'without nowSec every bucket is judged complete');
  // a partial source makes the target partial
  eq(C.aggregate([{ ...k(B, 1, 1, 1, 1, 1), partial: true }, k(B + 1800, 1, 1, 1, 1, 1)], '1h', '30m')[0].partial, true, 'partial source propagates');
  // unordered source is handled
  eq(C.aggregate([...src15].reverse(), '30m', '15m'), C.aggregate(src15, '30m', '15m'), 'source order does not matter');
  eq(C.aggregate([], '1w', '1d'), [], 'empty → empty');

  // refusal to downsample
  throws(() => C.aggregate(src1h, '15m', '1h'), 'refuses a smaller target');
  throws(() => C.aggregate(src1h, '1h', '1h'), 'refuses the same interval');
  throws(() => C.aggregate(src1h, '4h', 'nope'), 'refuses an unknown source');
}

// ── Gaps ─────────────────────────────────────────────────────────────────────
{
  const at = (...hours) => hours.map(h => ({ t: B + h * H, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  eq(C.findGaps(at(0, 1, 2, 3), '1h'), [], 'none');
  eq(C.findGaps(at(0, 1, 3), '1h'), [{ fromSec: B + 2 * H, toSec: B + 3 * H, missing: 1, kind: 'provider' }], 'single');
  eq(C.findGaps(at(0, 4, 5), '1h'), [{ fromSec: B + H, toSec: B + 4 * H, missing: 3, kind: 'provider' }], 'run');
  eq(C.findGaps(at(2, 3), '1h', { fromSec: B, toSec: B + 6 * H }),
    [{ fromSec: B, toSec: B + 2 * H, missing: 2, kind: 'provider' }, { fromSec: B + 4 * H, toSec: B + 6 * H, missing: 2, kind: 'provider' }], 'at both edges');
  eq(C.findGaps([], '1h', { fromSec: B + 30 * 60, toSec: B + H + 1 }), [{ fromSec: B, toSec: B + 2 * H, missing: 2, kind: 'provider' }],
    'window edges inside buckets include those buckets');
  eq(C.findGaps([], '1h'), [], 'no candles and no window → nothing');
  // a price jump is not a gap
  const jump = [{ t: B, o: 100, h: 100, l: 100, c: 100, v: 1 }, { t: B + H, o: 500, h: 500, l: 500, c: 500, v: 1 }];
  eq(C.findGaps(jump, '1h'), [], 'price jump between adjacent candles is not a gap');
  // not fetched versus provider gap: page of 3 hours; page 1 (hours 3–5) was never fetched
  const per = 3, fetchedPages = new Set([C.pageIndex(B, '1h', per), C.pageIndex(B + 6 * H, '1h', per)]);
  const isFetched = t => fetchedPages.has(C.pageIndex(t, '1h', per));
  eq(C.findGaps(at(0, 6, 7, 8), '1h', { isFetched }), [
    { fromSec: B + H, toSec: B + 3 * H, missing: 2, kind: 'provider' },
    { fromSec: B + 3 * H, toSec: B + 6 * H, missing: 3, kind: 'not_fetched' },
  ], 'missing buckets split into provider gap and not-fetched by coverage');
  // weekly gaps step from the Monday anchor
  eq(C.findGaps([{ t: B, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: B + 2 * W, o: 1, h: 1, l: 1, c: 1, v: 1 }], '1w'),
    [{ fromSec: B + W, toSec: B + 2 * W, missing: 1, kind: 'provider' }], 'weekly gap');
}

// ── Range rules ──────────────────────────────────────────────────────────────
{
  const NOW = utc(2026, 11, 14, 10);
  const EARLIEST = utc(2015, 7, 20);
  eq(C.RANGES.map(C.defaultInterval), ['5m','1h','4h','4h','1d','1d','1d','1d','1d','1w'], 'default interval per range');
  throws(() => C.defaultInterval('2Y'), 'unknown range');

  // range starts
  eq(C.rangeStart('1D', NOW), NOW - D, '1D = now − 24 h');
  eq(C.rangeStart('1W', NOW), NOW - W, '1W = now − 7 d');
  eq(C.rangeStart('1M', NOW), utc(2026, 10, 14, 10), '1M: same day and time a month back');
  eq(C.rangeStart('3M', NOW), utc(2026, 8, 14, 10), '3M');
  eq(C.rangeStart('6M', NOW), utc(2026, 5, 14, 10), '6M');
  eq(C.rangeStart('1M', utc(2026, 3, 31, 8)), utc(2026, 2, 28, 8), '1M from 31 Mar clamps to 28 Feb');
  eq(C.rangeStart('3M', utc(2026, 5, 31)), utc(2026, 2, 28), '3M from 31 May clamps to 28 Feb');
  eq(C.rangeStart('1M', utc(2026, 1, 15)), utc(2025, 12, 15), '1M across a year boundary');
  eq(C.rangeStart('YTD', NOW), utc(2026, 1, 1), 'YTD = 1 Jan 00:00 UTC');
  eq(C.rangeStart('1Y', NOW), utc(2025, 11, 14, 10), '1Y');
  eq(C.rangeStart('1Y', utc(2024, 2, 29, 12)), utc(2023, 2, 28, 12), '1Y from 29 Feb clamps to 28 Feb');
  eq(C.rangeStart('3Y', NOW), utc(2023, 11, 14, 10), '3Y');
  eq(C.rangeStart('5Y', NOW), utc(2021, 11, 14, 10), '5Y');
  eq(C.rangeStart('ALL', NOW, EARLIEST), EARLIEST, 'ALL = discovered earliest candle');
  eq(C.rangeStart('ALL', NOW), null, 'ALL unknown until discovered');
  throws(() => C.rangeStart('1D', NaN), 'nowSec must be finite');

  // worked examples in §10
  const allows = (r, iv, now = NOW) => C.allowedIntervals(r, now, EARLIEST).includes(iv);
  ok(allows('1D', '1m'), '1D@1m allowed (1,440 displayed)');
  ok(!allows('1W', '1m'), '1W@1m not allowed (10,080 displayed)');
  ok(allows('1Y', '4h', utc(2025, 11, 14)), '1Y@4h allowed (2,190 displayed from 8,760 native)');
  ok(allows('1Y', '4h', utc(2025, 3, 1)), '1Y@4h allowed across a leap day (2,196 / 8,784)');
  ok(!allows('3Y', '4h'), '3Y@4h not allowed (26,280 native)');
  ok(!allows('6M', '1h'), '6M@1h not allowed (4,380 displayed)');

  // full sets at a fixed instant, worked by hand
  eq(Object.fromEntries(C.RANGES.map(r => [r, C.allowedIntervals(r, NOW, EARLIEST)])), {
    '1D':  ['1m','5m','15m','30m','1h','4h'],         // 1d is not shorter than the range
    '1W':  ['5m','15m','30m','1h','4h','1d'],         // 1m: 10,080; 1w not shorter
    '1M':  ['15m','30m','1h','4h','1d','1w'],         // 31 d: 5m = 8,928; 15m = 2,976
    '3M':  ['1h','4h','1d','1w'],                     // 92 d: 30m = 4,416; 1h = 2,208
    '6M':  ['4h','1d','1w'],                          // 184 d: 1h = 4,416; 4h native = 4,416
    'YTD': ['4h','1d','1w'],                          // 317 d 10 h: 1h = 7,618
    '1Y':  ['4h','1d','1w'],                          // 365 d: 4h native = 8,760
    '3Y':  ['1d','1w'],                               // 1,096 d: 4h native = 26,304
    '5Y':  ['1d','1w'],
    'ALL': ['1d','1w'],
  }, 'allowed intervals for every range at 2026-11-14 10:00 UTC');
  ok(C.RANGES.every(r => C.allowedIntervals(r, NOW, EARLIEST).includes(C.defaultInterval(r))), 'every default is allowed');

  // the 1d exception: past the display cap but still allowed
  ok(Math.ceil((NOW - EARLIEST) / D) > C.MAX_VIEW_CANDLES, '(ALL since 2015 is more days than the view cap)');
  ok(C.allowedIntervals('ALL', NOW, EARLIEST).includes('1d'), '1d allowed beyond the view cap (exception)');
  const longAgo = utc(1990, 1, 1); // 13,100+ days: past the native cap too
  ok(!C.allowedIntervals('ALL', NOW, longAgo).includes('1w'), '1w refused when its native 1d count exceeds 9,000');
  ok(C.allowedIntervals('ALL', NOW, longAgo).includes('1d'), '1d still allowed there');
  eq(C.allowedIntervals('ALL', NOW, null), ['1d', '1w'], 'ALL before discovery offers 1d and 1w');

  // invalid stored / URL interval falls back
  eq(C.resolveInterval('1Y', '1m', NOW, EARLIEST), '1d', 'disallowed stored interval → range default');
  eq(C.resolveInterval('1Y', 'bogus', NOW, EARLIEST), '1d', 'unknown interval → range default');
  eq(C.resolveInterval('1Y', undefined, NOW, EARLIEST), '1d', 'missing interval → range default');
  eq(C.resolveInterval('1Y', '1w', NOW, EARLIEST), '1w', 'allowed explicit choice kept');
  eq(C.resolveInterval('1D', '1h', NOW, EARLIEST), '1h', 'allowed intraday choice kept');
  eq(C.allowedIntervals('YTD', utc(2026, 1, 1, 3), EARLIEST), ['1m','5m','15m','30m','1h'], 'YTD at 03:00 on 1 Jan');
  eq(C.resolveInterval('YTD', '1d', utc(2026, 1, 1, 3), EARLIEST), '1h', 'default impossible → largest allowed below it');
}

// ── Paging ───────────────────────────────────────────────────────────────────
{
  const per = 300;
  eq(C.pageSpan('1d', per), 300 * D, 'daily page span');
  eq(C.pageBounds(5, '1h', per), { index: 5, startSec: 5 * 300 * H, endSec: 6 * 300 * H }, 'page bounds');
  const t = utc(2024, 3, 17, 14, 23, 7);
  const p = C.pageBounds(C.pageIndex(t, '1h', per), '1h', per);
  ok(p.startSec <= t && t < p.endSec, 'pageIndex finds the page holding t');
  eq(C.pagesFor(t, t + 1, '1d', per).length, 1, 'a one-second window is one page');
  ok(C.pagesFor(t, t + 1, '1d', per)[0].startSec !== t, '…and its bounds are not the window');
  eq(C.pagesFor(0, 3 * 300 * D, '1d', per).map(x => x.index), [2, 1, 0], 'page-aligned window: exact pages, newest first');
  eq(C.pagesFor(5, 5, '1d', per), [], 'empty window → no pages');
  throws(() => C.pageSpan('4h', per), 'derived intervals are never paged');
  throws(() => C.pageSpan('1w', per), 'weekly is never paged');
  throws(() => C.pageSpan('1h', 0), 'perPage must be positive');
  throws(() => C.pageSpan('1h', 2.5), 'perPage must be an integer');

  // fuzz: transaction-shaped windows never appear in generated requests
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let good = true, checked = 0;
  for (let i = 0; i < 2000 && good; i++) {
    const iv = ['1m','5m','15m','1h','1d'][i % 5];
    const span = C.pageSpan(iv, per);
    const from = utc(2015, 1, 1) + Math.floor(rnd() * 11 * 365 * D);
    const to = from + 1 + Math.floor(rnd() * span * 4);
    const pages = C.pagesFor(from, to, iv, per);
    checked += pages.length;
    good = pages.length > 0
      && pages.every(pg => pg.startSec % span === 0 && pg.endSec - pg.startSec === span)
      && pages.every((pg, j) => j === 0 || pg.endSec === pages[j - 1].startSec)
      && pages.at(-1).startSec <= from && pages[0].endSec >= to
      && pages.at(-1).endSec > from && pages[0].startSec < to;
    if (!good) console.error('  window', iv, from, to, JSON.stringify(pages));
  }
  ok(good, `2,000 random windows: every request page-aligned, contiguous, newest first, covering (${checked} pages)`);
}

// ── Real Coinbase daily candles ──────────────────────────────────────────────
{
  const fx = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'test', 'fixtures', 'btc-usd-1d.json'), 'utf8'));
  ok(fx.rows.length >= 400, `fixture holds at least 400 days (${fx.rows.length})`);
  const r = C.parseRows(deepFreeze(fx.rows), '1d');
  eq(r.rejected, [], 'fixture: zero rejections');
  eq(r.valid.length, fx.rows.length, 'fixture: every row valid');
  ok(r.valid.every((x, i) => i === 0 || x.t === r.valid[i - 1].t + D), 'fixture: consecutive days, ascending');
  eq(C.findGaps(r.valid, '1d'), [], 'fixture: no gaps');
  ok(r.valid.every((x, i) => { const row = fx.rows[fx.rows.length - 1 - i];
    return x.t === row[0] && x.l === row[1] && x.h === row[2] && x.o === row[3] && x.c === row[4] && x.v === row[5]; }),
    'fixture: values unchanged, mapped [time, low, high, open, close, volume]');
  // weekly from real days agrees with a naive grouping
  const weeks = C.aggregate(r.valid, '1w', '1d');
  const naive = new Map();
  for (const d of r.valid) {
    const wk = d.t - (((d.t - 345600) % W) + W) % W;
    const g = naive.get(wk) || []; g.push(d); naive.set(wk, g);
  }
  ok(weeks.length === naive.size && weeks.every(w => {
    const g = naive.get(w.t);
    const vol = g.reduce((s, d) => s + d.v, 0);
    return g && w.o === g[0].o && w.c === g.at(-1).c && w.h === Math.max(...g.map(d => d.h)) && w.l === Math.min(...g.map(d => d.l))
      && Math.abs(w.v - vol) < 1e-9 && !!w.partial === (g.length < 7);
  }), `fixture: ${weeks.length} weekly candles match a naive grouping; only short edge weeks are partial`);
  ok(new Date(weeks[0].t * 1000).getUTCDay() === 1, 'fixture: weeks start on Monday');
}

// ═════════════════════════════════════════════════════════════════════════════
// MarketData: provider, memory store and service. No test performs network I/O: fetch is a fake
// that imitates the verified Coinbase behaviour (docs/market-data.md §4) — newest-first rows,
// inclusive `end`, 400 for a future start or more than 300 buckets, [] before history — over a
// synthetic market. The clock and sleep are injected.
// ═════════════════════════════════════════════════════════════════════════════

const asyncThrows = async (f, name, check = () => true) => {
  try { await f(); fail++; console.error(`FAIL ${name}: did not throw`); }
  catch (e) { if (check(e)) pass++; else { fail++; console.error(`FAIL ${name}: wrong error ${e?.code} ${e?.message}`); } }
};
// console.warn is part of the contract (counts and reasons) but noisy in a test run.
const warned = [];
const realWarn = console.warn;
console.warn = (...a) => warned.push(a);

const NOW = utc(2026, 11, 14, 10, 30);
const FIRST_DAY = utc(2015, 7, 20);
const GRAN = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 86400: '1d' };
let clock = NOW;
const now = () => clock;
const sleeps = [];
const sleep = async (ms, signal) => {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  sleeps.push(ms); clock += ms / 1000;
};
// Deterministic OHLCV for a bucket: always a valid candle.
const bar = (t, g) => { const b = 1000 + ((t / g) % 97); return [t, b - 1, b + 2, b, b + 1, 1 + ((t / g) % 5)]; };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// A fake Coinbase Exchange. `fail(call)` may return a Response to send instead; `holes` are
// bucket times the provider has no candle for; `gate` (a promise, or call → promise|null)
// delays the response.
const makeExchange = ({ first = FIRST_DAY, holes = new Set(), fail = () => null, gate = null, rows = null } = {}) => {
  const ex = { calls: [], inFlight: 0, maxInFlight: 0 };
  ex.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const g = Number(u.searchParams.get('granularity'));
    const start = Date.parse(u.searchParams.get('start')) / 1000, end = Date.parse(u.searchParams.get('end')) / 1000;
    const call = { url, init, path: u.pathname, g, interval: GRAN[g], start, end, at: clock };
    ex.calls.push(call);
    ex.inFlight++; ex.maxInFlight = Math.max(ex.maxInFlight, ex.inFlight);
    try {
      await new Promise(r => setImmediate(r)); // let other lanes start, so concurrency is real
      const held = typeof gate === 'function' ? gate(call) : gate;
      if (held) await held; // ignores abort, like a fetch that never settles
      const f = fail(call);
      if (f) return f;
      if (u.pathname.endsWith('/stats')) return json({ open: '69272.68', high: '70141.87', low: '66369.12', last: '67237.01', volume: '13089.29', volume_30day: '1' });
      if (u.hostname === 'api.coinbase.com') return json({ data: { amount: '67244.075', base: 'BTC', currency: 'USD' } });
      if (!GRAN[g]) return json({ message: 'Unsupported granularity' }, 400);
      if (start > clock) return json({ message: 'Start cannot be in the future' }, 400);
      if (!(start < end)) return json({ message: 'start must be before end' }, 400);
      if ((end - start) / g > 300) return json({ message: 'Count of aggregations requested exceeds 300' }, 400);
      if (rows) return json(rows(call));
      const out = [];
      for (let t = start; t <= end; t += g) if (t >= first && t <= clock && !holes.has(t)) out.push(bar(t, g)); // end inclusive
      return json(out.reverse());
    } finally { ex.inFlight--; }
  };
  ex.candleCalls = () => ex.calls.filter(c => c.path.endsWith('/candles'));
  return ex;
};
const setup = (opts = {}, svc = {}) => {
  const ex = makeExchange(opts);
  const provider = MD.createCoinbaseProvider({ fetchImpl: ex.fetchImpl, now });
  const store = svc.store || MD.createMemoryStore();
  const service = MD.createMarketDataService({ provider, store, now, sleep, random: () => 0, timeoutMs: 0, backfillPauseMs: 250, ...svc });
  return { ex, provider, store, service };
};
const reset = () => { clock = NOW; sleeps.length = 0; warned.length = 0; };
const SPAN_1D = 300 * D, SPAN_1H = 300 * H;

// ── Provider ─────────────────────────────────────────────────────────────────
{
  reset();
  const { ex, provider: p } = setup();
  eq([p.id, p.label, p.symbol, p.maxCandlesPerRequest], ['coinbase', 'Coinbase', 'BTC-USD', 300], 'provider identity and page size');
  eq(p.getAvailableIntervals(), ['1m', '5m', '15m', '1h', '1d'], 'native intervals (6h not exposed)');
  eq(p.getHistoricalRange({ interval: '1d' }), { earliestSec: null, hintSec: FIRST_DAY }, 'historical range: earliest unknown, 2015-07-20 only a hint');
  throws(() => MD.createCoinbaseProvider({}), 'provider requires fetchImpl');
  eq(Object.keys(MD.providers), ['coinbase'], 'provider registry');
  ok(MD.providers.coinbase.create === MD.createCoinbaseProvider, 'registry creates the Coinbase provider');

  // page-aligned request: exact bounds in the URL, HTTP cache bypassed, inclusive end row dropped
  const page = C.pageBounds(C.pageIndex(utc(2024, 6, 1), '1d', 300), '1d', 300);
  const got = await p.getCandles({ interval: '1d', startSec: page.startSec, endSec: page.endSec });
  const call = ex.candleCalls()[0];
  eq([call.g, call.start, call.end], [86400, page.startSec, page.endSec], 'request carries exactly the page bounds');
  ok(/start=\d{4}-\d{2}-\d{2}T00:00:00Z&end=\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(call.url), 'ISO 8601 start/end without milliseconds');
  eq([call.init.cache, call.init.credentials], ['no-store', 'omit'], 'no-store (Coinbase sends max-age=300) and no credentials');
  eq(got.length, 300, 'inclusive end: 301 upstream rows → the 300 that belong to the page');
  ok(got[0].t === page.startSec && got.at(-1).t === page.endSec - D, 'first and last bucket of the page');
  ok(got.every((x, i) => i === 0 || x.t > got[i - 1].t), 'ascending output from newest-first rows');
  eq(got[5], (([t, l, h, o, c, v]) => ({ t, o, h, l, c, v }))(bar(page.startSec + 5 * D, D)), 'columns mapped [time, low, high, open, close, volume]');

  // explicit rows: newest first, plus a row before start (documented) and the end row
  const S = utc(2024, 1, 1), E = S + 3 * H;
  const custom = makeExchange({ rows: () => [[E, 1, 4, 2, 3, 9], [S + 2 * H, 10, 14, 12, 13, 3], [S + H, 20, 24, 22, 23, 2], [S, 30, 34, 32, 33, 1], [S - H, 1, 2, 1, 2, 1]] });
  const cp = MD.createCoinbaseProvider({ fetchImpl: custom.fetchImpl, now });
  eq(await cp.getCandles({ interval: '1h', startSec: S, endSec: E }), [
    { t: S, o: 32, h: 34, l: 30, c: 33, v: 1 }, { t: S + H, o: 22, h: 24, l: 20, c: 23, v: 2 }, { t: S + 2 * H, o: 12, h: 14, l: 10, c: 13, v: 3 },
  ], 'rows outside [start, end) dropped; mapped by position; sorted ascending');

  // refused before any request
  const before = ex.calls.length;
  await asyncThrows(() => p.getCandles({ interval: '4h', startSec: 0, endSec: 4 * H }), 'derived interval refused', e => e.code === 'unsupported_interval');
  await asyncThrows(() => p.getCandles({ interval: '1h', startSec: 60, endSec: 60 + H }), 'misaligned window refused', e => e.code === 'bad_window');
  await asyncThrows(() => p.getCandles({ interval: '1h', startSec: 0, endSec: 301 * H }), 'window over 300 buckets refused', e => e.code === 'bad_window');
  eq(ex.calls.length, before, 'refused windows never reach the network');

  // malformed pages
  const bad = n => makeExchange({ rows: ({ start }) => Array.from({ length: 20 }, (_, i) => i < n ? [start + i * H, 0, 1, 1, 1, 1] : bar(start + i * H, H)) });
  warned.length = 0;
  const one = await MD.createCoinbaseProvider({ fetchImpl: bad(1).fetchImpl }).getCandles({ interval: '1h', startSec: S, endSec: S + 20 * H });
  eq(one.length, 19, '1 bad row in 20 (5 %) → dropped, page used');
  eq(warned.length === 1 ? [warned[0][0], warned[0][1]] : warned, ['MarketData: Coinbase 1h page dropped 1 of 20 rows', { price: 1 }], 'one console.warn with counts and reasons only');
  await asyncThrows(() => MD.createCoinbaseProvider({ fetchImpl: bad(2).fetchImpl }).getCandles({ interval: '1h', startSec: S, endSec: S + 20 * H }),
    '2 bad rows in 20 → page failed', e => e.code === 'rejected');
  await asyncThrows(() => MD.createCoinbaseProvider({ fetchImpl: async () => json({ message: 'x' }) }).getCandles({ interval: '1h', startSec: S, endSec: E }),
    'non-array response', e => e.code === 'bad_response');
  await asyncThrows(() => MD.createCoinbaseProvider({ fetchImpl: async () => json({ m: 1 }, 429, { 'Retry-After': '7' }) }).getCandles({ interval: '1h', startSec: S, endSec: E }),
    'HTTP error carries status and Retry-After', e => e.code === 'http' && e.status === 429 && e.retryAfterSec === 7);
  await asyncThrows(() => MD.createCoinbaseProvider({ fetchImpl: async () => json({}, 503, { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' }) }).getCandles({ interval: '1h', startSec: S, endSec: E }),
    'non-numeric Retry-After ignored', e => e.status === 503 && e.retryAfterSec === null);

  // stats and spot
  eq(await p.get24HourStats(), { open: 69272.68, high: 70141.87, low: 66369.12, last: 67237.01, volume: 13089.29, at: NOW }, '24h stats parsed from strings, at = receipt time');
  eq(await p.getCurrentPrice(), { price: 67244.075, at: NOW }, 'spot price');
  await asyncThrows(() => MD.createCoinbaseProvider({ fetchImpl: async () => json({ open: '', high: '1', low: '1', last: '1', volume: '1' }) }).get24HourStats(),
    'blank stats field is not 0', e => e.code === 'bad_response');

  // the committed real Coinbase response parses exactly as Candles.parseRows does
  const fx = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'test', 'fixtures', 'btc-usd-1d.json'), 'utf8'));
  const ts = fx.rows.map(r => r[0]);
  const lo = Math.min(...ts), span = C.pageSpan('1d', 300);
  const pg = C.pageBounds(C.pageIndex(lo, '1d', 300) + 1, '1d', 300); // a page wholly inside the fixture
  const fxp = MD.createCoinbaseProvider({ fetchImpl: async () => json(fx.rows) });
  const fromFx = await fxp.getCandles({ interval: '1d', startSec: pg.startSec, endSec: pg.endSec });
  eq(fromFx, C.parseRows(fx.rows, '1d').valid.filter(x => x.t >= pg.startSec && x.t < pg.endSec), 'real fixture rows → same candles as parseRows, clipped to the page');
  ok(fromFx.length > 0 && fromFx.length <= 300 && span === 300 * D, `(fixture page holds ${fromFx.length} days)`);
}

// ── Memory store ─────────────────────────────────────────────────────────────
{
  const s = MD.createMemoryStore();
  const k = { provider: 'p', symbol: 'BTC-USD', interval: '1h' };
  await s.putCandles({ ...k, candles: [{ t: 2 * H, o: 1, h: 1, l: 1, c: 1 }, { t: H, o: 2, h: 2, l: 2, c: 2, v: 3 }] });
  await s.putCandles({ ...k, candles: [{ t: H, o: 2, h: 2, l: 2, c: 2, v: 3 }] }); // the same row twice: harmless
  eq(await s.getCandles({ ...k, fromSec: 0, toSec: 10 * H }), [{ t: H, o: 2, h: 2, l: 2, c: 2, v: 3 }, { t: 2 * H, o: 1, h: 1, l: 1, c: 1, v: null }], 'candles ascending; repeat write overwrites');
  eq(await s.getCandles({ ...k, fromSec: H, toSec: 2 * H }), [{ t: H, o: 2, h: 2, l: 2, c: 2, v: 3 }], 'toSec exclusive');
  eq(await s.getCandles({ ...k, interval: '1d', fromSec: 0, toSec: 1e12 }), [], 'series are separated by interval');
  eq(await s.getCandles({ ...k, provider: 'other', fromSec: 0, toSec: 1e12 }), [], 'and by provider');
  await s.putCoverage({ ...k, pageIndex: 3, fetchedAt: 10, complete: 1 });
  await s.putCoverage({ ...k, pageIndex: 1, fetchedAt: 9, complete: false });
  eq((await s.getCoverage({ ...k, fromPage: 0, toPage: 3 })).map(r => [r.pageIndex, r.complete]), [[1, false], [3, true]], 'coverage inclusive range, ascending');
  await s.putMeta('m', { a: [1] });
  const m = await s.getMeta('m'); m.a.push(2);
  eq(await s.getMeta('m'), { a: [1] }, 'meta round-trips by value');
  eq(await s.getMeta('missing'), null, 'missing meta → null');
  await s.clear();
  eq([await s.getCandles({ ...k }), await s.getCoverage({ ...k }), await s.getMeta('m')], [[], [], null], 'clear empties everything');
}

// ── Service: cache-first reads, refresh, paging ─────────────────────────────
{
  reset();
  const { ex, store, service } = setup();
  // a historic window: three daily pages, all in the past
  const from = utc(2020, 1, 1), to = utc(2022, 1, 1);
  const r1 = await service.loadView({ interval: '1d', fromSec: from, toSec: to });
  const pages = C.pagesFor(from, to, '1d', 300);
  eq(r1.status, 'ok', 'historic view loads');
  eq(ex.candleCalls().map(c => c.start), pages.map(p => p.startSec), 'missing pages fetched, newest first');
  eq(r1.candles.length, (to - from) / D, 'every day in the window');
  ok(r1.candles[0].t === from && r1.candles.at(-1).t === to - D && r1.formingIndex === -1, 'clipped to the window; nothing forming');
  eq(r1.gaps, [], 'no gaps');
  const n1 = ex.calls.length;
  const updates = [];
  const r2 = await service.loadView({ interval: '1d', fromSec: from, toSec: to, onUpdate: u => updates.push(u.status) });
  eq(ex.calls.length - n1, 0, 'second identical view: zero fetches for completed pages');
  eq(r2.candles, r1.candles, '…and the same candles from the store');
  eq(updates, ['loading', 'ok'], 'cached render first, then the final result');

  // a range view reaching now: the page holding the newest two buckets is always refreshed
  reset();
  const { ex: ex2, store: st2, service: s2 } = setup();
  const a = await s2.loadView({ range: '1W', interval: '1h' });
  eq(a.interval, '1h', '1W@1h allowed');
  ok(a.fromSec === C.bucketStart(NOW - W, '1h') && a.toSec === NOW, 'window = range start (bucket-aligned) to now');
  eq(a.candles.at(-1).t, C.bucketStart(NOW, '1h'), 'the forming hour is included');
  eq(a.formingIndex, a.candles.length - 1, '…and flagged by formingIndex');
  eq((await st2.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1h', fromSec: C.bucketStart(NOW, '1h'), toSec: Infinity })).length, 0,
    'the forming candle is never written to the store');
  const firstCalls = ex2.candleCalls().length;
  clock += 60;
  await s2.loadView({ range: '1W', interval: '1h' });
  const again = ex2.candleCalls().slice(firstCalls);
  eq(again.map(c => c.start), [C.pageBounds(C.pageIndex(C.bucketStart(clock, '1h'), '1h', 300), '1h', 300).startSec],
    'reload: only the page with the newest two buckets is refetched');
  // a newest-two-buckets pair straddling a page boundary refreshes both pages
  reset();
  const boundary = Math.ceil(NOW / SPAN_1H) * SPAN_1H; // a 1h page boundary just after NOW
  clock = boundary + 10 * 60;                         // newest bucket is the page's first
  const { ex: ex3, service: s3 } = setup();
  await s3.loadView({ interval: '1h', fromSec: boundary - 48 * H, toSec: clock });
  const n3 = ex3.candleCalls().length;
  clock += 30;
  await s3.loadView({ interval: '1h', fromSec: boundary - 48 * H, toSec: clock });
  eq(ex3.candleCalls().slice(n3).map(c => c.start).sort(), [boundary - SPAN_1H, boundary].sort(), 'newest two buckets across a page boundary → both pages refreshed');

  // an incomplete page that is not the newest is refetched only once an interval has passed
  reset();
  const { ex: ex4, store: st4, service: s4 } = setup();
  const oldPage = C.pageBounds(C.pageIndex(utc(2023, 1, 1), '1d', 300), '1d', 300);
  await st4.putCoverage({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', pageIndex: oldPage.index, fetchedAt: NOW - 100, complete: false });
  await s4.loadView({ interval: '1d', fromSec: oldPage.startSec, toSec: oldPage.endSec });
  eq(ex4.candleCalls().length, 0, 'incomplete page fetched under an interval ago is not refetched');
  clock += D;
  await s4.loadView({ interval: '1d', fromSec: oldPage.startSec, toSec: oldPage.endSec });
  eq(ex4.candleCalls().length, 1, '…and is once an interval has passed');
  void store;
}

// ── Service: derived intervals ───────────────────────────────────────────────
{
  reset();
  const { ex, store, service } = setup();
  const r = await service.loadView({ range: '1M', interval: '4h' });
  eq([r.interval, r.sourceInterval], ['4h', '1h'], '4h is built from 1h');
  ok(ex.candleCalls().every(c => c.interval === '1h'), 'only native 1h is requested');
  const nat = await store.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1h', fromSec: r.fromSec, toSec: NOW });
  const forming = C.bucketStart(NOW, '1h');
  const formingRow = (([t, l, h, o, c, v]) => ({ t, o, h, l, c, v }))(bar(forming, H));
  eq(r.candles, C.aggregate([...nat, formingRow], '4h', '1h', { nowSec: NOW }), '4h candles = aggregate of the native 1h (forming hour included)');
  ok(r.fromSec % (4 * H) === 0 && r.candles[0].t === r.fromSec, 'derived window starts on a whole 4h bucket');
  eq(r.formingIndex, r.candles.length - 1, 'forming 4h bucket flagged');
  ok(!r.candles.at(-1).partial, 'forming bucket with every started hour present is not partial');
  eq(await store.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '4h', fromSec: 0, toSec: Infinity }), [], 'derived candles are never stored');
  const w = await service.loadView({ range: '1Y', interval: '1w' });
  eq([w.interval, w.sourceInterval], ['1w', '1d'], '1w from 1d');
  ok(w.candles.every(x => new Date(x.t * 1000).getUTCDay() === 1), 'weekly candles start on Monday');
  eq((await service.loadView({ range: '1Y', interval: '1m' })).interval, '1d', 'a disallowed stored interval falls back to the range default');
}

// ── Service: concurrency, retry, backoff ─────────────────────────────────────
{
  reset();
  const { ex, service } = setup();
  await service.loadView({ interval: '1d', fromSec: utc(2016, 1, 1), toSec: utc(2026, 1, 1) });
  const n = ex.candleCalls().length;
  ok(n >= 10, `(${n} pages requested)`);
  eq(ex.maxInFlight, 4, 'at most 4 requests in flight, and the pool uses all 4');
  ok(ex.candleCalls().every((c, i, a) => i === 0 || c.start < a[i - 1].start), 'requests start newest first');

  // 429 with Retry-After, then success; the whole queue pauses
  reset();
  let hit = false;
  const { ex: e2, service: s2 } = setup({ fail: c => c.path.endsWith('/candles') && !hit && (hit = true) ? json({ message: 'slow down' }, 429, { 'Retry-After': '2' }) : null });
  const r = await s2.loadView({ interval: '1d', fromSec: utc(2018, 1, 1), toSec: utc(2024, 1, 1) });
  eq(r.status, 'ok', '429 then success → view ok');
  ok(sleeps.includes(2000), 'Retry-After: 2 → 2000 ms wait instead of the backoff');
  const t429 = e2.candleCalls()[0].at;
  const later = e2.candleCalls().filter((c, i) => i >= 4); // requests issued after the first wave
  ok(later.length > 0 && later.every(c => c.at >= t429 + 2), 'requests after the 429 wait out the pause');

  // 5xx: retried with doubling backoff, then given up after 3 attempts
  reset();
  const { ex: e3, service: s3 } = setup({ fail: c => c.path.endsWith('/candles') ? json({}, 503) : null });
  const page = C.pageBounds(C.pageIndex(utc(2019, 1, 1), '1d', 300), '1d', 300);
  const r3 = await s3.loadView({ interval: '1d', fromSec: page.startSec, toSec: page.endSec });
  eq(e3.candleCalls().length, 3, '5xx: 3 attempts');
  eq(sleeps, [1000, 2000], 'backoff 1 s then 2 s (jitter injected as 0)');
  eq([r3.status, r3.failedPages.map(f => [f.index, f.error, f.status])], ['partial', [[page.index, 'http', 503]]], 'exhausted page → partial');

  // jitter is up to 250 ms
  reset();
  const { service: s3b } = setup({ fail: c => c.path.endsWith('/candles') ? json({}, 500) : null }, { random: () => 0.999 });
  await s3b.loadView({ interval: '1d', fromSec: page.startSec, toSec: page.endSec });
  ok(sleeps.length === 2 && sleeps[0] > 1249 && sleeps[0] < 1250 && sleeps[1] > 2249 && sleeps[1] < 2250, 'jitter adds under 250 ms');

  // 4xx other than 429: not retried
  reset();
  const { ex: e4, service: s4 } = setup({ fail: c => c.path.endsWith('/candles') ? json({ message: 'NotFound' }, 404) : null });
  const r4 = await s4.loadView({ interval: '1d', fromSec: page.startSec, toSec: page.endSec });
  eq([e4.candleCalls().length, sleeps.length, r4.status], [1, 0, 'partial'], '404: one attempt, no wait, partial');

  // network error and timeout are retried
  reset();
  let drops = 0;
  const flaky = makeExchange();
  const fetchImpl = (url, init) => drops++ < 2 ? Promise.reject(new TypeError('Failed to fetch')) : flaky.fetchImpl(url, init);
  const s5 = MD.createMarketDataService({ provider: MD.createCoinbaseProvider({ fetchImpl, now }), now, sleep, random: () => 0, timeoutMs: 0 });
  eq((await s5.loadView({ interval: '1d', fromSec: page.startSec, toSec: page.endSec })).status, 'ok', 'two network errors then success → ok');
  reset();
  let hang = 1;
  const slow = makeExchange();
  const hangOnce = (url, init) => hang-- > 0
    ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : slow.fetchImpl(url, init);
  const s6 = MD.createMarketDataService({ provider: MD.createCoinbaseProvider({ fetchImpl: hangOnce, now }), now, sleep, random: () => 0, timeoutMs: 20 });
  eq((await s6.loadView({ interval: '1d', fromSec: page.startSec, toSec: page.endSec })).status, 'ok', 'a request past its timeout is aborted and retried');

  // stats and price go through the same retry
  reset();
  let sf = 1;
  const { service: s7 } = setup({ fail: c => c.path.endsWith('/stats') && sf-- > 0 ? json({}, 502) : null });
  eq((await s7.get24HourStats()).last, 67237.01, 'stats retried after a 502');
  eq((await s7.getCurrentPrice()).price, 67244.075, 'spot price through the service');
}

// ── Service: partial results and coverage ────────────────────────────────────
{
  reset();
  let down = true;
  const from = utc(2019, 1, 1), to = utc(2023, 1, 1);
  const pages = C.pagesFor(from, to, '1d', 300);
  const bad = pages[2];
  const { ex, store, service } = setup({ fail: c => down && c.start === bad.startSec ? json({}, 500) : null });
  const r = await service.loadView({ interval: '1d', fromSec: from, toSec: to });
  eq(r.status, 'partial', 'one failed page → partial');
  eq(r.failedPages.map(f => f.index), [bad.index], 'the failed page is reported');
  const cov = await store.getCoverage({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', fromPage: pages.at(-1).index, toPage: pages[0].index });
  eq(cov.map(c => c.pageIndex).sort(), pages.filter(p => p !== bad).map(p => p.index).sort(), 'the failed page is not recorded in coverage');
  ok(r.candles.length > 0 && r.candles.every(c => c.t < bad.startSec || c.t >= bad.endSec), 'pages that succeeded are kept and shown');
  eq(r.gaps.filter(g => g.kind === 'not_fetched').map(g => [g.fromSec, g.toSec]), [[Math.max(from, bad.startSec), Math.min(to, bad.endSec)]],
    'the failed page shows as not fetched');
  down = false;
  const before = ex.candleCalls().length;
  const r2 = await service.loadView({ interval: '1d', fromSec: from, toSec: to });
  eq(ex.candleCalls().slice(before).map(c => c.start), [bad.startSec], 'next load retries only the failed page');
  eq([r2.status, r2.candles.length, r2.gaps], ['ok', (to - from) / D, []], '…and the view is complete');

  // provider gaps: a fetched page with buckets missing
  reset();
  const holes = new Set([utc(2021, 3, 3), utc(2021, 3, 4)]);
  const { service: sg } = setup({ holes });
  const g = await sg.loadView({ interval: '1d', fromSec: utc(2021, 3, 1), toSec: utc(2021, 3, 10) });
  eq(g.gaps, [{ fromSec: utc(2021, 3, 3), toSec: utc(2021, 3, 5), missing: 2, kind: 'provider' }], 'missing buckets in a fetched page are a provider gap');
  ok(!g.candles.some(c => holes.has(c.t)), 'nothing is filled in');

  // a page over the reject limit counts as failed and is not cached
  reset();
  const junk = makeExchange({ rows: ({ start, g: gr }) => Array.from({ length: 300 }, (_, i) => i % 10 === 0 ? [start + i * gr, 5, 1, 2, 3, 1] : bar(start + i * gr, gr)) });
  const sj = MD.createMarketDataService({ provider: MD.createCoinbaseProvider({ fetchImpl: junk.fetchImpl, now }), now, sleep, random: () => 0, timeoutMs: 0 });
  const pj = C.pageBounds(C.pageIndex(utc(2019, 1, 1), '1d', 300), '1d', 300);
  const rj = await sj.loadView({ interval: '1d', fromSec: pj.startSec, toSec: pj.endSec });
  eq([rj.status, junk.candleCalls().length, rj.candles.length], ['partial', 1, 0], 'over the 5 % limit: failed, not retried, nothing used');
  eq(await sj.store.getCoverage({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d' }), [], '…and not recorded as covered');
}

// ── Service: supersede and abort ─────────────────────────────────────────────
{
  reset();
  let release;
  const gate = new Promise(r => { release = r; });
  // View A spans two pages. The newer one answers at once; the older one is held by a fake that
  // ignores abort, and only answers after A has been superseded.
  const from = utc(2019, 1, 1), to = utc(2020, 1, 1);
  const [newer, older] = C.pagesFor(from, to, '1d', 300);
  ok(newer && older && C.pagesFor(from, to, '1d', 300).length === 2, '(view A spans two pages)');
  const { ex, store, service } = setup({ gate: c => c.start === older.startSec ? gate : null });
  const key = { provider: 'coinbase', symbol: 'BTC-USD', interval: '1d' };
  const seenA = [];
  const pa = service.loadView({ interval: '1d', fromSec: from, toSec: to, onUpdate: u => seenA.push(u) });
  for (let i = 0; i < 50 && !(await store.getCoverage({ ...key, fromPage: newer.index, toPage: newer.index })).length; i++) await new Promise(r => setImmediate(r));
  const heldCall = ex.candleCalls().find(c => c.start === older.startSec);
  ok(!!heldCall, '(view A has its older page in flight)');
  const pb = service.loadView({ interval: '1h', fromSec: utc(2020, 1, 1), toSec: utc(2020, 1, 3) });
  ok(heldCall.init.signal.aborted, 'a new view aborts the previous view’s requests');
  const ra = await pa; // settles without waiting for the held response
  eq(ra.status, 'superseded', 'superseded view resolves as superseded, without waiting for its request');
  ok(!('candles' in ra), '…with no candles');
  release();
  const rb = await pb;
  await new Promise(r => setImmediate(r));
  eq(seenA, [], 'nothing it received reaches onUpdate');
  eq(rb.status, 'ok', 'the newer view completes');
  ok(rb.token > ra.token, 'tokens increase');
  ok((await store.getCandles({ ...key, fromSec: newer.startSec, toSec: newer.endSec })).length === 300, 'the page that finished before the abort stays cached');
  eq(await store.getCoverage({ ...key, fromPage: older.index, toPage: older.index }), [], 'the abandoned page is not recorded as covered');

  // cancel() supersedes too (leaving the Market tab)
  reset();
  const { service: s2 } = setup({ gate: new Promise(() => {}) });
  const pc = s2.loadView({ interval: '1d', fromSec: from, toSec: to });
  await new Promise(r => setImmediate(r));
  s2.cancel();
  eq((await Promise.race([pc, new Promise(r => setTimeout(() => r({ status: 'hung' }), 500))])).status, 'superseded', 'cancel() resolves the view as superseded');
}

// ── Service: request windows are always pages ────────────────────────────────
{
  reset();
  const { ex, service } = setup();
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const range of C.RANGES) for (const iv of C.allowedIntervals(range, NOW, null).slice(0, 3)) await service.loadView({ range, interval: iv });
  for (let i = 0; i < 40; i++) { // transaction-shaped windows: arbitrary seconds
    const iv = ['1m', '5m', '15m', '1h', '1d', '30m', '4h', '1w'][i % 8];
    const from = utc(2016, 1, 1) + Math.floor(rnd() * 10 * 365 * D);
    await service.loadView({ interval: iv, fromSec: from, toSec: Math.min(NOW, from + 1 + Math.floor(rnd() * 20 * C.intervalSeconds(iv))) });
  }
  const future = await service.loadView({ interval: '1h', fromSec: NOW - 2 * D, toSec: NOW + 60 * D }); // window past now
  eq(future.status, 'ok', 'a window reaching past now loads (pages that start in the future are skipped)');
  const calls = ex.candleCalls();
  ok(calls.length > 40, `(${calls.length} requests)`);
  ok(calls.every(c => { const span = 300 * c.g; return c.start % span === 0 && c.end - c.start === span; }), 'every request window is exactly one page');
  ok(calls.every(c => c.start <= c.at), 'no request starts in the future');
  ok(calls.every(c => GRAN[c.g]), 'only native granularities are requested');
}

// ── Service: earliest-candle discovery and backfill ──────────────────────────
{
  reset();
  const { ex, store, service } = setup();
  eq(await service.getEarliest('1d'), null, 'earliest unknown before discovery');
  const all0 = await service.loadView({ range: 'ALL', interval: '1w' });
  eq([all0.status, all0.earliestSec, all0.interval], ['ok', null, '1w'], 'ALL before discovery: loads what it can, earliest null');
  ok(all0.candles.length > 0 && all0.candles[0].t >= C.pageBounds(C.pageIndex(NOW, '1d', 300), '1d', 300).startSec - W, '…the newest page');

  const viewCalls = ex.candleCalls().length;
  const r = await service.backfill();
  eq(r, { status: 'complete', earliestSec: FIRST_DAY }, 'backfill discovers the first candle (2015-07-20)');
  const firstPage = C.pageIndex(FIRST_DAY, '1d', 300);
  const asked = ex.candleCalls().slice(viewCalls).map(c => c.start / SPAN_1D);
  ok(asked.includes(firstPage - 1) && asked.includes(firstPage - 2) && !asked.includes(firstPage - 3), 'stops after two consecutive empty older pages');
  ok(asked.every((x, i) => i === 0 || x < asked[i - 1]), 'walks newest to oldest');
  eq(sleeps, Array(asked.length - 1).fill(250), '250 ms pause between backfill requests, none before the first');
  const e = await service.getEarliest('1d');
  eq([e.earliestSec, e.verifiedAt, e.stale], [FIRST_DAY, Math.floor(clock), false], 'earliest stored in meta with its verification time');
  const all = await service.loadView({ range: 'ALL', interval: '1w' });
  eq([all.earliestSec, all.fromSec], [FIRST_DAY, C.bucketStart(FIRST_DAY, '1w')], 'ALL now starts at the discovered candle');
  eq(all.candles[0].t, C.bucketStart(FIRST_DAY, '1w'), '…from the store');
  eq(C.allowedIntervals('ALL', NOW, all.earliestSec), ['1d', '1w'], 'ALL intervals');
  const n = ex.calls.length;
  eq(await service.backfill(), { status: 'complete', earliestSec: FIRST_DAY }, 'a second backfill is a no-op');
  eq(ex.calls.length, n, '…with no requests');

  // a different history start is found from the provider, not from any date constant
  reset();
  const later = utc(2017, 3, 6);
  const { service: s2 } = setup({ first: later });
  eq((await s2.backfill()).earliestSec, later, 'earliest follows the provider’s data');

  clock += 91 * D;
  ok((await s2.getEarliest('1d')).stale, 'record older than 90 days is stale');
}
{
  // resumable, idempotent backfill
  reset();
  const { ex, store, service } = setup();
  const ctl = new AbortController();
  let k = 0;
  const r1 = await service.backfill({ signal: ctl.signal, onProgress: () => { if (++k === 5) ctl.abort(); } });
  eq(r1.status, 'paused', 'aborting pauses the backfill');
  const saved = await store.getMeta('backfill:coinbase:BTC-USD:1d');
  eq(saved.nextPage, r1.nextPage, 'position saved in meta');
  const firstRun = ex.candleCalls().map(c => c.start / SPAN_1D);
  eq(firstRun.length, 5, '(5 pages fetched before the pause)');
  const r2 = await service.backfill();
  const secondRun = ex.candleCalls().slice(firstRun.length).map(c => c.start / SPAN_1D);
  eq(r2, { status: 'complete', earliestSec: FIRST_DAY }, 'resumed backfill completes');
  eq(secondRun[0], saved.nextPage, 'resumes from the saved position');
  ok(!secondRun.some(i => firstRun.includes(i)), 'no page fetched twice across the pause');
  eq(await store.getMeta('backfill:coinbase:BTC-USD:1d'), null, 'position cleared on completion');
  const allDays = await store.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', fromSec: 0, toSec: NOW });
  ok(allDays.length === (C.bucketStart(NOW, '1d') - FIRST_DAY) / D && allDays.every((x, i) => i === 0 || x.t === allDays[i - 1].t + D),
    `full daily history stored, contiguous (${allDays.length} days)`);
  // writing the same pages again is harmless
  const fresh = MD.createMarketDataService({ provider: service.provider, store, now, sleep, random: () => 0, timeoutMs: 0 });
  await store.putMeta('earliest:coinbase:BTC-USD:1d', null);
  for (const c of await store.getCoverage({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d' })) await store.putCoverage({ ...c, complete: false });
  eq((await fresh.backfill()).status, 'complete', 'a full re-walk over already-stored pages completes');
  eq(await store.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', fromSec: 0, toSec: NOW }), allDays, '…and leaves the stored history identical');

  // stale record: re-verification refetches only the empty pages
  clock += 91 * D;
  const before = ex.candleCalls().length;
  eq((await service.backfill()).status, 'complete', 'stale earliest is re-verified');
  const reverify = ex.candleCalls().slice(before).map(c => c.start / SPAN_1D);
  const fp = C.pageIndex(FIRST_DAY, '1d', 300);
  ok(reverify.includes(fp - 1) && reverify.includes(fp - 2) && reverify.filter(i => i < C.pageIndex(NOW, '1d', 300) - 1 && i >= fp).length === 0,
    `re-verification requests the empty pages (and the newest), not stored history (${reverify.join(',')})`);
  ok(!(await service.getEarliest('1d')).stale, 'record fresh again');
}
{
  // backfill stops after 3 consecutive page failures and resumes from there
  reset();
  let broken = true;
  const target = C.pageIndex(NOW, '1d', 300) - 3;
  const { ex, service } = setup({ fail: c => broken && c.start === target * SPAN_1D ? json({}, 500) : null });
  const r = await service.backfill();
  eq([r.status, r.nextPage], ['failed', target], 'three consecutive failures → failed at that page');
  eq(ex.candleCalls().filter(c => c.start === target * SPAN_1D).length, 9, '(3 page attempts × 3 request attempts)');
  broken = false;
  const before = ex.candleCalls().length;
  eq((await service.backfill()).status, 'complete', 'the next backfill completes');
  eq(ex.candleCalls()[before].start, target * SPAN_1D, '…resuming at the failed page');
}

{
  // readCached: completed candles already held, from the store only — no request, and no effect
  // on a view in flight (the Market summary reads daily history this way, Phase 5)
  let calls = 0;
  const provider = {
    id: 'coinbase', symbol: 'BTC-USD', label: 'Coinbase', maxCandlesPerRequest: 300,
    getAvailableIntervals: () => ['1m', '5m', '15m', '1h', '1d'],
    getCandles: async () => { calls++; return []; },
  };
  const store = MD.createMemoryStore();
  const days = [0, 1, 2, 4].map(k => ({ t: B + k * D, o: 100, h: 110, l: 90, c: 105, v: 1 }));
  await store.putCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', candles: days });
  const service = MD.createMarketDataService({ provider, store, now: () => B + 10 * D });
  eq(await service.readCached({ interval: '1d' }), days, 'readCached returns every held candle, ascending, gaps as they are');
  eq((await service.readCached({ interval: '1d', fromSec: B + D, toSec: B + 4 * D })).map(c => c.t), [B + D, B + 2 * D], 'readCached window is [from, to)');
  eq(await service.readCached({ interval: '1h' }), [], 'nothing held → empty');
  eq(calls, 0, 'readCached makes no request');
  let threw = false;
  try { await service.readCached({ interval: '4h' }); } catch (e) { threw = e.code === 'interval'; }
  ok(threw, 'readCached refuses a derived interval');
}

console.warn = realWarn;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
