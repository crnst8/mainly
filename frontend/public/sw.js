/* Mainly's service worker.
 *
 * Vite content-hashes asset filenames, so a static precache list would be wrong
 * on every build. Runtime caching instead: the app shell is cached so a cold
 * offline launch still paints, and the API is never cached — a stale inbox is
 * worse than no inbox.
 */

const CACHE = 'mainly-v1';

/* Where this build is mounted. A self-hosted install is at "/", the hosted demo
   shares a domain with a landing page and sits at "/demo/". The worker's own
   scope is the only thing that knows which, and every path below is built from
   it — a bare "/assets/…" would have this worker caching, and answering for,
   the site around it. */
const BASE = new URL(self.registration.scope).pathname;

/* The HTML filename is the one thing Vite does not hash, so it can be precached
   by name. Without this the navigation fallback below has nothing to fall back
   to and a cold offline launch shows the browser's error page. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([BASE, `${BASE}index.html`]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Anything outside this build's mount point belongs to whatever else is on
  // the domain, and is none of our business.
  if (!url.pathname.startsWith(BASE)) return;

  const path = url.pathname.slice(BASE.length);

  // The API is always network. Never serve stale mail.
  if (path.startsWith('api/')) return;

  // Content-hashed or stable same-origin assets: cache-first.
  if (
    path.startsWith('assets/') ||
    path.startsWith('fonts/') ||
    path.startsWith('logo/') ||
    path === 'favicon.svg' ||
    path.startsWith('icon-') ||
    path === 'apple-touch-icon.png'
  ) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigation: network-first, fall back to the cached shell so a cold offline
  // launch still paints.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Keep the cached shell current, so the offline copy is the shell the
          // last successful load actually used.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(`${BASE}index.html`, copy));
          }
          return res;
        })
        .catch(() => caches.match(`${BASE}index.html`).then((hit) => hit || Response.error())),
    );
    return;
  }
});
