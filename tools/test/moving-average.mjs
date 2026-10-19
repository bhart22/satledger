// Extracts the rolling-sum buildMovingAverageSeries from app.dev.html and compares it against a
// verbatim copy of the original naive implementation, which is kept here as the oracle.
// If you ever change the MA maths, this is what proves you didn't change the numbers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/harness.mjs';
const html = readFileSync(join(REPO_ROOT, 'app.dev.html'), 'utf8');
const m = html.match(/function buildMovingAverageSeries\(allDays\) \{[\s\S]*?\n\}/);
if(!m) throw new Error('could not extract buildMovingAverageSeries');
const rolling = new Function(`${m[0]}; return buildMovingAverageSeries;`)();

// The ORIGINAL implementation, kept verbatim as the oracle.
function naive(allDays) {
  if(!allDays.length) return [];
  const result = []; let avgGain = 0, avgLoss = 0;
  for(let i = 0; i < allDays.length; i++) {
    const [date, price] = allDays[i];
    const pt = { date, price };
    if(i >= 49)   { let s=0; for(let j=i-49;   j<=i;j++) s+=allDays[j][1]; pt.ma50d  = +(s/50).toFixed(2); }
    if(i >= 199)  { let s=0; for(let j=i-199;  j<=i;j++) s+=allDays[j][1]; pt.ma200d = +(s/200).toFixed(2); }
    if(i >= 1399) { let s=0; for(let j=i-1399; j<=i;j++) s+=allDays[j][1]; pt.ma200w = +(s/1400).toFixed(2); }
    if(i === 14) {
      let g=0,l=0; for(let j=1;j<=14;j++){const d=allDays[j][1]-allDays[j-1][1]; if(d>=0)g+=d; else l+=Math.abs(d);}
      avgGain=g/14; avgLoss=l/14;
      const rs = avgLoss===0?Infinity:avgGain/avgLoss; pt.rsi14 = +(100-(100/(1+rs))).toFixed(1);
    } else if(i > 14) {
      const d=allDays[i][1]-allDays[i-1][1]; const gain=Math.max(d,0), loss=Math.max(-d,0);
      avgGain=((avgGain*13)+gain)/14; avgLoss=((avgLoss*13)+loss)/14;
      const rs = avgLoss===0?Infinity:avgGain/avgLoss; pt.rsi14 = +(100-(100/(1+rs))).toFixed(1);
    }
    result.push(pt);
  }
  return result;
}

// Deterministic PRNG so failures are reproducible
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let pass=0, fail=0, maxDiff=0;
const scenarios = [
  ['empty', 0], ['single', 1], ['below 50', 30], ['exactly 50', 50], ['exactly 200', 200],
  ['exactly 1400', 1400], ['1401 days', 1401], ['realistic 4200 days', 4200], ['flat prices', 1500],
];
for (const [name, n] of scenarios) {
  const days = [];
  let price = 30000;
  for (let i = 0; i < n; i++) {
    price = name === 'flat prices' ? 50000 : Math.max(100, price * (1 + (rnd() - 0.5) * 0.08));
    days.push([`day${i}`, price]);
  }
  const a = rolling(days), b = naive(days);
  let ok = a.length === b.length;
  for (let i = 0; ok && i < a.length; i++) {
    for (const k of ['ma50d','ma200d','ma200w','rsi14']) {
      const x = a[i][k], y = b[i][k];
      if ((x === undefined) !== (y === undefined)) { ok = false; console.error(`  ${name}[${i}].${k}: presence mismatch ${x} vs ${y}`); break; }
      if (x !== undefined) { const d = Math.abs(x - y); maxDiff = Math.max(maxDiff, d); if (d > 0.01) { ok = false; console.error(`  ${name}[${i}].${k}: ${x} vs ${y} (diff ${d})`); break; } }
    }
  }
  if (ok) { pass++; console.log(`  ok  ${name} (${n} days)`); } else { fail++; console.log(`  FAIL ${name}`); }
}
console.log(`\nmax numeric drift vs naive oracle: ${maxDiff}`);
console.log(`${pass} passed, ${fail} failed`);

// Timing sanity on a realistic series
const big = []; let p = 30000;
for (let i = 0; i < 4200; i++) { p = Math.max(100, p * (1 + (rnd() - 0.5) * 0.08)); big.push([`d${i}`, p]); }
const t = (f) => { const s = process.hrtime.bigint(); for (let k = 0; k < 20; k++) f(big); return Number(process.hrtime.bigint() - s) / 20 / 1e6; };
console.log(`naive:   ${t(naive).toFixed(2)} ms/call`);
console.log(`rolling: ${t(rolling).toFixed(2)} ms/call`);
process.exit(fail ? 1 : 0);
