// Market preferences and URL state (docs/market-implementation-plan.md Phase 5):
// normalizeMarketPrefs, parseMarketHash and formatMarketHash from app.dev.html's helper region.
// Any input — a hand-edited backup, a Drive file, a hostile URL — must give valid preferences
// without throwing, and a formatted hash must read back to the same preferences.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppHelpers } from '../lib/app-helpers.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const { normalizeMarketPrefs: norm, parseMarketHash: parse, formatMarketHash: format, Indicators: I } =
  loadAppHelpers(['normalizeMarketPrefs', 'parseMarketHash', 'formatMarketHash', 'Indicators']);

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`); }
};
const ok = (c, name) => eq(!!c, true, name);
const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const clone = o => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  range: '1Y', intervals: {}, scale: 'linear', volume: true,
  indicators: {
    sma: { periods: [], source: 'close' }, ema: { periods: [], source: 'close' },
    bollinger: { on: false, period: 20, multiplier: 2 }, rsi: { on: false, period: 14 },
    macd: { on: false, fast: 12, slow: 26, signal: 9 }, atr: { on: false, period: 14 }, volatility: { on: false, period: 30 },
  },
};

// ── Scope ────────────────────────────────────────────────────────────────────
{
  const src = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');
  const a = src.indexOf('// ─── Market: Preferences');
  ok(a > 0 && a < src.indexOf('// ─── SVG Icons'), 'Market: Preferences is inside the helper region');
  const section = src.slice(a, src.indexOf('\n// ─── ', a + 1));
  const names = [...section.matchAll(/^(?:const|let|var|function|class)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)/gm)].map(m => m[1].replace(/\s+/g, ' '));
  eq(names, ['{ normalizeMarketPrefs, parseMarketHash, formatMarketHash }'], 'the section declares only its three functions at top level');
  const code = section.replace(/^\s*\/\/.*$/gm, '');
  eq(code.match(/\btransactions?\b|\btxs?\b|btc-tx|localStorage|sessionStorage|wallets?\b/gi), null,
    'preferences code references no transactions, wallets or storage');
}

// ── normalizeMarketPrefs ─────────────────────────────────────────────────────
{
  eq(norm(undefined), DEFAULTS, 'undefined → defaults');
  for (const bad of [null, 5, 'x', [], true, () => 1]) eq(norm(bad), DEFAULTS, `non-object ${typeof bad} → defaults`);
  eq(norm({}), DEFAULTS, 'empty object → defaults');

  const good = {
    range: '3M', intervals: { '3M': '1h', '1Y': '1w' }, scale: 'log', volume: false,
    indicators: {
      sma: { periods: [200, 50], source: 'hl2' }, ema: { periods: [21], source: 'close' },
      bollinger: { on: true, period: 10, multiplier: 2.5 }, rsi: { on: true, period: 9 },
      macd: { on: true, fast: 5, slow: 35, signal: 5 }, atr: { on: false, period: 7 }, volatility: { on: true, period: 90 },
    },
  };
  const n = norm(deepFreeze(clone(good)));
  eq(n.indicators.sma.periods, [50, 200], 'periods sorted ascending');
  eq({ ...n, indicators: { ...n.indicators, sma: { ...n.indicators.sma, periods: [200, 50] } } }, good, 'valid preferences are kept as they are');
  eq(norm(n), n, 'normalizing twice changes nothing');
  const frozen = deepFreeze(clone(good));
  norm(frozen);
  eq(frozen, good, 'input is not mutated');

  const hostile = norm({
    range: '2Y', intervals: { '1M': '2h', '1D': 5, 'ALL': '1w', bogus: '1h', '1Y': '1d' }, scale: 'cubic', volume: 'yes',
    indicators: {
      sma: { periods: ['50', 1, 50.5, 2000, 50, 50, NaN, null, {}, 20], source: 'bogus' },
      ema: { periods: 'all' }, bollinger: { on: 'true', period: 20, multiplier: 0 },
      rsi: { on: true, period: 1 }, macd: { on: true, fast: 30, slow: 26, signal: 9 },
      atr: [], volatility: { on: 1, period: 30 },
    },
  });
  eq(hostile, {
    ...DEFAULTS,
    indicators: { ...DEFAULTS.indicators, sma: { periods: [20, 50], source: 'close' }, rsi: { on: true, period: 14 }, macd: { on: true, fast: 12, slow: 26, signal: 9 } },
  }, 'wrong-typed and out-of-range values are dropped: range, intervals (and the default 1d / 1w entries), scale, volume, periods, source; bad settings fall back to that indicator\'s defaults; only on === true turns one on');
  eq(norm({ indicators: { sma: { periods: [2, 3, 4, 5, 6, 7, 8, 9] } } }).indicators.sma.periods, [2, 3, 4, 5, 6, 7], 'at most six lines');
  eq(norm(JSON.parse('{"__proto__":{"range":"ALL"},"indicators":{"__proto__":{"rsi":{"on":true}}}}')), DEFAULTS, '__proto__ keys are ignored');
  eq(norm({ indicators: { rsi: { on: true, period: 14, overbought: 'x', extra: 1 } } }).indicators.rsi, { on: true, period: 14 }, 'unknown indicator keys are dropped');
}

// ── formatMarketHash / parseMarketHash ───────────────────────────────────────
const SPEC = '#market?range=1y&interval=1d&scale=log&sma=50,200&ema=21&rsi=14&macd=12,26,9&bb=20,2&atr=14&hv=30&vol=1';
{
  const p = parse(SPEC);
  eq(p, {
    ...DEFAULTS, scale: 'log',
    indicators: {
      sma: { periods: [50, 200], source: 'close' }, ema: { periods: [21], source: 'close' },
      bollinger: { on: true, period: 20, multiplier: 2 }, rsi: { on: true, period: 14 },
      macd: { on: true, fast: 12, slow: 26, signal: 9 }, atr: { on: true, period: 14 }, volatility: { on: true, period: 30 },
    },
  }, 'the documented example parses to every indicator on');
  eq(format(p, '1d'), SPEC, 'and formats back to exactly the documented string');
  eq(format(p), SPEC, 'without an interval, the range default is written');
  eq(parse(SPEC.slice(1)), p, 'leading # is optional');
  eq(parse('?' + SPEC.split('?')[1]), p, 'so is the tab name');
  eq(format(DEFAULTS), '#market?range=1y&interval=1d&scale=linear&vol=1', 'defaults format to the short form');

  // round trips
  const cases = [
    DEFAULTS,
    { ...DEFAULTS, range: 'ALL', intervals: { ALL: '1d' }, volume: false },
    { ...DEFAULTS, range: '1D', intervals: { '1D': '1m' }, indicators: { ...DEFAULTS.indicators, bollinger: { on: true, period: 50, multiplier: 2.25 } } },
    { ...DEFAULTS, range: 'YTD', indicators: { ...DEFAULTS.indicators, ema: { periods: [5, 9, 12, 21, 50, 200], source: 'close' }, macd: { on: true, fast: 3, slow: 10, signal: 16 } } },
  ];
  for (const c of cases) eq(parse(format(c)), norm(c), `round trip: ${format(c)}`);

  // the interval belongs to the range in the same hash; the range default is not stored
  eq(parse('#market?range=1m&interval=1h').intervals, { '1M': '1h' }, 'interval recorded for the hash\'s range');
  eq(parse('#market?range=1m&interval=4h', { intervals: { '1M': '1h' } }).intervals, {}, 'choosing the range default clears the stored choice');
  eq(parse('#market?range=ytd').range, 'YTD', 'range is case-insensitive');
  eq(parse('#market?interval=1M').intervals, {}, 'interval is case-sensitive (1M is a range, not an interval)');
}
{
  // overrides: each parameter on its own; the indicator parameters as one group
  const stored = norm({ range: '3Y', scale: 'log', volume: false,
    indicators: { rsi: { on: true, period: 9 }, sma: { periods: [20] }, macd: { on: false, fast: 5, slow: 35, signal: 5 } } });
  const r = parse('#market?range=1m', stored);
  eq([r.range, r.scale, r.volume, r.indicators], ['1M', 'log', false, stored.indicators], 'only the given parameter overrides; stored indicators stand');
  const s = parse('#market?macd=12,26,9', stored);
  eq(s.indicators.macd, { on: true, fast: 12, slow: 26, signal: 9 }, 'an indicator in the URL is on with its settings');
  eq([s.indicators.rsi, s.indicators.sma.periods], [{ on: false, period: 9 }, []], 'one left out of the group is off, its settings kept');
  eq(parse('#market?rsi=abc', stored), stored, 'an invalid indicator value alone does not start the group');
  eq(parse('#market?vol=1&scale=linear', stored).volume, true, 'vol=1');
}
{
  // hostile input → the base, untouched
  const base = norm({ range: '5Y', indicators: { ema: { periods: [12] } } });
  const frozenBase = deepFreeze(clone(base));
  for (const h of [
    '#market?' + 'sma=50&'.repeat(400),
    '#market?range=2Y&interval=2h&scale=cubic&vol=yes&foo=bar',
    '#market?sma=abc&ema=1&rsi=-1&macd=26,12,9&bb=20,x&atr=1001&hv=1.5',
    '#market?sma=50,,200&ema=21,&macd=12,26&bb=20,2,3&rsi=14,14',
    '#market?sma=2,3,4,5,6,7,8', '#market?bb=20,11', '#market?bb=20,0', '#market?rsi=%31%34%00',
    '#market?constructor=1&__proto__=x&toString=y', '#market?range=constructor', '#market?interval=__proto__',
    '#dashboard?range=1m', '#market', '', '#market?', '#market?&&&==&', '%E0%A4%A',
    null, undefined, 42, {}, [],
  ]) eq(parse(h, frozenBase), base, `hostile hash leaves the base: ${String(h).slice(0, 60)}`);
  eq(parse('#market?' + 'x'.repeat(2000) + '&range=1m', base), base, 'over-long hash is ignored entirely');
  eq(parse('#market?range=1m&sma=abc', base).range, '1M', 'valid parameters survive invalid neighbours');
  eq(parse('#market?range=1m', { garbage: true, range: 'nope' }), { ...DEFAULTS, range: '1M' }, 'a malformed base is normalized first');
}
{
  // formatMarketHash: never personal data; total over junk
  eq(format(null), format(DEFAULTS), 'format(null) is the default hash');
  eq(format({ range: '1Y', note: 'secret wallet', amount: 1.5 }), format(DEFAULTS), 'unknown keys never reach the URL');
  eq(format(DEFAULTS, 'bogus'), format(DEFAULTS), 'an unknown interval argument is ignored');
  ok(/^#market\?range=[a-z0-9]+&interval=\w+&scale=(linear|log)(&(sma|ema|rsi|macd|bb|atr|hv)=[\d.,]+)*&vol=[01]$/.test(format(parse(SPEC))), 'hash grammar');
  // every setting the URL accepts is one Indicators accepts
  const p = parse('#market?sma=2,1000&bb=2,10&macd=2,3,2');
  eq([p.indicators.sma.periods, p.indicators.bollinger.multiplier, p.indicators.macd.slow], [[2, 1000], 10, 3], 'boundary values accepted');
  ok([I.PERIOD_MIN, I.PERIOD_MAX].join() === '2,1000', 'bounds come from Indicators');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
