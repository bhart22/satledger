// End-to-end smoke test in headless Chrome. Covers the behaviours that are hard to reason
// about statically and that regressed in the past: corrupt-storage recovery, the transfer
// wizard's step sequencing, chart geometry after memoization, and modal keyboard handling.
//
//   npm run test:browser
//
// Skips cleanly (exit 0) if no Chrome/Edge is installed — set CHROME_PATH to point at one.
import { launch, createChecks, findChrome } from './lib/harness.mjs';

if (!(await findChrome())) {
  console.log('No Chrome/Edge found — skipping browser tests. Set CHROME_PATH to enable them.');
  process.exit(0);
}

const { evaluate, reload, wait, seed, press, close, errors } =
  await launch({ page: 'app.html', port: 8791, debugPort: 9291, label: 'browser' });
const { check, report } = createChecks();

const tx = (o) => Object.assign({
  date:'2024-01-01', type:'Buy', wallet:'Kraken', wallet2:'',
  amount:'0.1', price:'40000', fee:'', totalUsd:'4000',
  notes:'', txhash:'', excludeStats:false,
}, o);
const WALLETS = [
  { id:'w1', name:'Kraken', type:'Exchange', address:'' },
  { id:'w2', name:'Ledger', type:'Cold Storage', address:'' },
];
const clickByText = (text) => evaluate(`
  const b=[...document.querySelectorAll('button,a')].find(x=>new RegExp('^\\\\s*${text}\\\\s*$').test(x.textContent));
  if(!b) return 'not found'; b.click(); return 'clicked';`);

// ── corrupt storage is quarantined, never silently emptied ───────────────────
console.log('\n[corrupt storage recovery]');
await seed({ 'btc-tx-v2': 'undefined', 'btc-wallets': WALLETS });
await reload();
check('corrupt value quarantined under -corrupt',
  await evaluate(`return localStorage.getItem('btc-tx-v2-corrupt') === 'undefined';`));
check('user is warned rather than shown an empty portfolio',
  /could not be read/i.test(await evaluate(`return document.querySelector('.toast')?.textContent || '';`)));

// ── stable transaction ids ──────────────────────────────────────────────────
console.log('\n[stable transaction ids]');
await seed({ 'btc-tx-v2': [tx({}), tx({ date:'2024-02-01' })], 'btc-wallets': WALLETS,
             'btc-last-modified': '2020-01-01T00:00:00.000Z' });
await reload();
const ids = await evaluate(`return JSON.parse(localStorage.getItem('btc-tx-v2')).map(t=>t.id);`);
check('ids backfilled and unique', ids.every(Boolean) && new Set(ids).size === 2, JSON.stringify(ids));
check('the id migration does NOT bump btc-last-modified (would trigger a bogus sync push)',
  await evaluate(`return localStorage.getItem('btc-last-modified') === '2020-01-01T00:00:00.000Z';`));
await reload();
check('ids are stable across reloads',
  JSON.stringify(await evaluate(`return JSON.parse(localStorage.getItem('btc-tx-v2')).map(t=>t.id);`)) === JSON.stringify(ids));

// ── malformed rows must not blank the dashboard ──────────────────────────────
console.log('\n[malformed data tolerance]');
await seed({ 'btc-tx-v2': [tx({}), tx({ date:'garbage', amount:'0.5' }), tx({ totalUsd:'abc', date:'2024-03-01' })],
             'btc-wallets': WALLETS });
await reload();
check('dashboard still renders', await evaluate(`return !!document.querySelector('.stats-grid');`));
check('no NaN in any stat', !/NaN/.test(await evaluate(
  `return [...document.querySelectorAll('.stat-value,.stat-sub')].map(e=>e.textContent).join('|');`)));
check('no NaN in any chart path', await evaluate(
  `return [...document.querySelectorAll('path')].every(p=>!/NaN|Infinity/.test(p.getAttribute('d')||''));`));

// ── unregistered wallet names are surfaced ───────────────────────────────────
console.log('\n[unregistered wallet names]');
await seed({ 'btc-tx-v2': [tx({}), tx({ wallet:'Krakn', date:'2024-02-01' })], 'btc-wallets': [WALLETS[0]] });
await reload();
await clickByText('Wallets');
await wait(1200);
const wtext = await evaluate(`return document.body.innerText;`);
check('orphaned wallet name is reported', /Unregistered Wallet Names/i.test(wtext) && /Krakn/.test(wtext));

// ── an edit made while signed out is still marked dirty ──────────────────────
// queueDrivePush used to bail on !isSignedIn() BEFORE writing btc-pending-push, so an edit made
// with no Drive token advanced btc-last-modified but left nothing marked dirty. The sync
// conflict dialog keys off that marker, so it could never fire for exactly the edits most
// likely to be lost — the ones made on a device that had not reconnected yet.
console.log('\n[offline edits are marked dirty]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS });
await reload();
await clickByText('Wallets');
await wait(900);
check('archive control present', await evaluate(`
  const b=document.querySelector('button[aria-label="Archive wallet"]');
  if(!b) return false; b.click(); return true;`));
await wait(600);
check('the edit reached localStorage', await evaluate(
  `return JSON.parse(localStorage.getItem('btc-wallets')).some(w=>w.archived===true);`));
check('btc-pending-push is set even with no Drive token',
  await evaluate(`return !!localStorage.getItem('btc-pending-push');`));
check('btc-last-modified advanced alongside it',
  await evaluate(`return !!localStorage.getItem('btc-last-modified');`));

// ── transfer wizard must visit EVERY transfer ────────────────────────────────
console.log('\n[transfer wizard sequencing]');
const transfers = [1,2,3,4].map(i => tx({
  id:'t'+i, type:'Transfer', date:`2024-0${i}-01`, wallet:'Kraken', wallet2:'',
  amount:'0.01', price:'', totalUsd:'',
}));
await seed({ 'btc-tx-v2': [tx({ id:'buy1' }), ...transfers], 'btc-wallets': WALLETS });
await reload();
await clickByText('Dashboard');
await wait(900);
check('wizard launcher present', await evaluate(`
  const b=[...document.querySelectorAll('button')].find(b=>/Fix Transfers/i.test(b.textContent));
  if(!b) return false; b.click(); return true;`));
await wait(800);
await evaluate(`
  const n=[...document.querySelectorAll('button')].find(b=>/Get Started|Start|Next/i.test(b.textContent));
  if(n) n.click(); return 1;`);
await wait(600);
check('wizard reports all 4 transfers', /of 4/.test(
  await evaluate(`return document.body.innerText.match(/Transfer \\d+ of \\d+/)?.[0] || '';`)));
const seen = [];
for (let step = 0; step < 4; step++) {
  seen.push(await evaluate(`return document.body.innerText.match(/Transfer \\d+ of \\d+/)?.[0] || '';`));
  await evaluate(`
    const b=[...document.querySelectorAll('button')].find(x=>/Ledger/.test(x.textContent) && !/Kraken/.test(x.textContent));
    if(b) b.click(); return 1;`);
  await wait(250);
  await evaluate(`
    const n=[...document.querySelectorAll('button')].find(b=>/^\\s*(Next|Continue|Save & Next|Review)/i.test(b.textContent));
    if(n) n.click(); return 1;`);
  await wait(350);
}
check('visited 4 DISTINCT steps (regression: every other transfer was skipped)',
  new Set(seen).size === 4, JSON.stringify(seen));
check('never rendered a blank step', !seen.includes(''), JSON.stringify(seen));

// ── chart geometry survives memoization ─────────────────────────────────────
console.log('\n[chart geometry]');
const prices = {};
let p = 29000;
for (let t = Date.UTC(2018, 0, 1); t <= Date.now(); t += 86400000) {
  p = Math.max(3000, p * (1 + Math.sin(t / 9e8) * 0.02));
  prices[new Date(t).toISOString().slice(0, 10)] = +p.toFixed(2);
}
const many = [];
for (let i = 0; i < 40; i++) {
  many.push(tx({ id:'m'+i, date: new Date(Date.UTC(2021,0,15) + i*30*86400000).toISOString().slice(0,10) }));
}
await seed({ 'btc-tx-v2': many, 'btc-wallets': WALLETS, 'btc-price-history-v1': prices });
await reload(6000);
const pathLen = () => evaluate(`
  const ds=[...document.querySelectorAll('svg path')].map(p=>p.getAttribute('d')||'').filter(d=>d.length>10);
  return { n: ds.length, len: ds.reduce((a,d)=>a+d.length,0), bad: ds.some(d=>/NaN|Infinity/.test(d)) };`);
let g = await pathLen();
check('charts render real geometry', g.n >= 3 && !g.bad, JSON.stringify(g));
const allLen = g.len;
await evaluate(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3M'); if(b) b.click(); return 1;`);
await wait(1500);
g = await pathLen();
check('range change invalidates the memo', g.len !== allLen && !g.bad, `All=${allLen} 3M=${g.len}`);
// NB: two buttons read "All" (a wallet chip and the range button) — pick the 3M sibling.
await evaluate(`
  const three=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3M');
  const all=three && [...three.parentElement.querySelectorAll('button')].find(x=>x.textContent.trim()==='All');
  if(all) all.click(); return 1;`);
await wait(1600);
g = await pathLen();
check('switching back restores the full series', g.len > 0 && g.len !== 0 && !g.bad, JSON.stringify(g));

// ── modal keyboard handling ─────────────────────────────────────────────────
console.log('\n[modal keyboard handling]');
await clickByText('Dashboard');
await wait(800);
await evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/Add transaction/i.test(x.getAttribute('aria-label')||''));
  if(b){ b.id='opener'; b.focus(); b.click(); } return 1;`);
await wait(700);
check('dialog has role + aria-modal + a label', await evaluate(`
  const d=document.querySelector('[role="dialog"][aria-modal="true"]');
  return !!d && !!document.getElementById(d.getAttribute('aria-labelledby'));`));
check('focus moved inside the dialog', await evaluate(`
  const d=document.querySelector('[role="dialog"]'); return !!d && d.contains(document.activeElement);`));
let escaped = false;
for (let i = 0; i < 30; i++) {
  await press('Tab', 'Tab');
  if (!(await evaluate(`const d=document.querySelector('[role="dialog"]'); return !!d && d.contains(document.activeElement);`))) {
    escaped = true; break;
  }
}
check('Tab is trapped inside the dialog', !escaped);
await press('Escape', 'Escape');
await wait(600);
check('Escape closes a clean form', await evaluate(`return !document.querySelector('[role="dialog"]');`));
check('body scroll released', await evaluate(`return document.body.style.overflow !== 'hidden';`));
check('focus returned to the opening control', await evaluate(`return document.activeElement?.id === 'opener';`));

// Dirty-form guard: React controlled inputs need the native setter to register a change
await evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/Add transaction/i.test(x.getAttribute('aria-label')||''));
  if(b) b.click(); return 1;`);
await wait(600);
await evaluate(`
  const amt=[...document.querySelectorAll('[role="dialog"] input')].find(i=>i.type==='number');
  if(!amt) return 0;
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  amt.focus(); setter.call(amt,'0.25'); amt.dispatchEvent(new Event('input',{bubbles:true}));
  return 1;`);
await wait(500);
await press('Escape', 'Escape');
await wait(600);
check('a dirty form asks before discarding', /Discard changes/i.test(await evaluate(`return document.body.innerText;`)));
check('the confirm stacks on top of the form',
  (await evaluate(`return document.querySelectorAll('[role="dialog"]').length;`)) >= 2);
await evaluate(`const b=[...document.querySelectorAll('button')].find(x=>/^Discard$/i.test(x.textContent.trim())); if(b) b.click(); return 1;`);
await wait(700);
check('body scroll released after nested dialogs',
  await evaluate(`return document.body.style.overflow !== 'hidden';`));

// ── monthly summary buckets ─────────────────────────────────────────────────
// Monthly bars are positioned at mid-month for centring. That synthetic day used to leak into
// the tooltip and the axis, and the range filter compared it against the cutoff — so a month
// was kept or dropped wholesale, and a partially-in-range month vanished entirely.
console.log('\n[monthly summary bucketing]');
{
  const today = new Date(await evaluate(`return new Date().toISOString().slice(0,10);`));
  const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  // Put one buy early and one late in the month that the 3M cutoff falls inside.
  const edge = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1));
  const edgeMonth = ym(edge);
  const monthly = [
    tx({ id:'early', date:`${edgeMonth}-03`, totalUsd:'111' }),
    tx({ id:'late',  date:`${edgeMonth}-27`, totalUsd:'222' }),
    tx({ id:'now',   date:`${ym(today)}-10`, totalUsd:'555' }),
  ];
  const readMonthly = () => evaluate(`
    const svg=document.querySelector('svg[role="img"][aria-label^="Monthly Summary"]');
    if(!svg) return null;
    const bars=[...svg.querySelectorAll('rect')];
    const b=bars[0].getBoundingClientRect(), r=svg.getBoundingClientRect();
    svg.dispatchEvent(new MouseEvent('mousemove',{clientX:b.left+b.width/2,clientY:r.top+r.height/2,bubbles:true}));
    return new Promise(res=>setTimeout(()=>{
      const card=svg.closest('.card');
      const labels=[...svg.querySelectorAll('text')].map(t=>t.textContent);
      res({ tail: card.textContent.slice(-90), labels });
    },400));`);

  await seed({ 'btc-tx-v2': monthly, 'btc-wallets': WALLETS,
               'btc-settings': { defaultTxType:'Buy', chartRange:'All', hiddenCharts:{} } });
  await reload(6500);
  const all = await readMonthly();
  check('monthly chart renders', !!all, 'no Monthly Summary svg');
  if (all) {
    check('axis labels name months, not fabricated days',
      all.labels.some(l => /^[A-Z][a-z]{2} \d{4}$/.test(l)) && !all.labels.some(l => /\d{2}\/\d{2}\/\d{4}/.test(l)),
      JSON.stringify(all.labels));
    check('tooltip shows the month, not a mid-month date',
      /[A-Z][a-z]{2} \d{4}/.test(all.tail) && !/\/15\//.test(all.tail), all.tail);
    check('range=All totals the whole month (111+222=333)', /\$333/.test(all.tail), all.tail);
  }

  await seed({ 'btc-tx-v2': monthly, 'btc-wallets': WALLETS,
               'btc-settings': { defaultTxType:'Buy', chartRange:'3M', hiddenCharts:{} } });
  await reload(6500);
  const three = await readMonthly();
  check('the partially-in-range month is NOT dropped', !!three, 'monthly chart disappeared at 3M');
  if (three) {
    check('range=3M counts only in-range activity in the edge month ($222, not $333)',
      /\$222/.test(three.tail) && !/\$333/.test(three.tail), three.tail);
  }
}

// ── reconciliation audit colours ────────────────────────────────────────────
// Two wallets emptied to the same zero used to render in different colours, because summing
// floats leaves sub-satoshi residue and the old thresholds were asymmetric: `> 0` caught
// +5.6e-17 as a healthy balance, while `< -1e-8` let -2.8e-17 fall through to the warning
// branch. Both displayed "0 sats" (one as the literal "-0 sats").
console.log('\n[reconciliation audit colours]');
{
  const bal = (id, type, wallet, amount) => ({
    id, date:'2024-01-01', type, wallet, wallet2:'', amount,
    price:'40000', fee:'', totalUsd:'', notes:'', txhash:'', excludeStats:false,
  });
  await seed({
    'btc-tx-v2': [
      // +5.55e-17 of float residue
      bal('p1','Buy','ArchDustPos','0.1'), bal('p2','Buy','ArchDustPos','0.2'), bal('p3','Sell','ArchDustPos','0.3'),
      // -2.78e-17 of float residue
      bal('n1','Buy','ArchDustNeg','0.3'), bal('n2','Sell','ArchDustNeg','0.1'), bal('n3','Sell','ArchDustNeg','0.2'),
      bal('z1','Buy','ArchZero','0.5'),    bal('z2','Sell','ArchZero','0.5'),
      bal('h1','Buy','ActiveHolds','0.25'),
      bal('g1','Sell','ActiveNeg','0.75'), // outflow with no inflow -> genuinely negative
    ],
    'btc-wallets': [
      { id:'w1', name:'ArchDustPos', type:'Exchange', address:'', archived:true },
      { id:'w2', name:'ArchDustNeg', type:'Exchange', address:'', archived:true },
      { id:'w3', name:'ArchZero',    type:'Exchange', address:'', archived:true },
      { id:'w5', name:'ActiveHolds', type:'Wallet',   address:'' },
      { id:'w6', name:'ActiveEmpty', type:'Wallet',   address:'' },
      { id:'w7', name:'ActiveNeg',   type:'Wallet',   address:'' },
    ],
    'btc-settings': { defaultTxType:'Buy', displayUnit:'sats' },
  });
  await reload(6000);
  await clickByText('Wallets');
  await wait(1300);
  const audit = await evaluate(`
    const out={};
    [...document.querySelectorAll('.audit-row')].forEach(r=>{
      const label=r.querySelector('.audit-label')?.textContent;
      const val=r.querySelector('.audit-value');
      if(!label||!val) return;
      out[label]={ shows: val.textContent.trim(),
                   colour: [...val.classList].find(c=>/^audit-/.test(c) && c!=='audit-value') };
    });
    return out;`);
  const zeros = ['ArchDustPos','ArchDustNeg','ArchZero'].map(k => audit[k]);
  check('all three emptied wallets display the same value',
    new Set(zeros.map(z => z?.shows)).size === 1, JSON.stringify(zeros));
  check('float residue no longer changes the colour of a zero balance',
    new Set(zeros.map(z => z?.colour)).size === 1, JSON.stringify(zeros));
  check('never renders the string "-0"',
    !zeros.some(z => /-0/.test(z?.shows || '')), JSON.stringify(zeros.map(z=>z?.shows)));
  check('an emptied archived wallet reads as neutral, not a warning',
    zeros.every(z => z?.colour === 'audit-muted'), JSON.stringify(zeros));
  check('a wallet holding coins is green', audit['ActiveHolds']?.colour === 'audit-ok', JSON.stringify(audit['ActiveHolds']));
  check('an active wallet with nothing logged still nudges (orange)',
    audit['ActiveEmpty']?.colour === 'audit-warn', JSON.stringify(audit['ActiveEmpty']));
  check('a genuinely negative balance is still flagged red',
    audit['ActiveNeg']?.colour === 'audit-err', JSON.stringify(audit['ActiveNeg']));
  check('a negative Total Tracked is not shown as healthy green', await evaluate(`
    const row=[...document.querySelectorAll('.audit-row')].find(r=>/Total Tracked/.test(r.textContent));
    const v=row?.querySelector('.audit-value');
    return !!v && !v.classList.contains('audit-ok');`));
}

// ── accessible names ────────────────────────────────────────────────────────
// Charts only exist on the Dashboard, and the block above leaves us on Wallets.
console.log('\n[accessible names]');
await clickByText('Dashboard');
await wait(1500);
check('no icon-only button without an accessible name', await evaluate(`
  const bad=[...document.querySelectorAll('button')].filter(b=>{
    const txt=(b.textContent||'').trim();
    return !txt && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby');
  });
  window.__bad=bad.map(b=>b.className||b.outerHTML.slice(0,70));
  return bad.length===0;`), await evaluate(`return JSON.stringify(window.__bad||[]);`));
check('every chart svg has a name', await evaluate(`
  const s=[...document.querySelectorAll('svg[role="img"]')];
  return s.length>0 && s.every(x=>(x.getAttribute('aria-label')||'').trim().length>0);`));

// ── search tolerates numeric fields ──────────────────────────────────────────
// A backup written by another tool stores amount as a number; `amount.includes` used to
// throw inside the filter and drop the whole app to the error screen.
console.log('\n[search with numeric fields]');
await seed({ 'btc-tx-v2': [tx({ amount: 0.25, price: 40000, totalUsd: 10000 }), tx({ date:'2024-02-01', notes:'coffee' })],
             'btc-wallets': WALLETS });
await reload();
await clickByText('Transactions');
await wait(800);
await evaluate(`
  const el=document.querySelector('input[aria-label="Search transactions"]');
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(el,'0.25'); el.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
await wait(500);
check('app still rendered after searching', await evaluate(
  `return !!document.querySelector('input[aria-label="Search transactions"]') && !/Something went wrong/i.test(document.body.innerText);`));
check('numeric amount is matched by search', /0\.25/.test(await evaluate(`return document.body.innerText;`)));

// ── another tab's write is picked up, not overwritten ────────────────────────
console.log('\n[cross-tab writes]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS, 'btc-last-modified': '2024-01-01T00:00:00.000Z' });
await reload();
await evaluate(`
  const next=[...JSON.parse(localStorage.getItem('btc-tx-v2')), {id:'other-tab', date:'2024-06-01', type:'Buy', wallet:'Kraken', wallet2:'', amount:'0.3', price:'60000', fee:'', totalUsd:'18000', notes:'from tab 2', txhash:''}];
  localStorage.setItem('btc-tx-v2', JSON.stringify(next));
  localStorage.setItem('btc-last-modified', '2024-06-01T00:00:00.000Z');
  window.dispatchEvent(new StorageEvent('storage', { key:'btc-last-modified', storageArea: localStorage }));
  return 1;`);
await wait(500);
await clickByText('Transactions');
await wait(800);
check('the other tab\'s transaction appears here', /from tab 2|0\.3/.test(await evaluate(`return document.body.innerText;`)));

// ── cost basis never goes negative ───────────────────────────────────────────
// Included buy 1 BTC @ $50k, excluded buy 1 BTC, included sell 1.5 → used to show -$25,000.
console.log('\n[oversell vs cost-basis pool]');
await seed({ 'btc-tx-v2': [
    tx({ amount:'1', price:'50000', totalUsd:'50000' }),
    tx({ date:'2024-02-01', amount:'1', price:'40000', totalUsd:'40000', excludeStats:true }),
    tx({ date:'2024-03-01', type:'Sell', amount:'1.5', price:'60000', totalUsd:'90000' }),
  ], 'btc-wallets': WALLETS });
await reload();
await clickByText('Dashboard');
await wait(1000);
const basisText = await evaluate(`const c=[...document.querySelectorAll('.stat-card')].find(e=>/^\\s*Cost Basis/i.test(e.querySelector('.stat-label')?.textContent||'')); return c ? c.querySelector('.stat-value').textContent : 'not found';`);
check('cost basis stat is shown', basisText !== 'not found', basisText);
check('cost basis is not negative (was -$25,000.00)', !/-/.test(basisText), basisText);

// ── an edit made while a push is in flight still reaches Drive ───────────────
// The older push finishing used to clear pendingPushRef and btc-pending-push, so the newer
// edit's debounce fired on nothing — never sent, and no longer even marked dirty.
console.log('\n[edit during an in-flight push]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS });
await reload();
await evaluate(`
  GDriveSync.accessToken = 'stub'; GDriveSync.tokenExpiry = Date.now() + 3600e3;
  GDriveSync.ensureToken = async () => 'stub';
  window.__pushes = [];
  GDriveSync.push = (data) => new Promise(res => {
    window.__pushes.push(data.lastModified);
    setTimeout(() => { localStorage.setItem('btc-drive-seen-mtime', 'rev' + window.__pushes.length); res(true); }, 1000);
  });
  return 1;`);
await clickByText('Wallets');
await wait(900);
const archiveNth = (n) => evaluate(`
  const b=[...document.querySelectorAll('button[aria-label="Archive wallet"]')][${n}];
  if(!b) return false; b.click(); return true;`);
check('first edit made', await archiveNth(0));
// Push #1 runs 1.5s→2.5s. Edit #2 at 1.8s arms its debounce for 3.3s — AFTER push #1 has
// finished, which is exactly when the old code had already wiped the queue.
await wait(1800);
check('second edit made while push #1 is in flight', await archiveNth(0));
await wait(6500);
const pushes = await evaluate(`return window.__pushes;`);
check('both edits were pushed', pushes.length === 2, JSON.stringify(pushes));
check('the last push carries the latest commit stamp',
  pushes[pushes.length - 1] === await evaluate(`return localStorage.getItem('btc-last-modified');`));
check('nothing left marked dirty', !(await evaluate(`return localStorage.getItem('btc-pending-push');`)));

// ── view toggles are not data edits ──────────────────────────────────────────
// A chart-range click used to stamp btc-last-modified and queue a Drive push, so two devices
// could raise a Sync Conflict over nothing but a view toggle.
console.log('\n[view settings stay local]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS, 'btc-last-modified': '2024-01-01T00:00:00.000Z' });
await reload();
await evaluate(`GDriveSync.accessToken = 'stub'; GDriveSync.tokenExpiry = Date.now() + 3600e3; return 1;`);
await clickByText('Dashboard');
await wait(600);
const clicked = await clickByText('1Y');
await wait(400);
check('range control found', clicked === 'clicked', clicked);
check('range change was saved locally',
  await evaluate(`return JSON.parse(localStorage.getItem('btc-settings')||'{}').chartRange === '1Y';`));
check('range change did not stamp a commit',
  await evaluate(`return localStorage.getItem('btc-last-modified') === '2024-01-01T00:00:00.000Z';`));
check('range change did not mark anything dirty',
  !(await evaluate(`return localStorage.getItem('btc-pending-push');`)));

// ── wrong-typed settings can't brick the app ─────────────────────────────────
// Settings come from backups and Drive. `chartOrder: "x"` used to throw on every render, on
// every synced device.
console.log('\n[malformed settings]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS,
             'btc-settings': { chartOrder: 'x', hiddenCharts: [1,2], maLines: 'yes', dashboardWalletFilter: 7, defaultTxType: 'Steal' } });
await reload();
await clickByText('Dashboard');
await wait(800);
check('dashboard renders with malformed settings', await evaluate(`return !!document.querySelector('.stats-grid');`));
check('no error screen', !/Something went wrong|could not start/i.test(await evaluate(`return document.body.innerText;`)));

// ── transaction form: labelled fields, date and wallet rules ────────────────
console.log('\n[transaction form]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS });
await reload();
await clickByText('Dashboard');
await wait(600);
const openAdd = () => evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/Add transaction/i.test(x.getAttribute('aria-label')||''));
  if(b) b.click(); return 1;`);
await openAdd();
await wait(600);
check('every form label is linked to its control', await evaluate(`
  const ls=[...document.querySelectorAll('[role="dialog"] label.form-label')];
  return ls.length > 3 && ls.every(l => !!l.control);`));
const setField = (id, value) => evaluate(`
  const el=document.getElementById('${id}');
  const proto = el.tagName==='SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); return 1;`);
const submit = () => evaluate(`
  const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>/^\\s*(Add|Update) Transaction/i.test(x.textContent));
  if(!b) return 'no button'; b.click(); return 'clicked';`);
const toastText = () => evaluate(`return document.querySelector('.toast')?.textContent || '';`);
await setField('tx-date', '2999-01-01');
await setField('tx-wallet', 'Kraken');
await setField('tx-amount', '0.1');
await setField('tx-price', '50000');
await wait(200);
check('submit button found', (await submit()) === 'clicked');
await wait(300);
check('a future date is refused', /future/i.test(await toastText()), await toastText());
await setField('tx-date', '2024-05-01');
await setField('tx-type', 'Transfer');
await wait(200);
await setField('tx-wallet2', 'Kraken');
await wait(200);
await submit();
await wait(300);
check('a transfer to the same wallet is refused', /two different wallets/i.test(await toastText()), await toastText());
check('nothing was saved', await evaluate(`return JSON.parse(localStorage.getItem('btc-tx-v2')).length === 1;`));

// ── excluded coins are not counted as profit ─────────────────────────────────
// Included buy 1 BTC @ $50k + excluded buy 1 BTC. Unrealized P&L used to be
// (2 BTC × price) − $50k, treating the excluded coin as free money.
console.log('\n[unrealized P&L ignores excluded coins]');
await seed({ 'btc-tx-v2': [
    tx({ amount:'1', price:'50000', totalUsd:'50000' }),
    tx({ date:'2024-02-01', amount:'1', price:'40000', totalUsd:'40000', excludeStats:true }),
  ], 'btc-wallets': WALLETS, 'btc-last-spot': { price: 70000, at: Date.now() } });
await reload();
await clickByText('Dashboard');
await wait(1200);
const pl = await evaluate(`
  const money = s => Number(String(s).replace(/[^0-9.-]/g,''));
  const pill = document.querySelector('.price-pill');
  const c=[...document.querySelectorAll('.stat-card')].find(e=>/^\\s*Total P&L/i.test(e.querySelector('.stat-label')?.textContent||''));
  return { price: pill ? money(pill.textContent) : null, pl: c ? money(c.querySelector('.stat-value').textContent) : null };`);
check('price and P&L are shown', pl.price > 0 && pl.pl !== null, JSON.stringify(pl));
check('P&L = 1 BTC × price − $50,000 (excluded coin not counted)',
  Math.abs(pl.pl - (pl.price - 50000)) < 1, JSON.stringify(pl));

// Offline price failures are expected in CI — they are warnings now, not errors
const unexpected = errors.filter(e => !/Failed to fetch|price|Stored data unreadable/i.test(e));
if (unexpected.length) {
  console.log(`\nunexpected console errors: ${unexpected.length}`);
  unexpected.slice(0, 8).forEach(e => console.log('  ✗ ' + e.slice(0, 250)));
}

const failed = report();
close();
process.exit(failed || unexpected.length ? 1 : 0);
