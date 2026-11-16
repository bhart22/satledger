// Technical indicator tests (docs/technical-indicators.md §14): the Indicators namespace, run
// straight out of app.dev.html's helper region. For every indicator there are three independent
// checks — a naive oracle written here from the formula on the page, a hand-computed vector
// with the arithmetic in a comment, and (where one exists with the same definition) a published
// worked example — plus the structural, causality and segmentation checks, and compatibility
// with the Dashboard's buildMovingAverageSeries.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppHelpers } from '../lib/app-helpers.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const { Indicators: I, Candles: C } = loadAppHelpers(['Indicators', 'Candles']);
const SRC = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (c, name) => eq(!!c, true, name);
const throws = (f, name) => { try { f(); fail++; console.error(`FAIL ${name}: did not throw`); } catch { pass++; } };
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const D = 86400;
const sum = xs => xs.reduce((a, b) => a + b, 0);

// a ≈ b: both null, or within 1e-9 relative. `floor` is an absolute allowance used only for
// series that cross zero (MACD line, histogram), where a relative bound is meaningless; it is
// set from the price scale (1e-12 × the largest close), far below anything visible.
const near = (a, b, floor = 0) => (a === null || b === null) ? a === b
  : Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) + floor;
const seriesNear = (actual, expected, name, floor = 0) => {
  if (actual.length !== expected.length) { fail++; console.error(`FAIL ${name}: length ${actual.length} vs ${expected.length}`); return; }
  for (let i = 0; i < actual.length; i++) {
    if (!near(actual[i], expected[i], floor)) { fail++; console.error(`FAIL ${name} [${i}]: ${actual[i]} vs ${expected[i]}`); return; }
  }
  pass++;
};

// Candles from closes: o = previous close, h/l bracket both so the candle is valid.
const fromCloses = (closes, t0 = utc(2024, 1, 1)) => closes.map((c, i) => {
  const o = i ? closes[i - 1] : c;
  return { t: t0 + i * D, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
});

// Deterministic PRNG so failures are reproducible.
const prng = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randomCandles = (n, seed, t0 = utc(2020, 1, 1)) => {
  const rnd = prng(seed);
  const out = [];
  let prev = 30000;
  for (let i = 0; i < n; i++) {
    const o = prev, c = Math.max(100, o * (1 + (rnd() - 0.5) * 0.08));
    const h = Math.max(o, c) * (1 + rnd() * 0.03), l = Math.min(o, c) * (1 - rnd() * 0.03);
    out.push({ t: t0 + i * D, o, h, l, c, v: rnd() * 1000 });
    prev = c;
  }
  return out;
};

const fixture = (() => {
  const fx = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'test', 'fixtures', 'btc-usd-1d.json'), 'utf8'));
  const r = C.parseRows(fx.rows, '1d');
  if (r.rejected.length) throw new Error('daily fixture does not validate');
  return deepFreeze(r.valid);
})();
const published = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'test', 'fixtures', 'indicators-published.json'), 'utf8'));

// ── Scope ───────────────────────────────────────────────────────────────────
{
  const a = SRC.indexOf('// ─── Market: Indicators');
  ok(a !== -1 && a > SRC.indexOf('// ─── Market: Candles') && a < SRC.indexOf('// ─── SVG Icons'), 'Market: Indicators is inside the helper region, after Candles');
  const section = SRC.slice(a, SRC.indexOf('\n// ─── ', a + 1));
  eq([...section.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]), ['Indicators'],
    'Market: Indicators section declares only Indicators at top level');
  const code = section.replace(/^\s*\/\/.*$/gm, '');
  eq(code.match(/\btransactions?\b|\btxs?\b|btc-tx|localStorage|sessionStorage|wallets?\b|fetch\(|indexedDB|\bthis\b/gi), null,
    'Indicators code references no transactions, storage, network or `this`');
  ok(Object.isFrozen(I) && Object.isFrozen(I.definitions) && I.definitions.every(Object.isFrozen) && Object.isFrozen(I.returns), 'Indicators and its definitions are frozen');
  // The seed recorded in Phase 8 (docs/technical-indicators.md §12): Bitstamp's highest daily
  // high before Coinbase's first BTC-USD daily candle (2015-07-20), read from Bitstamp's public
  // daily OHLC on 2026-11-14 — 1163.00 on 2013-11-30.
  eq({ price: I.ATH_SEED.price, date: I.ATH_SEED.date }, { price: 1163, date: '2013-11-30' }, 'ATH_SEED value and date');
  ok(/bitstamp/i.test(I.ATH_SEED.source) && Object.isFrozen(I.ATH_SEED), 'ATH_SEED cites its source and is frozen');
  eq(I.ATH_SEED_VERIFIED, true, 'a seed in the code is a verified seed');
  ok(/bitstamp\.net\/api\/v2\/ohlc\/btcusd/.test(section), 'the code comment cites the source');
}

// ── Registry ────────────────────────────────────────────────────────────────
{
  eq(I.ids, ['sma', 'ema', 'rsi', 'macd', 'bollinger', 'atr', 'volatility'], 'indicator ids');
  eq(I.definitions.map(d => [d.id, d.category, d.placement]), [
    ['sma', 'TREND', 'overlay'], ['ema', 'TREND', 'overlay'], ['rsi', 'MOMENTUM', 'pane'], ['macd', 'MOMENTUM', 'pane'],
    ['bollinger', 'VOLATILITY', 'overlay'], ['atr', 'VOLATILITY', 'pane'], ['volatility', 'VOLATILITY', 'pane'],
  ], 'categories and placement');
  ok(I.definitions.every(d => I.CATEGORIES.includes(d.category)), 'every category is a known one');
  eq(I.definitions.map(d => d.defaults), [
    { period: 50, source: 'close' }, { period: 21, source: 'close' }, { period: 14, overbought: 70, oversold: 30 },
    { fast: 12, slow: 26, signal: 9 }, { period: 20, multiplier: 2 }, { period: 14 }, { period: 30 },
  ], 'defaults');
  eq([I.get('sma').presets, I.get('ema').presets, I.get('volatility').presets], [[20, 50, 100, 200], [12, 21, 50, 200], [7, 14, 30, 90]], 'presets');
  eq(I.get('macd').series, ['macd', 'signal', 'histogram'], 'MACD series names');
  eq(I.get('bollinger').series, ['upper', 'middle', 'lower', 'percentB', 'bandWidth'], 'Bollinger series names');
  throws(() => I.get('vwap'), 'unknown indicator throws');
  throws(() => I.get('constructor'), 'prototype key is not an indicator');
  // Methods don't depend on `this`: a detached call works.
  const { calculate } = I.get('sma');
  eq(calculate(fromCloses([1, 2, 3]), { period: 2 }).sma, [null, 1.5, 2.5], 'detached calculate works');
}

// ── Settings validation ─────────────────────────────────────────────────────
{
  const sma = I.get('sma'), macd = I.get('macd'), bb = I.get('bollinger'), rsi = I.get('rsi');
  eq(sma.validate(), { period: 50, source: 'close' }, 'missing settings → defaults');
  eq(sma.validate({ period: 20, junk: 1 }), { period: 20, source: 'close' }, 'partial settings merged; unknown keys dropped');
  eq([sma.validate({ period: 2 }).period, sma.validate({ period: 1000 }).period], [2, 1000], 'period bounds inclusive');
  for (const p of [1, 1001, 0, -5, 20.5, '20', NaN, Infinity, null]) throws(() => sma.validate({ period: p }), `period ${String(p)} rejected`);
  throws(() => sma.validate({ source: 'typical' }), 'unknown source rejected');
  ok(I.SOURCES.every(s => sma.validate({ source: s }).source === s), 'every documented source accepted');
  throws(() => sma.validate([]), 'array settings rejected');
  throws(() => sma.validate('x'), 'string settings rejected');
  throws(() => macd.validate({ fast: 26, slow: 26 }), 'MACD fast == slow rejected');
  throws(() => macd.validate({ fast: 30, slow: 26 }), 'MACD fast > slow rejected');
  eq(macd.validate({ fast: 5, slow: 6, signal: 2 }), { fast: 5, slow: 6, signal: 2 }, 'MACD fast < slow accepted');
  for (const m of [0, -1, 10.01, NaN, Infinity, '2']) throws(() => bb.validate({ multiplier: m }), `multiplier ${String(m)} rejected`);
  eq([bb.validate({ multiplier: 10 }).multiplier, bb.validate({ multiplier: 0.5 }).multiplier], [10, 0.5], 'multiplier (0, 10]');
  throws(() => rsi.validate({ overbought: 30, oversold: 70 }), 'RSI oversold above overbought rejected');
  throws(() => rsi.validate({ overbought: 100 }), 'RSI level 100 rejected');
  eq(I.resolveSettings('macd', { fast: 40 }), { fast: 12, slow: 26, signal: 9 }, 'resolveSettings: invalid → defaults, no throw');
  eq(I.resolveSettings('sma', { period: 200 }), { period: 200, source: 'close' }, 'resolveSettings: valid kept');
  eq(I.resolveSettings('sma', 'garbage'), { period: 50, source: 'close' }, 'resolveSettings: non-object → defaults');
  throws(() => I.get('sma').calculate(fromCloses([1, 2, 3]), { period: 1 }), 'calculate validates its settings');
}

// ── Naive oracles, written directly from the formulas (§4–§10) ──────────────
// EMA-style recursions are evaluated in closed form, so the oracle shares no running state with
// the implementation: for a seed S at index s and smoothing factor a,
//   X[i] = (1-a)^(i-s) · S + Σ_{j=s+1..i} a · (1-a)^(i-j) · x[j]
const closedForm = (xs, N, from, a) => {
  const out = xs.map(() => null), s = from + N - 1;
  if (s >= xs.length) return out;
  const seed = sum(xs.slice(from, s + 1)) / N;
  for (let i = s; i < xs.length; i++) {
    let v = Math.pow(1 - a, i - s) * seed;
    for (let j = s + 1; j <= i; j++) v += a * Math.pow(1 - a, i - j) * xs[j];
    out[i] = v;
  }
  return out;
};
const naive = {
  sma: (cs, { period: N }) => ({ sma: cs.map((_, i) => i < N - 1 ? null : sum(cs.slice(i - N + 1, i + 1).map(x => x.c)) / N) }),
  ema: (cs, { period: N }) => ({ ema: closedForm(cs.map(x => x.c), N, 0, 2 / (N + 1)) }),
  rsi: (cs, { period: N }) => {
    const d = cs.map((x, i) => i ? x.c - cs[i - 1].c : 0);
    const g = closedForm(d.map(v => Math.max(v, 0)), N, 1, 1 / N), l = closedForm(d.map(v => Math.max(-v, 0)), N, 1, 1 / N);
    return { rsi: cs.map((_, i) => g[i] === null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + g[i] / l[i])) };
  },
  macd: (cs, { fast, slow, signal }) => {
    const c = cs.map(x => x.c);
    const f = closedForm(c, fast, 0, 2 / (fast + 1)), s = closedForm(c, slow, 0, 2 / (slow + 1));
    const m = c.map((_, i) => i < slow - 1 ? null : f[i] - s[i]);
    const sig = closedForm(m, signal, slow - 1, 2 / (signal + 1));
    return { macd: m, signal: sig, histogram: m.map((v, i) => v === null || sig[i] === null ? null : v - sig[i]) };
  },
  bollinger: (cs, { period: N, multiplier: k }) => {
    const out = { upper: [], middle: [], lower: [], percentB: [], bandWidth: [] };
    cs.forEach((x, i) => {
      if (i < N - 1) { for (const key in out) out[key].push(null); return; }
      const w = cs.slice(i - N + 1, i + 1).map(y => y.c), mid = sum(w) / N;
      const sd = Math.sqrt(sum(w.map(v => (v - mid) ** 2)) / N);
      const up = mid + k * sd, lo = mid - k * sd;
      out.upper.push(up); out.middle.push(mid); out.lower.push(lo);
      out.percentB.push(up === lo ? null : (x.c - lo) / (up - lo)); out.bandWidth.push((up - lo) / mid);
    });
    return out;
  },
  atr: (cs, { period: N }) => {
    const tr = cs.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c)) : null);
    return { atr: closedForm(tr, N, 1, 1 / N) };
  },
  volatility: (cs, { period: N }, interval) => {
    const P = 365 * 86400 / C.intervalSeconds(interval);
    return { volatility: cs.map((_, i) => {
      if (i < N) return null;
      const r = []; for (let j = i - N + 1; j <= i; j++) r.push(Math.log(cs[j].c / cs[j - 1].c));
      const m = sum(r) / N;
      return Math.sqrt(sum(r.map(v => (v - m) ** 2)) / (N - 1)) * Math.sqrt(P);
    }) };
  },
};
const CASES = [
  ['sma', {}], ['sma', { period: 20 }], ['sma', { period: 200 }],
  ['ema', {}], ['ema', { period: 12 }], ['ema', { period: 200 }],
  ['rsi', {}], ['rsi', { period: 2 }],
  ['macd', {}], ['macd', { fast: 3, slow: 10, signal: 4 }],
  ['bollinger', {}], ['bollinger', { period: 50, multiplier: 2.5 }],
  ['atr', {}], ['atr', { period: 5 }],
  ['volatility', {}], ['volatility', { period: 7 }], ['volatility', { period: 90 }],
];
{
  const series = [['fixture', fixture], ['random 600', randomCandles(600, 7)], ['random 2000', randomCandles(2000, 99)], ['random 40', randomCandles(40, 3)]];
  for (const [label, cs] of series) {
    const floor = 1e-12 * Math.max(...cs.map(x => x.c));
    for (const [id, settings] of CASES) {
      const def = I.get(id), s = def.validate(settings);
      const got = def.calculate(cs, s, '1d'), want = naive[id](cs, s, '1d');
      for (const k of def.series) seriesNear(got[k], want[k], `oracle ${id} ${JSON.stringify(settings)} ${k} on ${label}`, floor);
    }
  }
  // The rolling SMA equals the direct sum (§4).
  seriesNear(I.get('sma').calculate(fixture, { period: 50 }).sma, naive.sma(fixture, { period: 50 }).sma, 'rolling SMA = direct sum on the fixture');
}

// ── Sources (§1) ────────────────────────────────────────────────────────────
{
  const cs = [{ t: 0, o: 2, h: 8, l: 1, c: 5 }, { t: D, o: 4, h: 10, l: 2, c: 8 }];
  const at = src => I.get('sma').calculate(cs, { period: 2, source: src }).sma[1];
  // close (5+8)/2 = 6.5; open (2+4)/2 = 3; high (8+10)/2 = 9; low (1+2)/2 = 1.5;
  // hl2: (4.5 + 6)/2 = 5.25; ohlc4: ((2+8+1+5)/4 + (4+10+2+8)/4)/2 = (4 + 6)/2 = 5
  eq(['close', 'open', 'high', 'low', 'hl2', 'ohlc4'].map(at), [6.5, 3, 9, 1.5, 5.25, 5], 'SMA price sources');
  eq(I.get('ema').calculate(cs, { period: 2, source: 'high' }).ema[1], 9, 'EMA accepts a source');
}

// ── Hand-computed vectors (arithmetic in the comments) ──────────────────────
{
  // SMA(3) of 1..6: (1+2+3)/3 = 2, (2+3+4)/3 = 3, (3+4+5)/3 = 4, (4+5+6)/3 = 5
  eq(I.get('sma').calculate(fromCloses([1, 2, 3, 4, 5, 6]), { period: 3 }).sma, [null, null, 2, 3, 4, 5], 'hand: SMA(3)');

  // EMA(3), k = 2/(3+1) = 0.5, closes 2 4 6 8 4 10
  //   seed [2] = (2+4+6)/3 = 4
  //   [3] = 8·0.5 + 4·0.5 = 6;  [4] = 4·0.5 + 6·0.5 = 5;  [5] = 10·0.5 + 5·0.5 = 7.5
  eq(I.get('ema').calculate(fromCloses([2, 4, 6, 8, 4, 10]), { period: 3 }).ema, [null, null, 4, 6, 5, 7.5], 'hand: EMA(3)');

  // RSI(3), closes 10 11 10 12 13 12 12 → changes +1 −1 +2 +1 −1 0
  //   seed [3]: avgGain = (1+0+2)/3 = 1, avgLoss = (0+1+0)/3 = 1/3, RS = 3, RSI = 100 − 100/4 = 75
  //   [4] d=+1: avgGain = (1·2+1)/3 = 1, avgLoss = (1/3·2+0)/3 = 2/9, RS = 4.5, RSI = 100 − 100/5.5 = 900/11
  //   [5] d=−1: avgGain = (1·2+0)/3 = 2/3, avgLoss = (2/9·2+1)/3 = 13/27, RS = 18/13, RSI = 100 − 1300/31 = 1800/31
  //   [6] d=0:  avgGain = (2/3·2)/3 = 4/9, avgLoss = (13/27·2)/3 = 26/81, RS = 18/13 again → 1800/31
  seriesNear(I.get('rsi').calculate(fromCloses([10, 11, 10, 12, 13, 12, 12]), { period: 3 }).rsi,
    [null, null, null, 75, 900 / 11, 1800 / 31, 1800 / 31], 'hand: RSI(3)');

  // MACD(fast 2, slow 3, signal 2), closes 1 2 3 4 6 5 7
  //   EMA2 (k=2/3): [1] (1+2)/2 = 1.5; [2] 3·2/3 + 1.5/3 = 2.5; [3] 4·2/3 + 2.5/3 = 3.5;
  //                 [4] 6·2/3 + 3.5/3 = 31/6; [5] 5·2/3 + 31/18 = 91/18; [6] 7·2/3 + 91/54 = 343/54
  //   EMA3 (k=1/2): [2] (1+2+3)/3 = 2; [3] (4+2)/2 = 3; [4] (6+3)/2 = 4.5; [5] (5+4.5)/2 = 4.75; [6] (7+4.75)/2 = 5.875
  //   MACD: [2] 0.5; [3] 0.5; [4] 31/6 − 27/6 = 2/3; [5] 91/18 − 85.5/18 = 11/36; [6] 343/54 − 317.25/54 = 103/216
  //   Signal (k=2/3), seed [3] = (0.5+0.5)/2 = 0.5; [4] 2/3·2/3 + 0.5/3 = 11/18;
  //                 [5] 11/36·2/3 + 11/54 = 11/27; [6] 103/216·2/3 + 11/81 = 49/108
  //   Histogram: [3] 0; [4] 2/3 − 11/18 = 1/18; [5] 11/36 − 11/27 = −11/108; [6] 103/216 − 98/216 = 5/216
  const m = I.get('macd').calculate(fromCloses([1, 2, 3, 4, 6, 5, 7]), { fast: 2, slow: 3, signal: 2 });
  seriesNear(m.macd, [null, null, 0.5, 0.5, 2 / 3, 11 / 36, 103 / 216], 'hand: MACD line', 1e-15);
  seriesNear(m.signal, [null, null, null, 0.5, 11 / 18, 11 / 27, 49 / 108], 'hand: MACD signal', 1e-15);
  seriesNear(m.histogram, [null, null, null, 0, 1 / 18, -11 / 108, 5 / 216], 'hand: MACD histogram', 1e-15);

  // Bollinger(3, 2), closes 1 2 3 5
  //   [2] window 1 2 3: mid 2, σ = √((1+0+1)/3) = √(2/3); upper = 2 + 2√(2/3), lower = 2 − 2√(2/3)
  //       %B = (3 − lower)/(4√(2/3)) = (1 + 2√(2/3))/(4√(2/3)); bandWidth = 4√(2/3)/2 = 2√(2/3)
  //   [3] window 2 3 5: mid 10/3, deviations −4/3 −1/3 5/3, σ = √((16+1+25)/9/3) = √14/3
  const s1 = Math.sqrt(2 / 3), s2 = Math.sqrt(14) / 3;
  const b = I.get('bollinger').calculate(fromCloses([1, 2, 3, 5]), { period: 3, multiplier: 2 });
  seriesNear(b.middle, [null, null, 2, 10 / 3], 'hand: Bollinger middle');
  seriesNear(b.upper, [null, null, 2 + 2 * s1, 10 / 3 + 2 * s2], 'hand: Bollinger upper');
  seriesNear(b.lower, [null, null, 2 - 2 * s1, 10 / 3 - 2 * s2], 'hand: Bollinger lower');
  seriesNear(b.percentB, [null, null, (1 + 2 * s1) / (4 * s1), (5 - (10 / 3 - 2 * s2)) / (4 * s2)], 'hand: Bollinger %B');
  seriesNear(b.bandWidth, [null, null, 2 * s1, 4 * s2 / (10 / 3)], 'hand: Bollinger band width');

  // ATR(3) — (h, l, c) and true range against the previous close Cp:
  //   [0] 10 8 9    no TR
  //   [1] 11 9 10   max(2, |11−9|=2, |9−9|=0)     = 2
  //   [2] 13 10 12  max(3, |13−10|=3, |10−10|=0)  = 3
  //   [3] 12 11 11  max(1, |12−12|=0, |11−12|=1)  = 1    ATR = (2+3+1)/3 = 2
  //   [4] 15 12 14  max(3, |15−11|=4, |12−11|=1)  = 4    ATR = (2·2+4)/3 = 8/3       (gap up: |H−Cp| wins)
  //   [5] 14 9 10   max(5, |14−14|=0, |9−14|=5)   = 5    ATR = (8/3·2+5)/3 = 31/9
  //   [6] 11 10 10.5 max(1, |11−10|=1, |10−10|=0) = 1    ATR = (31/9·2+1)/3 = 71/27
  const hlc = [[10, 8, 9], [11, 9, 10], [13, 10, 12], [12, 11, 11], [15, 12, 14], [14, 9, 10], [11, 10, 10.5]];
  const atrIn = hlc.map(([h, l, c], i) => ({ t: i * D, o: l, h, l, c }));
  seriesNear(I.get('atr').calculate(atrIn, { period: 3 }).atr, [null, null, null, 2, 8 / 3, 31 / 9, 71 / 27], 'hand: ATR(3)');

  // Volatility(2) daily, closes 100 110 99: r1 = ln 1.1, r2 = ln 0.9.
  //   Two returns: sample variance = (r1 − r2)²/2 → s = |ln(1.1/0.9)|/√2; HV = s·√365
  const hv = I.get('volatility').calculate(fromCloses([100, 110, 99]), { period: 2 }, '1d').volatility;
  seriesNear(hv, [null, null, Math.log(1.1 / 0.9) / Math.SQRT2 * Math.sqrt(365)], 'hand: volatility(2)');
  throws(() => I.get('volatility').calculate(fromCloses([100, 110, 99]), { period: 2 }), 'volatility needs an interval');
}

// ── Published worked examples (StockCharts ChartSchool spreadsheets) ────────
{
  const pr = published.rsi14, pe = published.ema10, pb = published.bollinger20x2;
  seriesNear(I.get('rsi').calculate(fromCloses(pr.close), { period: 14 }).rsi, pr.rsi, `published: RSI(14) — ${pr.source}`);
  seriesNear(I.get('sma').calculate(fromCloses(pe.close), { period: 10 }).sma, pe.sma, `published: SMA(10) — ${pe.source}`);
  seriesNear(I.get('ema').calculate(fromCloses(pe.close), { period: 10 }).ema, pe.ema, `published: EMA(10) — ${pe.source}`);
  const b = I.get('bollinger').calculate(fromCloses(pb.close), { period: 20, multiplier: 2 });
  for (const k of ['upper', 'middle', 'lower']) seriesNear(b[k], pb[k], `published: Bollinger(20,2) ${k} — ${pb.source}`);
  ok(pr.rsi.findIndex(x => x !== null) === 14 && pe.ema.findIndex(x => x !== null) === 9, 'published examples have the documented warm-up');
}

// ── Structural checks ───────────────────────────────────────────────────────
{
  const cs = deepFreeze(randomCandles(300, 42));
  const before = JSON.stringify(cs);
  for (const [id, settings] of CASES) {
    const def = I.get(id), warm = def.warmup(settings);
    const out = def.calculate(cs, settings, '1d');
    eq(Object.keys(out), [...def.series], `${id} ${JSON.stringify(settings)}: series names`);
    eq(Object.keys(warm), [...def.series], `${id}: warm-up given per series`);
    for (const k of def.series) {
      const v = out[k];
      ok(v.length === cs.length, `${id} ${k}: length`);
      const lead = v.findIndex(x => x !== null);
      eq(lead, warm[k], `${id} ${JSON.stringify(settings)} ${k}: warm-up`);
      ok(v.slice(lead).every(x => x !== null), `${id} ${k}: no null after warm-up`);
      ok(v.every(x => x === null || (typeof x === 'number' && Number.isFinite(x))), `${id} ${k}: no NaN/Infinity`);
    }
    for (const n of [0, 1, Math.min(...Object.values(warm))]) {
      const short = def.calculate(cs.slice(0, n), settings, '1d');
      ok(def.series.every(k => short[k].length === n && short[k].every(x => x === null)), `${id}: ${n} candles → all null`);
    }
  }
  eq(JSON.stringify(cs), before, 'input unchanged (deep-frozen)');
  // Documented warm-ups (acceptance criterion 3)
  eq([I.get('sma').warmup().sma, I.get('ema').warmup().ema, I.get('rsi').warmup().rsi, I.get('atr').warmup().atr,
      I.get('volatility').warmup().volatility, I.get('bollinger').warmup().upper],
     [49, 20, 14, 14, 30, 19], 'default warm-ups: SMA N−1, EMA N−1, RSI N, ATR N, HV N, Bollinger N−1');
  eq(I.get('macd').warmup(), { macd: 25, signal: 33, histogram: 33 }, 'MACD warm-ups: slow−1, slow+signal−2');
}

// ── Causality: changing candles after i never changes outputs 0…i ───────────
{
  const base = randomCandles(400, 5);
  const rnd = prng(11);
  for (const [id, settings] of CASES) {
    const def = I.get(id), a = def.calculate(base, settings, '1d');
    for (let trial = 0; trial < 4; trial++) {
      const i = Math.floor(rnd() * base.length);
      const changed = base.map((x, j) => j <= i ? x : { ...x, o: x.o * 1.7, h: x.h * 2.1, l: x.l * 0.6, c: x.c * 1.3 });
      const b = def.calculate(changed, settings, '1d');
      if (!def.series.every(k => JSON.stringify(a[k].slice(0, i + 1)) === JSON.stringify(b[k].slice(0, i + 1)))) {
        fail++; console.error(`FAIL causality ${id} ${JSON.stringify(settings)} at ${i}`);
      } else pass++;
    }
  }
}

// ── Segmentation (§2) ───────────────────────────────────────────────────────
{
  const all = randomCandles(120, 8);
  const withGap = [...all.slice(0, 60), ...all.slice(63)];          // buckets 60–62 missing
  const sma = I.get('sma');
  const seg = I.calculateSegmented('sma', withGap, { period: 10 }, '1d').sma;
  eq(seg.length, withGap.length, 'segmented: same length');
  eq(seg.slice(60, 69).every(x => x === null) && seg[69] !== null, true, 'segmented: fresh warm-up after the gap');
  eq(seg, [...sma.calculate(withGap.slice(0, 60), { period: 10 }).sma, ...sma.calculate(withGap.slice(60), { period: 10 }).sma],
    'segmented: each side computed independently');
  ok(seg.slice(0, 60).every((x, i) => i < 9 ? x === null : x !== null), 'segmented: first segment unaffected');
  eq(I.calculateSegmented(sma, all, { period: 10 }, '1d').sma, sma.calculate(all, { period: 10 }).sma, 'segmented: gap-free input = plain calculate');

  const withPartial = all.map((x, i) => i === 80 ? { ...x, partial: true } : x);
  const p = I.calculateSegmented('rsi', withPartial, { period: 5 }, '1d').rsi;
  ok(p[79] !== null && p[80] === null && p.slice(81, 86).every(x => x === null) && p[86] !== null, 'segmented: partial candle is null and restarts the warm-up');

  const m = I.calculateSegmented('macd', withGap, { fast: 3, slow: 5, signal: 3 }, '1d');
  ok(m.macd[63] === null && m.macd[64] !== null && m.signal[65] === null && m.signal[66] !== null, 'segmented: MACD warm-ups per segment');
  const weeks = all.slice(0, 30).map((x, i) => ({ ...x, t: utc(2024, 1, 1) + i * 7 * D }));
  ok(I.calculateSegmented('sma', weeks, { period: 3 }, '1w').sma.slice(2).every(x => x !== null), 'segmented: weekly steps are not gaps');
  ok(I.calculateSegmented('sma', all.slice(0, 30), { period: 3 }, '1w').sma.every(x => x === null), 'segmented: daily steps on a weekly interval are all gaps');
  throws(() => I.calculateSegmented('sma', all, { period: 0 }, '1d'), 'segmented: settings validated');
}

// ── Dashboard compatibility: buildMovingAverageSeries (§6) ──────────────────
{
  const m = SRC.match(/function buildMovingAverageSeries\(allDays\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('could not extract buildMovingAverageSeries');
  const dashboard = new Function(`${m[0]}; return buildMovingAverageSeries;`)();
  const walk = (() => { const rnd = prng(2024); let p = 30000; return Array.from({ length: 2500 }, () => (p = Math.max(100, p * (1 + (rnd() - 0.5) * 0.08)))); })();
  for (const [label, closes] of [['fixture', fixture.map(x => x.c)], ['random walk 2500', walk], ['flat', new Array(300).fill(50000)]]) {
    const dash = dashboard(closes.map((c, i) => [`d${i}`, c]));
    const cs = fromCloses(closes);
    const rsi = I.get('rsi').calculate(cs, { period: 14 }).rsi;
    const s50 = I.get('sma').calculate(cs, { period: 50 }).sma, s200 = I.get('sma').calculate(cs, { period: 200 }).sma;
    const same = (mine, key, dp) => dash.every((pt, i) => mine[i] === null ? pt[key] === undefined : Number(mine[i].toFixed(dp)) === pt[key]);
    ok(same(rsi, 'rsi14', 1), `Dashboard RSI(14) equal at every index (${label})`);
    ok(same(s50, 'ma50d', 2), `Dashboard SMA(50) equal at every index (${label})`);
    ok(same(s200, 'ma200d', 2), `Dashboard SMA(200) equal at every index (${label})`);
  }
}

// ── RSI and divisor specifics ───────────────────────────────────────────────
{
  const rsi = cl => I.get('rsi').calculate(fromCloses(cl), { period: 14 }).rsi.slice(14);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i), down = up.map(x => 300 - x), flat = up.map(() => 100);
  ok(rsi(up).every(x => x === 100), 'RSI = 100 on a strictly rising series');
  ok(rsi(flat).every(x => x === 100), 'RSI = 100 on a flat series (avgLoss 0)');
  ok(rsi(down).every(x => x === 0), 'RSI = 0 on a strictly falling series');

  // Closes 100 110 121: one window of 2 returns, ln 1.1 twice → sample sd 0. Use 100 110 99 121
  // so population and sample differ: Bollinger(3) uses /3, volatility(3) uses /2.
  const cs = fromCloses([100, 110, 99, 121]);
  const w = [110, 99, 121], mid = sum(w) / 3, pop = Math.sqrt(sum(w.map(v => (v - mid) ** 2)) / 3), smp = Math.sqrt(sum(w.map(v => (v - mid) ** 2)) / 2);
  const bb = I.get('bollinger').calculate(cs, { period: 3, multiplier: 1 });
  ok(near(bb.upper[3] - mid, pop) && !near(bb.upper[3] - mid, smp), 'Bollinger uses the population deviation (divisor N)');
  const r = [Math.log(1.1), Math.log(0.9), Math.log(121 / 99)], rm = sum(r) / 3;
  const hv = I.get('volatility').calculate(cs, { period: 3 }, '1d').volatility[3] / Math.sqrt(365);
  ok(near(hv, Math.sqrt(sum(r.map(v => (v - rm) ** 2)) / 2)) && !near(hv, Math.sqrt(sum(r.map(v => (v - rm) ** 2)) / 3)), 'volatility uses the sample deviation (divisor N−1)');

  eq([I.annualizationFactor('1d'), I.annualizationFactor('1h')], [365, 8760], 'annualization: 1d 365, 1h 8760');
  ok(near(I.annualizationFactor('1w'), 365 / 7), 'annualization: 1w 52.142857…');
  const flatBands = I.get('bollinger').calculate(fromCloses(new Array(25).fill(50000)), {});
  ok(flatBands.percentB.every(x => x === null) && flatBands.bandWidth[19] === 0, 'Bollinger %B null when the bands coincide');
}

// ── Returns (§11) ───────────────────────────────────────────────────────────
{
  eq([I.returns.simple(100, 110), I.returns.log(100, 100)], [0.10000000000000009, 0], 'simple and log return');
  ok(near(I.returns.log(100, 110), Math.log(1.1)), 'log return');
  eq(I.returns.range([{ t: 0, o: 50, h: 70, l: 40, c: 60 }, { t: D, o: 60, h: 90, l: 55, c: 80 }]), 80 / 50 - 1, 'range return: last close / first open − 1');
  eq(I.returns.range([]), null, 'range return of nothing is null');

  // 800 daily candles from 2023-01-01, close = 100 + index; now is 01:00 on the day after the last.
  const t0 = utc(2023, 1, 1), n = 800;
  const daily = Array.from({ length: n }, (_, i) => ({ t: t0 + i * D, o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i }));
  const lastT = t0 + (n - 1) * D, now = lastT + D + 3600, P = 1000;
  eq(new Date(lastT * 1000).toISOString().slice(0, 10), '2025-03-10', 'returns fixture ends 2025-03-10');
  // `now` falls in day index n, so k days back lands at 01:00 on day n−k; the last daily candle
  // that had completed by then is index n−k−1.
  const ref = k => 100 + (n - k - 1);
  const r = I.returns.periods(daily, P, now);
  eq(r['1D'], P / ref(1) - 1, '1D return: close of the last candle completed 24 h ago');
  eq(r['7D'], P / ref(7) - 1, '7D return');
  eq(r['30D'], P / ref(30) - 1, '30D return');
  eq(r['90D'], P / ref(90) - 1, '90D return');
  eq(r['1Y'], P / ref(365) - 1, '1Y return (365 days)');
  eq(r['3Y'], null, '3Y return: reference before the earliest candle → null');
  eq(r['5Y'], null, '5Y return → null');
  // YTD: close of 2024-12-31 = index 730 (365 + 365 days after 2023-01-01).
  eq(r.YTD, P / (100 + 730) - 1, 'YTD return against 31 December of the previous year');
  const gapped = daily.filter((_, i) => i !== n - 31);
  eq(I.returns.periods(gapped, P, now)['30D'], null, '30D reference candle in a gap → null, no neighbour used');
  eq(I.returns.periods(gapped, P, now)['7D'], r['7D'], 'other periods unaffected by that gap');
  eq(I.returns.periods(daily, null, now)['1D'], null, 'no current price → null');
  // Exactly at a day boundary the candle that just closed counts.
  eq(I.returns.periods(daily, P, lastT + 2 * D)['1D'], P / (100 + n - 1) - 1, '1D at midnight: the candle that closed exactly 24 h ago');

  // Daily returns: closes 100 110 99 108.9 → +10 %, −10 %, +10 %; average 10/3 %, median 10 %.
  const dr = I.returns.daily(fromCloses([100, 110, 99, 108.9]));
  ok(near(dr.average, (0.1 - 0.1 + 0.1) / 3) && near(dr.median, 0.1) && dr.count === 3, 'average and median daily return');
  const even = I.returns.daily(fromCloses([100, 110, 99, 108.9, 98.01]));
  ok(near(even.median, 0, 1e-15), 'median of an even count is the mean of the middle two (−10 %, +10 %)');
  const skip = I.returns.daily([...fromCloses([100, 110]), { t: utc(2024, 1, 1) + 5 * D, o: 1, h: 1, l: 1, c: 1 }]);
  eq(skip.count, 1, 'a pair across a gap is not a daily return');
  eq(I.returns.daily([]), { average: null, median: null, count: 0 }, 'no daily returns → null');

  eq(I.extremes([{ t: 0, o: 5, h: 9, l: 4, c: 6 }, { t: D, o: 6, h: 12, l: 3, c: 7 }, { t: 2 * D, o: 7, h: 12, l: 5, c: 6 }]),
    { high: 12, highT: D, low: 3, lowT: D }, 'range high and low (first occurrence)');
  eq(I.extremes([]), null, 'extremes of nothing');
}

// ── Drawdown (§12) ──────────────────────────────────────────────────────────
{
  // closes 100 120 90 110 130 117 → peaks 100 120 120 120 130 130
  //   DD: 0, 0, 90/120−1 = −0.25, 110/120−1 = −1/12, 0, 117/130−1 = −0.1
  const cs = fromCloses([100, 120, 90, 110, 130, 117]);
  const d = I.drawdown(cs);
  seriesNear(d.series, [0, 0, -0.25, -1 / 12, 0, -0.1], 'drawdown series');
  eq([d.max.value, d.max.peakIndex, d.max.troughIndex, d.max.peakT, d.max.troughT], [-0.25, 1, 2, cs[1].t, cs[2].t], 'maximum drawdown with peak and trough');
  const rise = I.drawdown(fromCloses([1, 2, 3, 4]));
  ok(rise.series.every(x => x === 0) && rise.max.value === 0, 'monotonic rise → drawdown 0');
  eq(I.drawdown([]), { series: [], max: null }, 'drawdown of nothing');
}

// ── Previous ATH / high since (§12) ─────────────────────────────────────────
{
  const t0 = utc(2015, 1, 1);
  const highs = [10, 30, 20, 50, 40];
  const daily = highs.map((h, i) => ({ t: t0 + i * D, o: h - 1, h, l: h - 2, c: h - 1 }));
  const at = (T, opts = {}) => I.previousAth(daily, T, { seed: null, ...opts });
  eq(at(t0 + 3 * D + 12 * 3600), { price: 30, t: t0 + D, fromSeed: false }, 'transaction day\'s own candle is excluded (noon on day 3 → 30)');
  eq(at(t0 + 4 * D).price, 50, 'a candle that closed exactly at T counts');
  eq(at(t0 + 12 * 3600), null, 'nothing closed before T → null');
  const iso = s => new Date(s * 1000).toISOString().slice(0, 10);
  const seed = { price: 40, date: iso(t0 - 10 * D), source: 'test seed passed as an argument' };
  eq(at(t0 + D + 3600, { seed, earliestSec: t0 }), { price: 40, t: t0 - 10 * D, fromSeed: true }, 'seed applied before it is exceeded');
  eq(at(t0 + 4 * D + 3600, { seed, earliestSec: t0 }), { price: 50, t: t0 + 3 * D, fromSeed: false }, 'seed ignored once a candle high exceeds it');
  eq(at(t0 + 4 * D + 3600, { seed: { ...seed, price: 60 }, earliestSec: t0 }).price, 60, 'a seed above every candle stays');
  eq(at(t0 + D + 3600, { seed: { ...seed, date: iso(t0) }, earliestSec: t0 }).price, 10, 'seed ignored when the provider covers its date');
  eq(at(t0 + D + 3600, { seed, earliestSec: t0 - 20 * D }).price, 10, 'seed ignored when the provider\'s earliest candle precedes it');
  eq(at(t0 - 10 * D + 3600, { seed, earliestSec: t0 }), null, 'seed not used before its own day has ended');
  eq(at(t0 + D + 3600, { seed }).price, 40, 'earliestSec unknown → the first candle given stands in');
  throws(() => at(t0 + D, { seed: { price: -1, date: '2014-01-01' } }), 'invalid seed rejected');
  throws(() => at(t0 + D, { seed: { price: 1, date: '01/01/2014' } }), 'seed date must be YYYY-MM-DD');
  eq(I.previousAth(fixture, fixture[fixture.length - 1].t + D, { seed: null }).price, Math.max(...fixture.map(x => x.h)), 'fixture: max high over all closed candles');

  // The recorded seed (Bitstamp 1163.00 on 2013-11-30) as the default, against Coinbase-like
  // history from 2015-07-20.
  const e = utc(2015, 7, 20);
  const cb = [280, 300, 1200, 900].map((h, i) => ({ t: e + i * D, o: h - 1, h, l: h - 2, c: h - 1 }));
  eq(I.previousAth(cb, e + 12 * 3600, { earliestSec: e }), { price: 1163, t: utc(2013, 11, 30), fromSeed: true },
    'default seed: before any provider candle closed, the high known is the 2013 seed');
  eq(I.previousAth(cb, e + 2 * D + 3600, { earliestSec: e }).price, 1163, 'seed stands while provider highs are below it');
  eq(I.previousAth(cb, e + 3 * D + 3600, { earliestSec: e }), { price: 1200, t: e + 2 * D, fromSeed: false }, 'seed ignored once a provider high exceeds 1163');
  eq(I.previousAth(cb, utc(2013, 11, 30, 18), { earliestSec: e }), null, 'seed not used on its own day (look-ahead)');
  eq(I.previousAth(cb, utc(2013, 12, 1), { earliestSec: e }).price, 1163, 'seed used from the end of its day');
  eq(I.previousAth(cb, e + 2 * D + 3600, { earliestSec: utc(2013, 1, 1) }).price, 300, 'seed ignored if the provider history covered 2013-11-30');
}

// ── athLabels (§12, decision D18) ───────────────────────────────────────────
{
  const e = utc(2015, 7, 20);
  eq(I.athLabels({ seedVerified: false, earliestSec: e }), {
    loading: false, summaryHigh: 'High since 07/20/2015', summaryDistance: 'Drawdown from High since 07/20/2015',
    summaryDrawdown: 'Drawdown from High since 07/20/2015', contextHigh: 'High since 07/20/2015', contextDrawdown: 'Drawdown from High since 07/20/2015',
  }, 'no verified seed → "High since <date>" wording');
  const unseeded = JSON.stringify(I.athLabels({ earliestSec: e }));
  ok(!/All-Time|ATH/.test(unseeded), 'no all-time-high wording without a verified seed');
  eq(I.athLabels({ earliestSec: null }).loading, true, 'earliest date unknown → loading state');
  ok(Object.entries(I.athLabels({})).every(([k, v]) => k === 'loading' || v === null), 'loading state carries no date');
  eq(I.athLabels({ seedVerified: true, earliestSec: null }), {
    loading: false, summaryHigh: 'All-Time High', summaryDistance: 'Distance from ATH', summaryDrawdown: 'Current Drawdown',
    contextHigh: 'Previous ATH', contextDrawdown: 'Drawdown from Previous ATH',
  }, 'verified seed → all-time-high wording');
  eq(I.athLabels({ seedVerified: 'yes', earliestSec: e }).summaryHigh, 'High since 07/20/2015', 'only seedVerified === true counts');
}

// ── weeklySma (the 200-week moving average on any interval) ─────────────────
{
  const t0 = utc(2020, 1, 6); // a Monday, so weeks start on day 0, 7, 14…
  eq(C.bucketStart(t0 + 3 * D, '1w'), t0, 'weeks start on Monday (UTC)');
  const daily = deepFreeze(randomCandles(1600, 11, t0));
  const weekly = C.aggregate(daily, '1w', '1d');
  // On weekly candles it is exactly the weekly SMA.
  seriesNear(I.weeklySma(daily, weekly, 200), I.calculateSegmented('sma', weekly, { period: 200 }, '1w').sma, 'weekly candles: equals SMA 200 of weekly closes');
  seriesNear(I.weeklySma(daily, weekly, 3), I.calculateSegmented('sma', weekly, { period: 3 }, '1w').sma, 'weekly candles, period 3');
  // On daily candles: the 199 weeks before plus the candle's own close (oracle from the formula).
  const weekClose = new Map(weekly.map(w => [w.t, w.c]));
  const oracle = daily.map(c => {
    const w = C.bucketStart(c.t, '1w'), prev = [];
    for (let k = 199; k >= 1; k--) { const x = weekClose.get(w - k * 7 * D); if (x === undefined) return null; prev.push(x); }
    return (sum(prev) + c.c) / 200;
  });
  const onDaily = I.weeklySma(daily, daily, 200);
  seriesNear(onDaily, oracle, 'daily candles: 199 earlier weekly closes + the candle\'s close');
  eq(onDaily.findIndex(v => v !== null), 199 * 7, 'first value on the Monday of week 200');
  // Causal: later days never change an earlier value.
  seriesNear(I.weeklySma(daily.slice(0, 1500), daily.slice(0, 1500), 200), onDaily.slice(0, 1500), 'later history does not change earlier values');
  // Hand-computed, period 2: weekly closes 10 (week 0 Sunday), then a mid-week candle closing 30.
  const tiny = [{ t: t0 + 6 * D, o: 10, h: 10, l: 10, c: 10 }];
  eq(I.weeklySma(tiny, [{ t: t0 + 9 * D + 3600, c: 30 }], 2), [20], '(10 + 30) / 2 = 20');
  eq(I.weeklySma([{ t: t0 + 5 * D, o: 10, h: 10, l: 10, c: 10 }], [{ t: t0 + 9 * D, c: 30 }], 2), [null], 'a week without its Sunday close does not count');
  eq(I.weeklySma(tiny, [{ t: t0 + 9 * D, c: 30, partial: true }, null, { t: t0 + 9 * D }], 2), [null, null, null], 'partial or malformed candles → null');
  // A missing Sunday breaks the run: values needing that week are null, later ones recover.
  const gap = daily.filter(c => c.t !== t0 + (5 * 7 + 6) * D);
  const g = I.weeklySma(gap, daily, 200);
  eq(g.slice(0, 205 * 7).every(v => v === null), true, 'every value whose 199 weeks include the gap is null');
  ok(g[205 * 7] !== null && near(g[205 * 7], onDaily[205 * 7]), 'values resume once 199 unbroken weeks follow the gap');
  eq(I.weeklySma([], daily.slice(0, 3), 200), [null, null, null], 'no daily history → null');
  eq(I.weeklySma(null, null, 200), [], 'non-arrays are empty');
  for (const bad of [1, 1001, 2.5, '200', null]) throws(() => I.weeklySma(daily, daily, bad), `period ${bad} throws`);
  const before = JSON.stringify(daily); I.weeklySma(daily, daily, 200); eq(JSON.stringify(daily), before, 'input not mutated');
}

console.log(`market-indicators: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
