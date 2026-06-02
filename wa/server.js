'use strict';

/*
 | bukutamu-wa — WhatsApp online data-request connector (whatsapp-web.js).
 | Isolated, ToS-risky surface. Mirrors bukutamu-notifier's loopback + internal-secret pattern.
 |   - on('message')    -> POST {apiBase}/api/wa/ingest  {phone,text}
 |   - on('qr'/'ready') -> POST {apiBase}/api/wa/qr-state  (admin "Layanan Online" page shows it)
 |   - every poll       -> POST {apiBase}/api/wa/poll ; sendMessage ; POST /api/wa/ack
 | First QR scan links the number as a WhatsApp linked device. Session persists in .wwebjs_auth/.
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL = cfg.pollIntervalMs || 30000;
const MAX_SEND_ATTEMPTS = cfg.maxSendAttempts || 3;
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');
const INGEST_URL = BASE + '/api/wa/ingest';
const POLL_URL = BASE + '/api/wa/poll';
const ACK_URL = BASE + '/api/wa/ack';
const QR_STATE_URL = BASE + '/api/wa/qr-state'; // connector pushes QR/link state; admin page reads it (auth-gated)

function log(...a) { console.log(new Date().toISOString(), ...a); }
if (typeof fetch !== 'function') { log('FATAL: need Node >= 18 (global fetch)'); process.exit(1); }

function jidFromLocal(phone) {
  // If it's already a WhatsApp address (@c.us / @lid / @g.us), use it verbatim —
  // never reconstruct (WhatsApp may deliver a privacy @lid that can't be rebuilt).
  const s = String(phone);
  if (/@(c\.us|lid|g\.us)$/.test(s)) return s;
  const d = s.replace(/\D/g, '').replace(/^0/, '62');
  return d + '@c.us';
}

// Best-effort: push the current QR (as a data-URL) / link state to the backend so the
// authenticated admin "Layanan Online" page can display it (no exposed port).
async function pushQrState(obj) {
  try {
    await fetch(QR_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify(obj),
    });
  } catch (e) { log('qr-state push error', e.message); }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let ready = false;
let linkedNumber = null;

client.on('qr', async (qr) => {
  log('QR baru — buka halaman admin "Layanan Online" untuk scan (ASCII di bawah sebagai cadangan):');
  qrcode.generate(qr, { small: true });
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
    pushQrState({ qr: dataUrl, ready: false });
  } catch (e) { log('qr dataurl error', e.message); }
});
client.on('ready', () => {
  ready = true;
  linkedNumber = client.info?.wid?.user || null;
  log('WA client ready; nomor=' + linkedNumber);
  pushQrState({ qr: null, ready: true, number: linkedNumber });
});
client.on('auth_failure', (m) => log('auth_failure', m));
client.on('disconnected', (r) => { ready = false; linkedNumber = null; log('disconnected', r); pushQrState({ qr: null, ready: false }); });

// Tipe pesan sistem / non-percakapan yang harus diabaikan.
const IGNORED_TYPES = new Set(['e2e_notification', 'notification_template', 'gp2', 'call_log', 'ciphertext', 'revoked', 'protocol']);

client.on('message', async (msg) => {
  try {
    const from = typeof msg.from === 'string' ? msg.from : '';
    // HANYA balas DM (chat pribadi 1-1): alamat @c.us atau @lid.
    // Abaikan grup (@g.us), broadcast, status, channel/newsletter, pesan sendiri, & notifikasi sistem.
    const isDm = from.endsWith('@c.us') || from.endsWith('@lid');
    log('event message from=' + from + ' type=' + msg.type + ' fromMe=' + !!msg.fromMe + ' dm=' + isDm);
    if (!isDm || msg.fromMe || msg.isStatus || msg.broadcast) return;
    if (msg.type && IGNORED_TYPES.has(msg.type)) return;
    const waId = from;                     // exact reply target (@c.us or @lid) — reply here, never reconstruct
    let phone = waId.replace(/@.*$/, '');   // fallback digits for guest matching
    try { const c = await msg.getContact(); if (c && c.number) phone = String(c.number); } catch (_) { /* keep fallback */ }
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify({ phone, wa_id: waId, text: msg.body || '' }),
    });
    if (!res.ok) log('ingest http', res.status);
  } catch (e) { log('ingest error', e.message); }
});

// In-memory per-message failure cap: stop hammering a permanently-failing send after
// MAX_SEND_ATTEMPTS within this process. The visit still auto-closes server-side.
const failCount = new Map();

let busy = false;
async function tick() {
  if (busy || !ready) return;
  busy = true;
  try {
    const res = await fetch(POLL_URL, { method: 'POST', headers: { 'X-Internal-Secret': cfg.internalSecret } });
    if (!res.ok) { log('poll http', res.status); return; }
    const body = await res.json();
    if (body.data && body.data.command === 'logout') {
      log('command: logout — memutuskan tautan & restart untuk QR baru');
      try { await client.logout(); } catch (e) { log('logout err', e.message); }
      try { fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true }); } catch (e) { log('rm auth err', e.message); }
      setTimeout(() => process.exit(0), 1200); // PM2 autorestart → init bersih → QR baru
      return;
    }
    const messages = (body.data && body.data.messages) || [];
    const sent = [];
    for (const m of messages) {
      if ((failCount.get(m.id) || 0) >= MAX_SEND_ATTEMPTS) continue; // gave up on this one
      try {
        await client.sendMessage(m.wa_chat_id || jidFromLocal(m.phone), m.body);
        sent.push(m.id);
        failCount.delete(m.id);
      } catch (e) {
        const n = (failCount.get(m.id) || 0) + 1;
        failCount.set(m.id, n);
        log('send error id', m.id, 'attempt', n, e.message);
        if (n >= MAX_SEND_ATTEMPTS) log('giving up on outbox id', m.id, 'after', n, 'attempts (visit still auto-closes server-side)');
      }
    }
    if (sent.length) {
      await fetch(ACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ ids: sent }),
      });
      log('sent+acked', sent.length);
    }
  } catch (e) { log('tick error', e.message); }
  finally { busy = false; }
}

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
client.initialize();
setInterval(tick, POLL);
