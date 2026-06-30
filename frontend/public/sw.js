// Admin Buku Tamu 8200 Service Worker — minimal shell untuk installability PWA.
// Bukan offline-app sungguhan: API selalu network, navigasi & static asset
// pakai cache-then-network agar shell loading lebih cepat saat re-open.

// Bump versi ini SETIAP rilis frontend yang mengubah bundle. Ganti nama cache
// memicu `activate` menghapus cache lama + skipWaiting, supaya SW lama berhenti
// menyajikan chunk JS basi (static asset = cache-first) dan klien dapat kode
// terbaru pada full-reload berikutnya. Lupa bump = user lihat versi lama meski
// origin sudah update (bug 2026-06-02: form konsultasi tampak kosong saat dibuka
// ulang karena SW menyajikan ConsultationFormPage chunk lama).
const CACHE_NAME = 'admin-bukutamu-8200-v60';
const SHELL_PATHS = ['/admin', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Hanya tangani http(s) SAME-ORIGIN — abaikan chrome-extension://, data:, blob:, lintas-origin
  // (kalau tidak, cache.put melempar "Request scheme 'chrome-extension' is unsupported").
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  // API calls: network-only (auth & realtime data jangan di-cache).
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: network-first, fallback ke cache /admin saat offline. Selalu kembalikan
  // sebuah Response (jangan pernah undefined) supaya tidak muncul "network error page".
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request)
          .then((c) => c || caches.match('/admin'))
          .then((c) => c || new Response(
            '<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem;color:#444">Tidak ada koneksi ke server. Periksa jaringan, lalu muat ulang halaman.</body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          ))
      )
    );
    return;
  }

  // Static assets: cache-first. Catch network failures so a transient blip never becomes
  // an uncaught rejection / broken response — fall back to cache if we have it.
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        }).catch(() => caches.match(event.request))
    )
  );
});

// ── Web Push (Tier-2 desktop notifications) ──────────────────────────────
// Payload dikirim oleh service `notifier/` (VAPID). Bentuk:
//   { id, type, title, message, action_url }
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }

  const title = payload.title || 'Buku Tamu BPS Malut';
  const options = {
    body: payload.message || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.id || undefined,      // id sama → notifikasi diganti, tidak menumpuk
    renotify: !!payload.id,
    data: { action_url: payload.action_url || '/admin' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Klik notifikasi → fokus tab admin yang sudah ada (arahkan ke action_url),
// atau buka jendela baru kalau belum ada.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.action_url) || '/admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) { try { client.navigate(url); } catch (e) { /* ignore */ } }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
