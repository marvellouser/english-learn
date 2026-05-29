// service-worker.js
// Manual, dependency-free cache-first service worker for the vocab PWA.
// Keep CACHE_NAME in sync with CACHE_NAME in js/config.js.

const CACHE_NAME = 'vocab-pwa-v3';

// App shell assets to precache on install.
// All paths are relative to the service worker scope (the app root), so the
// PWA works at any GitHub Pages sub-path. './' covers the start_url.
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/srs.js',
  './js/tts.js',
  './js/settings.js',
  './js/reminder.js',
  './js/vocab-estimate.js',
  './js/views/home.js',
  './js/views/study.js',
  './js/views/settings-view.js',
  './js/views/vocab-test.js',
  './js/views/word-list.js',
  './js/views/mistakes.js',
  './manifest.json',
  './data/seed-words.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// --- Install: precache the app shell ----------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Add each asset individually so a single missing optional file
        // (e.g. seed-words.json before TASK-002 lands) does not abort the
        // whole install.
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] precache skipped:', url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

// --- Activate: drop stale caches + take control ------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// --- Fetch: cache-first, fall back to network, cache new GET responses -------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests; let the browser deal with the rest.
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request)
        .then((response) => {
          // Only cache valid, cacheable responses (basic = same-origin).
          if (
            response &&
            response.status === 200 &&
            (response.type === 'basic' || response.type === 'default')
          ) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached: for navigations, fall back to the shell.
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return Response.error();
        });
    })
  );
});
