'use strict';

/*
 | test-push.js — kirim SATU notifikasi uji ke SEMUA subscription terdaftar.
 | Untuk verifikasi manual bahwa Windows toast benar-benar muncul.
 | Jalankan: cd notifier && node test-push.js   (atau: npm run test-push)
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublic, cfg.vapidPrivate);
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');

(async () => {
  if (typeof fetch !== 'function') {
    console.error('Butuh Node >= 18 (global fetch).');
    process.exit(1);
  }
  const res = await fetch(BASE + '/api/notifications/dispatch', {
    headers: { 'X-Internal-Secret': cfg.internalSecret },
  });
  const body = await res.json();
  const subs = (body.data && body.data.subscriptions) || [];
  console.log('Subscriptions terdaftar:', subs.length);

  const payload = JSON.stringify({
    id: 'test-' + Date.now(),
    type: 'info',
    title: 'Tes Notifikasi',
    message: 'Ini notifikasi uji dari bukutamu-notifier. Kalau muncul, push berfungsi.',
    action_url: '/admin',
  });

  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      ok++;
      console.log('terkirim →', s.role, '·', String(s.endpoint).slice(0, 48) + '…');
    } catch (e) {
      console.log('GAGAL', e.statusCode || '', e.message);
    }
  }
  console.log(`Selesai: ${ok}/${subs.length} terkirim.`);
  process.exit(0);
})();
