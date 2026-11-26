// প্রস্তুতি AI — Offline-First Service Worker for PDF Library & Study Materials
// Cache strategy:
//  - Navigation / App Shell: NetworkFirst with cached '/' fallback
//  - Next.js static bundles, CSS, KaTeX & Google Fonts: StaleWhileRevalidate / CacheFirst
//  - PDFs & Study Documents: CacheFirst (persistent offline PDF access)
//  - API, AI, Auth & Firestore traffic: NetworkOnly (never stale / never breaks auth)

const CACHE_VERSION = 'v2';
const SHELL_CACHE = `prostuti-ai-shell-${CACHE_VERSION}`;
const ASSETS_CACHE = `prostuti-ai-assets-${CACHE_VERSION}`;
const PDF_CACHE = `prostuti-ai-pdfs-${CACHE_VERSION}`;
const ACTIVE_CACHES = new Set([SHELL_CACHE, ASSETS_CACHE, PDF_CACHE]);

const PRECACHE_SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png',
];

const BYPASS_HOST_PATTERNS = [
  /firestore\.googleapis\.com/i,
  /identitytoolkit\.googleapis\.com/i,
  /securetoken\.googleapis\.com/i,
  /accounts\.google\.com/i,
  /www\.googleapis\.com/i,
  /oauth2\.googleapis\.com/i,
  /firebaseinstallations\.googleapis\.com/i,
];

function classifyRequest(request) {
  if (request.method !== 'GET') return 'bypass';

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return 'bypass';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'bypass';
  }

  if (BYPASS_HOST_PATTERNS.some((re) => re.test(url.hostname))) {
    return 'bypass';
  }

  // Google Fonts (CSS + font files) -> CacheFirst
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    return 'font';
  }

  // Only cache same-origin requests beyond Google Fonts
  if (url.origin !== self.location.origin) {
    return 'bypass';
  }

  const pathname = url.pathname;

  // Never cache dynamic backend APIs, HMR, or the service worker script itself
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/webpack-hmr') ||
    pathname === '/sw.js'
  ) {
    return 'bypass';
  }

  // PDFs and study document files -> CacheFirst in dedicated PDF cache
  if (
    /\.(?:pdf|docx)$/i.test(pathname) ||
    pathname.startsWith('/assets/')
  ) {
    return 'pdf';
  }

  // HTML page navigations -> NetworkFirst with offline shell fallback
  if (request.mode === 'navigate') {
    return 'navigation';
  }

  // Next.js static bundles, JS, CSS, fonts, images, manifest -> StaleWhileRevalidate
  if (
    pathname.startsWith('/_next/static/') ||
    pathname === '/manifest.webmanifest' ||
    /\.(?:js|css|woff2?|ttf|eot|png|jpg|jpeg|webp|svg|ico)$/i.test(pathname)
  ) {
    return 'asset';
  }

  return 'bypass';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_SHELL_URLS.map((url) =>
            cache.add(new Request(url, { cache: 'reload' }))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith('prostuti-ai-') && !ACTIVE_CACHES.has(key)
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function handleNavigation(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      shellCache.put(request, networkResponse.clone()).catch(() => {});
      // Also keep '/' fresh as the universal offline fallback
      const reqUrl = new URL(request.url);
      if (reqUrl.pathname === '/') {
        shellCache.put('/', networkResponse.clone()).catch(() => {});
      }
    }
    return networkResponse;
  } catch {
    const exactMatch = await shellCache.match(request, { ignoreSearch: true });
    if (exactMatch) return exactMatch;
    const rootFallback = await shellCache.match('/');
    if (rootFallback) return rootFallback;
    return new Response(
      '<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>প্রস্তুতি AI — অফলাইন</title></head><body style="font-family:sans-serif;padding:32px;background:#f8fafc;color:#0f172a"><h1>অফলাইন মোড</h1><p>ইন্টারনেট সংযোগ বিচ্ছিন্ন রয়েছে। পুনরায় সংযোগ হলে পেজটি রিলোড করুন।</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

function isVersionedStaticAsset(request) {
  try {
    const parsed = new URL(request.url);
    if (parsed.origin !== self.location.origin) return false;
    return (
      parsed.pathname.startsWith('/_next/static/') ||
      /\.(?:js|css|woff2?|ttf|eot|png|jpg|jpeg|webp|svg|ico)$/i.test(
        parsed.pathname
      )
    );
  } catch {
    return false;
  }
}

async function handleCacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    if (isVersionedStaticAsset(request)) {
      const searchFallback = await cache.match(request, { ignoreSearch: true });
      if (searchFallback) return searchFallback;
    }
    return new Response('Offline resource unavailable', { status: 503 });
  }
}

async function handleStaleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) {
    return networkResponse;
  }

  // Offline fallback: Next.js dev/build cache-busting query params (?v=...)
  // may differ between the cached HTML shell and cached static assets.
  if (isVersionedStaticAsset(request)) {
    const searchFallback = await cache.match(request, { ignoreSearch: true });
    if (searchFallback) return searchFallback;
  }

  return new Response('Offline asset unavailable', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  const strategy = classifyRequest(event.request);
  if (strategy === 'bypass') return;

  if (strategy === 'navigation') {
    event.respondWith(handleNavigation(event.request));
    return;
  }

  if (strategy === 'pdf') {
    event.respondWith(handleCacheFirst(event.request, PDF_CACHE));
    return;
  }

  if (strategy === 'font') {
    event.respondWith(handleCacheFirst(event.request, ASSETS_CACHE));
    return;
  }

  if (strategy === 'asset') {
    event.respondWith(handleStaleWhileRevalidate(event.request, ASSETS_CACHE));
  }
});

async function computeCacheStatus() {
  const [shell, assets, pdfs] = await Promise.all([
    caches.open(SHELL_CACHE).then((c) => c.keys()),
    caches.open(ASSETS_CACHE).then((c) => c.keys()),
    caches.open(PDF_CACHE).then((c) => c.keys()),
  ]);
  return {
    version: CACHE_VERSION,
    shellEntries: shell.length,
    assetEntries: assets.length,
    pdfEntries: pdfs.length,
    totalEntries: shell.length + assets.length + pdfs.length,
  };
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'WARM_URLS' && Array.isArray(data.urls)) {
    const targetCacheName =
      data.bucket === 'pdf'
        ? PDF_CACHE
        : data.bucket === 'shell'
          ? SHELL_CACHE
          : ASSETS_CACHE;
    event.waitUntil(
      caches.open(targetCacheName).then(async (cache) => {
        const urls = data.urls.filter(
          (u) => typeof u === 'string' && u.length > 0
        );
        let cachedCount = 0;
        for (const rawUrl of urls) {
          try {
            const parsed = new URL(rawUrl, self.location.origin);
            if (
              parsed.origin !== self.location.origin &&
              parsed.hostname !== 'fonts.googleapis.com' &&
              parsed.hostname !== 'fonts.gstatic.com'
            ) {
              continue;
            }
            const existing = await cache.match(parsed.href);
            if (existing) {
              cachedCount += 1;
              continue;
            }
            const resp = await fetch(parsed.href, { credentials: 'same-origin' });
            if (resp && (resp.ok || resp.type === 'opaque')) {
              await cache.put(parsed.href, resp.clone());
              cachedCount += 1;
            }
          } catch {
            // Skip unreachable URLs during background warm-up
          }
        }
        const status = await computeCacheStatus();
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true, cachedCount, status });
        }
      })
    );
    return;
  }

  if (data.type === 'GET_CACHE_STATUS') {
    event.waitUntil(
      computeCacheStatus().then((status) => {
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true, status });
        }
      })
    );
    return;
  }

  if (data.type === 'CLEAR_PDF_CACHE') {
    event.waitUntil(
      caches.delete(PDF_CACHE).then(async () => {
        const status = await computeCacheStatus();
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true, status });
        }
      })
    );
  }
});
