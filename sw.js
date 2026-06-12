// SatLedger service worker — offline support and CDN asset caching
const CACHE_NAME = 'satledger-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.html',
  './manifest.json',
  './privacy.html',
  './terms.html',
  './images/favicon-32.png',
  './images/apple-touch-icon.png',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/logo.png',
  './images/logo-dark.png',
  './images/logo-minimal.png',
  './images/logo-white.png',
  // Pinned CDN scripts — immutable, safe to cache forever (SRI still verified on use)
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.7/babel.min.js',
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
      .then(cache => cache.addAll(PRECACHE_URLS))
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NETWORK_ONLY_HOSTS.includes(url.hostname)) return;

  // App pages: network-first so deploys propagate, cache fallback for offline
  if (url.origin === self.location.origin && (req.mode === 'navigate' || url.pathname.endsWith('.html'))) {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
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
