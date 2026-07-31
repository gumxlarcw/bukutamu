# Rekomendasi Kegiatan Statistik — Lewati Form Blok 3

- **Tanggal:** 2026-07-31
- **Status:** Disetujui, siap direncanakan
- **Halaman terdampak:** `/admin/consultations` (Antrian PST)
- **Berkas inti:** `backend/application/modules/api/controllers/Api_base.php`,
  `frontend/src/lib/role-access.ts`,
  `frontend/src/pages/admin/ConsultationQueuePage.tsx`

## 1. Masalah

Layanan `Rekomendasi Kegiatan Statistik` saat ini wajib mengisi form Blok 3
(rincian data, status perolehan, sumber data) sebelum kunjungannya bisa
diselesaikan — sama seperti tiga layanan SKD lainnya. Gerbangnya ada di
`Api_base::layanan_requires_skd_form()` dan ditegakkan di
`Consultations::detail()` serta `Visits::status`.

Aturan itu tidak mencerminkan cara kantor bekerja. Sejak 2025-12-03 sampai
2026-07-14 tercatat **25 kunjungan Rekomendasi**, dan:

| Status | Jumlah | Punya Blok 3 | Terevaluasi |
| --- | --- | --- | --- |
| `selesai` | 14 | **0** | **0** |
| `antri` | 10 | 0 | 0 |
| `diproses` | 1 | 0 | 0 |

Tidak satu pun pernah mengisi Blok 3 dalam delapan bulan. Empat belas di
antaranya toh mencapai `selesai` — artinya gerbangnya dilewati lewat role
bypass (`admin`/`superadmin`/`operator`), bukan dipatuhi. Aturan yang secara
rutin dilanggar untuk bisa bekerja bukan aturan; ia hanya beban.

Rekomendasi memang tidak menghasilkan "kebutuhan data" dalam pengertian SKD —
tamu datang meminta rekomendasi kegiatan statistik, bukan meminta angka.
Memaksanya mengisi rincian data adalah kesalahan pemodelan sejak awal.

## 2. Tujuan

Kunjungan Rekomendasi berjalan langsung dari pemanggilan ke evaluasi tablet,
tanpa singgah ke form Blok 3 — sementara tiga layanan SKD lainnya tetap
terkunci seperti sekarang.

## 3. Keputusan yang diambil

| # | Keputusan | Alasan |
| --- | --- | --- |
| R1 | **Rekomendasi TETAP layanan SKD** | Tetap satu grup dengan tiga layanan lain, tetap memakai daftar sarana SKD, tetap wajib evaluasi tablet. Yang dilewati hanya form Blok 3. |
| R2 | **Pisahkan "wajib Blok 3" dari "adalah SKD"** | Kode memakai satu daftar 4-layanan untuk lima pertanyaan berbeda. Permintaan ini memisahkan satu di antaranya. Mengeluarkan Rekomendasi dari `SKD_SERVICES` akan diam-diam merusak keanggotaan grup, whitelist sarana, dan justru menghapus kewajiban evaluasi yang harus dipertahankan. |
| R3 | **Skip, bukan opsional** | Tombol "Mulai / Lihat / Edit" tidak dirender untuk Rekomendasi. Form yang terbuka tapi boleh kosong akan tetap kosong — persis nasib Blok 3 selama delapan bulan — sambil menyisakan langkah yang membingungkan. |
| R4 | **`Consultations::data` tidak dilonggarkan** | Endpoint itu hanya bisa dicapai dari form, dan form itu tidak lagi dibuka untuk Rekomendasi. Melonggarkannya hanya melemahkan gerbang bagi tiga layanan yang masih membutuhkannya. |

## 4. Perubahan

### 4.1 Backend — pecah satu fungsi menjadi dua

**Jebakan yang harus dihindari.** `Api_base::layanan_requires_skd_form()`
mengerjakan **dua pekerjaan berbeda** di bawah satu nama, dan punya lima
pemanggil — bukan dua:

| Pemanggil | Maksud sebenarnya |
| --- | --- |
| `Consultations.php:196` | gerbang FORM Blok 3 |
| `Visits.php:263` | gerbang FORM Blok 3 |
| `Dtsen.php:181` | gerbang FORM Blok 3 |
| `Evaluations.php:22` (`pending`) | **kelayakan EVALUASI tablet** |
| `Evaluations.php:95` (`pending_list`) | **kelayakan EVALUASI tablet** |

`pending()` hanya menerbitkan token kiosk bila fungsi ini bernilai true, dan
`pending_list()` menyaring antrean tablet dengan fungsi yang sama. Sekadar
membuang Rekomendasi dari fungsi ini akan membuat kunjungan Rekomendasi tetap
berpindah ke `menunggu_evaluasi` — karena `next_status_after_completion` tidak
diubah — tapi **tidak pernah muncul di tablet**, dan tombol "Buka Evaluasi"
mengembalikan null. Ia terjebak selamanya di status itu: kebalikan persis dari
tujuan spec ini.

**Karena itu fungsinya dipecah dua, dan nama lamanya dipensiunkan** supaya nama
yang ambigu tidak bisa dipanggil lagi:

```php
/** Wajib mengisi form Blok 3 (rincian kebutuhan data). TIGA layanan —
 *  Rekomendasi TIDAK termasuk: tamu datang meminta rekomendasi kegiatan,
 *  bukan meminta angka, sehingga "kebutuhan data" tidak berlaku baginya. */
protected function layanan_requires_blok3($jenis_layanan_raw) {
    $svc = ['Perpustakaan', 'Konsultasi Statistik', 'Penjualan Produk Statistik'];
    ...
}

/** Wajib melewati evaluasi tablet. EMPAT layanan SKD — Rekomendasi TETAP
 *  termasuk. Jangan satukan dengan layanan_requires_blok3(): dulu keduanya
 *  satu fungsi, dan itu membuat "lewati form" tidak bisa dibedakan dari
 *  "lewati evaluasi". */
protected function layanan_requires_evaluasi($jenis_layanan_raw) {
    $svc = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
    ...
}
```

Lalu tiap pemanggil diarahkan ke fungsi yang sesuai maksudnya: tiga situs Gate 2
memakai `layanan_requires_blok3()`, dua situs `Evaluations.php` memakai
`layanan_requires_evaluasi()`. `layanan_requires_skd_form()` dihapus.

**Empat fungsi lain di berkas yang sama TIDAK berubah** — masing-masing memakai
daftar 4-layanan untuk tujuan yang berbeda:

| Fungsi | Perannya | Rekomendasi tetap di dalamnya? |
| --- | --- | --- |
| `layanan_role_map()` | siapa boleh memfinalisasi | ya |
| `validate_no_cross_layanan()` | keanggotaan grup, cegah campur SKD+DTSEN | ya |
| `validate_sarana_for_layanan()` | sarana mana yang sah per grup | ya |
| `next_status_after_completion()` | **wajib evaluasi tablet** | **ya** |

Yang terakhir adalah inti R1: Rekomendasi tetap mendarat di
`menunggu_evaluasi`, bukan langsung `selesai`.

### 4.2 Frontend — konstanta baru, bukan mengubah yang lama

`frontend/src/lib/role-access.ts` mendapat konstanta dan helper baru,
mencerminkan backend:

```ts
/** Layanan yang WAJIB mengisi form Blok 3. Sengaja berbeda dari SKD_SERVICES:
 *  Rekomendasi tetap SKD (grup, sarana, evaluasi) tapi tidak menghasilkan
 *  "kebutuhan data" sehingga Blok 3 tidak berlaku baginya.
 *  Cermin Api_base::layanan_requires_blok3(). */
const BLOK3_SERVICES = [
  'Perpustakaan',
  'Konsultasi Statistik',
  'Penjualan Produk Statistik',
] as const

export function requiresBlok3(layanan_list: string[]): boolean
```

Penamaannya sengaja mencerminkan backend (`blok3`, bukan `skdForm`). Istilah
"SKD form" adalah nama ambigu yang justru dipensiunkan di §4.1 karena ia tidak
membedakan "wajib isi form" dari "wajib evaluasi" — memakainya kembali di
frontend akan menanam ulang kebingungan yang sama di sisi seberang.

`SKD_SERVICES` **tidak diubah** — ia tetap berisi empat layanan dan tetap
menyetir `getServiceGroup`, `nextStatusAfterCompletion`, `needsQueueCall`, dan
`SARANA_BY_GROUP`.

### 4.3 Frontend — tombol form disembunyikan

Di `ConsultationQueuePage.tsx`, tombol "Mulai" / "Lihat / Edit" hanya dirender
bila `requiresBlok3(...)` bernilai true. Untuk Rekomendasi, tombol itu hilang;
yang tersisa adalah "Panggil" dan "Selesai".

## 5. Alur baru

```
Rekomendasi:  antri → dipanggil → [Selesai] → menunggu_evaluasi → selesai
Tiga lainnya: antri → dipanggil → [Mulai→form] → diproses → [Selesai] → menunggu_evaluasi → selesai
```

**Konsekuensi yang diterima:** status `diproses` tidak akan pernah tercapai
untuk Rekomendasi, karena transisi `antri`/`dipanggil` → `diproses` selama ini
menumpang di tombol "Mulai" yang kini dilewati. Penanda "sedang dilayani" hilang
untuk layanan ini. Ini konsekuensi langsung dari R3 dan diterima secara sadar.

## 6. Data lama

Tidak ada migrasi. Nol dari 25 kunjungan Rekomendasi punya baris Blok 3, jadi
tidak ada data yang perlu dibersihkan atau ditafsirkan ulang. Sebelas kunjungan
yang belum selesai (10 `antri`, 1 `diproses`) justru menjadi lebih mudah
diselesaikan setelah perubahan ini.

Satu kunjungan berstatus `diproses` akan tetap di sana sampai petugas
menyelesaikannya; ia tidak akan pernah kembali ke `diproses` setelahnya.

## 7. Rencana verifikasi

Repo ini tidak punya tes otomatis (`.claude/rules/testing.md`), jadi verifikasi
bersifat manual:

- `php7.4 -l` bersih; `npm run lint` dan `npx tsc -b` bersih
- **Tiga layanan lain TETAP terkunci** tanpa Blok 3 — ini yang membuktikan
  perubahannya tidak melebar. Coba selesaikan kunjungan Perpustakaan tanpa
  mengisi form: harus ditolak dengan pesan "Form konsultasi SKD belum lengkap."
- **Rekomendasi mendarat di `menunggu_evaluasi`**, bukan `selesai` — ini yang
  membuktikan R1 utuh dan evaluasi tidak ikut terlewat
- **Rekomendasi BENAR-BENAR SAMPAI KE TABLET.** Ini pemeriksaan terpenting di
  seluruh spec, karena inilah yang nyaris rusak: setelah sebuah kunjungan
  Rekomendasi berstatus `menunggu_evaluasi`, ia harus muncul di
  `GET /api/evaluations/pending-list`, dan tombol "Buka Evaluasi" di Antrian PST
  harus mengembalikan token — bukan `data: null`. Kalau ia berpindah status tapi
  tidak pernah muncul di tablet, pemecahan fungsinya salah arah dan kunjungan
  akan terjebak permanen.
- Tombol "Mulai / Lihat / Edit" hilang pada baris Rekomendasi, tetap ada pada
  ketiga layanan lain
- Kunjungan Rekomendasi tetap muncul di Antrian PST dan tetap punya tombol
  "Panggil" (grup dan `needsQueueCall` tidak berubah)
- Pemeriksaan browser oleh pemilik repo

## 8. Di luar lingkup

- Menyatukan lima daftar 4-layanan yang tersebar di `Api_base.php` menjadi satu
  sumber. Nyata dan layak, tapi menyentuh berkas yang diwarisi seluruh controller
  dan pantas mendapat spec tersendiri.
- Melonggarkan validasi `Consultations::data` (lihat R4).
- Status `diproses` untuk Rekomendasi — dihilangkan secara sadar, bukan diganti
  mekanisme lain.
- Kewajiban `status_data` ("Apakah data sudah diperoleh?") yang saat ini tidak
  pernah divalidasi dan hanya terisi lewat nilai default. Temuan terpisah,
  berlaku untuk tiga layanan yang masih memakai Blok 3.
