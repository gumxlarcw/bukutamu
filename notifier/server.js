'use strict';

/*
 | bukutamu-notifier — Web Push sender for admin desktop notifications (Tier-2).
 |
 | Loop tiap pollIntervalMs:
 |   1. GET  {apiBase}/api/notifications/dispatch  (X-Internal-Secret)
 |        → { subscriptions:[{endpoint,endpoint_hash,p256dh,auth,role}],
 |            notifications_by_role:{ role:[{id,type,title,message,action_url}] } }
 |   2. Untuk tiap role, cari notif yang BARU muncul (id belum pernah dikirim)
 |        → kirim Web Push ke semua subscription role itu.
 |   3. Subscription mati (404/410) → POST {apiBase}/api/push/prune.
 |
 | "lastSeen" disimpan in-memory. Tick pertama setelah start hanya MENYEMAI
 | baseline (tidak push) supaya restart tidak membanjiri notif yang sudah ada.
 | VAPID keys + internal secret ada di config.json (git-ignored).
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublic, cfg.vapidPrivate);

const POLL = cfg.pollIntervalMs || 30000;
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');
const DISPATCH_URL = BASE + '/api/notifications/dispatch';
const PRUNE_URL = BASE + '/api/push/prune';

const lastSeen = new Map(); // role -> Set<notifId> yang sudah dikirim
let primed = false;
const pushTries = new Map(); // #33 — notifId -> jumlah kegagalan transien (batasi retry)
const MAX_PUSH_TRIES = cfg.maxPushTries || 5;
const FETCH_TIMEOUT = cfg.fetchTimeoutMs || 15000; // #34

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

if (typeof fetch !== 'function') {
  log('FATAL: global fetch tidak tersedia — butuh Node >= 18.');
  process.exit(1);
}

let busy = false; // #34 — re-entrancy guard: jangan tumpuk tick kalau yang sebelumnya masih jalan
async function tick() {
  if (busy) return; // #34 — koneksi loopback yang hang tak boleh menumpuk tick (setInterval terus jalan)
  busy = true;
  try {
  let data;
  try {
    const res = await fetch(DISPATCH_URL, { headers: { 'X-Internal-Secret': cfg.internalSecret }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) {
      log('dispatch HTTP', res.status);
      return;
    }
    const body = await res.json();
    data = body && body.data;
  } catch (e) {
    log('dispatch fetch error:', e.message);
    return;
  }
  if (!data) return;

  const byRole = data.notifications_by_role || {};

  // Tick pertama: semai baseline, jangan push (hindari banjir saat restart).
  if (!primed) {
    for (const role of Object.keys(byRole)) {
      lastSeen.set(role, new Set((byRole[role] || []).map((n) => n.id)));
    }
    primed = true;
    log('primed baseline — no push on startup');
    return;
  }

  const subs = data.subscriptions || [];
  const subsByRole = new Map();
  for (const s of subs) {
    if (!subsByRole.has(s.role)) subsByRole.set(s.role, []);
    subsByRole.get(s.role).push(s);
  }

  const deadHashes = [];

  for (const role of Object.keys(byRole)) {
    const notifs = byRole[role] || [];
    const currentIds = new Set(notifs.map((n) => n.id));
    const seen = lastSeen.get(role) || new Set();
    const fresh = notifs.filter((n) => !seen.has(n.id));
    lastSeen.set(role, currentIds);

    if (fresh.length === 0) continue;
    const roleSubs = subsByRole.get(role) || [];
    if (roleSubs.length === 0) continue;

    for (const n of fresh) {
      const payload = JSON.stringify({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        action_url: n.action_url,
      });
      let delivered = false, liveFailure = false;
      for (const s of roleSubs) {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await webpush.sendNotification(subscription, payload);
          delivered = true;
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            deadHashes.push(s.endpoint_hash);
          } else {
            liveFailure = true;
            log('push error', code || '', (err && err.message) || err);
          }
        }
      }
      // #33 — kalau SEMUA sub gagal transien (bukan 404/410 sub-mati) & belum pernah sukses, un-mark
      // dari seen (currentIds sudah jadi lastSeen di atas) supaya di-retry tick berikut; dibatasi
      // MAX_PUSH_TRIES agar notif yang permanen-gagal tak loop selamanya.
      const tries = (pushTries.get(n.id) || 0) + 1;
      if (!delivered && liveFailure && tries < MAX_PUSH_TRIES) { currentIds.delete(n.id); pushTries.set(n.id, tries); }
      else pushTries.delete(n.id);
    }
    log(`role=${role} pushed ${fresh.length} new notif(s) to ${roleSubs.length} sub(s)`);
  }

  if (deadHashes.length) {
    const uniq = [...new Set(deadHashes)];
    try {
      const res = await fetch(PRUNE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ endpoint_hashes: uniq }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT), // #34
      });
      log('pruned', uniq.length, 'dead sub(s); http', res.status);
    } catch (e) {
      log('prune error:', e.message);
    }
  }
  } finally { busy = false; } // #34
}

log('bukutamu-notifier start; poll', POLL, 'ms;', DISPATCH_URL);
tick();
setInterval(tick, POLL);
