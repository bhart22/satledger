// Market data tests (docs/market-data.md §20): the Candles namespace — normalization,
// validation, UTC bucketing, aggregation, gaps, range/interval rules and paging — plus the real
// Coinbase daily fixture. Runs the code straight out of app.dev.html's helper region.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppHelpers } from '../lib/app-helpers.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const { Candles: C } = loadAppHelpers(['Candles']);

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

// ── Scope: the helper region gains exactly one name ──────────────────────────
{
  const src = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');
  const section = src.slice(src.indexOf('// ─── Market: Candles'), src.indexOf('// ─── SVG Icons'));
  const topLevel = [...section.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  eq(topLevel, ['Candles'], 'Market: Candles section declares only Candles at top level');
  ok(Object.isFrozen(C) && Object.isFrozen(C.INTERVALS) && Object.isFrozen(C.INTERVALS['1w']), 'Candles and its tables are frozen');
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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
