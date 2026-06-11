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
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const crypto = require('crypto');
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
const CHAT_INGEST_URL = BASE + '/api/wa/chat-ingest'; // pesan masuk → wa_messages (thread chat)
const FAIL_URL = BASE + '/api/wa/messages/fail';      // tandai chat keluar gagal kirim
const BACKFILL_ACTIVE_URL = BASE + '/api/wa/backfill-active'; // saat ready (reconnect) → recovery sesi aktif
const BACKFILL_LIMIT = cfg.backfillLimit || 100; // jumlah pesan histori diambil per chat (batas wwebjs)
// Disk bersama untuk media chat: connector menulis media masuk di sini; backend menyajikan
// + membaca media keluar dari path yang sama (connector & backend satu server).
const MEDIA_DIR = path.join(__dirname, '..', 'backend', 'assets', 'wa_media');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEND_GAP_MS = cfg.sendGapMs || 1200; // jeda antar kirim — lindungi nomor dari flooding/ban
const FETCH_TIMEOUT_MS = cfg.fetchTimeoutMs || 15000; // loopback ke backend tak boleh menggantung tick
const WA_OP_TIMEOUT_MS = cfg.waOpTimeoutMs || 45000;  // panggilan wwebjs (send/fetch/download) berbatas waktu

function log(...a) { console.log(new Date().toISOString(), ...a); }
if (typeof fetch !== 'function') { log('FATAL: need Node >= 18 (global fetch)'); process.exit(1); }

// Semua fetch loopback lewat sini → AbortSignal.timeout mencegah await menggantung & mengunci `busy`.
function bfetch(url, opts = {}) { return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
// Bungkus panggilan wwebjs yang mengabaikan AbortSignal (Promise.race vs timer penolak) → tick tak bisa wedge.
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);
}

// Process-level safety net: error async fatal yang "tertelan" TIDAK boleh meninggalkan proses
// hidup-tapi-mati (akar bug 6 Jun: ERR_NETWORK_CHANGED saat init bikin connector mogok diam).
// Fail fast → PM2 autorestart memulihkan proses bersih (sesi LocalAuth dipertahankan di disk).
let shuttingDown = false;
process.on('unhandledRejection', (e) => { log('FATAL unhandledRejection', (e && e.stack) || e); process.exit(1); });
process.on('uncaughtException',  (e) => { log('FATAL uncaughtException',  (e && e.stack) || e); process.exit(1); });

function jidFromLocal(phone) {
  // If it's already a WhatsApp address (@c.us / @lid / @g.us), use it verbatim —
  // never reconstruct (WhatsApp may deliver a privacy @lid that can't be rebuilt).
  const s = String(phone);
  if (/@(c\.us|lid|g\.us)$/.test(s)) return s;
  const d = s.replace(/\D/g, '').replace(/^0/, '62');
  return d + '@c.us';
}

// Normalisasi nomor untuk perbandingan allowlist: buang non-digit + 0 depan + kode negara 62.
function normNum(s) {
  let d = String(s).replace(/\D/g, '').replace(/^0+/, '');
  if (d.startsWith('62')) d = d.slice(2);
  return d; // contoh: 085159170808 / 6285159170808 → "85159170808"
}
// For-now allowlist nomor pengirim (kosong = balas semua DM).
const ALLOW_FROM = (cfg.allowFrom || []).map(normNum).filter(Boolean);
if (ALLOW_FROM.length) log('allowFrom aktif — hanya balas DM dari:', ALLOW_FROM.join(', '));

// Best-effort: push the current QR (as a data-URL) / link state to the backend so the
// authenticated admin "Layanan Online" page can display it (no exposed port).
async function pushQrState(obj) {
  try {
    const r = await bfetch(QR_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify(obj),
    });
    return await r.json().catch(() => null); // {data:{pair_phone}} → trigger pairing kalau ada
  } catch (e) { log('qr-state push error', e.message); return null; }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

// Reap puppeteer's Chromium on ANY exit so it can't orphan & keep holding the profile
// SingletonLock — an orphaned lock makes the NEXT init hang → watchdog loop → ~6 menit
// recovery. 'exit' (sync) covers every process.exit() path (watchdog/failFast/connect/
// unhandled/logout); SIGINT/SIGTERM (PM2 reload/stop) route through process.exit(0) so the
// same reap runs before PM2 escalates to SIGKILL. Killing the browser-main pid frees the
// lock (renderers die with their broken IPC); LocalAuth session on disk is untouched → no relink.
function killBrowserSync() {
  try {
    const proc = client && client.pupBrowser && client.pupBrowser.process && client.pupBrowser.process();
    if (proc && proc.pid) process.kill(proc.pid, 'SIGKILL');
  } catch (_) { /* sudah mati / belum ada browser — abaikan */ }
}
process.on('exit', killBrowserSync);
process.on('SIGINT',  () => { log('SIGINT — shutdown'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM — shutdown'); process.exit(0); });

let ready = false;
let linkedNumber = null;
let lastPairPhone = null; // nomor yang terakhir diminta pairing code-nya (hindari minta berulang)

// Readiness watchdog: kalau 'ready' tak tercapai dalam batas waktu (init nge-hang / stall pasca-QR
// yang TIDAK menolak promise initialize), exit(1) → PM2 restart bersih. Ini menutup SEMUA jalur
// silent-hang menuju "tak pernah ready". Di-clear saat 'ready'.
const READY_DEADLINE_MS = cfg.readyDeadlineMs || 180000;
let readyWatchdog = null;
function armReadyWatchdog() {
  if (readyWatchdog) clearTimeout(readyWatchdog);
  readyWatchdog = setTimeout(() => {
    log('FATAL: tidak mencapai ready dalam', READY_DEADLINE_MS, 'ms — exit(1) untuk restart PM2');
    process.exit(1);
  }, READY_DEADLINE_MS);
  if (readyWatchdog.unref) readyWatchdog.unref();
}
armReadyWatchdog();

client.on('qr', async (qr) => {
  log('QR baru — buka halaman admin "Layanan Online" untuk scan (ASCII di bawah sebagai cadangan):');
  qrcode.generate(qr, { small: true });
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
    const resp = await pushQrState({ qr: dataUrl, ready: false });
    // Opsi "tautkan via nomor HP": kalau admin minta pairing utk sebuah nomor → minta kodenya
    // (QR & kode pairing valid bersamaan untuk sesi unpaired yang sama).
    const pairPhone = resp && resp.data && resp.data.pair_phone;
    if (pairPhone && pairPhone !== lastPairPhone) {
      lastPairPhone = pairPhone;
      try {
        const code = await client.requestPairingCode(pairPhone);
        log('pairing code utk ' + pairPhone + ' = ' + code);
        await pushQrState({ pairing_code: code });
      } catch (e) { log('requestPairingCode err', e.message); lastPairPhone = null; }
    } else if (!pairPhone) {
      lastPairPhone = null; // pairing dibatalkan → reset
    }
  } catch (e) { log('qr dataurl error', e.message); }
});
// Kode pairing di-refresh wwebjs tiap ~3 menit → dorong ke halaman admin.
client.on('code', (code) => { log('pairing code refreshed = ' + code); pushQrState({ pairing_code: code }); });
client.on('ready', () => {
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; } // sehat → batalkan watchdog
  ready = true;
  linkedNumber = client.info?.wid?.user || null;
  log('WA client ready; nomor=' + linkedNumber);
  pushQrState({ qr: null, ready: true, number: linkedNumber });
  // Recovery: setiap reconnect, minta backfill semua sesi aktif → tangkap pesan yang
  // mungkin terlewat saat server/internet mati (dedup by wa_msg_id di backend).
  bfetch(BACKFILL_ACTIVE_URL, { method: 'POST', headers: { 'X-Internal-Secret': cfg.internalSecret } })
    .then(() => log('backfill-active requested'))
    .catch((e) => log('backfill-active err', e.message));
});
// Auth mati (sesi korup/kedaluwarsa) & disconnect pasca-ready: pulih lewat exit(1) → PM2 restart
// bersih (sesi LocalAuth dipertahankan, jadi reconnect tanpa scan QR ulang kecuali memang mati).
// Re-init in-process pada client yang sama tidak diandalkan (lihat wwebjs #387); restart bersih
// adalah jalur paling kokoh — sama dengan jalur logout di tick (exit → PM2 → init bersih).
async function failFast(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false; linkedNumber = null;
  log(reason, '— exit(1) untuk restart PM2');
  try { await pushQrState({ qr: null, ready: false }); } catch (_) { /* best-effort */ }
  process.exit(1);
}
client.on('auth_failure', (m) => { failFast('auth_failure: ' + m); });
client.on('disconnected', (r) => { failFast('disconnected: ' + r); });

// Tipe pesan sistem / non-percakapan yang harus diabaikan.
const IGNORED_TYPES = new Set(['e2e_notification', 'notification_template', 'gp2', 'call_log', 'ciphertext', 'revoked', 'protocol', 'interactive', 'notification']);

client.on('message', async (msg) => {
  try {
    const from = typeof msg.from === 'string' ? msg.from : '';
    // HANYA balas DM (chat pribadi 1-1): alamat @c.us atau @lid.
    // Abaikan grup (@g.us), broadcast, status, channel/newsletter, pesan sendiri, & notifikasi sistem.
    const isDm = from.endsWith('@c.us') || from.endsWith('@lid');
    log('event message from=' + from + ' type=' + msg.type + ' fromMe=' + !!msg.fromMe + ' dm=' + isDm);
    if (!isDm || msg.fromMe || msg.isStatus || msg.broadcast) return;
    if (msg.type && IGNORED_TYPES.has(msg.type)) return;
    // Alamat sistem/server WhatsApp (mis. 0@c.us mengirim pesan 'interactive'/pengumuman
    // yang BUKAN kontak nyata) — user-part '0'/kosong. Jangan perlakukan sebagai pelanggan.
    const userPart = from.replace(/@.*$/, '');
    if (userPart === '' || userPart === '0') { log('diabaikan — alamat sistem WhatsApp ' + from); return; }
    const waId = from;                     // exact reply target (@c.us or @lid) — reply here, never reconstruct
    let phone = waId.replace(/@.*$/, '');   // @c.us → sudah nomor; @lid → di-resolve di bawah
    // WhatsApp privacy: DM bisa datang sebagai @lid (Linked Identity) — digit di
    // JID BUKAN nomor HP. Resolusikan ke nomor asli lewat peta LID↔phone milik
    // WhatsApp: getContactLidAndPhone([lid]) → [{ lid, pn }], pn = "62xxx@c.us".
    // (wwebjs >= 1.34; balas tetap ke @lid via waId — jangan rekonstruksi.)
    // Catatan: nama profil WhatsApp (pushname) SENGAJA tidak diambil — identitas
    // hanya boleh bersumber dari DB (match nomor HP / hasil isi form).
    if (from.endsWith('@lid') && typeof client.getContactLidAndPhone === 'function') {
      try {
        const [map] = await client.getContactLidAndPhone([from]);
        if (map && map.pn) phone = String(map.pn).replace(/@.*$/, '');
        log('lid-resolve from=' + from + ' pn=' + (map && map.pn));
      } catch (e) { log('lid-resolve err', e.message); }
    }
    // Cocokkan allowFrom ke nomor TERESOLUSI maupun alamat mentah (@lid/@c.us) —
    // WhatsApp kerap menyembunyikan nomor asli di balik @lid yang stabil per kontak.
    const senderKeys = [normNum(phone), normNum(from)];
    if (ALLOW_FROM.length && !ALLOW_FROM.some(a => senderKeys.includes(a))) {
      log('diabaikan — pengirim ' + phone + ' / ' + from + ' tidak ada di allowFrom');
      return;
    }
    // wwebjs menaruh base64 jpegThumbnail di msg.body untuk pesan media tanpa directPath
    // (mis. view-once / interactive). Hanya teruskan body bila benar-benar teks.
    const bodyText = (msg.hasMedia || msg.type === 'chat') ? (msg.body || '') : '';
    const res = await bfetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify({ phone, wa_id: waId, text: bodyText }),
    });
    if (!res.ok) log('ingest http', res.status);

    // Simpan ke thread chat (wa_messages) — best-effort, terpisah dari logika sesi.
    // Backend yang memutuskan disimpan/tidak (guard sesi aktif) & dedup by wa_msg_id.
    let mediaFile = null; // file media yang ditulis — dihapus bila backend tak menyimpan (cegah orphan)
    try {
      const waMsgId = (msg.id && msg.id._serialized) || null;
      let payload = { phone, wa_chat_id: waId, wa_msg_id: waMsgId, type: 'text', body: bodyText };
      if (msg.hasMedia) {
        const media = await withTimeout(msg.downloadMedia(), WA_OP_TIMEOUT_MS, 'downloadMedia-in');
        if (media && media.data) {
          const mime = media.mimetype || 'application/octet-stream';
          const ext = ((mime.split(';')[0].split('/')[1]) || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
          const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
          try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
          mediaFile = path.join(MEDIA_DIR, fname);
          fs.writeFileSync(mediaFile, Buffer.from(media.data, 'base64'));
          try { fs.chmodSync(mediaFile, 0o644); } catch (_) { /* www-data harus bisa baca */ }
          payload = {
            phone, wa_chat_id: waId, wa_msg_id: waMsgId,
            type: mime.startsWith('image/') ? 'image' : 'document',
            body: msg.body || '', media_path: fname, media_mime: mime, media_name: media.filename || fname,
          };
        }
      }
      const r2 = await bfetch(CHAT_INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify(payload),
      });
      // Hapus file kalau backend TIDAK menyimpan (sesi tak aktif / duplikat / ditolak) → cegah orphan.
      let stored = false;
      try { stored = r2.ok && ((((await r2.json()) || {}).data || {}).stored === true); } catch (_) { stored = false; }
      if (mediaFile && !stored) { try { fs.unlinkSync(mediaFile); } catch (_) { /* ignore */ } }
      if (!r2.ok) log('chat-ingest http', r2.status);
    } catch (e) {
      if (mediaFile) { try { fs.unlinkSync(mediaFile); } catch (_) { /* ignore */ } }
      log('chat-ingest error', e.message);
    }
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
    const res = await bfetch(POLL_URL, { method: 'POST', headers: { 'X-Internal-Secret': cfg.internalSecret } });
    if (!res.ok) { log('poll http', res.status); return; }
    const body = await res.json();
    if (body.data && body.data.command === 'logout') {
      shuttingDown = true; // cegah handler 'disconnected' dari client.logout() balapan exit
      log('command: logout — memutuskan tautan & restart untuk QR baru');
      try { await client.logout(); } catch (e) { log('logout err', e.message); }
      try { fs.rmSync(path.join(__dirname, '.wwebjs_auth'), { recursive: true, force: true }); } catch (e) { log('rm auth err', e.message); }
      setTimeout(() => process.exit(0), 1200); // PM2 autorestart → init bersih → QR baru
      return;
    }
    // Heartbeat liveness: poll sukses = bukti hidup. Backend cap updated_at tiap detak; UI/monitor
    // anggap "online" hanya bila now - updated_at < TTL → status mati tak bisa basi seperti dulu.
    // (Fire-and-forget; pushQrState menelan error sendiri & sudah ber-timeout via bfetch.)
    pushQrState({ ready: true, number: linkedNumber, heartbeat: true });
    const messages = (body.data && body.data.messages) || [];
    const sentOutbox = []; // wa_outbox ids (templated)
    const chatSent = [];   // [{id, wa_msg_id}] live chat — simpan WA id agar backfill/recovery tak menggandakan
    const failedChat = []; // wa_messages ids yang menyerah → tandai 'failed'
    const BATCH = cfg.sendBatch || 6; // batasi kirim per tick → command (logout) tetap responsif + pacing terjaga
    let processed = 0;
    for (const m of messages) {
      if (processed >= BATCH) break; // sisanya di tick berikutnya
      const key = (m.kind || 'outbox') + ':' + m.id; // outbox & chat punya ruang id sendiri
      if ((failCount.get(key) || 0) >= MAX_SEND_ATTEMPTS) continue; // sudah menyerah
      // Chat media: pastikan file masih ada sebelum kirim — hindari crash & false-fail.
      if (m.kind === 'chat' && m.media_path && !fs.existsSync(path.join(MEDIA_DIR, path.basename(m.media_path)))) {
        log('media file missing for chat', m.id);
        failedChat.push(m.id);
        continue;
      }
      processed++;
      try {
        const dest = m.wa_chat_id || jidFromLocal(m.phone);
        let sentMsg;
        if (m.kind === 'chat' && m.media_path) {
          const media = MessageMedia.fromFilePath(path.join(MEDIA_DIR, path.basename(m.media_path)));
          if (m.media_name) media.filename = m.media_name; // pakai nama asli, bukan uuid disk, di WhatsApp
          sentMsg = await withTimeout(client.sendMessage(dest, media, { caption: m.body || '' }), WA_OP_TIMEOUT_MS, 'send-media');
        } else {
          sentMsg = await withTimeout(client.sendMessage(dest, m.body || ''), WA_OP_TIMEOUT_MS, 'send-text');
        }
        if (m.kind === 'chat') chatSent.push({ id: m.id, wa_msg_id: (sentMsg && sentMsg.id && sentMsg.id._serialized) || '' });
        else sentOutbox.push(m.id);
        failCount.delete(key);
        await sleep(SEND_GAP_MS); // pacing antar kirim (anti-flood/ban)
      } catch (e) {
        const n = (failCount.get(key) || 0) + 1;
        failCount.set(key, n);
        log('send error', key, 'attempt', n, e.message);
        if (n >= MAX_SEND_ATTEMPTS) {
          log('giving up on', key, 'after', n, 'attempts');
          if (m.kind === 'chat') failedChat.push(m.id);
        }
      }
    }
    // ── Backfill: ambil histori chat dari WhatsApp → ingest (dedup). Juga recovery pasca-outage. ──
    const backfills = (body.data && body.data.backfills) || [];
    // Persist pesan terkirim SEBELUM backfill jalan → dedup wa_msg_id backend bisa melihat id-nya
    // (cegah duplikat hantu saat reconnect mengirim balasan + backfill chat yang sama di tick yg
    // sama). Hanya saat ada backfill, jadi steady-state (tanpa backfill) tak menambah POST.
    if (backfills.length && (sentOutbox.length || chatSent.length)) {
      await bfetch(ACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ ids: sentOutbox, chat_sent: chatSent }),
      }).catch((e) => log('ack-send(pre-backfill) error', e.message));
      log('acked-send(pre-backfill) outbox=' + sentOutbox.length + ' chat=' + chatSent.length);
      sentOutbox.length = 0; chatSent.length = 0; // sudah di-ack; jangan ack ganda di akhir
    }
    const backfillDone = [];
    const backfillFailed = [];
    for (const bf of backfills.slice(0, 2)) { // maks 2 per tick → jaga durasi tick tetap pendek
      let ok = false;
      try {
        const chat = await withTimeout(client.getChatById(bf.wa_chat_id), WA_OP_TIMEOUT_MS, 'getChatById');
        const msgs = await withTimeout(chat.fetchMessages({ limit: BACKFILL_LIMIT }), WA_OP_TIMEOUT_MS, 'fetchMessages');
        for (const msg of msgs) {
          if (msg.isStatus || (msg.type && IGNORED_TYPES.has(msg.type))) continue;
          const payload = {
            phone: bf.phone, wa_chat_id: bf.wa_chat_id,
            wa_msg_id: (msg.id && msg.id._serialized) || null,
            from_me: !!msg.fromMe, ts: msg.timestamp || 0, backfill: true,
            type: 'text', body: msg.body || '',
          };
          let mf = null;
          if (msg.hasMedia) {
            try {
              const media = await withTimeout(msg.downloadMedia(), WA_OP_TIMEOUT_MS, 'downloadMedia-bf');
              if (media && media.data) {
                const mime = media.mimetype || 'application/octet-stream';
                const ext = ((mime.split(';')[0].split('/')[1]) || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
                const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
                mf = path.join(MEDIA_DIR, fname);
                fs.writeFileSync(mf, Buffer.from(media.data, 'base64'));
                try { fs.chmodSync(mf, 0o644); } catch (_) { /* readable oleh www-data */ }
                payload.type = mime.startsWith('image/') ? 'image' : 'document';
                payload.media_path = fname; payload.media_mime = mime; payload.media_name = media.filename || fname;
              }
            } catch (e) { log('backfill media err', e.message); }
          }
          try {
            const rr = await bfetch(CHAT_INGEST_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
              body: JSON.stringify(payload),
            });
            if (mf) { // dedup/ditolak backend → buang file biar tak orphan
              let stored = false;
              try { stored = rr.ok && ((((await rr.json()) || {}).data || {}).stored === true); } catch (_) { stored = false; }
              if (!stored) { try { fs.unlinkSync(mf); } catch (_) { /* ignore */ } }
            }
          } catch (e) { if (mf) { try { fs.unlinkSync(mf); } catch (_) { /* ignore */ } } log('backfill ingest err', e.message); }
        }
        log('backfill done phone=' + bf.phone + ' msgs=' + msgs.length);
        ok = true;
      } catch (e) { log('backfill err phone=' + bf.phone, e.message); }
      // Sukses → done. Gagal (chat tak ada / timeout) → retry via poll berikutnya;
      // backend menyerah setelah 4 percobaan supaya tak loop selamanya. (anti data-loss)
      if (ok) backfillDone.push(bf.id); else backfillFailed.push(bf.id);
    }

    if (sentOutbox.length || chatSent.length || backfillDone.length || backfillFailed.length) {
      await bfetch(ACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ ids: sentOutbox, chat_sent: chatSent, backfill_ids: backfillDone, backfill_fail: backfillFailed }),
      });
      log('acked outbox=' + sentOutbox.length + ' chat=' + chatSent.length + ' backfill=' + backfillDone.length + ' bf_fail=' + backfillFailed.length);
    }
    if (failedChat.length) {
      await bfetch(FAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ ids: failedChat }),
      }).catch((e) => log('fail-mark error', e.message));
    }
  } catch (e) { log('tick error', e.message); }
  finally { busy = false; }
}

// Init dengan penanganan error: page.goto WhatsApp Web bisa gagal transient (ERR_NETWORK_CHANGED
// saat jaringan belum stabil di boot — ini akar bug 6 Jun). Retry transient dengan backoff;
// error non-transient / kuota habis → exit(1) supaya PM2 restart bersih. Re-init memakai client
// yang SAMA (handler event tetap terpasang; hindari jebakan "handler hilang" wwebjs #387).
const INIT_MAX_RETRY  = cfg.initMaxRetry  || 5;
const INIT_BACKOFF_MS = cfg.initBackoffMs || 3000; // 3s,6s,12s,24s,48s (cap 60s)
const isTransientNav = (e) => {
  const m = (e && e.message) || '';
  return (e && e.name === 'TimeoutError') ||
    /net::ERR_(NETWORK_CHANGED|CONNECTION_(RESET|REFUSED|CLOSED)|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|TIMED_OUT)/.test(m) ||
    /Target closed|Execution context was destroyed|Navigation failed|Protocol error/.test(m);
};
async function connect() {
  for (let attempt = 1; attempt <= INIT_MAX_RETRY; attempt++) {
    try { await client.initialize(); return; }
    catch (e) {
      log('initialize gagal attempt ' + attempt + '/' + INIT_MAX_RETRY + ':', e.message);
      if (!isTransientNav(e) || attempt === INIT_MAX_RETRY) {
        log('initialize tak terpulihkan — exit(1) untuk restart PM2'); process.exit(1);
      }
      const wait = Math.min(INIT_BACKOFF_MS * Math.pow(2, attempt - 1), 60000);
      log('retry initialize dalam ' + wait + ' ms'); await sleep(wait);
    }
  }
}

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
connect();
setInterval(tick, POLL);
