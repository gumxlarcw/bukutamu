'use strict';

/*
 | bukutamu-wa — WhatsApp online data-request connector (whatsapp-web.js).
 | Isolated, ToS-risky surface. Mirrors bukutamu-notifier's loopback + internal-secret pattern.
 |   - on('message')  -> POST {apiBase}/api/wa/ingest  {phone,text}   (backend decides new vs continuation)
 |   - every poll     -> POST {apiBase}/api/wa/poll                    (idempotent dispatch scan; returns pending)
 |                       -> client.sendMessage(jid, body) per message
 |                       -> POST {apiBase}/api/wa/ack  {ids:[...]}
 | First QR scan links the BPS 0851 number as a WhatsApp linked device. Session persists in .wwebjs_auth/.
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const QRCode = require('qrcode');
const crypto = require('crypto');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL = cfg.pollIntervalMs || 30000;
const MAX_SEND_ATTEMPTS = cfg.maxSendAttempts || 3;
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');
const INGEST_URL = BASE + '/api/wa/ingest';
const POLL_URL = BASE + '/api/wa/poll';
const ACK_URL = BASE + '/api/wa/ack';
const QR_PORT = cfg.qrPort || 5310;
// QR page is reachable on the LAN (operator opens it in a browser), so it MUST be
// token-guarded — the QR is a WhatsApp pairing credential. Token from config (stable)
// or random per start. Without ?t=<token> → 403.
const QR_TOKEN = cfg.qrToken || crypto.randomBytes(16).toString('hex');

function log(...a) { console.log(new Date().toISOString(), ...a); }
if (typeof fetch !== 'function') { log('FATAL: need Node >= 18 (global fetch)'); process.exit(1); }

function jidFromLocal(phone) {
  // Accept stored 0xxx or raw 62xxx; emit 62xxx@c.us.
  const d = String(phone).replace(/\D/g, '').replace(/^0/, '62');
  return d + '@c.us';
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let ready = false;
let latestQr = null;       // raw QR string, also served by the web page below
let linkedNumber = null;   // set once linked
client.on('qr', (qr) => {
  latestQr = qr;
  log('Scan QR — buka http://<server-ip>:' + QR_PORT + ' (atau lihat ASCII di bawah):');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => { ready = true; latestQr = null; linkedNumber = client.info?.wid?.user || null; log('WA client ready; nomor=' + linkedNumber); });
client.on('auth_failure', (m) => log('auth_failure', m));
client.on('disconnected', (r) => { ready = false; linkedNumber = null; log('disconnected', r); });

client.on('message', async (msg) => {
  try {
    if (typeof msg.from !== 'string' || msg.from.endsWith('@g.us')) return; // ignore groups
    if (msg.isStatus) return;
    const phone = msg.from.replace(/@c\.us$/, '');
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify({ phone, text: msg.body || '' }),
    });
    if (!res.ok) log('ingest http', res.status);
  } catch (e) { log('ingest error', e.message); }
});

// In-memory per-message failure cap: stop hammering a permanently-failing send
// (e.g. an invalid number) after MAX_SEND_ATTEMPTS within this process. The visit
// still auto-closes server-side (keyed off enqueue time), so nothing gets stuck.
const failCount = new Map();

let busy = false;
async function tick() {
  if (busy || !ready) return;
  busy = true;
  try {
    const res = await fetch(POLL_URL, { method: 'POST', headers: { 'X-Internal-Secret': cfg.internalSecret } });
    if (!res.ok) { log('poll http', res.status); return; }
    const body = await res.json();
    const messages = (body.data && body.data.messages) || [];
    const sent = [];
    for (const m of messages) {
      if ((failCount.get(m.id) || 0) >= MAX_SEND_ATTEMPTS) continue; // gave up on this one
      try {
        await client.sendMessage(jidFromLocal(m.phone), m.body);
        sent.push(m.id);
        failCount.delete(m.id);
      } catch (e) {
        const n = (failCount.get(m.id) || 0) + 1;
        failCount.set(m.id, n);
        log('send error id', m.id, 'attempt', n, e.message);
        if (n >= MAX_SEND_ATTEMPTS) log('giving up on outbox id', m.id, 'after', n, 'attempts (visit will still auto-close server-side)');
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

// ── Halaman QR web (gambar QR yg gampang di-scan), meniru email-wa-bot /qr ──
function qrTokenOk(req) {
  const m = /[?&]t=([^&]+)/.exec(req.url || '');
  const given = m ? decodeURIComponent(m[1]) : '';
  const a = Buffer.from(given), b = Buffer.from(QR_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!qrTokenOk(req)) { res.writeHead(403); res.end('Forbidden — token QR salah atau tidak ada.'); return; }
  if (ready) {
    res.end('<meta http-equiv="refresh" content="10"><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>&#9989; WhatsApp terhubung</h2><p>Nomor tertaut: <b>' + (linkedNumber || '?') + '</b></p><p>Connector bukutamu-wa siap menerima permintaan.</p></body>');
    return;
  }
  if (!latestQr) {
    res.end('<meta http-equiv="refresh" content="3"><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Menyiapkan QR&#8230;</h2><p>Tunggu sebentar, halaman ini refresh otomatis.</p></body>');
    return;
  }
  try {
    const dataUrl = await QRCode.toDataURL(latestQr, { margin: 2, width: 320 });
    res.end('<meta http-equiv="refresh" content="15"><body style="font-family:sans-serif;text-align:center;padding:24px"><h2>Scan untuk menautkan WhatsApp</h2><p>Di HP: WhatsApp &rarr; <b>Perangkat Tertaut</b> &rarr; <b>Tautkan Perangkat</b> &rarr; scan:</p><img src="' + dataUrl + '" alt="QR" style="width:320px;height:320px"><p style="color:#888">Scan dengan nomor WhatsApp yang ingin Anda tautkan. Halaman auto-refresh tiap 15 dtk sampai QR baru / terhubung.</p></body>');
  } catch (e) {
    res.end('<body>QR error: ' + e.message + '</body>');
  }
}).listen(QR_PORT, '0.0.0.0', () => log('QR web page: http://<server-ip>:' + QR_PORT + '/?t=' + QR_TOKEN));

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
client.initialize();
setInterval(tick, POLL);
