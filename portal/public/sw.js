const CACHE_NAME = 'clawd-chat-v1';
const STATIC_ASSETS = [
  '/portal/chat/',
  '/portal/chat/index.html',
  '/portal/chat/chat.css',
  '/portal/chat/chat.js',
  '/portal/chat/offline.html',
  '/portal/logo.svg',
  '/portal/manifest.json'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and API/streaming requests
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/portal/api/')) return;

  // Static assets: cache-first
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Other requests: network-first with offline fallback
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((cached) =>
        cached || caches.match('/portal/chat/offline.html')
      )
    )
  );
});
