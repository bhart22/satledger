// Service worker behaviour behind Cloudflare-style "pretty URLs" (/app.html → 308 → /app),
// which is how the live site is served.
//
//   npm run test:sw
//
// Regression guard: a worker that treated the redirect as a failed fetch answered the
// navigation from cache instead — with a cached response that was itself reached through a
// redirect, which browsers refuse for a navigation. Opening /app.html then failed outright.
// Skips cleanly (exit 0) if no Chrome/Edge is installed.
import { launch, createChecks, findChrome } from './lib/harness.mjs';

if (!(await findChrome())) {
  console.log('No Chrome/Edge found — skipping service worker tests. Set CHROME_PATH to enable them.');
  process.exit(0);
}

const { send, evaluate, wait, close } =
  await launch({ page: 'app', port: 8792, debugPort: 9292, label: 'sw-' + Date.now(), prettyUrls: true });
const { check, report } = createChecks();
const BASE = 'http://localhost:8792';
const appRendered = () => evaluate(`return !!document.querySelector('nav, .sidebar, .stats-grid') && location.pathname;`);
const navigate = async (path, ms = 4000) => { await send('Page.navigate', { url: BASE + path }); await wait(ms); };

console.log('\n[service worker behind pretty URLs]');
const ready = await evaluate(`
  return navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false);`);
check('service worker installed and active', ready === true);
await navigate('/app');            // now controlled by the worker
check('page is controlled by the worker', await evaluate(`return !!navigator.serviceWorker.controller;`));

await navigate('/app.html');
check('online: /app.html follows the redirect and renders', (await appRendered()) === '/app', await appRendered());

await send('Network.enable');
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await navigate('/app.html', 3000);
check('offline: /app.html renders from cache', !!(await appRendered()), await appRendered());
await navigate('/app', 3000);
check('offline: /app renders from cache', !!(await appRendered()), await appRendered());
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

const failed = report();
close();
process.exit(failed ? 1 : 0);
