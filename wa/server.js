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
const { wedgePolicy } = require('./lib/wedge-policy');

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
// Liveness pasca-`ready`: probe renderer chromium. Sengaja jauh lebih pendek dari
// WA_OP_TIMEOUT_MS — pada renderer sehat, evaluate(() => 1) kembali dalam milidetik.
const PROBE_TIMEOUT_MS = cfg.probeTimeoutMs || 5000;
const PROBE_SKIP_MS    = cfg.probeSkipMs || 30000;         // lewati probe bila ada operasi WA nyata sebaru ini
// JAM DINDING, bukan hitungan tick: saat wedge satu tick bisa makan ~100 detik karena
// terhenti di WA_OP_TIMEOUT_MS berkali-kali (terukur 2026-08-04), jadi ambang berbasis
// tick meleset sampai 10x. Lihat wa/lib/wedge-policy.js.
const WEDGE_RESTART_MS = cfg.wedgeRestartMs || 600000;     // 10 menit wedge → exit(1)
let lastWaOkAt = Date.now();   // operasi WhatsApp NYATA terakhir yang sukses
let wedgeSince = null;         // epoch ms kegagalan probe pertama dari deret berjalan

function log(...a) { console.log(new Date().toISOString(), ...a); }
if (typeof fetch !== 'function') { log('FATAL: need Node >= 18 (global fetch)'); process.exit(1); }

// Semua fetch loopback lewat sini → AbortSignal.timeout mencegah await menggantung & mengunci `busy`.
function bfetch(url, opts = {}) { return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
// Bungkus panggilan wwebjs yang mengabaikan AbortSignal (Promise.race vs timer penolak) → tick tak bisa wedge.
function withTimeout(p, ms, label) {
  return Promise.race([
    // Sukses operasi WhatsApp NYATA = bukti hidup; menekan probe saat connector sibuk.
    Promise.resolve(p).then((v) => { lastWaOkAt = Date.now(); return v; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms)),
  ]);
}

// Probe liveness: uji apakah renderer masih mengeksekusi JavaScript. SENGAJA tidak
// menyentuh internal WhatsApp Web (mis. client.getState() → window.require('WAWebSocketModel')),
// karena internal itu terbukti drift dan probe yang salah memicu restart-loop tanpa akhir.
// Sengaja TIDAK lewat withTimeout: sukses probe bukan bukti lalu lintas nyata.
async function probeRenderer() {
  if (!client.pupPage) return false; // belum ada halaman = tidak hidup
  try {
    await Promise.race([
      client.pupPage.evaluate(() => 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:probe')), PROBE_TIMEOUT_MS)),
    ]);
    return true;
  } catch (e) {
    log('probe renderer gagal', e.message);
    return false;
  }
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
// NUANSA QR (insiden 2026-07-15): saat sesi hilang (hard-crash host → chromium wipe IndexedDB),
// konektor menunggu MANUSIA scan QR — itu bukan hang. Event 'qr'/'code' yang terus ter-emit adalah
// bukti hidup, jadi tiap event me-re-arm watchdog dengan deadline longgar (qrDeadlineMs) alih-alih
// exit(1) tiap 180s (dulu: loop restart ~3 menit tanpa henti, 132× dalam 6 jam, QR ikut ter-reset).
// Kalau chromium benar-benar wedge (qr berhenti ter-emit, ready tak datang), deadline longgar
// tetap memulihkan lewat restart. 'authenticated' (QR discan) mengembalikan deadline ketat.
const READY_DEADLINE_MS = cfg.readyDeadlineMs || 180000;
const QR_DEADLINE_MS = cfg.qrDeadlineMs || 1800000; // 30 menit per QR/kode segar
let readyWatchdog = null;
let watchdogPhase = null; // 'boot' | 'qr' | 'auth' — log hanya saat fase berganti (qr tiap ~20s = spam)
function armReadyWatchdog(ms, phase) {
  ms = ms || READY_DEADLINE_MS; phase = phase || 'boot';
  if (watchdogPhase !== phase) {
    watchdogPhase = phase;
    if (phase === 'qr') log('menunggu scan QR — watchdog dilonggarkan ke', ms, 'ms (proses TIDAK di-restart selama QR terus di-refresh)');
    if (phase === 'auth') log('QR discan (authenticated) — watchdog kembali ketat', ms, 'ms sampai ready');
  }
  if (readyWatchdog) clearTimeout(readyWatchdog);
  readyWatchdog = setTimeout(() => {
    log('FATAL: tidak mencapai ready dalam', ms, 'ms (fase ' + phase + ') — exit(1) untuk restart PM2');
    process.exit(1);
  }, ms);
  if (readyWatchdog.unref) readyWatchdog.unref();
}
armReadyWatchdog();

client.on('qr', async (qr) => {
  armReadyWatchdog(QR_DEADLINE_MS, 'qr'); // QR segar = bukti hidup — jangan restart selagi menunggu scan
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
      // Pairing dibatalkan (backend mengosongkan pair_phone). cancelPairingCode() TIDAK
      // pernah dipanggil di mana pun, jadi tombol "Batal / kembali ke QR" hanya kosmetik:
      // WhatsApp Web tetap di mode ALT_DEVICE_LINKING sampai proses di-restart.
      // AUDIT_2026-08-01 #11.
      if (lastPairPhone) {
        try { await client.cancelPairingCode(); log('pairing dibatalkan — kembali ke mode QR'); }
        catch (e) { log('cancelPairingCode err', e.message); }
      }
      lastPairPhone = null;
    }
  } catch (e) { log('qr dataurl error', e.message); }
});
// Kode pairing di-refresh wwebjs tiap ~3 menit → dorong ke halaman admin.
client.on('code', (code) => { armReadyWatchdog(QR_DEADLINE_MS, 'qr'); log('pairing code refreshed = ' + code); pushQrState({ pairing_code: code }); });
// QR discan / sesi tervalidasi → 'ready' harus menyusul cepat; kembalikan deadline ketat supaya
// stall pasca-auth tetap dipulihkan restart (aman: sesi baru sudah tersimpan, reconnect tanpa QR).
client.on('authenticated', () => { armReadyWatchdog(READY_DEADLINE_MS, 'auth'); });
client.on('ready', () => {
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; } // sehat → batalkan watchdog
  ready = true;
  linkedNumber = client.info?.wid?.user || null;
  failCount.clear(); // reconnect/recovery → beri baris yang sempat menyerah satu kesempatan kirim ulang (fresh, bukan basi)
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

// Status pengiriman (ack) pesan KELUAR kita: 1=server ✓, 2=delivered ✓✓, 3=read ✓✓ biru, 4=played.
// Di-buffer di sini lalu di-flush ke backend tiap tick bersama ack lain (hemat request, urut naik saja).
const ackStates = new Map(); // wa_msg_id -> ack tertinggi yang terlihat
client.on('message_ack', (msg, ack) => {
  try {
    const id = msg && msg.id && msg.id._serialized;
    if (!id || !msg.fromMe) return; // hanya lacak pesan yang KITA kirim
    if ((ackStates.get(id) || 0) < ack) ackStates.set(id, ack);
  } catch (_) { /* noop */ }
});

// Reaksi (visitor ↔ kita) pada sebuah pesan: buffer lalu flush tiap tick (emoji terbaru menang).
const reactionBuf = new Map(); // wa_msg_id -> emoji ('' = reaksi dihapus)
client.on('message_reaction', (reaction) => {
  try {
    const id = reaction && reaction.msgId && reaction.msgId._serialized;
    if (!id) return;
    reactionBuf.set(id, reaction.reaction || '');
  } catch (_) { /* noop */ }
});

// Tipe pesan sistem / non-percakapan yang harus diabaikan.
const IGNORED_TYPES = new Set(['e2e_notification', 'notification_template', 'gp2', 'call_log', 'ciphertext', 'revoked', 'protocol', 'interactive', 'notification']);

// msg_type DB dari msg.type wwebjs + mime. Stiker=webp; ptt=voice note; gif≈video.
function mediaTypeOf(msg, mime) {
  if (msg.type === 'sticker') return 'sticker';
  if (msg.type === 'ptt' || msg.type === 'audio' || (mime && mime.startsWith('audio/'))) return 'audio';
  if (msg.type === 'video' || msg.type === 'gif' || (mime && mime.startsWith('video/'))) return 'video';
  if (mime && mime.startsWith('image/')) return 'image';
  return 'document';
}
// Pesan non-file (lokasi / kontak vCard) → set payload.type + body, tanpa media. true bila ditangani.
function applyNonFile(msg, payload) {
  if (msg.type === 'location' && msg.location) {
    const loc = msg.location;
    payload.type = 'location';
    payload.body = (loc.description ? loc.description + '\n' : '') + 'https://maps.google.com/?q=' + loc.latitude + ',' + loc.longitude;
    return true;
  }
  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    payload.type = 'contact';
    payload.body = msg.body || '[kontak]';
    return true;
  }
  return false;
}

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
      // Reply: tangkap pesan yang dikutip (utk chip kutipan di FE).
      let quoted = {};
      if (msg.hasQuotedMsg) {
        try {
          const q = await withTimeout(msg.getQuotedMessage(), WA_OP_TIMEOUT_MS, 'getQuotedMessage-in');
          if (q) quoted = { quoted_msg_id: (q.id && q.id._serialized) || null, quoted_preview: (q.body || '').slice(0, 255) };
        } catch (_) { /* best-effort */ }
      }
      let payload = { phone, wa_chat_id: waId, wa_msg_id: waMsgId, type: 'text', body: bodyText, ...quoted };
      applyNonFile(msg, payload); // lokasi / kontak (tanpa file)
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
            type: mediaTypeOf(msg, mime),
            body: msg.body || '', media_path: fname, media_mime: mime, media_name: media.filename || fname,
            ...quoted,
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
    // Heartbeat liveness: backend cap updated_at tiap detak; UI/monitor anggap "online" hanya bila
    // now - updated_at < TTL → status mati tak bisa basi seperti dulu.
    // (Fire-and-forget; pushQrState menelan error sendiri & sudah ber-timeout via bfetch.)
    //
    // Bukti hidup harus menyentuh WhatsApp. Dulu heartbeat didorong tiap poll HTTP sukses —
    // poll itu murni HTTP ke backend, jadi ia membuktikan proses Node hidup, BUKAN bahwa
    // WhatsApp berfungsi. Itulah sebabnya renderer mati 3 Agu 2026 lolos 8j14m tanpa alert.
    // Operasi WA nyata yang baru saja sukses sudah cukup jadi bukti; selain itu, probe.
    const alive = (Date.now() - lastWaOkAt < PROBE_SKIP_MS) || (await probeRenderer());
    const now   = Date.now();
    const act   = wedgePolicy(alive, wedgeSince, now, WEDGE_RESTART_MS);
    wedgeSince  = act.wedgeSince;
    if (act.heartbeat) {
      pushQrState({ ready: true, number: linkedNumber, heartbeat: true });
    } else {
      const lama = Math.round((now - act.wedgeSince) / 1000);
      log('renderer tak responsif — heartbeat ditahan (' + lama + 's/' + Math.round(WEDGE_RESTART_MS / 1000) + 's)');
    }
    if (act.restart && !shuttingDown) {
      log('FATAL: renderer tak responsif ' + Math.round((now - act.wedgeSince) / 1000) + ' detik — exit(1) untuk restart PM2');
      process.exit(1);
    }
    const messages = (body.data && body.data.messages) || [];
    const sentOutbox = []; // wa_outbox ids (templated)
    const chatSent = [];   // [{id, wa_msg_id}] live chat — simpan WA id agar backfill/recovery tak menggandakan
    const failedChat = []; // wa_messages ids yang menyerah → tandai 'failed'
    const failedOutbox = []; // wa_outbox ids yang menyerah → backend bump attempts/failed (cegah stuck-pending → terkirim basi)
    const BATCH = cfg.sendBatch || 6; // batasi kirim per tick → command (logout) tetap responsif + pacing terjaga
    let processed = 0;
    for (const m of messages) {
      if (processed >= BATCH) break; // sisanya di tick berikutnya
      const key = (m.kind || 'outbox') + ':' + m.id; // outbox & chat punya ruang id sendiri
      if ((failCount.get(key) || 0) >= MAX_SEND_ATTEMPTS) {
        // #10 — sudah menyerah kirim, tapi RE-REPORT tiap tick sampai backend ack (idempoten: backend
        // bump attempts / tandai 'failed' lalu berhenti menyajikannya → re-report berhenti sendiri).
        // Tanpa ini, kalau POST fail-mark sebelumnya hilang, row tetap 'pending' + failCount skip
        // selamanya → stuck-pending → terkirim basi saat connector restart.
        if (m.kind === 'chat') failedChat.push(m.id); else failedOutbox.push(m.id);
        continue;
      }
      // Chat media: pastikan file masih ada sebelum kirim — hindari crash & false-fail.
      if (m.kind === 'chat' && m.media_path && !fs.existsSync(path.join(MEDIA_DIR, path.basename(m.media_path)))) {
        log('media file missing for chat', m.id);
        failedChat.push(m.id);
        continue;
      }
      processed++;
      try {
        const dest = m.wa_chat_id || jidFromLocal(m.phone);
        const sendOpts = m.quoted_msg_id ? { quotedMessageId: m.quoted_msg_id } : {}; // reply → kutip pesan
        let sentMsg;
        if (m.kind === 'chat' && m.media_path) {
          const media = MessageMedia.fromFilePath(path.join(MEDIA_DIR, path.basename(m.media_path)));
          if (m.media_name) media.filename = m.media_name; // pakai nama asli, bukan uuid disk, di WhatsApp
          sentMsg = await withTimeout(client.sendMessage(dest, media, { caption: m.body || '', ...sendOpts }), WA_OP_TIMEOUT_MS, 'send-media');
        } else {
          sentMsg = await withTimeout(client.sendMessage(dest, m.body || '', sendOpts), WA_OP_TIMEOUT_MS, 'send-text');
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
          else failedOutbox.push(m.id); // outbox: lapor ke backend → bump attempts / tandai failed (anti stale)
        }
      }
    }
    // ── Auto-seen: chat yang dibuka petugas → tandai "dibaca" (centang biru utk visitor). Best-effort. ──
    const seenChats = (body.data && body.data.seen) || [];
    for (const cid of seenChats) {
      try {
        const c = await withTimeout(client.getChatById(cid), WA_OP_TIMEOUT_MS, 'getChatById-seen');
        await withTimeout(c.sendSeen(), WA_OP_TIMEOUT_MS, 'sendSeen');
      } catch (e) { log('sendSeen err ' + cid, e.message); }
    }
    // ── Reaksi keluar (petugas → visitor): message.react(emoji). Best-effort. ──
    const reactionsOut = (body.data && body.data.reactions_out) || [];
    for (const ro of reactionsOut) {
      try {
        const rm = await withTimeout(client.getMessageById(ro.wa_msg_id), WA_OP_TIMEOUT_MS, 'getMessageById-react');
        if (rm) await withTimeout(rm.react(ro.emoji || ''), WA_OP_TIMEOUT_MS, 'react');
      } catch (e) { log('react-out err ' + ro.wa_msg_id, e.message); }
    }
    // ── Backfill: ambil histori chat dari WhatsApp → ingest (dedup). Juga recovery pasca-outage. ──
    const backfills = (body.data && body.data.backfills) || [];
    // Persist pesan terkirim SEBELUM backfill jalan → dedup wa_msg_id backend bisa melihat id-nya
    // (cegah duplikat hantu saat reconnect mengirim balasan + backfill chat yang sama di tick yg
    // sama). Hanya saat ada backfill, jadi steady-state (tanpa backfill) tak menambah POST.
    if (backfills.length && (sentOutbox.length || chatSent.length)) {
      // #9 — clear sent-id buffer HANYA bila ACK POST sukses. Sebelumnya .catch menelan error lalu
      // buffer tetap ter-clear → row 'pending' → kirim ganda + backfill re-ingest pesan sendiri.
      let preAckOk = false;
      try {
        const rr = await bfetch(ACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
          body: JSON.stringify({ ids: sentOutbox, chat_sent: chatSent }),
        });
        preAckOk = rr.ok;
      } catch (e) { log('ack-send(pre-backfill) error', e.message); }
      if (preAckOk) {
        log('acked-send(pre-backfill) outbox=' + sentOutbox.length + ' chat=' + chatSent.length);
        sentOutbox.length = 0; chatSent.length = 0; // sudah di-ack; jangan ack ganda di akhir
      } else {
        // ACK gagal → JANGAN clear (id terbawa ke ack akhir tick) & tunda backfill tick ini supaya
        // backfill tak menggandakan pesan yang wa_msg_id-nya belum sempat tercatat backend.
        log('ack-send(pre-backfill) gagal — tunda backfill tick ini, sent-id dipertahankan');
        backfills.length = 0;
      }
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
          if (msg.hasQuotedMsg) {
            try {
              const q = await withTimeout(msg.getQuotedMessage(), WA_OP_TIMEOUT_MS, 'getQuotedMessage-bf');
              if (q) { payload.quoted_msg_id = (q.id && q.id._serialized) || null; payload.quoted_preview = (q.body || '').slice(0, 255); }
            } catch (_) { /* best-effort */ }
          }
          applyNonFile(msg, payload); // lokasi / kontak (tanpa file)
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
                payload.type = mediaTypeOf(msg, mime);
                payload.media_path = fname; payload.media_mime = mime; payload.media_name = media.filename || fname;
              }
            } catch (e) { log('backfill media err', e.message); }
          }
          // Media gagal diunduh (timeout/throttle) → JANGAN ingest baris teks-only ber-wa_msg_id.
          // Kalau diingest, wa_msg_id terkunci ke baris tanpa media → backfill ulang ditolak duplikat
          // → media hilang permanen (audit 2026-06-19, dedup-poison). Lewati; backfill berikut retry bersih.
          if (msg.hasMedia && !payload.media_path) { log('backfill skip media-undownloaded msg=' + payload.wa_msg_id); continue; }
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
      } catch (e) {
        log('backfill err phone=' + bf.phone, e.message);
        // wa_chat_id BASI (mis. setelah sesi di-relink 2026-07-15) → getChatById melempar
        // selamanya, jadi backfill tidak pernah pulih dengan sendirinya: 26 baris menyerah
        // di attempts=4 dan seluruh jalur pemulihan pasca-outage mati ~2,5 minggu tanpa
        // sinyal. Resolve ulang id dari nomor lalu coba SEKALI lagi. AUDIT_2026-08-01 #10.
        try {
          const nid = await withTimeout(client.getNumberId(bf.phone), WA_OP_TIMEOUT_MS, 'getNumberId-bf');
          const fresh = nid && nid._serialized;
          if (fresh && fresh !== bf.wa_chat_id) {
            log('backfill chat-id basi ' + bf.wa_chat_id + ' -> ' + fresh + ' (coba ulang)');
            const chat2 = await withTimeout(client.getChatById(fresh), WA_OP_TIMEOUT_MS, 'getChatById-retry');
            const msgs2 = await withTimeout(chat2.fetchMessages({ limit: BACKFILL_LIMIT }), WA_OP_TIMEOUT_MS, 'fetchMessages-retry');
            // Ingest teks saja pada jalur pemulihan ini — media ditangani percobaan normal
            // berikutnya, dan yang penting di sini adalah tidak kehilangan riwayat percakapan.
            for (const m2 of msgs2) {
              if (m2.isStatus || (m2.type && IGNORED_TYPES.has(m2.type))) continue;
              if (m2.hasMedia) continue;
              try {
                await bfetch(CHAT_INGEST_URL, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
                  body: JSON.stringify({
                    phone: bf.phone, wa_chat_id: fresh,
                    wa_msg_id: (m2.id && m2.id._serialized) || null,
                    from_me: !!m2.fromMe, ts: m2.timestamp || 0, backfill: true,
                    type: 'text', body: m2.body || '',
                  }),
                });
              } catch (e3) { log('backfill retry ingest err', e3.message); }
            }
            log('backfill pulih via chat-id baru phone=' + bf.phone + ' msgs=' + msgs2.length);
            ok = true;
          }
        } catch (e2) { log('backfill chat-id resolve gagal', e2.message); }
      }
      // Sukses → done. Gagal (chat tak ada / timeout) → retry via poll berikutnya;
      // backend menyerah setelah 4 percobaan supaya tak loop selamanya. (anti data-loss)
      if (ok) backfillDone.push(bf.id); else backfillFailed.push(bf.id);
    }

    // Snapshot buffer ack/reaksi TANPA clear dulu — buffer ini state ephemeral connector; kalau
    // POST gagal & sudah ter-clear, tick delivered/read & reaksi masuk HILANG permanen. Hapus hanya
    // setelah POST sukses, dan hanya entri yang belum berubah (event baru saat POST in-flight tetap aman).
    const ackArr = [];
    for (const [wa_msg_id, ack] of ackStates) ackArr.push({ wa_msg_id, ack });
    const reactArr = [];
    for (const [wa_msg_id, emoji] of reactionBuf) reactArr.push({ wa_msg_id, emoji });
    if (sentOutbox.length || chatSent.length || backfillDone.length || backfillFailed.length || failedOutbox.length || ackArr.length || reactArr.length) {
      try {
        await bfetch(ACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
          body: JSON.stringify({ ids: sentOutbox, chat_sent: chatSent, backfill_ids: backfillDone, backfill_fail: backfillFailed, outbox_fail: failedOutbox, ack_states: ackArr, reactions: reactArr }),
        });
        for (const a of ackArr) if (ackStates.get(a.wa_msg_id) === a.ack) ackStates.delete(a.wa_msg_id);
        for (const r of reactArr) if (reactionBuf.get(r.wa_msg_id) === r.emoji) reactionBuf.delete(r.wa_msg_id);
        log('acked outbox=' + sentOutbox.length + ' chat=' + chatSent.length + ' backfill=' + backfillDone.length + ' bf_fail=' + backfillFailed.length + ' ob_fail=' + failedOutbox.length + ' ack=' + ackArr.length + ' react=' + reactArr.length);
      } catch (e) {
        log('ack POST gagal — buffer dipertahankan, retry tick berikutnya', e.message); // jangan hapus → cegah hilang
      }
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
    /Target closed|Execution context was destroyed|Navigation failed|Protocol error/.test(m) ||
    /browser is already running/i.test(m); // lock profil dari chromium sisa attempt sebelumnya — pulih setelah reap
};
async function connect() {
  for (let attempt = 1; attempt <= INIT_MAX_RETRY; attempt++) {
    try { await client.initialize(); return; }
    catch (e) {
      log('initialize gagal attempt ' + attempt + '/' + INIT_MAX_RETRY + ':', e.message);
      if (!isTransientNav(e) || attempt === INIT_MAX_RETRY) {
        log('initialize tak terpulihkan — exit(1) untuk restart PM2'); process.exit(1);
      }
      // initialize yang gagal pasca-launch MENINGGALKAN chromium hidup memegang SingletonLock profil
      // → tanpa reap, attempt berikutnya pasti "browser is already running" (insiden 2026-07-15:
      // retry 5x efektif cuma 2x lalu exit). Bunuh dulu supaya retry benar-benar bersih.
      killBrowserSync();
      const wait = Math.min(INIT_BACKOFF_MS * Math.pow(2, attempt - 1), 60000);
      log('retry initialize dalam ' + wait + ' ms'); await sleep(wait);
    }
  }
}

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
connect();
setInterval(tick, POLL);
