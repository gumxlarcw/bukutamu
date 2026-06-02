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

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL = cfg.pollIntervalMs || 30000;
const MAX_SEND_ATTEMPTS = cfg.maxSendAttempts || 3;
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');
const INGEST_URL = BASE + '/api/wa/ingest';
const POLL_URL = BASE + '/api/wa/poll';
const ACK_URL = BASE + '/api/wa/ack';

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
client.on('qr', (qr) => { log('Scan this QR with the BPS WhatsApp (0851...) to link as a device:'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => { ready = true; log('WA client ready'); });
client.on('auth_failure', (m) => log('auth_failure', m));
client.on('disconnected', (r) => { ready = false; log('disconnected', r); });

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

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
client.initialize();
setInterval(tick, POLL);
