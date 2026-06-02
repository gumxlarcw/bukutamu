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

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

if (typeof fetch !== 'function') {
  log('FATAL: global fetch tidak tersedia — butuh Node >= 18.');
  process.exit(1);
}

async function tick() {
  let data;
  try {
    const res = await fetch(DISPATCH_URL, { headers: { 'X-Internal-Secret': cfg.internalSecret } });
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
      for (const s of roleSubs) {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await webpush.sendNotification(subscription, payload);
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            deadHashes.push(s.endpoint_hash);
          } else {
            log('push error', code || '', (err && err.message) || err);
          }
        }
      }
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
      });
      log('pruned', uniq.length, 'dead sub(s); http', res.status);
    } catch (e) {
      log('prune error:', e.message);
    }
  }
}

log('bukutamu-notifier start; poll', POLL, 'ms;', DISPATCH_URL);
tick();
setInterval(tick, POLL);
