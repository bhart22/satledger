// SatLedger service worker — offline support and CDN asset caching
const CACHE_NAME = 'satledger-v5';
const NETWORK_TIMEOUT_MS = 4000;

// Split so one unreachable URL can't silently disable offline support entirely.
// cache.addAll() is atomic: a blocked unpkg (corporate proxy, DNS filter, ad blocker) used to
// reject the whole install, so the worker never activated and nothing was ever cached.
// CRITICAL stays atomic on purpose — if app.html can't be fetched, the install SHOULD fail.
const CRITICAL_URLS = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './images/favicon-32.png',
  './images/icon-192.png',
];

// Nice to have offline, but never worth failing the install over. Each is added individually.
const OPTIONAL_URLS = [
  './privacy.html',
  './terms.html',
  './images/apple-touch-icon.png',
  './images/icon-512.png',
  './images/logo-dark-128.png',
  './images/logo-white-128.png',
  './images/tip-lightning.png',
  './images/tip-onchain.png',
  // Pinned CDN scripts — immutable, safe to cache forever (SRI still verified on use)
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
];

// Hosts the SW must never intercept: live data and auth flows
const NETWORK_ONLY_HOSTS = [
  'api.coinbase.com',
  'api.exchange.coinbase.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CRITICAL_URLS)
        .then(() => Promise.allSettled(
          OPTIONAL_URLS.map(u => cache.add(u).catch(err => {
            console.warn('[SW] optional precache skipped:', u, err && err.message);
          }))
        ))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A cached page usable for a navigation. Tries the URL itself, then its .html twin, because
// the precache stores ./app.html while the address bar (after Cloudflare's redirect) says /app.
// A stored response that was reached through a redirect is re-wrapped: browsers reject a
// `redirected` response for a navigation.
async function cachedPage(url) {
  const candidates = [url.href];
  if (url.pathname !== '/' && !/\.[a-z0-9]+$/i.test(url.pathname)) candidates.push(url.origin + url.pathname.replace(/\/$/, '') + '.html');
  if (url.pathname === '/') candidates.push(url.origin + '/index.html');
  for (const c of candidates) {
    const hit = await caches.match(c, { ignoreSearch: true });
    if (!hit) continue;
    if (!hit.redirected) return hit;
    const body = await hit.blob();
    return new Response(body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
  }
  return undefined;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NETWORK_ONLY_HOSTS.includes(url.hostname)) return;
  // Deploy-version probe: must always reach the network
  if (url.origin === self.location.origin && url.pathname.endsWith('/version.json')) return;

  // App pages: network-first so deploys propagate, cache fallback for offline.
  //
  // Only a clean 200 replaces the cached shell. Caching every response meant one 5xx, a
  // mid-deploy 404 or a captive-portal redirect overwrote the good copy, and the next offline
  // launch served the error page. A slow network (one bar, hotel Wi-Fi) also used to hang
  // with no fallback, so give up after NETWORK_TIMEOUT_MS and serve the cached copy — the
  // fetch carries on and still refreshes the cache for next time.
  //
  // Redirects are answers, not failures. Cloudflare Pages 308s /app.html → /app, and a
  // navigation fetch hands that back as an `opaqueredirect` (resp.ok is false). It must go
  // straight to the browser to follow — treating it as an error served a cached copy instead,
  // and the cached copy of a redirected URL is itself a redirected response, which browsers
  // refuse for a navigation, so the page failed to load.
  if (url.origin === self.location.origin && (req.mode === 'navigate' || url.pathname.endsWith('.html'))) {
    const network = fetch(req).then(resp => {
      if (resp.ok && !resp.redirected && resp.type === 'basic') {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      }
      return resp;
    });
    const cached = () => cachedPage(url);
    event.respondWith(new Promise(resolve => {
      let settled = false;
      const done = r => { if (!settled && r) { settled = true; resolve(r); } };
      const timer = setTimeout(() => cached().then(done), NETWORK_TIMEOUT_MS);
      network
        .then(resp => {
          if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) return resp;
          // A server error with a good copy on hand: prefer the copy
          if (!resp.ok) return cached().then(c => c || resp);
          return resp;
        })
        .catch(() => cached().then(c => c || Response.error()))
        .then(r => { clearTimeout(timer); done(r); });
    }));
    return;
  }

  // Everything else cacheable (pinned CDN scripts, fonts, images): cache-first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        const cacheable = resp.ok || resp.type === 'opaque';
        const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
        if (cacheable && (url.origin === self.location.origin || url.hostname === 'unpkg.com' || isFont)) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return resp;
      });
    })
  );
});
