# Deteksi Connector WA Lumpuh Pasca-`ready`

- **Tanggal:** 2026-08-03
- **Status:** Disetujui, siap direncanakan
- **Komponen terdampak:** `wa/server.js` (connector), `wa/config.json`
- **Tidak berubah:** backend, frontend, database
- **Insiden pemicu:** outage senyap 8 jam 14 menit, 2026-08-03 07:37–15:56 WIT

## 1. Masalah

Pada 2026-08-03 pukul ~07:37 WIT proses renderer chromium yang menjalankan
`web.whatsapp.com` mati. Enumerasi proses milik sesi connector saat insiden
menunjukkan BROWSER + 2 zygote + gpu-process + 3 utility, tetapi **nol proses
`--type=renderer`**.

whatsapp-web.js menjalankan setiap operasi lewat `page.evaluate()`. Tanpa
renderer, promise itu tidak pernah *resolve* maupun *reject* — ia menggantung
selamanya, dan satu-satunya yang muncul adalah pagar `withTimeout` milik
connector sendiri:

```
06:37:03Z send error outbox:2106 attempt 1 timeout:send-text
06:39:28Z send error chat:812  attempt 1 timeout:send-media
...  sendSeen err ... timeout:getChatById-seen
...  backfill err ... timeout:getChatById
```

Selama 8 jam 14 menit **tidak satu pun operasi WhatsApp berhasil**. Namun:

| Sinyal | Nilai selama lumpuh | Seharusnya |
| --- | --- | --- |
| PM2 status | `online`, tidak cycling | — |
| `wa_qr_state.ready` | `1` | `0` |
| `wa_qr_state.updated_at` | segar ke detik | basi |
| Alert "tidak merespons" | **tidak pernah menyala** | menyala |

Akibatnya petugas melihat "WA tersambung" dan terus mengetik ke saluran mati
selama 8 jam. Empat pesan ke pemohon dan empat baris `wa_outbox` mati permanen
(`poll()` hanya menyajikan `status='pending'`, sehingga baris `failed` tidak
pernah dicoba lagi — bahkan setelah restart).

### 1.1 Akar penyebab kebutaan

Dua cacat di `wa/server.js`, keduanya masih ada:

1. **`server.js:371` — heartbeat berbohong.** Dorongan heartbeat dipicu setiap
   poll HTTP ke backend yang sukses. Poll itu murni HTTP ke Apache dan **tidak
   pernah menyentuh WhatsApp**. Ia membuktikan proses Node hidup, bukan bahwa
   WhatsApp berfungsi.

2. **`server.js:178` — tak ada pengawas pasca-`ready`.** `client.on('ready')`
   menghapus `readyWatchdog` dan tidak pernah memasangnya lagi. Watchdog hanya
   menjaga fase *menuju* ready; wedge yang terjadi *sesudah* ready tidak ada
   yang mengawasi.

Backend justru sudah benar: `Wa.php:1251-1258` menurunkan `ready` menjadi
`false` begitu `updated_at` lewat `STALE_TTL = 60` detik, dan UI menampilkan
kartu OFFLINE merah. Mesin alert-nya sudah ada dan sudah tepat — ia hanya tidak
pernah menerima sinyal, karena heartbeat mengalir tanpa syarat.

## 2. Tujuan

Wedge pasca-`ready` terdeteksi dalam hitungan menit, bukan jam:

1. Heartbeat hanya mengalir bila WhatsApp **terbukti** responsif.
2. Alert OFFLINE yang sudah ada menyala otomatis ≈60–70 detik setelah wedge.
3. Wedge berkepanjangan pulih sendiri lewat restart PM2, tanpa manusia.

## 3. Non-tujuan

**Drift wwebjs sengaja di luar cakupan.** Investigasi hari ini menemukan
masalah kedua yang terpisah: `getChatById`, `getNumberId`, dan `sendSeen` gagal
dengan error ter-minify bernama `r`/`t` sejak ~16 Juli, dan backfill mati total
sejak 2026-07-14 12:18 (47 gagal berturut, nol berhasil). Dugaan: WhatsApp Web
berganti build dan wwebjs 1.34.7 jadi setengah-kompatibel.

Itu **tidak** boleh dicampur ke perbaikan ini, karena restart tidak
menyembuhkan drift versi. Probe yang ikut menangkap drift akan memicu
restart-loop tanpa akhir. Prinsip yang dipegang:

> Pemeriksaan otomatis hanya boleh memicu tindakan yang benar-benar
> memperbaiki hal yang diperiksanya.

Drift ditangani terpisah (kemungkinan upgrade wwebjs), dengan spesifikasi
sendiri.

## 4. Desain

### 4.1 Probe: uji renderer, bukan WhatsApp

```js
await withTimeout(client.pupPage.evaluate(() => 1), PROBE_TIMEOUT_MS, 'probe');
```

`client.pupPage` tersedia (di-set di `Client.js:478`). Probe ini menguji tepat
satu hal: **apakah renderer masih bisa mengeksekusi JavaScript.**

`client.getState()` **ditolak** sebagai probe. Isinya:

```js
async getState() {
    return await this.pupPage.evaluate(() => {
        return window.require('WAWebSocketModel').Socket.state ?? null;
    });
}
```

Ia bergantung pada nama modul internal WhatsApp Web — persis kategori yang
sudah terbukti drift di sistem ini. Bila WhatsApp mengganti nama modul itu,
probe gagal padahal connector sehat, lalu memicu restart beruntun selamanya.
Probe yang salah lebih berbahaya daripada tidak ada probe.

### 4.2 Lalu lintas nyata dihitung sebagai bukti hidup

Ke-16 pemanggil `withTimeout` di `server.js` seluruhnya operasi WhatsApp murni
(`client.*`, `msg.*`, `chat.*`, `c.sendSeen()`, `rm.react()`); panggilan ke
backend memakai `bfetch` yang terpisah. Karena itu satu sisipan di jalur sukses
`withTimeout` meliput semuanya:

```js
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p).then((v) => { lastWaOkAt = Date.now(); return v; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms)),
  ]);
}
```

Bila ada operasi WhatsApp yang sukses dalam `PROBE_SKIP_MS` terakhir, probe
sintetis dilewati — connector sibuk tidak membayar biaya probe.

Ini bukan sekadar penghematan. JavaScript di halaman berjalan satu utas, jadi
operasi berat (mis. mengirim lampiran 1,3 MB) bisa memblokir `evaluate` cukup
lama untuk memicu timeout probe. Menghitung operasi nyata sebagai bukti hidup
menekan false-positive itu langsung ke akarnya.

### 4.3 Gerbang heartbeat

Menggantikan dorongan tanpa syarat di `server.js:371`:

| Kondisi | Tindakan |
| --- | --- |
| Operasi WA sukses < `PROBE_SKIP_MS` lalu | hidup — dorong heartbeat, `wedgeStreak = 0` |
| Probe sukses | hidup — dorong heartbeat, `wedgeStreak = 0` |
| Probe gagal/timeout | `wedgeStreak++`, **heartbeat TIDAK didorong**, catat log |
| `wedgeStreak >= WEDGE_RESTART_TICKS` | log FATAL + `process.exit(1)` → PM2 restart |

### 4.4 Ambang alert muncul sendiri — tanpa kode

Poin desain terpenting: **tidak ada logika ambang alert yang perlu ditulis.**

Tick berjalan tiap 10 detik (`pollIntervalMs: 10000`) dan backend memakai
`STALE_TTL = 60` detik. Karena heartbeat dilewatkan sejak kegagalan probe
pertama, dibutuhkan ≈6 kegagalan berturut-turut agar TTL terlampaui. Ambang
"≈6× → alert" yang dikehendaki **muncul sendiri** dari mesin yang sudah ada.

Efek sampingnya menguntungkan: satu-dua kegagalan probe sporadis tidak
menimbulkan apa-apa. Heartbeat pulih di tick berikutnya jauh sebelum TTL
terlampaui. TTL 60 detik itu sendiri yang berperan sebagai debounce.

### 4.5 Garis waktu

```
t+0     renderer mati
t+10s   probe gagal #1  → heartbeat dilewatkan (senyap)
t+60s   probe gagal #6  → TTL backend terlampaui → ALERT OFFLINE  ← dulu: tak pernah
t+10m   probe gagal #60 → exit(1) → PM2 restart → renderer baru   ← dulu: 8j14m manual
```

### 4.6 Konfigurasi

Ditambahkan ke `wa/config.json`, semuanya bernilai default bila absen:

| Kunci | Default | Arti |
| --- | --- | --- |
| `probeTimeoutMs` | 5000 | batas waktu probe renderer |
| `probeSkipMs` | 30000 | lewati probe bila operasi WA sukses lebih baru dari ini |
| `wedgeRestartTicks` | 60 | kegagalan berturut sebelum `exit(1)` (≈10 menit) |

`probeTimeoutMs` sengaja jauh lebih pendek dari `WA_OP_TIMEOUT_MS` (45 detik):
pada renderer sehat, `evaluate(() => 1)` kembali dalam milidetik.

## 5. Penanganan galat dan risiko

**Restart salah-sasaran.** Memori proyek mencatat aturan keras: jangan restart
connector yang *hangat*, karena melemparnya ke cold-sync gauntlet justru
menciptakan outage (insiden 12 Juni: 8 restart beruntun). Ambang 10 menit
dipilih tepat untuk menghormati ini — cold-sync stall self-heal dalam 8–15
menit dan **tidak pernah** menyentuh kondisi ini, sebab selama cold-sync
`ready` belum `true` sehingga `tick()` keluar lebih awal dan probe tak pernah
jalan. Probe hanya aktif pasca-`ready`, yang justru ruang yang selama ini buta.

**Wedge saat proses sedang shutdown.** `exit(1)` harus dilewati bila
`shuttingDown` bernilai true (perintah logout sedang berjalan), agar tidak
mengacaukan alur unlink.

**Probe gagal karena halaman sibuk.** Ditekan oleh §4.2; sisa risikonya hanya
menunda heartbeat satu tick, tidak sampai memicu alert.

**Interaksi dengan readiness watchdog.** Setelah `exit(1)`, PM2 menjalankan
ulang proses dan watchdog boot (`READY_DEADLINE_MS`) mengambil alih seperti
biasa. Tidak ada tumpang tindih: watchdog menjaga pra-`ready`, probe menjaga
pasca-`ready`.

## 6. Verifikasi

Repo ini tidak punya suite otomatis (lihat `.claude/rules/testing.md`), jadi
verifikasi bersifat manual dan berjenjang.

**Tahap 1 — jalur sehat (aman, tanpa gangguan).** Setelah deploy, log harus
menunjukkan heartbeat tetap mengalir dan probe tidak pernah gagal. Pastikan
`wa_qr_state.updated_at` terus segar dan tidak ada baris `probe gagal`.

**Tahap 2 — reproduksi wedge sungguhan (mengganggu, butuh izin).** Bunuh
sengaja proses renderer milik sesi connector — persis kegagalan 3 Agustus:

```
pkill -f "type=renderer.*wwebjs_auth"
```

Yang harus teramati berurutan: baris `probe gagal` mulai muncul → heartbeat
berhenti → kartu OFFLINE muncul di halaman admin dalam ≈60–70 detik →
`exit(1)` pada ≈10 menit → PM2 restart → `WA client ready` tanpa scan QR.

Tahap 2 menimbulkan pemadaman singkat yang disengaja, jadi **wajib di luar jam
layanan dan dengan persetujuan eksplisit**. Untuk memperpendek pengamatan,
`wedgeRestartTicks` boleh diturunkan sementara lewat config, lalu dikembalikan.

## 7. Berkas terdampak

| Berkas | Perubahan |
| --- | --- |
| `wa/server.js` | `lastWaOkAt` + sisipan di `withTimeout`; gerbang heartbeat menggantikan baris 371; konstanta probe |
| `wa/config.json` | tiga kunci baru (opsional, ada default) |

Backend, frontend, dan skema database **tidak berubah** — seluruh mesin alert
sudah ada dan sudah benar.

## 8. Catatan penerapan

`wa/server.js` berjalan di bawah PM2 dan perubahannya **tidak** aktif sampai
`pm2 restart bukutamu-wa`. Restart itu sendiri melempar connector ke cold-sync;
lakukan saat saluran sedang tidak dipakai. Sesi WhatsApp dipakai ulang — tidak
perlu scan QR (terverifikasi hari ini: `ready` dalam ~13 detik).
