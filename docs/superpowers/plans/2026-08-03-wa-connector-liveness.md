# Deteksi Connector WA Lumpuh Pasca-`ready` — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## STATUS — 2026-08-04

**Kode SELESAI dan ter-commit. Belum DITERAPKAN ke proses yang berjalan.**

| Task | Status | Commit |
| --- | --- | --- |
| 1 — `wedgePolicy` + skrip verifikasi | selesai | `40d2dcd` |
| 2 — `probeRenderer` + `lastWaOkAt` | selesai | `7164134` |
| 3 — gerbang heartbeat di `tick()` | selesai | `87639eb` |
| 4 — konfigurasi | kunci sudah ditulis ke `wa/config.json` (tak ter-commit, gitignore) | — |
| 4 — penerapan (Step 2–5) | **BELUM** — menunggu izin `pm2 restart bukutamu-wa` | — |

`wa/server.js` di disk sudah berisi perbaikan, tetapi proses PM2 masih menjalankan kode
lama sampai di-restart. Sampai saat itu **connector masih buta terhadap wedge pasca-`ready`**.

Penyimpangan dari rencana (disengaja, satu tempat): pada Task 3 Step 2 rencana meminta
komentar lama dipertahankan apa adanya. Kalimat pembukanya berbunyi "poll sukses = bukti
hidup" — justru klaim keliru yang sedang diperbaiki commit ini. Kalimat itu ditulis ulang;
sisa komentar (semantik TTL, catatan fire-and-forget) dipertahankan.

Langkah berikutnya: Task 4 Step 2 (minta izin) → Step 3 (restart) → Step 4 (verifikasi
jalur sehat) → Step 5 (reproduksi wedge, opsional dan mengganggu) → perbarui memori
`wa_connector_resilience.md` bagian "Fixing this needs a liveness probe … NOT shipped".

**Goal:** Heartbeat connector WhatsApp hanya mengalir bila renderer chromium terbukti responsif, sehingga kelumpuhan pasca-`ready` memicu alert OFFLINE dalam ~60 detik dan restart otomatis dalam ~10 menit — bukan senyap 8 jam seperti 2026-08-03.

**Architecture:** Tiga bagian kecil di satu berkas. (1) Penanda `lastWaOkAt` yang dibumbui di jalur sukses `withTimeout` — satu sisipan meliput ke-16 operasi WhatsApp. (2) `probeRenderer()` yang menguji `client.pupPage.evaluate(() => 1)` dengan batas waktu pendek dan sengaja **tidak** memakai `withTimeout` agar probe tidak menganggap dirinya sendiri sebagai bukti lalu lintas nyata. (3) `wedgePolicy()` — fungsi murni tanpa efek samping yang memetakan (hasil probe, panjang deret gagal) menjadi keputusan (heartbeat / tahan / restart), sehingga logikanya bisa diuji tanpa WhatsApp, chromium, maupun jaringan.

**Tech Stack:** Node.js (CommonJS), whatsapp-web.js 1.34.7, puppeteer, PM2. Tanpa framework test — repo ini memang tidak punya (lihat `.claude/rules/testing.md`); verifikasi memakai skrip node berdiri sendiri plus pengamatan langsung.

## Global Constraints

- Spesifikasi sumber: `docs/superpowers/specs/2026-08-03-wa-connector-liveness-design.md`.
- **Hanya** `wa/server.js` dan `wa/config.json` yang berubah. Backend, frontend, dan skema database TIDAK berubah — mesin alert sudah ada dan sudah benar (`Wa.php:1254`, `$STALE_TTL = 60`).
- **Drift wwebjs di luar cakupan.** Dilarang memakai `client.getState()` atau API apa pun yang menyentuh internal WhatsApp Web (`window.require('WAWebSocketModel')` dan sejenisnya) sebagai probe. Alasan lengkap di §3 dan §4.1 spec.
- Aturan wajib tiap suntingan berkas (dari `CLAUDE.md`): baca berkas dulu → `cp {file} {file}.backup` → ubah seminimal mungkin → `diff {file}.backup {file}`.
- Commit **tanpa** trailer `Co-Authored-By` (aturan permanen repo ini).
- Gaya kode: ikuti `wa/server.js` yang ada — CommonJS, `const` di puncak berkas, komentar berbahasa Indonesia, `log(...)` untuk keluaran.
- Nilai default wajib ada di kode sehingga `wa/config.json` yang belum diperbarui tetap jalan: `probeTimeoutMs` 5000, `probeSkipMs` 30000, `wedgeRestartTicks` 60.
- `wa/server.js` berjalan di bawah PM2 dan perubahan **tidak aktif** sampai `pm2 restart bukutamu-wa`. Jangan restart tanpa izin — restart melempar connector ke cold-sync.

---

### Task 1: Fungsi keputusan `wedgePolicy` (murni, teruji)

Fungsi ini adalah satu-satunya tempat kebijakan operasional dikodekan. Dibuat murni (tanpa I/O, tanpa `Date.now()`, tanpa efek samping) supaya bisa diuji penuh tanpa WhatsApp.

Dibuat sebagai **modul terpisah**, bukan disisipkan ke `wa/server.js`. Alasannya praktis: `wa/server.js` memanggil `connect()` dan `setInterval(tick, POLL)` di baris terakhirnya, jadi mem-`require`-nya dari skrip uji akan meluncurkan chromium dan berebut lock dengan connector produksi. Modul murni menghindari itu sepenuhnya tanpa perlu menyentuh bootstrap.

**Files:**
- Create: `wa/lib/wedge-policy.js`
- Create: `scripts/smoke/wa_wedge_policy.js`

**Interfaces:**
- Produces: `wedgePolicy(alive: boolean, streak: number, maxStreak: number) => { streak: number, heartbeat: boolean, restart: boolean }`
  - `alive` — hasil pemeriksaan hidup tick ini
  - `streak` — jumlah kegagalan berturut **sebelum** hasil ini
  - `maxStreak` — ambang restart (`WEDGE_RESTART_TICKS`)
  - `streak` (keluaran) — nilai penghitung yang harus dipakai tick berikutnya
  - `heartbeat` — true bila heartbeat boleh didorong
  - `restart` — true bila proses harus `exit(1)`
- Consumes: —

- [x] **Step 1: Tulis skrip verifikasi yang gagal lebih dulu**

Buat `scripts/smoke/wa_wedge_policy.js`. Skrip ini **tidak menyentuh database maupun jaringan** — murni memeriksa logika, jadi aman dijalankan kapan saja (berbeda dari smoke lain di direktori ini yang menulis ke produksi).

```js
#!/usr/bin/env node
// Verifikasi wedgePolicy — murni logika, TIDAK menyentuh DB/jaringan/WhatsApp.
// Jalankan: node scripts/smoke/wa_wedge_policy.js
const { wedgePolicy } = require('../../wa/lib/wedge-policy');

let gagal = 0;
function cek(nama, aktual, harapan) {
  const a = JSON.stringify(aktual), h = JSON.stringify(harapan);
  if (a === h) { console.log('  ok   ' + nama); }
  else { console.log('  GAGAL ' + nama + '\n         dapat  ' + a + '\n         harap  ' + h); gagal++; }
}

const MAX = 60;

// Sehat → heartbeat mengalir, deret ter-reset.
cek('hidup dari nol',      wedgePolicy(true,  0,  MAX), { streak: 0, heartbeat: true,  restart: false });
cek('hidup setelah gagal', wedgePolicy(true, 37,  MAX), { streak: 0, heartbeat: true,  restart: false });

// Gagal → heartbeat DITAHAN sejak kegagalan pertama (TTL 60s backend yang jadi debounce).
cek('gagal pertama',       wedgePolicy(false, 0,  MAX), { streak: 1, heartbeat: false, restart: false });
cek('gagal keenam',        wedgePolicy(false, 5,  MAX), { streak: 6, heartbeat: false, restart: false });

// Belum sampai ambang → jangan restart.
cek('tepat sebelum ambang', wedgePolicy(false, MAX - 2, MAX), { streak: MAX - 1, heartbeat: false, restart: false });

// Mencapai ambang → restart.
cek('mencapai ambang',      wedgePolicy(false, MAX - 1, MAX), { streak: MAX, heartbeat: false, restart: true });
cek('melewati ambang',      wedgePolicy(false, MAX + 3, MAX), { streak: MAX + 4, heartbeat: false, restart: true });

console.log(gagal === 0 ? '\nSEMUA LULUS' : '\n' + gagal + ' GAGAL');
process.exit(gagal === 0 ? 0 : 1);
```

- [x] **Step 2: Jalankan untuk memastikan ia GAGAL**

```bash
cd /var/www/html/bukutamu && node scripts/smoke/wa_wedge_policy.js
```

Harapan: `Error: Cannot find module '../../wa/lib/wedge-policy'` — modulnya memang belum ada.

- [x] **Step 3: Buat modul `wa/lib/wedge-policy.js`**

Berkas baru, tidak ada yang di-backup. Isi badan fungsi sesuai tabel §4.3 spec:

```js
// Kebijakan wedge pasca-`ready` — MURNI (tanpa I/O), supaya bisa diuji tanpa WhatsApp.
// alive     : hasil pemeriksaan hidup tick ini
// streak    : jumlah kegagalan berturut SEBELUM hasil ini
// maxStreak : ambang restart (WEDGE_RESTART_TICKS)
// → { streak, heartbeat, restart }
//
// Catatan desain: heartbeat ditahan sejak kegagalan PERTAMA. Tidak perlu ambang
// alert di sini — TTL 60 detik di backend (Wa.php:1254) yang berperan sebagai
// debounce, sehingga butuh ~6 kegagalan berturut (tick 10 detik) sebelum alert
// OFFLINE menyala. Blip satu-dua tick sembuh sendiri tanpa efek.
function wedgePolicy(alive, streak, maxStreak) {
  if (alive) return { streak: 0, heartbeat: true, restart: false };
  const next = streak + 1;
  return { streak: next, heartbeat: false, restart: next >= maxStreak };
}
```

Tutup berkas dengan ekspornya:

```js
module.exports = { wedgePolicy };
```

- [x] **Step 4: Jalankan verifikasi sampai LULUS**

```bash
cd /var/www/html/bukutamu && node scripts/smoke/wa_wedge_policy.js
```

Harapan: tujuh baris `ok` lalu `SEMUA LULUS`, kode keluar 0. Skrip harus selesai seketika — modul ini murni, tidak ada chromium yang diluncurkan.

- [x] **Step 5: Commit**

```bash
cd /var/www/html/bukutamu
git add wa/lib/wedge-policy.js scripts/smoke/wa_wedge_policy.js
git commit -m "feat(wa): tambah wedgePolicy — kebijakan deteksi connector lumpuh pasca-ready"
```

---

### Task 2: Probe renderer dan penanda lalu lintas nyata

**Files:**
- Modify: `wa/server.js` (konstanta di puncak; `withTimeout`; fungsi baru `probeRenderer`)

**Interfaces:**
- Consumes: `wedgePolicy` dari Task 1
- Produces:
  - `lastWaOkAt: number` — epoch ms operasi WhatsApp **nyata** terakhir yang sukses
  - `probeRenderer() => Promise<boolean>` — true bila renderer masih mengeksekusi JavaScript
  - Konstanta `PROBE_TIMEOUT_MS`, `PROBE_SKIP_MS`, `WEDGE_RESTART_TICKS`

- [x] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu && cp wa/server.js wa/server.js.backup
```

- [x] **Step 2: Tambahkan konstanta dan state**

Letakkan bersama konstanta lain di puncak berkas, dekat `WA_OP_TIMEOUT_MS` (baris ~37). Baris `require` menyusul modul dari Task 1 — letakkan bersama `require` lain di puncak berkas:

```js
const { wedgePolicy } = require('./lib/wedge-policy');

// Liveness pasca-`ready`: probe renderer chromium. Sengaja jauh lebih pendek dari
// WA_OP_TIMEOUT_MS — pada renderer sehat, evaluate(() => 1) kembali dalam milidetik.
const PROBE_TIMEOUT_MS    = cfg.probeTimeoutMs || 5000;
const PROBE_SKIP_MS       = cfg.probeSkipMs || 30000;      // lewati probe bila ada operasi WA nyata sebaru ini
const WEDGE_RESTART_TICKS = cfg.wedgeRestartTicks || 60;   // ~10 menit pada tick 10 detik
let lastWaOkAt  = Date.now();  // operasi WhatsApp NYATA terakhir yang sukses
let wedgeStreak = 0;           // kegagalan probe berturut-turut
```

- [x] **Step 3: Bumbui jalur sukses `withTimeout`**

Ke-16 pemanggil `withTimeout` seluruhnya operasi WhatsApp murni (`client.*`, `msg.*`, `chat.*`, `c.sendSeen()`, `rm.react()`); panggilan ke backend memakai `bfetch` yang terpisah. Karena itu satu sisipan di sini meliput semuanya. Ganti:

```js
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);
}
```

menjadi:

```js
function withTimeout(p, ms, label) {
  return Promise.race([
    // Sukses operasi WhatsApp NYATA = bukti hidup; menekan probe saat connector sibuk.
    Promise.resolve(p).then((v) => { lastWaOkAt = Date.now(); return v; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms)),
  ]);
}
```

- [x] **Step 4: Tambahkan `probeRenderer`**

Letakkan setelah `withTimeout`. Catat: fungsi ini **tidak** memakai `withTimeout`, karena keberhasilan probe bukan bukti lalu lintas nyata — kalau ia ikut membumbui `lastWaOkAt`, probe akan melewatkan dirinya sendiri di tick berikutnya dan memperlambat deteksi.

```js
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
```

- [x] **Step 5: Verifikasi berkas tetap sah dan uji Task 1 masih lulus**

```bash
cd /var/www/html/bukutamu && node --check wa/server.js && node scripts/smoke/wa_wedge_policy.js
```

Harapan: `node --check` diam (sintaks sah), lalu `SEMUA LULUS`.

- [x] **Step 6: Verifikasi diff**

```bash
cd /var/www/html/bukutamu && diff wa/server.js.backup wa/server.js
```

Harapan: hanya blok konstanta baru, `withTimeout` yang diperluas, dan `probeRenderer`. Tidak ada perubahan lain.

- [x] **Step 7: Commit**

```bash
cd /var/www/html/bukutamu
git add wa/server.js
git commit -m "feat(wa): probe renderer + penanda lalu lintas WhatsApp nyata"
```

---

### Task 3: Gerbangi heartbeat di `tick()`

Inilah perubahan yang benar-benar menutup celahnya.

**Files:**
- Modify: `wa/server.js:371` (dorongan heartbeat tanpa syarat)

**Interfaces:**
- Consumes: `wedgePolicy`, `probeRenderer`, `lastWaOkAt`, `wedgeStreak`, `PROBE_SKIP_MS`, `WEDGE_RESTART_TICKS`
- Produces: —

- [x] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu && cp wa/server.js wa/server.js.backup
```

- [x] **Step 2: Ganti dorongan heartbeat tanpa syarat**

Baris 371 saat ini berbunyi:

```js
    pushQrState({ ready: true, number: linkedNumber, heartbeat: true });
```

Ganti seluruh baris itu (pertahankan komentar di atasnya) dengan:

```js
    // Bukti hidup harus menyentuh WhatsApp. Dulu heartbeat didorong tiap poll HTTP sukses —
    // poll itu murni HTTP ke backend, jadi ia membuktikan proses Node hidup, BUKAN bahwa
    // WhatsApp berfungsi. Itulah sebabnya renderer mati 3 Agu 2026 lolos 8j14m tanpa alert.
    // Operasi WA nyata yang baru saja sukses sudah cukup jadi bukti; selain itu, probe.
    const alive = (Date.now() - lastWaOkAt < PROBE_SKIP_MS) || (await probeRenderer());
    const act   = wedgePolicy(alive, wedgeStreak, WEDGE_RESTART_TICKS);
    wedgeStreak = act.streak;
    if (act.heartbeat) {
      pushQrState({ ready: true, number: linkedNumber, heartbeat: true });
    } else {
      log('renderer tak responsif — heartbeat ditahan (deret ' + wedgeStreak + '/' + WEDGE_RESTART_TICKS + ')');
    }
    if (act.restart && !shuttingDown) {
      log('FATAL: renderer tak responsif ' + wedgeStreak + ' tick berturut — exit(1) untuk restart PM2');
      process.exit(1);
    }
```

- [x] **Step 3: Verifikasi sintaks dan uji unit**

```bash
cd /var/www/html/bukutamu && node --check wa/server.js && node scripts/smoke/wa_wedge_policy.js
```

Harapan: sintaks sah, `SEMUA LULUS`.

- [x] **Step 4: Verifikasi diff**

```bash
cd /var/www/html/bukutamu && diff wa/server.js.backup wa/server.js
```

Harapan: satu baris terhapus, blok gerbang bertambah. Tidak ada yang lain.

- [x] **Step 5: Commit**

```bash
cd /var/www/html/bukutamu
git add wa/server.js
git commit -m "fix(wa): gerbangi heartbeat dengan probe renderer — tutup outage senyap pasca-ready"
```

---

### Task 4: Konfigurasi, penerapan, dan verifikasi langsung

**Files:**
- Modify: `wa/config.json`

**Interfaces:**
- Consumes: konstanta dari Task 2
- Produces: —

- [x] **Step 1: Backup dan tambahkan kunci konfigurasi** — sudah; `wa/config.json` ter-gitignore (memuat `internalSecret`), jadi TIDAK di-commit (lihat catatan Step 6).

```bash
cd /var/www/html/bukutamu && cp wa/config.json wa/config.json.backup
```

Tambahkan tiga kunci (nilainya sama dengan default di kode — ditulis eksplisit agar terlihat dan mudah disetel saat verifikasi Tahap 2):

```json
  "probeTimeoutMs": 5000,
  "probeSkipMs": 30000,
  "wedgeRestartTicks": 60,
```

Verifikasi JSON tetap sah:

```bash
cd /var/www/html/bukutamu && node -e "JSON.parse(require('fs').readFileSync('wa/config.json','utf8')); console.log('JSON sah')"
```

- [ ] **Step 2: MINTA IZIN sebelum restart**

`pm2 restart bukutamu-wa` melempar connector ke cold-sync (bisa 8–15 menit bila WhatsApp sedang rewel). **Jangan lakukan tanpa persetujuan eksplisit**, dan pilih saat saluran sedang sepi. Sesi WhatsApp dipakai ulang — tidak perlu scan QR.

- [ ] **Step 3: Terapkan**

```bash
pm2 restart bukutamu-wa && pm2 logs bukutamu-wa --lines 40 --nostream
```

Harapan: `WA client ready; nomor=6285176764422` muncul dalam ~15 detik.

- [ ] **Step 4: Verifikasi Tahap 1 — jalur sehat (aman)**

Amati beberapa menit:

```bash
cd /var/www/html/bukutamu
mysql db_tamdes -e "SELECT ready, updated_at, TIMESTAMPDIFF(SECOND,updated_at,NOW()) AS sec_ago FROM wa_qr_state WHERE id=1;"
pm2 logs bukutamu-wa --lines 60 --nostream | grep -cE "renderer tak responsif"
```

Harapan: `sec_ago` selalu di bawah 60 (heartbeat mengalir), dan hitungan baris "renderer tak responsif" = **0**.

- [ ] **Step 5: Verifikasi Tahap 2 — reproduksi wedge sungguhan (MENGGANGGU, minta izin lagi)**

Ini sengaja mematikan saluran WA sebentar. **Wajib di luar jam layanan dan dengan izin eksplisit.** Untuk memperpendek pengamatan, turunkan dulu `wedgeRestartTicks` ke `12` (≈2 menit) di `wa/config.json`, restart, lalu bunuh renderer — mereproduksi kegagalan 3 Agustus:

```bash
pkill -f "type=renderer.*wwebjs_auth"
```

Amati berurutan:

1. `renderer tak responsif — heartbeat ditahan (deret 1/12)` muncul di log dalam ~10 detik
2. kartu OFFLINE merah muncul di halaman admin Layanan Online dalam ~60–70 detik
3. `FATAL: renderer tak responsif 12 tick berturut — exit(1)` pada ~2 menit
4. PM2 menjalankan ulang, lalu `WA client ready` tanpa scan QR

Kembalikan `wedgeRestartTicks` ke `60` dan restart sekali lagi setelah selesai.

- [ ] **Step 6: Verifikasi diff dan commit**

```bash
cd /var/www/html/bukutamu
diff wa/config.json.backup wa/config.json
git add wa/config.json
git commit -m "chore(wa): kunci konfigurasi probe liveness"
```

Catatan: periksa apakah `wa/config.json` terlacak git — ia memuat `internalSecret` dan `qrToken`. Bila berkas ini ter-gitignore, **lewati `git add`** dan cukup catat perubahannya; jangan pernah mendorong rahasia ke repo.

---

## Catatan pasca-implementasi

Setelah Task 4 selesai, perbarui memori proyek `wa_connector_resilience.md`: mode kegagalan keempat kini **terdeteksi otomatis**, dan kalimat "Fixing this needs a liveness probe … NOT shipped as of 2026-08-03" harus diganti dengan rujukan ke perilaku baru beserta ambangnya.

Dua hal yang **tidak** disentuh rencana ini dan tetap terbuka:

1. **Drift wwebjs** — backfill mati sejak 2026-07-14 (47 gagal berturut), `sendSeen` rusak, `sendMessage` mengembalikan objek tanpa `id._serialized` sehingga `wa_msg_id` tersimpan NULL dan `ack` tak pernah naik. Butuh spesifikasi sendiri; kemungkinan upgrade wwebjs.
2. **Pesan `failed` tidak pernah dicoba ulang** — `poll()` hanya menyajikan `status='pending'`. Setelah outage, baris `failed` harus diantrikan ulang manual. Layak dipertimbangkan sebagai perbaikan terpisah.
