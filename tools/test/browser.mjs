// End-to-end smoke test in headless Chrome. Covers the behaviours that are hard to reason
// about statically and that regressed in the past: corrupt-storage recovery, the transfer
// wizard's step sequencing, chart geometry after memoization, and modal keyboard handling.
//
//   npm run test:browser
//
// Skips cleanly (exit 0) if no Chrome/Edge is installed — set CHROME_PATH to point at one.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, createChecks, findChrome, REPO_ROOT } from './lib/harness.mjs';

if (!(await findChrome())) {
  console.log('No Chrome/Edge found — skipping browser tests. Set CHROME_PATH to enable them.');
  process.exit(0);
}

const { send, on, evaluate, reload, wait, seed, press, close, errors } =
  await launch({ page: process.env.SATLEDGER_PAGE || 'app.html', port: 8791, debugPort: 9291, label: 'browser' });
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
// In-browser Babel (app.dev.html only) reports through console.error that it skips
// pretty-printing a script over 500 KB. A note about its output formatting, not a failure.
const BABEL_SIZE_NOTE = /\[BABEL\] Note: The code generator has deoptimised/;
const clickByText = (text) => evaluate(`
  const b=[...document.querySelectorAll('button,a')].find(x=>new RegExp('^\\\\s*${text}\\\\s*$').test(x.textContent));
  if(!b) return 'not found'; b.click(); return 'clicked';`);
// Wallets and Export are tabs inside Settings: open Settings, then the section.
const openSettingsTab = async (label) => { await clickByText('Settings'); await wait(150); return clickByText(label); };

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
await openSettingsTab('Wallets');
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
await openSettingsTab('Wallets');
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
  await openSettingsTab('Wallets');
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
await openSettingsTab('Wallets');
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

// ── the built page's CSP blocks nothing it needs ─────────────────────────────
// app.html pins script-src to hashes and exact URLs. A violation at boot would leave a blank
// page (caught by every check above); this catches ones that only happen later, such as the
// on-demand Google sign-in script.
console.log('\n[content security policy]');
await seed({ 'btc-tx-v2': [tx({})], 'btc-wallets': WALLETS });
await reload();
await evaluate(`window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); return 1;`);
// Wallets and Export are tabs inside Settings, so they are reachable only once Settings is open.
for (const t of ['Transactions', 'Settings', 'Wallets', 'Export', 'Dashboard']) { await clickByText(t); await wait(300); }
await evaluate(`GDriveSync.loadScript(); return 1;`);
await wait(2500);
const csp = await evaluate(`return window.__csp;`);
check('no CSP violations after boot', csp.length === 0, JSON.stringify(csp));

// ── delete is undoable; duplicate pre-fills a new row; shortcuts ─────────────
console.log('\n[undo, duplicate, shortcuts]');
await seed({ 'btc-tx-v2': [tx({ id:'a', notes:'first' }), tx({ id:'b', date:'2024-02-01', notes:'second', txhash:'abc' })],
             'btc-wallets': WALLETS });
await reload();
await clickByText('Transactions');
await wait(800);
const storedIds = () => evaluate(`return JSON.parse(localStorage.getItem('btc-tx-v2')).map(t=>t.id).join(',');`);
await evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/^Delete Buy/.test(x.getAttribute('aria-label')||'') && /02\\/01\\/2024/.test(x.getAttribute('aria-label')));
  if(!b) return 0; b.click(); return 1;`);
await wait(400);
check('delete happens immediately, no confirm', (await storedIds()) === 'a' && !(await evaluate(`return !!document.querySelector('[role="dialog"]');`)));
check('toast offers Undo', await evaluate(`return [...document.querySelectorAll('.toast button')].some(b=>b.textContent.trim()==='Undo');`));
await evaluate(`[...document.querySelectorAll('.toast button')].find(b=>b.textContent.trim()==='Undo').click(); return 1;`);
await wait(400);
check('Undo restores the row in its original position', (await storedIds()) === 'a,b', await storedIds());
// Ctrl+Z path
await evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/^Delete Buy/.test(x.getAttribute('aria-label')||'') && /01\\/01\\/2024/.test(x.getAttribute('aria-label')));
  b.click(); document.activeElement && document.activeElement.blur(); return 1;`);
await wait(300);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true})); return 1;`);
await wait(400);
check('Ctrl+Z undoes a delete', (await storedIds()) === 'a,b', await storedIds());
// Duplicate
await evaluate(`
  const b=[...document.querySelectorAll('button')].find(x=>/^Duplicate Buy/.test(x.getAttribute('aria-label')||'') && /02\\/01\\/2024/.test(x.getAttribute('aria-label')));
  if(b) b.click(); return 1;`);
await wait(600);
const dup = await evaluate(`return { date: document.getElementById('tx-date')?.value, wallet: document.getElementById('tx-wallet')?.value, hash: document.getElementById('tx-hash')?.value, notes: document.getElementById('tx-notes')?.value, title: document.querySelector('[role="dialog"] .modal-title')?.textContent };`);
check('duplicate opens an Add form copied from the row, dated today, no txhash',
  /Add/.test(dup.title) && dup.wallet === 'Kraken' && dup.notes === 'second' && dup.hash === '' && dup.date === await evaluate(`const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');`),
  JSON.stringify(dup));
check('the form opens with focus on Date', await evaluate(`return document.activeElement?.id === 'tx-date';`));
await press('Escape', 'Escape');
await wait(400);
await evaluate(`const b=[...document.querySelectorAll('button')].find(x=>/^Discard$/i.test(x.textContent.trim())); if(b) b.click(); return 1;`);
await wait(500);
// "n" opens a new transaction (not while typing)
await evaluate(`document.activeElement && document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true})); return 1;`);
await wait(500);
check('"n" opens the Add Transaction form', await evaluate(`return /Add/.test(document.querySelector('[role="dialog"] .modal-title')?.textContent||'');`));
await press('Escape', 'Escape');
await wait(400);

// ── harvest view and the new transaction fields ──────────────────────────────
console.log('\n[harvest]');
await seed({
  'btc-tx-v2': [
    tx({ id:'h1', date:'2024-01-01', datetimeUtc:'2024-01-01T12:00:00.000Z', sequence:1, wallet:'Bitkey', amount:'1', price:'100000', totalUsd:'100000' }),
    tx({ id:'h2', date:'2024-02-01', datetimeUtc:'2024-02-01T12:00:00.000Z', sequence:1, wallet:'Bitkey', amount:'1', price:'30000', totalUsd:'30000' }),
  ],
  'btc-wallets': [{ id:'w9', name:'Bitkey', type:'Wallet', address:'' }, ...WALLETS],
  'btc-last-modified': '2024-01-01T00:00:00.000Z',
});
await reload();
await clickByText('Harvest');
await wait(600);
check('Harvest opens on the all-wallets summary', await evaluate(`return document.getElementById('harvest-wallet')?.value === '' && !!document.getElementById('harvest-total-table') && !document.getElementById('harvest-lots-table');`));
await setField('harvest-price', '60000');
await wait(300);
const totalRows = await evaluate(`return [...document.querySelectorAll('#harvest-total-table tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim());`);
check('the summary lists the wallet plus a Total row', totalRows.length === 2 && /^Bitkey\b/.test(totalRows[0]) && /^Total\b/.test(totalRows[1]), JSON.stringify(totalRows));
check('the Total row: 1 lot under water, $100,000 basis, $40,000 est. loss at $60,000', /\b1\b/.test(totalRows[1] || '') && /\$100,000\.00/.test(totalRows[1] || '') && /\$40,000\.00/.test(totalRows[1] || ''), JSON.stringify(totalRows));
check('the summary export button is enabled', await evaluate(`return [...document.querySelectorAll('button')].some(b => /Export summary/.test(b.innerText) && !b.disabled);`));
// drill into the wallet by clicking its row
await evaluate(`document.querySelector('#harvest-total-table tbody tr').click(); return 1;`);
await wait(400);
check('clicking a wallet row opens that wallet', await evaluate(`return document.getElementById('harvest-wallet')?.value === 'Bitkey' && !!document.getElementById('harvest-back') && !document.getElementById('harvest-total-table');`));
const harvestRows = await evaluate(`return [...document.querySelectorAll('#harvest-lots-table tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim());`);
check('only the lot costing more than the price is listed', harvestRows.length === 1 && /100,000\.00/.test(harvestRows[0]), JSON.stringify(harvestRows));
check('its loss at the price is shown', /\$40,000\.00/.test(harvestRows[0] || ''), JSON.stringify(harvestRows));
check('the wallet summary counts one lot', await evaluate(`return /lots to sell\\s*1\\b/i.test(document.body.innerText.replace(/\\n+/g,' '));`));
await setField('harvest-price', '20000');
await wait(300);
check('a lower price lists both lots', (await evaluate(`return document.querySelectorAll('#harvest-lots-table tbody tr').length;`)) === 2);
// back to the summary; the price carries over
await evaluate(`document.getElementById('harvest-back').click(); return 1;`);
await wait(300);
const totalRows2 = await evaluate(`return [...document.querySelectorAll('#harvest-total-table tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim());`);
check('Back returns to the summary, now at $20,000 (2 lots, $130,000 basis, $90,000 est. loss)', /\b2\b/.test(totalRows2[1] || '') && /\$130,000\.00/.test(totalRows2[1] || '') && /\$90,000\.00/.test(totalRows2[1] || ''), JSON.stringify(totalRows2));
// the transaction form has the new fields
await evaluate(`document.activeElement && document.activeElement.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true})); return 1;`);
await wait(500);
check('the form has Time and Sequence', await evaluate(`return !!document.getElementById('tx-time') && !!document.getElementById('tx-seq');`));
check('time defaults to now (hh:mm)', await evaluate(`return /^\\d{2}:\\d{2}$/.test(document.getElementById('tx-time').value);`));
await setField('tx-type', 'Reward');
await wait(300);
check('Reward shows the USD value and category fields', await evaluate(`return !!document.getElementById('tx-usd-value') && !!document.getElementById('tx-reward-cat');`));
await press('Escape', 'Escape');
await wait(400);

// ── CoinLedger export is unchanged ───────────────────────────────────────────
// Golden regression test for the tax export (Market Analytics plan, Phase 0). A fixed fixture
// is exported through the real UI and compared to committed goldens as exact text, CRLF and
// all. The goldens were generated once from the unmodified app and reviewed by hand. This test
// NEVER writes them: when output differs (or a golden is missing) it fails and saves what the
// app produced to the temp directory for inspection.
//
// Capture: URL.createObjectURL is wrapped to keep the Blob that downloadBlob creates, and the
// anchor click for coinledger-* files is swallowed so headless Chrome downloads nothing.
// downloadBlob and exportCSV themselves are untouched.
console.log('\n[CoinLedger export is unchanged]');
{
  const FIXTURES = join(REPO_ROOT, 'tools', 'test', 'fixtures');
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'coinledger-golden-input.json'), 'utf8'));
  const GOLDENS = [
    { card: 'All Years', file: 'coinledger-golden.csv',      name: /^coinledger-all-\d{4}-\d{2}-\d{2}\.csv$/ },
    { card: '2024',      file: 'coinledger-golden-2024.csv', name: /^coinledger-2024-\d{4}-\d{2}-\d{2}\.csv$/ },
  ];
  await seed({ 'btc-tx-v2': fixture.transactions, 'btc-wallets': fixture.wallets });
  await reload();
  await clickByText('Settings');
  await wait(300);
  await clickByText('Export');
  await wait(900);
  for (const g of GOLDENS) {
    const got = await evaluate(`
      if(!window.__clHooked){
        window.__clHooked = true;
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = b => { window.__clBlobs.push(b); return make(b); };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){
          if(/^coinledger-/.test(this.download || '')) { window.__clNames.push(this.download); return; }
          return click.call(this);
        };
      }
      window.__clBlobs = []; window.__clNames = [];
      const card=[...document.querySelectorAll('.stat-card')].find(c=>(c.querySelector('.stat-label')?.textContent||'').trim()===${JSON.stringify(g.card)});
      if(!card) return { error: 'export card not found' };
      card.click();
      if(window.__clBlobs.length !== 1) return { error: 'expected exactly 1 blob, got ' + window.__clBlobs.length };
      const blob = window.__clBlobs[0];
      return blob.text().then(text => ({ text, type: blob.type, name: window.__clNames[0] || '' }));`);
    const label = `"${g.card}"`;
    if (!got || got.error) { check(`${label}: export captured`, false, got?.error || 'nothing returned'); continue; }
    check(`${label}: blob is text/csv`, got.type === 'text/csv', got.type);
    check(`${label}: filename unchanged`, g.name.test(got.name), got.name);
    const goldenPath = join(FIXTURES, g.file);
    let golden = null;
    try { golden = readFileSync(goldenPath, 'utf8'); } catch {}
    const same = golden !== null && got.text === golden;
    let detail = '';
    if (!same) {
      const actualPath = join(tmpdir(), `satledger-actual-${g.file}`);
      writeFileSync(actualPath, got.text);
      if (golden === null) detail = `golden ${g.file} is MISSING (never auto-generated); app output saved to ${actualPath}`;
      else {
        let i = 0; while (i < golden.length && golden[i] === got.text[i]) i++;
        detail = `first difference at char ${i}: golden ${JSON.stringify(golden.slice(i, i + 40))} vs app ${JSON.stringify(got.text.slice(i, i + 40))}; app output saved to ${actualPath}`;
      }
    }
    check(`${label}: CSV is byte-identical to ${g.file}`, same, detail);
  }
}

// ── Market candle store (IndexedDB) ──────────────────────────────────────────
// MarketCandleStore round-trips candles, coverage and meta through real IndexedDB, and falls
// back to the in-memory store — with the app still booting — when indexedDB.open fails.
console.log('\n[Market candle store]');
{
  const base = `{ provider: 'test', symbol: 'BTC-USD', interval: '1h' }`;
  const r = await evaluate(`return (async () => {
    const k = ${base};
    const s = await MarketCandleStore.create();
    await s.clear();
    await s.putCandles({ ...k, candles: [{ t: 7200, o: 2, h: 3, l: 1, c: 2.5, v: null }, { t: 3600, o: 1, h: 2, l: 0.5, c: 1.5, v: 4 }, { t: 10800, o: 3, h: 3, l: 3, c: 3, v: 1 }] });
    await s.putCandles({ ...k, interval: '1d', candles: [{ t: 0, o: 9, h: 9, l: 9, c: 9, v: 9 }] });
    await s.putCoverage({ ...k, pageIndex: 4, fetchedAt: 123, complete: true });
    await s.putMeta('earliest:test:BTC-USD:1d', { earliestSec: 42, verifiedAt: 7 });
    const again = await MarketCandleStore.create(); // a second connection reads what the first wrote
    const out = {
      kind: s.kind,
      window: await again.getCandles({ ...k, fromSec: 3600, toSec: 10800 }),
      other: await again.getCandles({ ...k, interval: '1d', fromSec: -Infinity, toSec: Infinity }),
      empty: await again.getCandles({ ...k, fromSec: 5, toSec: 5 }),
      coverage: await again.getCoverage({ ...k, fromPage: 0, toPage: 10 }),
      meta: await again.getMeta('earliest:test:BTC-USD:1d'),
      missing: await again.getMeta('nope'),
    };
    await s.clear();
    out.cleared = (await again.getCandles({ ...k })).length + (await again.getCoverage({ ...k })).length;
    out.dbs = (await indexedDB.databases?.() || []).map(d => d.name + '@' + d.version);
    return out;
  })()`);
  check('IndexedDB store opened', r?.kind === 'indexeddb', r?.kind);
  check('candles round-trip, ascending, toSec exclusive', JSON.stringify(r?.window) === JSON.stringify([
    { t: 3600, o: 1, h: 2, l: 0.5, c: 1.5, v: 4 }, { t: 7200, o: 2, h: 3, l: 1, c: 2.5, v: null }]), JSON.stringify(r?.window));
  check('series kept apart by interval', r?.other?.length === 1 && r.other[0].t === 0);
  check('empty window → []', Array.isArray(r?.empty) && r.empty.length === 0);
  check('coverage round-trips', JSON.stringify(r?.coverage) === JSON.stringify([{ provider: 'test', symbol: 'BTC-USD', interval: '1h', pageIndex: 4, fetchedAt: 123, complete: true }]), JSON.stringify(r?.coverage));
  check('meta round-trips; missing meta → null', JSON.stringify(r?.meta) === '{"earliestSec":42,"verifiedAt":7}' && r?.missing === null, JSON.stringify(r?.meta));
  check('clear() empties the stores', r?.cleared === 0);
  check('database is satledger-market v1', (r?.dbs || []).includes('satledger-market@1'), JSON.stringify(r?.dbs));

  // indexedDB.open made to fail before any app script runs
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `IDBFactory.prototype.open = function(){ throw new DOMException('blocked by test', 'SecurityError'); };`,
  });
  await seed({ 'btc-tx-v2': [tx({ id: 'mk1' })], 'btc-wallets': WALLETS });
  await evaluate(`history.replaceState(null, '', '#dashboard'); return 1;`); // the export test left #export
  const errorsBefore = errors.length;
  await reload();
  check('app still boots with indexedDB.open failing', await evaluate(`return !!document.querySelector('.stats-grid');`));
  const f = await evaluate(`return (async () => {
    const s = await MarketCandleStore.open();
    const k = ${base};
    await s.putCandles({ ...k, candles: [{ t: 3600, o: 1, h: 1, l: 1, c: 1, v: 1 }] });
    return { kind: s.kind, n: (await s.getCandles({ ...k })).length, same: s === await MarketCandleStore.open() };
  })()`);
  check('falls back to the in-memory store', f?.kind === 'memory' && f?.n === 1, JSON.stringify(f));
  check('open() is lazy and shared', f?.same === true);
  const thrown = errors.slice(errorsBefore).filter(e => !BABEL_SIZE_NOTE.test(e));
  check('nothing thrown', thrown.length === 0, thrown.join(' | '));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await reload();
}

// ── Market tab ───────────────────────────────────────────────────────────────
// Every Coinbase request is intercepted through the DevTools Fetch domain and answered from a
// synthetic, deterministic candle history — no real network, no test hook in the app. The
// vendored chart library is intercepted too, so its load can be made to fail.
{
  const DAY = 86400;
  const EARLIEST = Math.floor(Date.now() / 1000 / DAY) * DAY - 420 * DAY; // synthetic history start
  const priceAt = t => 50000 + 8000 * Math.sin(t / DAY / 40) + 1500 * Math.sin(t / 3600 / 7);
  // Coinbase shape: newest first, [time, low, high, open, close, volume], `end` inclusive.
  const rowsFor = (g, start, end) => {
    const now = Date.now() / 1000, rows = [];
    for (let t = Math.ceil(Math.max(start, EARLIEST) / g) * g; t <= end && t <= now; t += g) {
      const o = priceAt(t), c = priceAt(t + g);
      rows.push([t, Math.min(o, c) - 40, Math.max(o, c) + 40, o, c, 5 + (t / g) % 7]);
    }
    return rows.reverse();
  };
  const requests = [];
  let failCandles = false, failVendor = false, netDown = false; // netDown: API requests fail like a lost connection
  on('Fetch.requestPaused', p => {
    const url = p.request.url;
    if (netDown && !url.includes('/vendor/')) { send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }); return; }
    if (url.includes('/vendor/lightweight-charts')) {
      send(failVendor ? 'Fetch.failRequest' : 'Fetch.continueRequest',
        failVendor ? { requestId: p.requestId, errorReason: 'Failed' } : { requestId: p.requestId });
      return;
    }
    requests.push(url);
    const u = new URL(url);
    let status = 200, body = '{}';
    if (u.pathname.endsWith('/candles')) {
      if (failCandles) { status = 503; body = '{"message":"unavailable"}'; }
      else body = JSON.stringify(rowsFor(+u.searchParams.get('granularity'),
        Date.parse(u.searchParams.get('start')) / 1000, Date.parse(u.searchParams.get('end')) / 1000));
    } else if (u.pathname.endsWith('/stats')) {
      body = JSON.stringify({ open: '58000', high: '61000', low: '57000', last: '60000', volume: '1234.5', volume_30day: '40000' });
    } else if (u.pathname.includes('/prices/')) {
      body = JSON.stringify({ data: { amount: '60000.00', base: 'BTC', currency: 'USD' } });
    } else status = 404;
    send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(body).toString('base64'),
    });
  });
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true }); // let interception see the vendor file
  await send('Fetch.enable', { patterns: [
    { urlPattern: '*api.exchange.coinbase.com*' }, { urlPattern: '*api.coinbase.com*' }, { urlPattern: '*/vendor/lightweight-charts*' },
  ] });

  const waitFor = async (js, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await evaluate(js);
      if (v || Date.now() > end) return v;
      await wait(150);
    }
  };
  const chart = () => evaluate(`const c = document.querySelector('.mkt-chart'); if(!c) return null;
    const r = c.getBoundingClientRect();
    return { state: c.dataset.state, candles: +c.dataset.candles, range: c.dataset.range, interval: c.dataset.interval,
      scale: c.dataset.scale, forming: +c.dataset.forming, w: Math.round(r.width), h: Math.round(r.height) };`);
  const radio = (group, label) => evaluate(`const b = [...document.querySelectorAll('[role=radiogroup][aria-label="${group}"] [role=radio]')]
    .find(x => x.childNodes[0].textContent === '${label}'); if(!b) return 'missing'; if(b.disabled) return 'disabled'; b.click(); return 'clicked';`);
  const ready = (cond = 'true') => waitFor(`const c = document.querySelector('.mkt-chart');
    return !!c && c.dataset.state !== 'loading' && c.dataset.state !== 'library-loading' && +c.dataset.candles > 0 && (${cond});`, 20000);
  const candleWindows = () => requests.filter(u => u.includes('/candles?')).map(u => {
    const q = new URL(u).searchParams, g = +q.get('granularity');
    return { g, start: Date.parse(q.get('start')) / 1000, end: Date.parse(q.get('end')) / 1000 };
  });
  const allPageAligned = list => list.every(w => w.start % (w.g * 300) === 0 && w.end - w.start === w.g * 300);
  const show = (tabTitle) => evaluate(`const b = document.querySelector('.sidebar-item[title="${tabTitle}"]'); if(!b) return false; b.click(); return true;`);

  console.log('\n[Market tab opens and draws candles]');
  await seed({ 'btc-tx-v2': [tx({ id: 'mkt1' })], 'btc-wallets': WALLETS });
  await evaluate(`history.replaceState(null, '', '#dashboard'); return 1;`);
  await reload();
  await wait(2500); // the Dashboard's own price-history fetch settles before requests are judged
  requests.length = 0;
  await evaluate(`window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); return 1;`);
  const navOrder = await evaluate(`return [...document.querySelectorAll('.sidebar-item')].map(b => b.title);`);
  check('Market is the second sidebar item', navOrder?.[1] === 'Market', JSON.stringify(navOrder));
  check('sidebar opens the Market tab', await show('Market'));
  check('chart draws candles', !!(await ready()), JSON.stringify(await chart()));
  let c = await chart();
  check('hash is #market with the view parameters and the title says Market',
    (await evaluate(`return location.hash + '|' + document.querySelector('.page-title').textContent;`)) === '#market?range=1y&interval=1d&scale=linear&vol=1|Market',
    await evaluate(`return location.hash;`));
  check('chart container has a size', c?.w > 100 && c?.h >= 300, JSON.stringify(c));
  check('default 1Y at 1d, about a year of daily candles', c?.range === '1Y' && c?.interval === '1d' && c.candles >= 360 && c.candles <= 370, JSON.stringify(c));
  check('the newest candle is marked forming', c?.forming === c?.candles - 1, JSON.stringify(c));
  check('the library drew into the container', await evaluate(`return document.querySelectorAll('.mkt-chart .tv-lightweight-charts').length === 1;`));
  check('price header shows the current price', /\$60,000\.00/.test(await evaluate(`return document.querySelector('.mkt-price').textContent;`)));
  check('24 h change comes from the stats endpoint', /\+\$2,000\.00 \(\+3\.45%\)/.test(await waitFor(`const t = document.querySelector('[data-change24]').textContent; return /\\$/.test(t) && t;`)),
    await evaluate(`return document.querySelector('[data-change24]').textContent;`));
  const readout = await evaluate(`return document.querySelector('[data-readout]').textContent;`);
  check('readout labels volume "Volume (Coinbase)" and marks the forming candle', /Volume \(Coinbase\)/.test(readout) && /forming/.test(readout), readout);
  check('TradingView notice and link are on the page', await evaluate(`return !!document.querySelector('.mkt-legal a[href="https://www.tradingview.com/"]') && /Copyright \\(c\\) 2025 TradingView, Inc\\./.test(document.querySelector('.mkt-legal').textContent);`));
  check('library attribution logo is kept', await evaluate(`return !!document.querySelector('.mkt-chart a#tv-attr-logo');`));
  check('every candle request is one page-aligned window', allPageAligned(candleWindows()), JSON.stringify(candleWindows().slice(0, 4)));
  check('the background daily backfill ran', await waitFor(`return !/Loading full daily history/.test(document.querySelector('[data-freshness]').textContent);`, 20000)
    && candleWindows().filter(w => w.g === 86400).length >= 3, candleWindows().filter(w => w.g === 86400).length);

  console.log('\n[Market range and interval]');
  requests.length = 0;
  await radio('Range', '1M');
  c = await ready(`c.dataset.range === '1M'`) && await chart();
  check('1M defaults to 4h', c?.interval === '4h' && c.candles >= 170 && c.candles <= 190, JSON.stringify(c));
  check('1m is not offered for 1M', (await radio('Interval', '1m')) === 'disabled');
  check('1d is offered for 1M', await evaluate(`return [...document.querySelectorAll('[aria-label="Interval"] [role=radio]')].some(b => b.childNodes[0].textContent === '1d' && !b.disabled);`));
  await radio('Interval', '1h');
  c = await ready(`c.dataset.interval === '1h'`) && await chart();
  check('switching to 1h updates the count', c?.range === '1M' && c.candles >= 700 && c.candles <= 750, JSON.stringify(c));
  check('range and interval changes requested only page-aligned windows', candleWindows().length > 0 && allPageAligned(candleWindows()),
    JSON.stringify(candleWindows().filter(w => !(w.start % (w.g * 300) === 0 && w.end - w.start === w.g * 300)).slice(0, 3)));
  for (const r of ['1W', '3M', '6M', 'YTD', '1D']) await radio('Range', r); // no waiting in between
  await ready(`c.dataset.range === '1D'`);
  await wait(1500); // anything superseded and still in flight would land now
  c = await chart();
  check('rapid range changes end on the last one (1D at 5m)', c?.range === '1D' && c.interval === '5m' && c.candles >= 287 && c.candles <= 290, JSON.stringify(c));
  check('every range is selectable', (await evaluate(`return [...document.querySelectorAll('[aria-label="Range"] [role=radio]')].filter(b => !b.disabled).map(b => b.textContent).join(' ');`)) === '1D 1W 1M 3M 6M YTD 1Y 3Y 5Y ALL');
  await radio('Range', 'ALL');
  c = await ready(`c.dataset.range === 'ALL'`) && await chart();
  check('ALL starts at the discovered earliest candle', c?.interval === '1w' && c.candles >= 59 && c.candles <= 62, JSON.stringify(c));
  await radio('Range', '1Y');
  await ready(`c.dataset.range === '1Y'`);

  console.log('\n[Market scale, keyboard, expand]');
  await evaluate(`[...document.querySelectorAll('.mkt-btn')].find(b => b.textContent === 'Log').click(); return 1;`);
  check('Log toggles the price scale', (await chart())?.scale === 'log' && await evaluate(`return [...document.querySelectorAll('.mkt-btn')].find(b => b.textContent === 'Log').getAttribute('aria-pressed') === 'true';`));
  await evaluate(`[...document.querySelectorAll('.mkt-btn')].find(b => b.textContent === 'Log').click(); return 1;`);
  await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await wait(200);
  const inspected = await evaluate(`return document.querySelector('[data-readout]').textContent;`);
  check('Left arrow inspects the previous candle', !/forming/.test(inspected) && /O \$/.test(inspected) && /[+−]\$/.test(inspected), inspected);
  await press('Escape', 'Escape');
  await wait(200);
  check('Escape returns the readout to the latest candle', /forming/.test(await evaluate(`return document.querySelector('[data-readout]').textContent;`)));
  const before = await chart();
  await evaluate(`const b = document.querySelector('button[aria-label="Expand chart"]'); b.focus(); b.click(); return 1;`);
  await wait(400);
  const exp = await evaluate(`const s = document.querySelector('.mkt-shell'); return { open: s.classList.contains('expanded'), dialog: s.getAttribute('role'), body: document.body.classList.contains('mkt-expanded'), inside: s.contains(document.activeElement) };`);
  const big = await chart();
  check('Expand opens a full-viewport dialog with focus inside', exp.open && exp.dialog === 'dialog' && exp.body && exp.inside, JSON.stringify(exp));
  check('the expanded chart is larger and keeps its candles', big.h > before.h && big.candles === before.candles, JSON.stringify([before, big]));
  await press('Escape', 'Escape');
  await wait(400);
  const closed = await evaluate(`return { open: !!document.querySelector('.mkt-shell.expanded'), body: document.body.classList.contains('mkt-expanded'), focus: document.activeElement?.getAttribute('aria-label') };`);
  check('Escape closes it and returns focus to Expand', !closed.open && !closed.body && closed.focus === 'Expand chart', JSON.stringify(closed));
  check('the chart is the same instance after closing', (await chart())?.candles === before.candles && await evaluate(`return document.documentElement.dataset.marketCharts === '1';`));

  console.log('\n[Market stale and failure states]');
  await evaluate(`window.__realNow = Date.now; const skew = 3 * 3600e3; Date.now = () => window.__realNow.call(Date) + skew; return 1;`);
  await radio('Range', '1D');
  const stale = await waitFor(`return !!document.querySelector('[data-stale="candles"]') && !!document.querySelector('[data-stale="price"]') && document.querySelector('.mkt-chart').dataset.state;`, 20000);
  check('stale badges for price and candles after the clock moves on', stale === 'stale', stale);
  await evaluate(`Date.now = window.__realNow; return 1;`);
  // The skewed clock marked cached pages complete too early; start the failure check from empty.
  await evaluate(`return MarketCandleStore.open().then(s => s.clear()).then(() => 1);`);
  failCandles = true;
  await radio('Range', '6M');
  const err = await waitFor(`const c = document.querySelector('.mkt-chart'); return c.dataset.range === '6M' || c.dataset.state === 'error' ? c.dataset.state : '';`, 25000);
  check('provider failure with nothing cached shows an error with Retry', err === 'error'
    && await evaluate(`return [...document.querySelectorAll('.mkt-overlay button')].some(b => b.textContent === 'Retry');`), err);
  failCandles = false;
  await evaluate(`[...document.querySelectorAll('.mkt-overlay button')].find(b => b.textContent === 'Retry').click(); return 1;`);
  c = await ready(`c.dataset.range === '6M'`) && await chart();
  check('Retry recovers', c?.state === 'ready' && c.interval === '1d', JSON.stringify(c));

  console.log('\n[Market tab lifecycle]');
  for (let i = 0; i < 10; i++) { await show('Dashboard'); await wait(120); await show('Market'); await wait(120); }
  await ready();
  check('ten visits leave exactly one chart instance', await evaluate(`return document.querySelectorAll('.tv-lightweight-charts').length === 1 && document.documentElement.dataset.marketCharts === '1';`),
    await evaluate(`return document.querySelectorAll('.tv-lightweight-charts').length + ' / ' + document.documentElement.dataset.marketCharts;`));
  await show('Dashboard'); await wait(300);
  check('leaving the tab destroys the chart', await evaluate(`return document.documentElement.dataset.marketCharts === '0' && !document.querySelector('.tv-lightweight-charts');`));
  check('no CSP violations on the Market tab', (await evaluate(`return window.__csp;`)).length === 0, JSON.stringify(await evaluate(`return window.__csp;`)));

  // A throw inside the Market view stays inside the Market tab.
  const errorsBefore = errors.length;
  await evaluate(`window.__lc = window.LightweightCharts; window.LightweightCharts = { ...window.__lc, createChart() { throw new Error('boom-from-test'); } }; return 1;`);
  await show('Market');
  check('a throw in the view shows the Market error boundary', !!(await waitFor(`return !!document.querySelector('[data-market-error]');`, 5000)));
  await show('Dashboard'); await wait(300);
  check('other tabs still work after it', await evaluate(`return !!document.querySelector('.stats-grid');`));
  await evaluate(`window.LightweightCharts = window.__lc; return 1;`);
  await show('Market');
  check('the Market tab works again afterwards', !!(await ready()));
  errors.splice(errorsBefore, errors.length - errorsBefore,
    ...errors.slice(errorsBefore).filter(e => !/boom-from-test|Market view error|above error occurred|componentStack/i.test(e)));

  console.log('\n[Market navigation]');
  await evaluate(`history.replaceState(null, '', '#market?range=1y'); return 1;`);
  await reload();
  check('#market?… opens the Market tab and keeps its suffix', await evaluate(`return !!document.querySelector('[data-market-view]') && location.hash.startsWith('#market?range=1y&');`),
    await evaluate(`return location.hash;`));
  await evaluate(`location.hash = '#wallets'; return 1;`); await wait(300);
  check('hash navigation to another tab still works', await evaluate(`return document.querySelector('.page-title').textContent === 'Settings' && location.hash === '#wallets'
    && document.querySelector('.sidebar-item.active')?.title === 'Settings'
    && document.querySelector('.settings-tab[aria-current="page"]')?.textContent.trim() === 'Wallets';`));
  await evaluate(`location.hash = '#dashboard?x=1'; return 1;`); await wait(300);
  check('other tabs still drop a ?suffix', await evaluate(`return document.querySelector('.page-title').textContent === 'Dashboard' && location.hash === '#dashboard';`),
    await evaluate(`return location.hash;`));
  await evaluate(`location.hash = '#market'; return 1;`);
  check('#market opens the Market tab', !!(await ready()));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(600);
  const bar = await evaluate(`const row = document.querySelector('.mobile-bottom-nav-row');
    return { labels: [...row.querySelectorAll('.mobile-bottom-nav-item')].map(b => b.getAttribute('aria-label')),
      overflow: row.scrollWidth > row.clientWidth, more: row.parentElement.dataset.more };`);
  check('bottom nav: Market is second', bar?.labels?.[1] === 'Market', JSON.stringify(bar));
  // With Wallets and Export moved into Settings the bar may fit outright; the fade must then stay off.
  check('bottom nav shows the trailing fade exactly when it overflows', bar?.more === (bar?.overflow ? '1' : '0'), JSON.stringify(bar));
  await evaluate(`const items = document.querySelectorAll('.mobile-bottom-nav-item'); items[items.length - 1].click(); return 1;`);
  await wait(900);
  const inView = await evaluate(`const row = document.querySelector('.mobile-bottom-nav-row'), items = row.querySelectorAll('.mobile-bottom-nav-item');
    const a = items[items.length - 1].getBoundingClientRect(), r = row.getBoundingClientRect();
    return { ok: a.left >= r.left - 1 && a.right <= r.right + 1, active: items[items.length - 1].classList.contains('active'), title: document.querySelector('.page-title').textContent };`);
  check('activating the last item scrolls it into view', inView?.ok && inView.active, JSON.stringify(inView));
  await evaluate(`[...document.querySelectorAll('.mobile-bottom-nav-item')][1].click(); return 1;`);
  check('bottom nav opens the Market tab', !!(await ready()));
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('\n[Market indicators, summary and preferences]');
  // A Drive session is faked so a data edit would stamp a commit and queue a push; a Market
  // preference must do neither.
  const STAMP = '2024-01-01T00:00:00.000Z';
  await evaluate(`history.replaceState(null, '', '#market?range=1y&interval=1d'); return 1;`);
  await reload();
  await ready(`c.dataset.range === '1Y'`);
  await evaluate(`GDriveSync.accessToken = 'stub'; GDriveSync.tokenExpiry = Date.now() + 3600e3;
    localStorage.setItem('btc-last-modified', '${STAMP}'); localStorage.removeItem('btc-pending-push'); return 1;`);
  const counts = () => evaluate(`const c = document.querySelector('.mkt-chart');
    return { overlays: +(c.dataset.overlays || 0), panes: +(c.dataset.panes || 1), legends: document.querySelectorAll('[data-pane-legend]').length, volume: c.dataset.volume };`);
  const inSheet = js => evaluate(`const s = document.querySelector('[data-market-sheet]'); if(!s) return 'no sheet'; ${js}`);
  const chip = (fam, label) => inSheet(`const b = [...s.querySelectorAll('[data-indicator="${fam}"] .mkt-chips button')].find(x => x.textContent === '${label}');
    if(!b) return 'missing'; b.click(); return 'clicked';`);
  const toggle = id => inSheet(`const b = s.querySelector('[data-indicator="${id}"] [role=switch]'); if(!b) return 'missing'; b.click(); return b.getAttribute('aria-checked');`);
  await evaluate(`document.querySelector('[data-open-indicators]').click(); return 1;`);
  await wait(300);
  check('Indicators opens a dialog with focus inside', await evaluate(`const s = document.querySelector('[data-market-sheet]');
    return !!s && s.getAttribute('role') === 'dialog' && s.contains(document.activeElement);`));
  check('grouped by category', (await inSheet(`return [...s.querySelectorAll('h3')].map(h => h.textContent).join(',');`)) === 'Trend,Momentum,Volatility,Volume');
  const steps = [
    ['SMA 50', () => chip('sma', '50'), { overlays: 1, panes: 1 }],
    ['EMA 21', () => chip('ema', '21'), { overlays: 2, panes: 1 }],
    ['Bollinger Bands', () => toggle('bollinger'), { overlays: 5, panes: 1 }],
    ['RSI', () => toggle('rsi'), { overlays: 5, panes: 2 }],
    ['MACD', () => toggle('macd'), { overlays: 5, panes: 3 }],
    ['ATR', () => toggle('atr'), { overlays: 5, panes: 4 }],
    ['Historical Volatility', () => toggle('volatility'), { overlays: 5, panes: 5 }],
  ];
  for (const [name, act, want] of steps) {
    await act();
    const got = await waitFor(`const c = document.querySelector('.mkt-chart');
      return +(c.dataset.overlays || 0) === ${want.overlays} && +(c.dataset.panes || 1) === ${want.panes};`, 4000) && await counts();
    check(`enabling ${name} adds its ${want.panes > 1 && name !== 'SMA 50' && !/EMA|Bollinger/.test(name) ? 'pane' : 'overlay'}`, !!got, JSON.stringify(await counts()));
  }
  await wait(400);
  check('each indicator pane has a title with a close button', (await counts()).legends === 4
    && await evaluate(`return [...document.querySelectorAll('[data-pane-legend] button')].map(b => b.getAttribute('aria-label')).join('|') === 'Hide RSI|Hide MACD|Hide ATR|Hide Historical Volatility';`));
  check('panes are panes of one chart (one time scale, one crosshair)', await evaluate(`return document.querySelectorAll('.mkt-chart .tv-lightweight-charts').length === 1;`));
  await toggle('volume');
  await wait(200);
  check('Volume can be hidden', (await counts()).volume === '0');
  const bad = await inSheet(`const i = s.querySelector('[data-indicator="macd"] input[name="macd-fast"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '40'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('focusout', { bubbles: true })); i.blur();
    return 1;`);
  await wait(200);
  check('an invalid setting shows a message and is not applied', bad === 1
    && /fast must be smaller than slow/i.test(await inSheet(`return s.querySelector('[data-indicator="macd"] [role=alert]')?.textContent || '';`))
    && (await evaluate(`return JSON.parse(localStorage.getItem('btc-settings')).market.indicators.macd.fast;`)) === 12);
  await press('Escape', 'Escape');
  await wait(300);
  check('Escape closes the sheet', !(await evaluate(`return !!document.querySelector('[data-market-sheet]');`)));
  const stored = await evaluate(`return JSON.parse(localStorage.getItem('btc-settings') || '{}').market;`);
  check('preferences are saved in settings.market', JSON.stringify(stored?.indicators?.sma?.periods) === '[50]' && stored?.indicators?.rsi?.on === true && stored?.volume === false, JSON.stringify(stored));
  check('the hash describes the view', (await evaluate(`return location.hash;`)) === '#market?range=1y&interval=1d&scale=linear&sma=50&ema=21&rsi=14&macd=12,26,9&bb=20,2&atr=14&hv=30&vol=0',
    await evaluate(`return location.hash;`));
  check('indicator changes did not stamp a commit', (await evaluate(`return localStorage.getItem('btc-last-modified');`)) === STAMP);
  check('indicator changes did not mark anything dirty', !(await evaluate(`return localStorage.getItem('btc-pending-push');`)));
  check('market is a device view setting, left out of sync comparisons', await evaluate(`return DEVICE_VIEW_SETTING_KEYS.includes('market')
    && !('market' in withoutViewSettings({ market: { range: '1D' }, defaultTxType: 'Buy' }))
    && keepLocalViewSettings({ market: { range: 'ALL' } }, { market: { range: '1D' } }).market.range === '1D';`));

  // Readout values are Indicators' output for the inspected candle, recomputed here from the same
  // cached candles; inspecting candles does not recompute indicators.
  const runsBefore = await evaluate(`return document.documentElement.dataset.marketIndicatorRuns;`);
  await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
  for (let i = 0; i < 6; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  }
  await wait(300);
  check('moving the crosshair does not recompute indicators', runsBefore && runsBefore === await evaluate(`return document.documentElement.dataset.marketIndicatorRuns;`),
    `${runsBefore} → ${await evaluate(`return document.documentElement.dataset.marketIndicatorRuns;`)}`);
  const readoutCheck = await evaluate(`
    const t = +document.querySelector('[data-readout]').dataset.t, from = +document.querySelector('.mkt-chart').dataset.from;
    const shown = {};
    for(const b of document.querySelectorAll('[data-readout-indicators] [data-ind]')) shown[b.dataset.ind + '/' + b.dataset.series] = b.dataset.value === '' ? null : +b.dataset.value;
    return MarketCandleStore.open().then(s => s.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d', fromSec: from, toSec: t + 1 })).then(cs => {
      const calc = (id, settings, key) => { const r = Indicators.calculateSegmented(id, cs, settings, '1d')[key]; return r[r.length - 1]; };
      const want = {
        'sma:50/sma': calc('sma', { period: 50 }, 'sma'), 'ema:21/ema': calc('ema', { period: 21 }, 'ema'),
        'bollinger/upper': calc('bollinger', {}, 'upper'), 'bollinger/lower': calc('bollinger', {}, 'lower'),
        'rsi/rsi': calc('rsi', {}, 'rsi'), 'macd/macd': calc('macd', {}, 'macd'), 'macd/signal': calc('macd', {}, 'signal'),
        'atr/atr': calc('atr', {}, 'atr'), 'volatility/volatility': calc('volatility', {}, 'volatility'),
      };
      const bad = Object.entries(want).filter(([k, v]) => !(v != null && shown[k] != null && Math.abs(shown[k] - v) <= 1e-9 * Math.abs(v)));
      return { ok: cs[cs.length - 1].t === t && bad.length === 0, bad, n: cs.length };
    });`);
  check('readout indicator values equal Indicators output at the inspected candle', readoutCheck?.ok, JSON.stringify(readoutCheck));
  await press('Escape', 'Escape');
  await wait(200);
  check('values on the forming candle are marked provisional', /provisional/.test(await evaluate(`return document.querySelector('[data-readout-indicators]').textContent;`)));

  // Summary: the same figures recomputed from the daily candles held on this device.
  const summary = await waitFor(`const d = document.querySelector('[data-summary="sma200"]'), h = document.querySelector('[data-summary="high"]');
    return d && h && d.dataset.value !== '' && h.dataset.value !== '' && d.dataset.value;`, 30000);
  const sumCheck = await evaluate(`
    const val = k => { const d = document.querySelector('[data-summary="' + k + '"]'); return d && d.dataset.value !== '' ? +d.dataset.value : null; };
    const now = Date.now() / 1000;
    return MarketCandleStore.open().then(s => s.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d' })).then(all => {
      const cs = all.filter(c => c.t + 86400 <= now);
      const last = (id, settings, key) => { const r = Indicators.calculateSegmented(id, cs, settings, '1d')[key]; return r[r.length - 1]; };
      const want = { sma50: last('sma', { period: 50 }, 'sma'), sma200: last('sma', { period: 200 }, 'sma'), rsi14: last('rsi', { period: 14 }, 'rsi'),
        atr14: last('atr', { period: 14 }, 'atr'), hv30: last('volatility', { period: 30 }, 'volatility') };
      const bad = Object.entries(want).filter(([k, v]) => !(v != null && val(k) != null && Math.abs(val(k) - v) <= 1e-9 * Math.abs(v)));
      const text = document.querySelector('[data-market-view]').innerText;
      return { ok: bad.length === 0, bad, athLabel: /All-Time High/.test(text) && /Current Drawdown/.test(text), noHighSince: !/High since/.test(text),
        dd: val('drawdownFromHigh'), high: val('high') };
    });`);
  check('summary daily figures match Indicators on the cached daily candles', !!summary && sumCheck?.ok, JSON.stringify(sumCheck));
  // Phase 8 verified the ATH seed (Bitstamp, 2013-11-30), which is what allows this wording.
  check('with the verified seed the high is labelled "All-Time High"', sumCheck?.athLabel && sumCheck?.noHighSince, JSON.stringify(sumCheck));
  check('drawdown from that high is price / high − 1', sumCheck?.high > 0 && Math.abs(sumCheck.dd - (60000 / sumCheck.high - 1)) < 1e-9, JSON.stringify(sumCheck));

  console.log('\n[Market preferences persist; the URL configures the view]');
  await evaluate(`history.replaceState(null, '', '#dashboard'); return 1;`);
  await reload();
  await show('Market');
  await ready();
  await waitFor(`return +(document.querySelector('.mkt-chart').dataset.panes || 1) === 5;`, 5000);
  check('indicators survive a reload', JSON.stringify(await counts()) === JSON.stringify({ overlays: 5, panes: 5, legends: 4, volume: '0' }), JSON.stringify(await counts()));
  check('…and so does the hash they produce', (await evaluate(`return location.hash;`)).includes('&sma=50&ema=21&rsi=14&'));
  await evaluate(`history.replaceState(null, '', '#market?range=3m&interval=1d&scale=log&rsi=9&vol=1'); return 1;`);
  await reload();
  c = await ready(`c.dataset.range === '3M'`) && await chart();
  await waitFor(`return +(document.querySelector('.mkt-chart').dataset.panes || 1) === 2;`, 5000);
  check('a hash with parameters configures range, interval and scale', c?.interval === '1d' && c.scale === 'log', JSON.stringify(c));
  check('…and the indicator set (RSI 9 only)', JSON.stringify(await counts()) === JSON.stringify({ overlays: 0, panes: 2, legends: 1, volume: '1' })
    && /RSI 9/.test(await evaluate(`return document.querySelector('[data-readout-indicators]').textContent;`)), JSON.stringify(await counts()));
  check('opening a link does not overwrite the saved preferences',
    await evaluate(`const m = JSON.parse(localStorage.getItem('btc-settings')).market; return m.range === '1Y' && m.indicators.sma.periods[0] === 50;`));
  await evaluate(`location.hash = '#market?range=1m&sma=20'; return 1;`);
  c = await ready(`c.dataset.range === '1M'`) && await chart();
  check('a hash edited by hand is applied', c?.range === '1M' && JSON.stringify(await counts()) === JSON.stringify({ overlays: 1, panes: 1, legends: 0, volume: '1' }), JSON.stringify([c, await counts()]));
  // (1h, not 1M's default 4h: the 1h chosen for 1M earlier in this run is a saved preference)
  check('the URL holds only view parameters', /^#market\?range=1m&interval=1h&scale=log&sma=20&vol=1$/.test(await evaluate(`return location.hash;`)), await evaluate(`return location.hash;`));

  // Narrow screen: two indicator panes; a third is refused with a reason.
  await evaluate(`location.hash = '#market?range=1y&rsi=14&macd=12,26,9&atr=14'; return 1;`);
  await ready(`c.dataset.range === '1Y'`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(800);
  check('a phone shows at most two indicator panes', await evaluate(`return document.querySelector('.mkt-chart-wrap').dataset.panes === '2' && document.querySelector('[data-hidden-panes]')?.dataset.hiddenPanes === '1';`));
  await evaluate(`document.querySelector('[data-open-indicators]').click(); return 1;`);
  await wait(300);
  await toggle('volatility');
  await wait(200);
  check('enabling a third pane on a phone is refused with a reason', !!(await inSheet(`return s.querySelector('[data-pane-limit]')?.textContent;`))
    && (await inSheet(`return s.querySelector('[data-indicator="volatility"] [role=switch]').getAttribute('aria-checked');`)) === 'false');
  await press('Escape', 'Escape');
  await wait(200);
  await send('Emulation.clearDeviceMetricsOverride');

  // Malformed settings.market from a backup or Drive must not break the tab.
  for (const market of ['x', [1, 2], { range: 5, intervals: 'a', indicators: { sma: 'x', macd: { on: true, fast: 'a' }, rsi: null } }]) {
    await seed({ 'btc-tx-v2': [tx({ id: 'mkt1' })], 'btc-wallets': WALLETS, 'btc-settings': { market } });
    await evaluate(`history.replaceState(null, '', '#market'); return 1;`);
    await reload();
    check(`malformed settings.market ${JSON.stringify(market).slice(0, 40)} still draws the chart`, !!(await ready())
      && !(await evaluate(`return !!document.querySelector('[data-market-error]');`)));
  }

  // ── Phase 7: the user's transactions on the chart ──
  console.log('\n[Market transaction markers]');
  const NOW = Math.floor(Date.now() / 1000), TODAY = NOW - NOW % DAY;
  const at = (daysAgo, hh, mm) => new Date((TODAY - daysAgo * DAY + hh * 3600 + mm * 60) * 1000).toISOString();
  const dayOf = daysAgo => new Date((TODAY - daysAgo * DAY) * 1000).toISOString().slice(0, 10);
  const PTX = [
    tx({ id: 'pb1', date: dayOf(200), datetimeUtc: at(200, 14, 30), sequence: 0, amount: '0.10000000', price: '50000', totalUsd: '5000', fee: '10' }),
    tx({ id: 'pb2', date: dayOf(70), datetimeUtc: at(70, 9, 15), sequence: 0, amount: '0.05', price: '52000', totalUsd: '2600', fee: '5' }),
    tx({ id: 'pb3', date: dayOf(70), datetimeUtc: at(70, 18, 0), sequence: 0, amount: '0.02', price: '48000', totalUsd: '960', fee: '' }),
    tx({ id: 'pd1', date: dayOf(150), amount: '0.01', price: '', totalUsd: '' }), // date only, no price: an estimated position
    tx({ id: 'pr1', type: 'Reward', date: dayOf(60), datetimeUtc: at(60, 8, 0), sequence: 0, amount: '0.001', price: '', totalUsd: '',
      usdValueAtReceipt: '55.000000', usdValueSource: 'manual', rewardCategory: 'cash_back' }),
    tx({ id: 'ps1', type: 'Sell', date: dayOf(30), datetimeUtc: at(30, 16, 0), sequence: 0, amount: '0.03', price: '60000', totalUsd: '1800', fee: '3', notes: 'trim' }),
    tx({ id: 'pt1', type: 'Transfer', date: dayOf(20), datetimeUtc: at(20, 10, 0), sequence: 0, wallet: 'Kraken', wallet2: 'Ledger', amount: '0.05', price: '', totalUsd: '', fee: '0.0001' }),
  ];
  // Average Acquisition Price by hand: buys with their fees plus the reward at receipt; the
  // date-only buy has no value and is left out of both sides; the sale changes nothing.
  const AAP = (5000 + 10 + 2600 + 5 + 960 + 55) / ((10_000_000 + 5_000_000 + 2_000_000 + 100_000) / 1e8);
  const FINAL_SATS = 10_000_000 + 5_000_000 + 2_000_000 + 1_000_000 + 100_000 - 3_000_000 - 10_000; // the transfer costs its fee only
  const dayStartOf = s => s - (s % DAY);
  const markerCount = () => evaluate(`return +(document.querySelector('.mkt-chart').dataset.markers || 0);`);
  const key = async (k, code, vk, shift = false) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0, ...(k === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
  };
  // Inspect the daily candle `daysAgo` before today, then press Enter on it.
  const enterOnDay = async daysAgo => {
    await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
    await key('End', 'End', 35);
    await wait(100);
    for (let i = 0; i < Math.floor(daysAgo / 10); i++) await key('ArrowLeft', 'ArrowLeft', 37, true);
    for (let i = 0; i < daysAgo % 10; i++) await key('ArrowLeft', 'ArrowLeft', 37);
    await wait(150);
    await key('Enter', 'Enter', 13);
    await wait(300);
  };
  const txSheet = js => evaluate(`const s = document.querySelector('[data-market-sheet]'); if(!s) return 'no sheet'; ${js}`);
  const txSwitch = name => txSheet(`const b = s.querySelector('[data-tx-filter="${name}"] [role=switch]'); if(!b) return 'missing'; b.click(); return b.getAttribute('aria-checked');`);
  const openTxOptions = async () => { await evaluate(`document.querySelector('[data-open-tx-options]').click(); return 1;`); await wait(250); };
  const closeSheet = async () => { await press('Escape', 'Escape'); await wait(250); };

  await seed({ 'btc-tx-v2': PTX, 'btc-wallets': WALLETS });
  await evaluate(`history.replaceState(null, '', '#market'); return 1;`);
  requests.length = 0; // from here on, every request is judged for privacy
  await reload();
  await ready(`c.dataset.range === '1Y'`);
  const keysBefore = await evaluate(`return Object.keys(localStorage).sort().join(',');`);
  check('buys, rewards and sales are marked; the transfer is hidden by default',
    await waitFor(`return +(document.querySelector('.mkt-chart').dataset.markers || 0) === 5;`, 8000), await markerCount());
  await openTxOptions();
  check('transfers are off in the filter by default', (await txSheet(`return s.querySelector('[data-tx-filter="transfers"] [role=switch]').getAttribute('aria-checked');`)) === 'false');
  // BTC Acquired counts every purchase's satoshis, the value-unknown one included (0.18 BTC).
  const acquiredOff = await evaluate(`return document.querySelector('[data-personal="rAcquired"]')?.dataset.value;`);
  await txSwitch('transfers'); await wait(250);
  check('enabling Transfers adds the transfer marker', (await markerCount()) === 6, await markerCount());
  check('a shown transfer is never counted as acquired or sold', acquiredOff === '18000000'
    && (await evaluate(`return document.querySelector('[data-personal="rAcquired"]').dataset.value + '/' + document.querySelector('[data-personal="rSold"]').dataset.value;`)) === '18000000/3000000',
    await evaluate(`return document.querySelector('[data-personal="rAcquired"]').dataset.value + '/' + document.querySelector('[data-personal="rSold"]').dataset.value;`));
  await txSwitch('transfers'); await txSwitch('purchases'); await wait(250);
  check('turning Purchases off leaves the reward and the sale', (await markerCount()) === 2, await markerCount());
  await txSwitch('purchases');
  await txSheet(`s.querySelector('[data-wallet="Kraken"]').click(); return 1;`); await wait(250);
  check('a wallet filter (Ledger only) hides Kraken rows and labels the scope', (await markerCount()) === 0
    && await evaluate(`return /Selected wallets/.test(document.querySelector('[data-my-activity]').textContent);`));
  await txSheet(`s.querySelector('[data-wallet-all]').click(); return 1;`); await wait(150);
  await txSwitch('showTx'); await wait(250);
  check('Show My Transactions off removes every marker', (await markerCount()) === 0);
  await txSwitch('showTx'); await wait(250);
  check('…and on brings them back', (await markerCount()) === 5, await markerCount());
  await closeSheet();

  console.log('\n[Market marker aggregation and detail]');
  await enterOnDay(70);
  check('two purchases in one daily candle are one marker listing two members',
    (await evaluate(`return document.querySelector('[data-marker-members]')?.dataset.markerMembers;`)) === '2',
    await evaluate(`return document.querySelector('[data-market-sheet]')?.textContent;`));
  await closeSheet();
  await radio('Range', '3M');
  await ready(`c.dataset.range === '3M' && c.dataset.interval === '4h'`);
  await wait(300);
  check('at 4h the two purchases separate (3M: two buys, the reward, the sale)', (await markerCount()) === 4, await markerCount());
  await radio('Interval', '1d');
  await ready(`c.dataset.interval === '1d'`); await wait(300);
  check('…and merge again at 1d', (await markerCount()) === 3, await markerCount());
  await radio('Range', '1Y');
  await ready(`c.dataset.range === '1Y'`); await wait(300);

  await enterOnDay(200);
  const d1 = await evaluate(`const d = document.querySelector('[data-tx-detail]'); if(!d) return null;
    const v = k => d.querySelector('[data-detail="' + k + '"]')?.textContent || '';
    return { id: d.dataset.txDetail, amount: v('amount'), usd: v('usd'), price: v('price'), allIn: d.textContent.includes('Cost per BTC including fees') ? v('allIn') : '',
      wallet: v('wallet'), fee: v('fee'), focus: d.closest('[data-market-sheet]').contains(document.activeElement) };`);
  check('a single marker opens its detail panel', d1?.id === 'pb1' && d1.focus, JSON.stringify(d1));
  check('detail shows BTC, satoshis, USD value, price and its source', d1 && /^0\.10000000 BTC/.test(d1.amount) && /10,000,000 sats/.test(d1.amount)
    && d1.usd === '$5,000.00' && /^\$50,000\.00Recorded price \(before fees\)$/.test(d1.price), JSON.stringify(d1));
  check('detail shows the all-in figure, wallet and fee', d1?.allIn === '$50,100.00' && d1.wallet === 'Kraken' && d1.fee === '$10.00', JSON.stringify(d1));
  check('the selected marker is summarised in the readout', /Selected: 1 Purchase/.test(await evaluate(`return document.querySelector('[data-readout-marker]')?.textContent || '';`)));
  await closeSheet();
  await enterOnDay(60);
  check('a reward shows its value at receipt as the price source', /Value at receipt \(entered by hand\)/.test(await evaluate(`return document.querySelector('[data-detail="price"]')?.textContent || '';`)));
  await closeSheet();
  await enterOnDay(150);
  const est = await evaluate(`const d = document.querySelector('[data-tx-detail]'); return d ? d.dataset.txDetail + '|' + d.textContent : '';`);
  check('a date-only row without a price is an estimated position, its time "not recorded"', /^pd1\|/.test(est) && /Time not recorded/.test(est)
    && /(Estimated from that day’s closing price|Estimated from that day's closing price|Price unknown)/.test(est), est);
  check('…drawn differently: the readout says the position is estimated', /position estimated/.test(await evaluate(`return document.querySelector('[data-readout-marker]')?.textContent || '';`)));
  await closeSheet();

  // A real click on the sale's marker: the crosshair finds its candle's x, then a vertical sweep.
  const saleT = TODAY - 30 * DAY;
  const box = await evaluate(`const r = document.querySelector('.mkt-chart').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  let lo = box.x + 5, hi = box.x + box.w - 70, sx = null;
  for (let i = 0; i < 20 && sx == null; i++) {
    const mid = (lo + hi) / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid, y: box.y + box.h * 0.3 });
    await wait(40);
    const t = await evaluate(`return +document.querySelector('[data-readout]').dataset.t;`);
    if (t === saleT) sx = mid; else if (t < saleT) lo = mid; else hi = mid;
  }
  let clicked = false;
  for (let y = box.y + 4; sx != null && y < box.y + box.h * 0.66 && !clicked; y += 6) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y, button: 'left', clickCount: 1 });
    await wait(60);
    clicked = (await evaluate(`return document.querySelector('[data-tx-detail]')?.dataset.txDetail || '';`)) === 'ps1';
  }
  check('clicking the sale marker opens its detail', clicked, `x=${sx}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); // off the chart, so the crosshair follows the keyboard
  check('the sale shows its net per BTC after fees and notes', /Net per BTC after fees/.test(await evaluate(`return document.querySelector('[data-tx-detail]')?.textContent || '';`))
    && (await evaluate(`return document.querySelector('[data-detail="notes"]')?.textContent;`)) === 'trim');

  console.log('\n[Market ↔ Transactions navigation]');
  await evaluate(`document.querySelector('[data-view-transaction]').click(); return 1;`);
  await wait(500);
  const edit = await evaluate(`const m = document.querySelector('.modal[role=dialog]'); return { title: document.querySelector('.page-title').textContent,
    modal: m ? m.querySelector('.modal-title')?.textContent : null, amount: [...m.querySelectorAll('input')].find(i => i.value === '0.03') ? 'ok' : 'missing' };`);
  check('"View Transaction" opens the existing edit dialog for that transaction', edit.title === 'Transactions' && edit.modal === 'Edit Transaction' && edit.amount === 'ok', JSON.stringify(edit));
  await press('Escape', 'Escape'); await wait(300);
  // The Dashboard's own price-history fetch (pre-existing, outside Market) has finished by now;
  // what follows is the Market's response to "View on Chart".
  const focusFrom = requests.length;
  await evaluate(`document.querySelector('.tx-table-wrap [data-view-on-chart="ps1"]').click(); return 1;`);
  const landed = await waitFor(`const d = document.querySelector('[data-tx-detail]'); return d && d.dataset.txDetail;`, 20000);
  const after = await chart();
  check('"View on Chart" lands on the Market tab with that transaction open', landed === 'ps1' && after?.range === '3M', JSON.stringify([landed, after]));
  check('…its marker highlighted', /Selected: 1 Sale/.test(await evaluate(`return document.querySelector('[data-readout-marker]')?.textContent || '';`)));
  const hash = await evaluate(`return location.hash;`);
  check('the URL carries no transaction id, amount, wallet or date', /^#market\?range=3m&interval=4h&scale=linear&vol=1$/.test(hash), hash);
  const focusWindows = candleWindows().slice(candleWindows().length - requests.slice(focusFrom).filter(u => u.includes('/candles?')).length);
  check('every candle request "View on Chart" made is page-aligned', focusWindows.length > 0 && allPageAligned(focusWindows), JSON.stringify(focusWindows.slice(0, 3)));
  const txDays = new Set(PTX.map(t => Date.parse(t.date + 'T00:00:00Z') / 1000));
  const onTxDay = candleWindows().filter(w => txDays.has(w.start) || txDays.has(w.end) || txDays.has(dayStartOf((w.start + w.end) / 2)));
  check('no candle request starts, ends or is centred on a transaction day', onTxDay.length === 0, JSON.stringify(onTxDay.slice(0, 2)));
  await closeSheet();

  console.log('\n[Market Average Acquisition Price, balance, hide values]');
  await radio('Range', '1Y'); await ready(`c.dataset.range === '1Y'`);
  const aap = await evaluate(`return +document.querySelector('[data-personal="aap"]').dataset.value;`);
  check('Average Acquisition Price equals the hand computation', Math.abs(aap - AAP) < 1e-6, `${aap} vs ${AAP}`);
  const diff = await evaluate(`return +document.querySelector('[data-personal="diffPct"]').dataset.value;`);
  check('"Difference" is current price over it, minus one', Math.abs(diff - (60000 / AAP - 1)) < 1e-9
    && await evaluate(`return [...document.querySelectorAll('[data-my-activity] dt')].some(d => d.textContent === 'Difference');`), diff);
  await evaluate(`document.querySelector('[data-personal="aap"]').closest('.mkt-stat').querySelector('.info-tip-btn').click(); return 1;`);
  await wait(150);
  const help = await evaluate(`return document.querySelector('[role=tooltip]')?.textContent;`);
  check('the help text is the specified wording', help === 'An analytical weighted average of what your BTC cost to acquire — purchases at what you paid including fees, rewards at their USD value when received. Sales do not change it. It is not tax cost basis; see Harvest for tax lots and the Dashboard for Average Cost.', help);
  await evaluate(`document.querySelector('[data-personal="aap"]').closest('.mkt-stat').querySelector('.info-tip-btn').click(); document.activeElement.blur(); return 1;`);
  await wait(150);
  const words = await evaluate(`return (document.querySelector('[data-market-view]').innerText.match(/\\bcost basis\\b|\\bgains?\\b|\\bloss(es)?\\b/gi) || []).join(',');`);
  check('"cost basis", "gain" and "loss" do not appear in the Market tab', words === '', words);
  const overlaysBefore = (await counts()).overlays;
  await openTxOptions();
  await txSheet(`[...s.querySelectorAll('[aria-label="Average Acquisition Price line"] [role=radio]')].find(b => b.textContent === 'Historical').click(); return 1;`);
  await wait(250);
  check('the Average Acquisition Price line can be drawn', (await counts()).overlays === overlaysBefore + 1, JSON.stringify(await counts()));
  await txSwitch('balancePane'); await wait(600);
  await closeSheet();
  const bal = await evaluate(`const l = document.querySelector('[data-pane-legend="balance"] [data-balance-sats]'); return l ? +l.dataset.balanceSats : null;`);
  check('the BTC Balance pane ends at total holdings, in whole satoshis', bal === FINAL_SATS, `${bal} vs ${FINAL_SATS}`);
  const holdings = await evaluate(`return PersonalMarket.balanceHistory(JSON.parse(localStorage.getItem('btc-tx-v2'))).at(-1).sats;`);
  check('…and matches the balance rules over the stored transactions', holdings === FINAL_SATS, holdings);
  await evaluate(`document.querySelector('button[aria-label="Hide financial values"]').click(); return 1;`);
  await wait(250);
  const blur = await evaluate(`const f = el => getComputedStyle(el).filter;
    return { aap: f(document.querySelector('[data-personal="aap"]')), bal: f(document.querySelector('[data-pane-legend="balance"] b')),
      chart: f(document.querySelector('.mkt-chart')), price: f(document.querySelector('[data-personal="price"]')) };`);
  check('hide values blurs personal figures and leaves the chart visible', /blur/.test(blur.aap) && /blur/.test(blur.bal) && blur.chart === 'none' && blur.price === 'none', JSON.stringify(blur));
  await enterOnDay(30);
  const detailBlur = await waitFor(`const a = document.querySelector('[data-detail="amount"]'); return a && getComputedStyle(a).filter;`, 3000)
    || await evaluate(`return 'no detail; t=' + document.querySelector('[data-readout]').dataset.t + ' active=' + document.activeElement?.className;`);
  check('…including in the detail panel', /blur/.test(detailBlur), detailBlur);
  await closeSheet();
  await evaluate(`document.querySelector('button[aria-label="Show financial values"]').click(); return 1;`);

  // ── Phase 8: market context at a transaction, acquisition tables ──
  console.log('\n[Market context at a transaction and acquisition tables]');
  await show('Transactions'); await wait(300);
  await evaluate(`document.querySelector('.tx-table-wrap [data-view-on-chart="pb1"]').click(); return 1;`);
  await waitFor(`return document.querySelector('[data-tx-detail]')?.dataset.txDetail === 'pb1';`, 20000);
  const ctxReady = await waitFor(`return document.querySelector('[data-tx-context]')?.dataset.txContext === 'ready';`, 40000);
  check('the purchase detail shows a market context block once daily history is held', !!ctxReady,
    await evaluate(`return document.querySelector('[data-tx-context]')?.dataset.txContext || (document.querySelector('[data-market-sheet]') ? 'no context block' : 'no detail');`));
  const ctxCheck = await evaluate(`
    if(!document.querySelector('[data-tx-context]')) return { ok: false, missing: true };
    const T = Date.parse('${PTX[0].datetimeUtc}') / 1000, price = 50000;
    const shown = {};
    for(const d of document.querySelectorAll('[data-context]')) shown[d.dataset.context] = d.dataset.value === '' ? null : d.dataset.value;
    const refT = +document.querySelector('[data-tx-context]').dataset.refT;
    return MarketCandleStore.open().then(s => s.getCandles({ provider: 'coinbase', symbol: 'BTC-USD', interval: '1d' })).then(all => {
      const cs = all.filter(c => c.t + 86400 <= T);   // only candles that had closed before the purchase
      const last = (id, settings, key) => { const r = Indicators.calculateSegmented(id, cs, settings, '1d')[key]; return r[r.length - 1]; };
      const high = Math.max(Indicators.ATH_SEED.price, ...cs.map(c => c.h));
      const want = { sma20: last('sma', { period: 20 }, 'sma'), sma50: last('sma', { period: 50 }, 'sma'), sma200: last('sma', { period: 200 }, 'sma'),
        rsi14: last('rsi', { period: 14 }, 'rsi'), macd: last('macd', {}, 'macd'), atr14: last('atr', { period: 14 }, 'atr'),
        bollinger: last('bollinger', {}, 'middle'), hv30: last('volatility', { period: 30 }, 'volatility'),
        high, drawdown: price / high - 1, trend: String(last('sma', { period: 50 }, 'sma') > last('sma', { period: 200 }, 'sma')) };
      const bad = Object.entries(want).filter(([k, v]) => typeof v === 'string' ? shown[k] !== v
        : !(v != null && shown[k] != null && Math.abs(+shown[k] - v) <= 1e-9 * Math.abs(v)));
      return { ok: bad.length === 0 && refT === cs[cs.length - 1].t && refT === T - T % 86400 - 86400, bad, refT, n: cs.length };
    });`);
  check('context values equal Indicators on the daily candles closed before the transaction', ctxCheck?.ok, JSON.stringify(ctxCheck));
  const ctxText = await evaluate(`return document.querySelector('[data-tx-context]')?.innerText || '';`);
  check('context uses the verified seed\'s wording ("Previous ATH")', /Previous ATH/.test(ctxText) && /Drawdown from Previous ATH/.test(ctxText), ctxText);
  check('the panel grades nothing', !/\b(good|bad|smart|early|late|cheap|expensive|buy signal|sell signal|recommend\w*|should)\b/i.test(ctxText), ctxText);
  await closeSheet();

  const tables = await waitFor(`const b = document.querySelector('[data-acq-tables]'); if(!b || b.querySelector('[data-loading]')) return null;
    return { total: +b.dataset.totalSats, ids: [...b.querySelectorAll('[data-acq-table]')].map(t => t.dataset.acqTable),
      sums: [...b.querySelectorAll('[data-acq-table]')].map(t => [...t.querySelectorAll('tbody tr')].reduce((s, r) => s + +r.dataset.sats, 0)),
      unknownRows: [...b.querySelectorAll('[data-acq-table]')].map(t => !!t.querySelector('tr[data-bucket="unknown"]')),
      accessible: [...b.querySelectorAll('table')].every(t => t.querySelector('caption') && t.querySelectorAll('th[scope=col]').length === 5),
      text: b.innerText };`, 20000);
  const ACQUIRED = 10_000_000 + 5_000_000 + 2_000_000 + 1_000_000 + 100_000; // buys (the value-unknown one included) + the reward
  check('six acquisition tables are shown as accessible tables', JSON.stringify(tables?.ids) === '["price","sma50","sma200","trend","rsi","drawdown"]'
    && tables.accessible && tables.unknownRows.every(Boolean), JSON.stringify(tables && { ids: tables.ids, accessible: tables.accessible }));
  check('every table totals the acquired BTC exactly, Unknown included', tables?.total === ACQUIRED && tables.sums.every(s => s === ACQUIRED),
    JSON.stringify(tables && { total: tables.total, sums: tables.sums }));
  check('the drawdown table uses the verified-seed wording', /Drawdown from Previous ATH/.test(tables?.text || ''), tables?.text);
  check('the tables grade nothing', !/\b(good|bad|smart|cheap|expensive|buy signal|sell signal|recommend\w*|should)\b/i.test(tables?.text || ''));
  await evaluate(`document.querySelector('button[aria-label="Hide financial values"]').click(); return 1;`);
  await wait(200);
  check('hide values blurs the table figures', /blur/.test(await evaluate(`return getComputedStyle(document.querySelector('[data-acq-table] tbody td')).filter;`)));
  await evaluate(`document.querySelector('button[aria-label="Show financial values"]').click(); return 1;`);

  console.log('\n[Market personal data stays local]');
  // The app's own price caches and its existing settings key may appear meanwhile; nothing else may.
  const newKeys = (await evaluate(`return Object.keys(localStorage).sort().join(',');`)).split(',')
    .filter(k => !keysBefore.split(',').includes(k) && !['btc-last-spot', 'btc-price-history-v1', 'btc-settings'].includes(k));
  check('no new localStorage key', newKeys.length === 0, newKeys.join(','));
  const stored7 = await evaluate(`return JSON.stringify(JSON.parse(localStorage.getItem('btc-settings')).market);`);
  check('settings.market holds no transaction data', !/pb1|ps1|pr1|0\.03|trim/.test(stored7), stored7);
  const idb = await evaluate(`return new Promise(res => { const r = indexedDB.open('satledger-market'); r.onsuccess = () => {
      const db = r.result, out = []; const t = db.transaction([...db.objectStoreNames], 'readonly');
      for(const n of db.objectStoreNames) t.objectStore(n).getAll().onsuccess = e => out.push(JSON.stringify(e.target.result));
      t.oncomplete = () => { db.close(); res(out.join('')); }; }; r.onerror = () => res(''); });`);
  check('IndexedDB holds no transaction data', idb.length > 0 && !/pb1|ps1|Kraken|Ledger|trim/.test(idb));
  const leaked = requests.filter(u => /pb\d|ps1|pr1|pd1|pt1|Kraken|Ledger|trim/.test(decodeURIComponent(u)));
  check('no request carries a transaction id, wallet or note', leaked.length === 0, leaked.slice(0, 2).join(' '));

  // Editing and deleting update the markers without a reload.
  await show('Transactions'); await wait(300);
  await evaluate(`document.querySelector('.tx-table-wrap button[title="Delete"][aria-label*="Sell"]').click(); return 1;`);
  await wait(300);
  await show('Market'); await ready(); await wait(400);
  check('a deleted sale is no longer marked', (await markerCount()) === 4 && (await evaluate(`return document.querySelector('[data-personal="rSold"]').dataset.value;`)) === '0', await markerCount());

  console.log('\n[Market with no transactions]');
  await seed({ 'btc-tx-v2': [], 'btc-wallets': WALLETS });
  await evaluate(`history.replaceState(null, '', '#market'); return 1;`);
  await reload();
  check('the chart works with no transactions', !!(await ready()) && (await markerCount()) === 0);
  check('My Activity shows an empty state', await evaluate(`return document.querySelector('[data-my-activity]')?.dataset.myActivity === 'empty';`));

  console.log('\n[Market chart library fails to load]');
  failVendor = true;
  await send('Network.setCacheDisabled', { cacheDisabled: true }); // the file must be requested again
  await evaluate(`history.replaceState(null, '', '#market'); return 1;`);
  await reload();
  const libState = await waitFor(`const c = document.querySelector('.mkt-chart'); return c && c.dataset.state === 'library-error' && c.dataset.state;`, 10000);
  check('library failure shows an error with Retry', libState === 'library-error'
    && await evaluate(`return [...document.querySelectorAll('.mkt-overlay button')].some(b => b.textContent === 'Retry');`), libState);
  await show('Transactions'); await wait(300);
  check('the rest of the app still works', await evaluate(`return document.querySelector('.page-title').textContent === 'Transactions' && !/Something went wrong/.test(document.body.innerText);`));
  failVendor = false;
  await show('Market'); await wait(300);
  await evaluate(`[...document.querySelectorAll('.mkt-overlay button')].find(b => b.textContent === 'Retry')?.click(); return 1;`);
  check('Retry loads the library and draws the chart', !!(await ready()));

  // ── Phase 9: phones, keyboard, screen readers, offline, load ──
  const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
  const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } };
  const phone = async (m = PHONE) => {
    await send('Emulation.setDeviceMetricsOverride', { ...m, screenOrientation: m.screenOrientation || { type: 'portraitPrimary', angle: 0 } });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await wait(700);
  };
  const desktop = async () => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');
    await wait(500);
  };
  const chartBox = () => evaluate(`const r = document.querySelector('.mkt-chart').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  const swipe = async (x, y, dx, dy, steps = 10) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(x), y: Math.round(y) }] });
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x + dx * i / steps), y: Math.round(y + dy * i / steps) }] });
      await wait(16);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const visible = () => evaluate(`const v = (document.querySelector('.mkt-chart').dataset.visible || '').split(',').map(Number); return v.length === 2 ? { from: v[0], to: v[1] } : null;`);

  console.log('\n[Market on a phone, portrait]');
  await seed({ 'btc-tx-v2': PTX, 'btc-wallets': WALLETS });
  await evaluate(`history.replaceState(null, '', '#market?range=1y&interval=1d&rsi=14&macd=12,26,9&atr=14'); return 1;`);
  await phone();
  await reload();
  await ready(`c.dataset.range === '1Y'`);
  await wait(500);
  const nav = await evaluate(`const row = document.querySelector('.mobile-bottom-nav-row'), a = row.querySelector('.mobile-bottom-nav-item.active');
    const r = row.getBoundingClientRect(), b = a.getBoundingClientRect();
    return { label: a.getAttribute('aria-label'), inView: b.left >= r.left - 1 && b.right <= r.right + 1, scrolls: row.scrollWidth > row.clientWidth };`);
  check('bottom nav scrolls and the active Market item is in view', nav?.label === 'Market' && nav.inView && nav.scrolls, JSON.stringify(nav));
  const tbar = await evaluate(`const t = document.querySelector('.mkt-scroll[role=toolbar]'), r = t.getBoundingClientRect();
    const btns = [...t.querySelectorAll('button')].filter(b => b.offsetParent);
    const small = btns.map(b => b.getBoundingClientRect()).filter(x => x.width < 44 || x.height < 44).length;
    let tight = 0; // neighbours closer than 8 px
    const rects = btns.map(b => b.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    for(let i = 1; i < rects.length; i++) if(rects[i].left - rects[i - 1].right < 7.5) tight++;
    return { scrolls: t.scrollWidth > t.clientWidth, oneRow: r.height < 60, small, tight, pageScrollsSideways: document.documentElement.scrollWidth > innerWidth };`);
  check('the toolbar is one sideways-scrolling row', tbar?.scrolls && tbar.oneRow, JSON.stringify(tbar));
  check('every toolbar control is at least 44 × 44 px with 8 px between them', tbar?.small === 0 && tbar.tight === 0, JSON.stringify(tbar));
  check('the page itself does not scroll sideways', tbar?.pageScrollsSideways === false);
  check('portrait shows at most two panes', await evaluate(`return document.querySelector('.mkt-chart-wrap').dataset.panes === '2';`));

  // Indicator sheet: focus trapped, closed by drag, backdrop and button.
  const sheetOpen = () => evaluate(`return !!document.querySelector('[data-market-sheet]');`);
  await evaluate(`const b = document.querySelector('[data-open-indicators]'); b.focus(); b.click(); return 1;`); await wait(300);
  let escaped = false;
  for (let i = 0; i < 40; i++) {
    await press('Tab', 'Tab');
    if (!(await evaluate(`return !!document.activeElement.closest('[data-market-sheet]');`))) { escaped = true; break; }
  }
  const sheetGeo = await evaluate(`const s = document.querySelector('[data-market-sheet]').getBoundingClientRect(); return { b: s.bottom, w: s.width, h: s.height, iw: innerWidth, ih: innerHeight };`);
  check('the indicator sheet is a bottom sheet that traps focus', !escaped && Math.abs(sheetGeo.b - sheetGeo.ih) < 2 && Math.abs(sheetGeo.w - sheetGeo.iw) < 2 && sheetGeo.h <= sheetGeo.ih * 0.86, JSON.stringify({ escaped, ...sheetGeo }));
  const grip = await evaluate(`const g = document.querySelector('[data-sheet-handle]').getBoundingClientRect(); return { x: g.left + g.width / 2, y: g.top + g.height / 2, h: g.height };`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x, y: grip.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y + 30 }] }); await wait(30);
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y + 40 }] }); await wait(250);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(300);
  check('a short drag on the handle springs back', await sheetOpen() && await evaluate(`return document.querySelector('[data-market-sheet]').style.transform === '';`));
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x, y: grip.y }] });
  for (let dy = 30; dy <= 150; dy += 30) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y + dy }] }); await wait(30); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(300);
  check('dragging the handle down closes the sheet and returns focus', !(await sheetOpen())
    && await evaluate(`return document.activeElement?.dataset.openIndicators === '1';`), await evaluate(`return document.activeElement?.outerHTML.slice(0, 80);`));
  await evaluate(`document.querySelector('[data-open-indicators]').click(); return 1;`); await wait(300);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 20, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 20, button: 'left', clickCount: 1 }); await wait(300);
  check('the backdrop closes the sheet', !(await sheetOpen()));
  await evaluate(`document.querySelector('[data-open-indicators]').click(); return 1;`); await wait(300);
  await evaluate(`document.querySelector('[data-market-sheet] .mkt-sheet-head button[aria-label="Close"]').click(); return 1;`); await wait(300);
  check('the close button closes the sheet', !(await sheetOpen()));

  // Readout at 360 px: three lines at most, and the same height idle and while inspecting.
  await phone({ ...PHONE, width: 360 });
  const readoutAt = () => evaluate(`const r = document.querySelector('[data-readout]');
    const tops = new Set([...r.children].filter(e => !e.matches('.mkt-readout-ind, .mkt-readout-sel')).map(e => Math.round(e.getBoundingClientRect().top)));
    return { lines: tops.size, h: Math.round(r.getBoundingClientRect().height), sideways: document.documentElement.scrollWidth > innerWidth };`);
  const idle = await readoutAt();
  await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
  await key('ArrowLeft', 'ArrowLeft', 37); await wait(200);
  const inspecting = await readoutAt();
  check('at 360 px the readout fits three lines and does not jump', idle.lines <= 3 && inspecting.lines <= 3 && idle.h === inspecting.h && !idle.sideways,
    JSON.stringify([idle, inspecting]));
  await key('Escape', 'Escape', 27); await wait(150);
  check('"Average Acquisition Price" is written out in full at 360 px', await evaluate(`return [...document.querySelectorAll('[data-my-activity] dt')].some(d => d.textContent === 'Average Acquisition Price');`));
  await phone();

  // Touch: a vertical swipe on the chart scrolls the page; a horizontal one pans; a pinch zooms;
  // a long press inspects without scrolling the page.
  await evaluate(`window.scrollTo(0, 0); document.querySelector('.mkt-chart').scrollIntoView({ block: 'center' }); return 1;`); await wait(300);
  let box2 = await chartBox();
  const t0 = await evaluate(`return document.querySelector('[data-readout]').dataset.t;`);
  const sy = await evaluate(`return Math.round(scrollY);`);
  const lx = Math.round(box2.x + box2.w * 0.5), ly = Math.round(box2.y + box2.h * 0.3);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly, id: 1 }] });
  await wait(700);
  for (let i = 1; i <= 6; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: lx - i * 12, y: ly + i * 10, id: 1 }] }); await wait(40); }
  const tl = await evaluate(`return document.querySelector('[data-readout]').dataset.t;`);
  const sy2 = await evaluate(`return Math.round(scrollY);`);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(200);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lx, y: ly, id: 2 }] }); // the next tap ends inspection
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(300);
  check('a long press inspects a candle and does not scroll the page', tl && tl !== t0 && sy2 === sy, JSON.stringify({ t0, tl, sy, sy2 }));
  await evaluate(`window.scrollTo(0, 0); document.querySelector('.mkt-chart').scrollIntoView({ block: 'center' }); return 1;`); await wait(300);
  box2 = await chartBox();
  const y0 = await evaluate(`return Math.round(scrollY);`);
  await swipe(box2.x + box2.w / 2, box2.y + box2.h * 0.6, 0, -220);
  await wait(500);
  const y1 = await evaluate(`return Math.round(scrollY);`);
  check('a vertical swipe that starts on the chart scrolls the page', y1 > y0 + 50, `${y0} → ${y1}`);
  await evaluate(`document.querySelector('.mkt-chart').scrollIntoView({ block: 'center' }); return 1;`); await wait(300);
  box2 = await chartBox();
  const v0 = await visible();
  await swipe(box2.x + box2.w * 0.3, box2.y + box2.h * 0.3, 200, 0);
  await wait(900);
  const v1 = await visible();
  check('a horizontal swipe pans the chart', v0 && v1 && v1.from < v0.from - 5, JSON.stringify([v0, v1]));
  await send('Input.synthesizePinchGesture', { x: Math.round(box2.x + box2.w / 2), y: Math.round(box2.y + box2.h * 0.3), scaleFactor: 2.5, gestureSourceType: 'touch', relativeSpeed: 400 });
  await wait(700);
  const v2 = await visible();
  check('a pinch zooms the time axis', v1 && v2 && (v2.to - v2.from) < (v1.to - v1.from) * 0.8, JSON.stringify([v1, v2]));
  check('no floating tooltip covers the chart', await evaluate(`return ![...document.querySelectorAll('.mkt-chart-wrap [role=tooltip], .mkt-chart-wrap .tooltip')].length;`));

  console.log('\n[Market on a phone, landscape]');
  await phone(LANDSCAPE);
  const land = await waitFor(`const s = document.querySelector('.mkt-shell'); return s.classList.contains('expanded') && {
      nav: getComputedStyle(document.querySelector('.mobile-bottom-nav')).display,
      readoutInChart: !!document.querySelector('.mkt-chart-wrap [data-readout]'),
      chartH: Math.round(document.querySelector('.mkt-chart').getBoundingClientRect().height),
      bars: [...s.querySelectorAll('.mkt-shell-bar')].map(b => Math.round(b.getBoundingClientRect().height)),
      panes: document.querySelector('.mkt-chart-wrap').dataset.panes };`, 5000);
  check('turning a phone sideways opens the full-viewport chart by itself', !!land, JSON.stringify(land));
  check('…with the bottom navigation hidden and one compact toolbar row', land?.nav === 'none' && land.bars.length === 1 && land.bars[0] <= 52, JSON.stringify(land));
  check('…the chart filling the height and the readout over the price pane', land?.chartH >= 390 - land.bars[0] - 40 && land.readoutInChart, JSON.stringify(land));
  check('…and up to four panes', land?.panes === '3', JSON.stringify(land));
  const ro = await evaluate(`const r = document.querySelector('[data-readout]').getBoundingClientRect(), c = document.querySelector('.mkt-chart').getBoundingClientRect();
    return { left: r.left - c.left, right: c.right - r.right, h: r.height, pe: getComputedStyle(document.querySelector('[data-readout]')).pointerEvents };`);
  check('the landscape readout is one line at the left, clear of the newest candles, and takes no touches', ro.h < 30 && ro.left < 10 && ro.right > 100 && ro.pe === 'none', JSON.stringify(ro));
  await evaluate(`const s = document.querySelector('[data-expanded-range]'); s.value = '3M'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
  check('the compact range picker changes the range', !!(await ready(`c.dataset.range === '3M'`)));
  await phone();
  check('turning back to portrait closes an overlay that opened by itself', await waitFor(`return !document.querySelector('.mkt-shell.expanded');`, 3000)
    && (await chart())?.range === '3M');
  await evaluate(`document.querySelector('button[aria-label="Expand chart"]').click(); return 1;`); await wait(300);
  await phone(LANDSCAPE);
  await phone();
  check('an overlay the user opened stays open through rotation', await evaluate(`return !!document.querySelector('.mkt-shell.expanded');`));
  await press('Escape', 'Escape'); await wait(300);
  check('closing it keeps the range and interval', !(await evaluate(`return !!document.querySelector('.mkt-shell.expanded');`)) && (await chart())?.range === '3M');
  await radio('Range', '1Y'); await ready(`c.dataset.range === '1Y'`);
  await desktop();

  console.log('\n[Market keyboard and screen readers]');
  await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
  await key('ArrowLeft', 'ArrowLeft', 37);
  const live = await waitFor(`const t = document.querySelector('.mkt-sr[aria-live=polite]')?.textContent; return /open \\$/.test(t || '') && t;`, 3000);
  check('arrow keys on the chart are announced in a polite live region', !!live, live);
  check('the chart is an image with a description of what it shows', await evaluate(`const c = document.querySelector('.mkt-chart');
    return c.getAttribute('role') === 'img' && /BTC\\/USD daily candles, 1 year\\. Last close \\$/.test(c.getAttribute('aria-label')) && /of your transactions are marked/.test(c.getAttribute('aria-label'));`),
    await evaluate(`return document.querySelector('.mkt-chart').getAttribute('aria-label');`));
  await key('Escape', 'Escape', 27);
  // Tab through the Market controls: each takes focus and shows a focus ring.
  await evaluate(`document.querySelector('.mkt-header').setAttribute('tabindex', '-1'); document.querySelector('.mkt-header').focus(); return 1;`);
  const rings = [];
  for (let i = 0; i < 18; i++) {
    await press('Tab', 'Tab');
    rings.push(await evaluate(`const a = document.activeElement; if(!a.closest('.mkt')) return null; const s = getComputedStyle(a);
      return { el: (a.getAttribute('aria-label') || a.textContent).slice(0, 20), fv: a.matches(':focus-visible'), o: s.outlineStyle + ' ' + s.outlineWidth, ring: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1.5) || /rgb/.test(s.boxShadow) };`));
  }
  const reached = rings.filter(Boolean);
  check('Market controls are reachable by Tab and show a visible focus ring', reached.length >= 10 && reached.every(r => r.ring), JSON.stringify(reached.filter(r => !r.ring).slice(0, 4)));
  await evaluate(`document.querySelector('.mkt-header').removeAttribute('tabindex'); return 1;`);

  console.log('\n[Market "View as table"]');
  await evaluate(`document.querySelector('[data-open-tx-table]').click(); return 1;`); await wait(300);
  const tbl = await evaluate(`const t = document.querySelector('[data-tx-table]'); if(!t) return null;
    return { n: t.dataset.txTable, ids: [...t.querySelectorAll('tr[data-table-tx]')].map(r => r.dataset.tableTx), caption: !!t.querySelector('caption'),
      headers: t.querySelectorAll('th[scope=col]').length, focus: t.closest('[data-market-sheet]').contains(document.activeElement) };`);
  check('"View as table" lists every transaction marked in the visible range', tbl && JSON.stringify(tbl.ids) === JSON.stringify(['pb1', 'pd1', 'pb2', 'pb3', 'pr1', 'ps1']), JSON.stringify(tbl));
  check('…as a table with a caption and column headers, in a dialog', tbl?.caption && tbl.headers === 5 && tbl.focus, JSON.stringify(tbl));
  await key('End', 'End', 35); // nothing: focus is in the sheet, not on the chart
  await press('Escape', 'Escape'); await wait(250);
  await evaluate(`document.querySelector('.mkt-chart').focus(); return 1;`);
  for (let i = 0; i < 5; i++) { await key('+', 'Equal', 187); await wait(60); }
  await evaluate(`document.querySelector('[data-open-tx-table]').click(); return 1;`); await wait(300);
  const zoomed = await evaluate(`return [...document.querySelectorAll('tr[data-table-tx]')].map(r => r.dataset.tableTx);`);
  check('zoomed in, the table follows the visible range', zoomed.length < 6 && zoomed.every(id => ['pb1', 'pd1', 'pb2', 'pb3', 'pr1', 'ps1'].includes(id)), JSON.stringify(zoomed));
  await press('Escape', 'Escape'); await wait(200);
  await evaluate(`document.querySelector('[data-market-view] button[title="Back to the selected range"]').click(); return 1;`); await wait(400);
  await evaluate(`document.querySelector('[data-open-tx-table]').click(); return 1;`); await wait(300);
  await evaluate(`document.querySelector('[data-table-view="ps1"]').click(); return 1;`); await wait(500);
  const fromTable = await evaluate(`const m = document.querySelector('.modal[role=dialog]'); return { title: document.querySelector('.page-title').textContent, modal: m?.querySelector('.modal-title')?.textContent };`);
  check('"View Transaction" in the table opens the existing editor', fromTable.title === 'Transactions' && fromTable.modal === 'Edit Transaction', JSON.stringify(fromTable));
  await press('Escape', 'Escape'); await wait(300);

  console.log('\n[Market contrast in both themes]');
  await show('Market'); await ready();
  const contrast = async theme => { await evaluate(`document.documentElement.setAttribute('data-theme', '${theme}'); return 1;`); await wait(800); return evaluate(`
    const lum = c => { const m = c.match(/[\\d.]+/g).map(Number); const v = m.slice(0, 3).map(x => x / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
    const hex = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',') + ')';
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const bgOf = el => { for(let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if(/^rgb\\(/.test(b)) return b; } return getComputedStyle(document.body).backgroundColor; }; // the first opaque background
    const bad = [];
    const sel = '.mkt-legal, .mkt-stat dt, .mkt-stat dd, .mkt-stat-sub, .mkt-btn:not(:disabled), .mkt-fresh, .mkt-readout, .mkt-readout b, .mkt-ind-short, .mkt-up, .mkt-down, .mkt-pane-title, .mkt-badge, .mkt-count, .mkt-pair, .mkt-change, .mkt-acq-table th, .mkt-acq-table td';
    for(const el of document.querySelectorAll('[data-market-view] :is(' + sel + ')')) {
      if(!el.offsetParent || !el.textContent.trim()) continue;
      const r = ratio(getComputedStyle(el).color, bgOf(el));
      if(r < 4.5) bad.push(el.className + ' "' + el.textContent.trim().slice(0, 16) + '" ' + r.toFixed(2));
    }
    // Essential chart lines and text against the chart surface.
    const surface = bgOf(document.querySelector('.mkt-chart'));
    const col = MKT_COLORS['${theme}'], pal = CHART_PALETTES['${theme}'], mk = MKT_MARKER_COLORS['${theme}'];
    const lines = { text: pal.text, up: pal.up, down: pal.down, ...Object.fromEntries(Object.entries(col.sma).map(([k, v]) => ['sma' + k, v])),
      ...Object.fromEntries(Object.entries(col.ema).map(([k, v]) => ['ema' + k, v])), bb: col.bb, bbMid: col.bbMid, rsi: col.rsi, macd: col.macd,
      signal: col.signal, atr: col.atr, hv: col.hv, aap: mk.aap, balance: mk.balance };
    for(const [k, v] of Object.entries(lines)) { const r = ratio(hex(v), surface); if(r < 4.5) bad.push(k + ' ' + v + ' ' + r.toFixed(2)); }
    return bad;`); };
  const themeBefore = await evaluate(`return document.documentElement.getAttribute('data-theme');`);
  const badLight = await contrast('light'), badDark = await contrast('dark');
  check('Market text and essential lines reach 4.5:1 in the light theme', badLight.length === 0, badLight.join(' | '));
  check('…and in the dark theme', badDark.length === 0, badDark.join(' | '));
  await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(themeBefore)}); return 1;`);

  console.log('\n[Market offline]');
  await radio('Range', '1Y'); await ready(`c.dataset.range === '1Y'`); await wait(500);
  // Interception sits in front of the emulated network, so it fails the requests itself.
  netDown = true;
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await show('Dashboard'); await wait(300); await show('Market');
  const off = await waitFor(`const c = document.querySelector('.mkt-chart'); return c && c.dataset.state === 'offline-cached' && +c.dataset.candles > 300 && {
      banner: document.querySelector('.mkt-banner')?.textContent || '', forming: c.dataset.forming, readout: document.querySelector('[data-readout]').textContent };`, 20000);
  check('offline with saved candles: the chart draws them under an offline banner', /^Offline — showing saved data from /.test(off?.banner || ''), JSON.stringify(off));
  check('…and nothing saved is presented as live (no forming candle)', off?.forming === '-1' && !/forming/.test(off.readout), JSON.stringify(off));
  await evaluate(`return MarketCandleStore.open().then(s => s.clear()).then(() => 1);`);
  await show('Dashboard'); await wait(300); await show('Market');
  const offEmpty = await waitFor(`const c = document.querySelector('.mkt-chart'); return c && c.dataset.state === 'offline' && document.querySelector('.mkt-overlay')?.textContent;`, 20000);
  check('offline with nothing saved: a message instead of a chart', /offline and no market data is saved/.test(offEmpty || ''), offEmpty);
  await show('Transactions'); await wait(300);
  check('…and the other tabs work', await evaluate(`return document.querySelector('.page-title').textContent === 'Transactions' && document.querySelectorAll('.tx-table-wrap tr').length > 1;`));
  netDown = false;
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  console.log('\n[Clear cached market data]');
  await show('Market'); await ready(); await wait(1500);
  const storeCount = () => evaluate(`return new Promise(res => { const r = indexedDB.open('satledger-market'); r.onsuccess = () => {
      const db = r.result, n = {}; const t = db.transaction([...db.objectStoreNames], 'readonly');
      for(const s of db.objectStoreNames) t.objectStore(s).count().onsuccess = e => { n[s] = e.target.result; };
      t.oncomplete = () => { db.close(); res(n); }; }; r.onerror = () => res(null); });`);
  const beforeClear = await storeCount();
  const lsBefore = await evaluate(`return JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]).filter(([k]) => !['btc-last-spot', 'btc-price-history-v1'].includes(k)));`);
  await show('Settings'); await wait(300);
  await evaluate(`document.querySelector('[data-clear-market-cache]').click(); return 1;`);
  await waitFor(`return /Cached market data cleared/.test(document.body.innerText);`, 5000);
  const afterClear = await storeCount();
  const lsAfter = await evaluate(`return JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]).filter(([k]) => !['btc-last-spot', 'btc-price-history-v1'].includes(k)));`);
  check('"Clear cached market data" empties satledger-market', beforeClear?.candles > 0 && afterClear && Object.values(afterClear).every(n => n === 0), JSON.stringify([beforeClear, afterClear]));
  check('…and nothing else', lsBefore === lsAfter && JSON.parse(lsAfter).find(([k]) => k === 'btc-tx-v2')?.[1].includes('pb1'));
  await show('Market');
  check('the Market tab downloads the history again', !!(await ready()));

  console.log('\n[Market with IndexedDB unavailable]');
  {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `IDBFactory.prototype.open = function(){ throw new DOMException('blocked by test', 'SecurityError'); };`,
    });
    await reload();
    await show('Market');
    check('the Market tab works for the session from memory', !!(await ready()) && (await evaluate(`return MarketCandleStore.open().then(s => s.kind);`)) === 'memory');
    await radio('Range', '3M');
    check('…including a range change', !!(await ready(`c.dataset.range === '3M'`)));
    await radio('Range', '1Y'); await ready(`c.dataset.range === '1Y'`);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }

  console.log('\n[Market under load: 2,000 transactions]');
  {
    const many = [];
    for (let i = 0; i < 2000; i++) {
      const d = 1 + (i % 380), kind = i % 10;
      many.push(tx({ id: 'load' + i, type: kind === 9 ? 'Sell' : kind === 8 ? 'Reward' : 'Buy', date: dayOf(d), datetimeUtc: at(d, (i * 7) % 24, (i * 13) % 60), sequence: 0,
        amount: (0.0001 + (i % 50) / 10000).toFixed(8), price: kind === 8 ? '' : String(40000 + (i % 300) * 50), totalUsd: '', fee: '',
        ...(kind === 8 ? { usdValueAtReceipt: '5.000000', usdValueSource: 'manual', rewardCategory: 'cash_back' } : {}) }));
    }
    await seed({ 'btc-tx-v2': many, 'btc-wallets': WALLETS });
    await evaluate(`history.replaceState(null, '', '#market?range=1y&interval=1d'); return 1;`);
    await reload();
    await ready(`c.dataset.range === '1Y'`);
    const m1 = await waitFor(`const n = +(document.querySelector('.mkt-chart').dataset.markers || 0); return n > 0 && n;`, 15000);
    check('2,000 transactions draw within the marker cap', m1 > 0 && m1 <= 300, m1);
    await radio('Range', '3M'); await ready(`c.dataset.range === '3M'`); // load 3M once, so the timed change is not network-bound
    await radio('Range', '1Y'); await ready(`c.dataset.range === '1Y'`); await wait(300);
    const t0 = Date.now();
    await radio('Range', '3M');
    await ready(`c.dataset.range === '3M' && +(c.dataset.markers || 0) > 0`);
    const ms = Date.now() - t0;
    check(`a range change with 2,000 transactions stays responsive (${ms} ms)`, ms < 4000, ms);
    const lag = await evaluate(`return new Promise(res => { const t = performance.now(); setTimeout(() => res(Math.round(performance.now() - t)), 0); });`);
    check('…and the main thread is free afterwards', lag < 200, lag);
  }

  await send('Fetch.disable');
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  await send('Network.setBypassServiceWorker', { bypass: false });
  await evaluate(`history.replaceState(null, '', '#dashboard'); return 1;`);
  await reload();
}

// ── a new deploy is announced ────────────────────────────────────────────────
// Built page only: app.dev.html has no build id and skips the check.
if (!process.env.SATLEDGER_PAGE || process.env.SATLEDGER_PAGE === 'app.html') {
  console.log('\n[update available prompt]');
  const versionPath = join(REPO_ROOT, 'version.json');
  const original = readFileSync(versionPath, 'utf8');
  await reload();
  check('no prompt when version.json matches this build',
    !/new version of SatLedger/i.test(await evaluate(`return document.body.innerText;`)));
  try {
    writeFileSync(versionPath, JSON.stringify({ build: 'a-newer-deploy' }) + '\n');
    await reload();
    check('prompt shown when a different build is deployed',
      /new version of SatLedger/i.test(await evaluate(`return document.body.innerText;`)));
  } finally {
    writeFileSync(versionPath, original);
  }
}

// Offline price failures are expected in CI — they are warnings now, not errors
const unexpected = errors.filter(e => !/Failed to fetch|price|Stored data unreadable/i.test(e) && !BABEL_SIZE_NOTE.test(e));
if (unexpected.length) {
  console.log(`\nunexpected console errors: ${unexpected.length}`);
  unexpected.slice(0, 8).forEach(e => console.log('  ✗ ' + e.slice(0, 250)));
}

const failed = report();
close();
process.exit(failed || unexpected.length ? 1 : 0);
