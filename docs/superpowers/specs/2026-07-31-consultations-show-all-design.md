# Antrian PST — Tampilkan Semua Kunjungan

- **Tanggal:** 2026-07-31
- **Status:** Disetujui, siap direncanakan
- **Halaman terdampak:** `/admin/consultations`
- **Berkas inti:** `backend/application/modules/api/controllers/Consultations.php`,
  `backend/application/modules/api/controllers/Api_base.php`,
  `frontend/src/api/consultations.ts`,
  `frontend/src/pages/admin/ConsultationQueuePage.tsx`,
  `frontend/src/components/admin/QueueList.tsx`

## 1. Masalah

`GET /api/consultations` menyaring baris lewat **tiga filter keras** yang
tertanam di kode (`Consultations.php:34-42`):

```php
->where("DATE(k.date_visit)", $today)                                   // hanya hari ini
->group_start()->like('k.jenis_layanan', 'Perpustakaan') /* …4 SKD… */  // hanya SKD
->where("(k.created_by IS NULL OR k.created_by <> 'whatsapp')", …)      // buang kanal WA
```

Ditambah **filter keempat di frontend** (`ConsultationQueuePage.tsx:29-32`) yang
membatasi `petugas_pst` / `resepsionis` pada layanan yang menjadi kewenangannya.

Akibatnya, per 2026-07-31 terdapat **27 kunjungan yang tidak pernah muncul di
layar mana pun** dan karenanya tak pernah ditindaklanjuti:

| Status | Jumlah | Tanggal terlama |
| --- | --- | --- |
| `antri` | 22 | 2026-07-09 |
| `menunggu_evaluasi` | 4 | 2026-07-17 |
| `dipanggil` | 1 | 2026-05-13 |

Filter tanggal adalah penyebab utamanya: begitu hari berganti, kunjungan yang
belum diselesaikan hilang dari antrian tanpa jejak dan tanpa peringatan.

## 2. Tujuan

Semua transaksi tersedia di `/admin/consultations` — semua tanggal, semua
layanan, semua kanal — dengan status terlihat dan dapat disaring, tanpa
membuat halaman menjadi berat atau merusak pemisahan tabel data antar-grup
layanan.

## 3. Keputusan yang diambil

| # | Keputusan | Alasan |
| --- | --- | --- |
| D1 | **Buang ketiga filter keras** (tanggal, layanan, kanal) | Permintaan eksplisit: "jangan dihide". Konsekuensinya kunjungan DTSEN, Resepsionis, dan WA ikut tampil di Antrian PST. |
| D2 | **Semua status tampil secara default**, ditambah dropdown filter status dan paginasi 25/halaman | Filter dikendalikan petugas, bukan aturan tersembunyi di kode. 463 dari 490 baris berstatus `selesai`; tanpa paginasi halaman akan berat dan makin lambat tiap bulan. |
| D3 | **Role scoping dipertahankan**, tapi pindah ke server | `petugas_pst` / `resepsionis` tetap fokus pada layanannya. Wajib pindah ke server karena filter client setelah paginasi akan membuat halaman berisi 25 baris menyisakan 3 baris. |
| D4 | **Tombol "Mulai" dirutekan per grup layanan** | Tanpa ini, data konsultasi DTSEN akan tertulis ke `konsultasi_pengunjung` — tabel yang salah. Lihat §7. |
| D5 | **Perluas `Consultations::index`**, bukan pakai ulang `/api/visits` | Menjaga radius perubahan. `/api/visits` dipakai VisitLogPage yang sekarang sehat; menambahkan `has_konsultasi` + role scoping ke sana membebani pemanggil yang tidak membutuhkannya. |
| D6 | **Satukan daftar layanan Resepsionis** FE↔BE | Backend punya 2 item, frontend 3 (`Daftar Antrian Offline`). Selama filter role di client, selisih ini tak terlihat; begitu pindah ke server ia menjadi bug diam-diam. |

## 4. Kontrak API baru

`GET /api/consultations` — semua parameter opsional, divalidasi di controller
sesuai `.claude/rules/api-conventions.md`.

| Param | Perilaku | Default |
| --- | --- | --- |
| `q` | LIKE ke `b.nama`, `b.nama_instansi`, `k.jenis_layanan`, `k.status` | — |
| `status` | exact match ke enum `tamdes_kunjungan.status` | semua |
| `layanan` | LIKE ke `k.jenis_layanan` | semua |
| `tahun` / `bulan` | `YEAR()` / `MONTH()` atas `k.date_visit` | semua |
| `page` | `(int)`, minimum 1 | `1` |
| `limit` | `(int)`, **di-clamp ke rentang 1–100** | `25` |

Respons berubah dari `ApiResponse<Visit[]>` menjadi `PaginatedResponse<Visit>`.
Aman dilakukan: `consultationsApi.list()` hanya dipanggil di satu tempat
(`ConsultationQueuePage.tsx:23`). Pemakai di luar frontend sudah diperiksa dan
tidak ada — konektor WA (`wa/`), notifier (`notifier/`), maupun dashboard-pst
(sumbernya di `/opt/newdls`, bukan di repo ini) tidak menyentuh endpoint ini.
Satu-satunya sebutan `bukutamu` di dashboard-pst adalah entri allowlist CORS
(`/opt/newdls/backend/server.js:57`), yakni arah masuk: bukutamu memanggil
dashboard-pst untuk panggilan TV, bukan sebaliknya.

### 4.1 Role scoping server-side

Tambah satu method `protected` baru di `Api_base`:

```php
protected function services_visible_to_role($role)   // → array nama layanan, atau NULL = semua
```

`NULL` untuk role bypass (`admin`, `superadmin`, `operator`). `require_layanan_role`
dan `Consultations::index` sama-sama membacanya, sehingga taksonomi layanan tidak
melahirkan salinan ketiga. Ini *menambah* method tanpa mengubah perilaku lama —
jauh lebih kecil risikonya daripada merombak `Api_base` yang diwarisi seluruh
controller.

Sesuai D6, `Daftar Antrian Offline` ditambahkan ke daftar Resepsionis di backend.

### 4.2 `has_konsultasi` sadar-grup

```sql
(SELECT COUNT(*) FROM konsultasi_pengunjung kp
   WHERE kp.id_kunjungan = k.id_kunjungan
     AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data) <> '')
+ (SELECT COUNT(*) FROM dtsen_konsultasi dk
   WHERE dk.id_kunjungan = k.id_kunjungan) AS has_konsultasi
```

Penjumlahan aman karena grup layanan mutually exclusive — `validate_no_cross_layanan`
di backend dan `isCrossLayanan` di frontend sama-sama menolak kombinasi lintas-grup.

### 4.3 Penghitungan total

Memakai `count_all_results('', FALSE)`. Argumen kedua `FALSE` **wajib** — ia
menahan reset Query Builder CI3 yang menyebabkan insiden mass-update
2026-06-30 (auto-memory `ci3_query_builder_reset_footgun`). Pola ini sudah
dipakai benar di `Visits::index` dan harus ditiru persis.

Urutan tetap `k.date_visit DESC`. Daftar `select` tetap `k.*` + 7 field tamu
supaya `QueueList` tidak kehilangan data.

## 5. Perubahan frontend

**`src/api/consultations.ts`**

```ts
list: (params?: { q?: string; status?: string; layanan?: string;
                  tahun?: string; bulan?: string; page?: number; limit?: number }) =>
  apiClient.get<PaginatedResponse<Visit>>('/api/consultations', { params }),
```

**`src/pages/admin/ConsultationQueuePage.tsx`**

1. State filter + debounce 400 ms, meniru pola `VisitLogPage.tsx:685-703`.
   Jangan memperkenalkan pola baru.
2. `queryKey: ['consultations-queue', { ...filters, page, limit }]`.
   `refetchInterval: 30000` dipertahankan.
3. **Hapus** filter role client (baris 29-32) — sudah pindah ke server.
4. `queryFn` mengembalikan `r.data` utuh — bukan `r.data.data` seperti sekarang —
   agar amplop paginasi ikut terbaca. Daftar kunjungan lalu dibaca dari
   `data.data`, jumlah totalnya dari `data.pagination.total`.
5. `handleStart` dirutekan lewat `getActiveServiceGroup()` yang sudah ada di
   `role-access.ts:150`.

| Grup | Rute | Tabel tujuan |
| --- | --- | --- |
| SKD | `/admin/consultations/:id/form` | `konsultasi_pengunjung` |
| DTSEN | `/admin/dtsen/:id/form` | `dtsen_konsultasi` |
| ONLINE | `/admin/layanan-online` | — (ditangani via chat) |
| RESEPSIONIS | `/admin/visits` | `konsultasi_pengunjung.hasil_konsultasi` |

Resepsionis **tidak** dirutekan ke form konsultasi karena
`ConsultationFormPage.tsx:146` mewajibkan ≥1 baris `kebutuhan_data`, sedangkan
gerbang Resepsionis hanya menuntut `keterangan`. Editor yang cocok
("Ringkasan / Keterangan" + "Simpan & Selesaikan") ada di VisitLogPage.

Transisi `antri`/`dipanggil` → `diproses` sebelum navigasi tetap dipertahankan.

**`src/components/admin/QueueList.tsx`** — tambah prop opsional
`emptyMessage?: string` dengan default `"Tidak ada antrian hari ini."`.
Komponen ini dipakai bersama `DtsenQueuePage.tsx:100`; mengubah stringnya
langsung akan mengubah halaman DTSEN tanpa diminta.

## 6. Copy

| Elemen | Sebelum | Sesudah |
| --- | --- | --- |
| `admin-h1` | `Antrian PST` | `Antrian PST — Semua Kunjungan` |
| `admin-subtitle` | `4 layanan inti SKD: …` | `Semua layanan, semua tanggal, semua kanal` |
| Empty state (PST saja) | `Tidak ada antrian hari ini.` | `Tidak ada kunjungan yang cocok dengan filter.` |

## 7. Risiko yang ditangani desain ini

**Korupsi data lintas-tabel.** Antrian PST dan antrian DTSEN menulis ke tabel
berbeda: `/admin/consultations/:id/form` → `konsultasi_pengunjung`
(`Consultations.php:299`), `/admin/dtsen/:id/form` → `dtsen_konsultasi`
(`Dtsen.php:192`). Tanpa D4, kunjungan DTSEN yang kini tampil di Antrian PST
akan membuka form SKD dan menulis ke tabel yang salah. Efek sampingnya juga
terlihat sebelum ditulis: `has_konsultasi` lama hanya menghitung
`konsultasi_pengunjung`, sehingga kunjungan DTSEN yang sudah terisi tetap
tampil bertombol "Mulai" seolah belum tersentuh — diperbaiki oleh §4.2.

**Beban query.** Sebelum perubahan, subquery `has_konsultasi` berjalan sekali
per baris pada rentang "hari ini" (0–3 baris). Membuka filter tanpa paginasi
akan menjadikannya 490 subquery tiap 30 detik per tab terbuka, tumbuh linear
~37 baris/bulan. Paginasi (D2) mengurungnya pada `limit`, apa pun besar tabel
nanti.

## 8. Yang sudah tertangani — tidak perlu kode baru

Diverifikasi saat brainstorming, dicatat agar tidak dikerjakan ulang:

- **Tombol "Selesai" sudah agnostik layanan.** `PUT /api/consultations/:id`
  menolak `menunggu_evaluasi` untuk non-SKD (#21), memanggil
  `require_layanan_role`, dan punya tiga gerbang kelengkapan form — termasuk
  Gate 3 khusus DTSEN yang memeriksa `dtsen_konsultasi` (`Consultations.php:120-128`).
- **Tombol panggilan TV sudah dipakai bersama.** `DtsenQueuePage.tsx:105`
  memakai `QueueCallButton` yang sama, dan komponen itu memanggil
  `consultationsApi.call()`.
- **Baris `selesai`** tidak menampilkan tombol Selesai — guard di baris 150.
- **Baris `menunggu_evaluasi`** menampilkan "Buka Evaluasi"; inilah jalur yang
  dibutuhkan 4 baris tertahan itu.
- **Tombol lintas-kewenangan** sudah punya varian gembok dengan tooltip
  "Layanan ini di luar kewenangan role Anda" (baris 172-183).

## 9. Konsekuensi yang diterima

Kunjungan WA muncul **ganda** — di Antrian PST *dan* di inbox Layanan Online.
Ini akibat langsung dari D1 dan diterima secara sadar; per hari ini hanya 7 baris.

## 10. Rencana verifikasi

Repo ini tidak punya tes otomatis (`.claude/rules/testing.md`), jadi
verifikasi bersifat manual.

- `npm run lint` dan `npm run build` harus bersih
- `curl` endpoint: tanpa param; `?status=antri`; `?page=2`; `?limit=200`
  (harus ter-clamp ke 100)
- `pagination.total` = 490 tanpa filter, 22 untuk `?status=antri`
- Login sebagai `petugas_pst`: hasil scoping server-side harus sama dengan
  perilaku filter client hari ini
- Klik "Mulai" pada baris DTSEN → harus mendarat di `/admin/dtsen/:id/form`
- Buka salah satu dari 4 baris `menunggu_evaluasi` → "Buka Evaluasi" berfungsi

## 11. Urutan rilis

PHP backend **langsung live begitu disimpan** — tidak ada gerbang deploy
(auto-memory `infra_php_live_on_edit`). Perubahan ini *forward-compatible*:
`PaginatedResponse` tetap memiliki kunci `data`, sehingga frontend lama yang
membaca `r.data.data` tetap berfungsi (terbatas 25 baris, tanpa kontrol
paginasi) selama jeda sebelum build frontend selesai. Tidak ada jendela rusak,
tetapi frontend harus segera menyusul.

`CACHE_NAME` di `frontend/public/sw.js` **wajib** dinaikkan, kalau tidak
petugas tetap melihat kode lama (auto-memory `deploy_frontend_sw_cache_bump`).

## 12. Di luar lingkup

- Membereskan 27 kunjungan tertahan itu sendiri. Perubahan ini membuatnya
  **terlihat dan dapat ditindak**; keputusan menutupnya massal adalah
  penulisan ke basis data produksi dan butuh persetujuan terpisah
  (auto-memory `feedback_prod_write_safety`).
- Deep-link ke satu kunjungan di `/admin/visits` dan `/admin/layanan-online`.
  Kedua halaman itu tidak punya parameter rute untuk membuka satu baris, jadi
  rute RESEPSIONIS dan ONLINE mendarat di daftar, bukan pada barisnya.
- Menyatukan taksonomi layanan FE↔BE secara menyeluruh. D6 hanya menutup
  selisih `Daftar Antrian Offline`; penyatuan penuh adalah pekerjaan tersendiri.
