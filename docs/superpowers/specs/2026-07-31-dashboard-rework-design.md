# Dashboard — Rework Tampilan

- **Tanggal:** 2026-07-31
- **Status:** Disetujui, siap direncanakan
- **Halaman terdampak:** `/admin` (Dashboard)
- **Berkas inti:** `frontend/src/pages/admin/DashboardPage.tsx`,
  `backend/application/modules/api/controllers/Dashboard.php`,
  komponen baru di `frontend/src/components/admin/`

## 1. Masalah

Dashboard sekarang menampilkan 12 `StatsCard` identik dalam grid 2×6 di kolom
kiri (dibatasi 480px) dan FullCalendar di kolom kanan. Tiga masalah:

**Tidak ada hierarki.** "Total Kunjungan" — angka utama halaman — tampil dengan
bobot visual yang sama persis dengan "Instansi Terbanyak". Mata tidak punya
titik masuk; kedua belas kartu berteriak sama keras.

**Satu komponen dipaksa menampung empat jenis data.** `StatsCard` menerima
angka (`total_kunjungan`), persentase (`tingkat_selesai`), durasi
(`rata_rata_durasi`), dan nama panjang (`instansi_terbanyak`). Gejalanya
terlihat di `StatsCard.tsx:15`:

```tsx
const isLong = typeof value === 'string' && value.length > 12
```

Komponen itu mengecilkan fontnya sendiri saat kebanjiran teks. Itu tambalan
untuk masalah struktural, bukan penyelesaian.

**Tidak ada dimensi waktu.** Pertanyaan paling berguna bagi pimpinan —
"kunjungan naik atau turun?" — tidak terjawab, padahal datanya sudah ada di
`Dashboard::events()` dan hanya dipakai sebagai titik berwarna di kalender.

## 2. Tujuan

Dashboard yang bisa dibaca dalam lima detik: beberapa angka utama menonjol,
tren terlihat sebagai bentuk, dan rincian tetap tersedia tanpa berebut
perhatian.

## 3. Keputusan yang diambil

| # | Keputusan | Alasan |
| --- | --- | --- |
| D1 | **Rombak tata letak + tambah grafik**, bukan sekadar poles gaya | Poles gaya tidak menyentuh akar masalahnya: hierarki dan ketiadaan tren. |
| D2 | **Grafik SVG buatan sendiri**, bukan memasang Recharts | Grafik yang dibutuhkan sederhana. Chunk terbesar sudah 516 KB dan build memperingatkan ambang 500 KB; Recharts menambah ~100 KB gzip. Repo ini juga tidak punya tes otomatis sebagai jaring pengaman dependensi baru. SVG sendiri bisa memakai token warna admin sehingga menyatu dengan halaman lain. |
| D3 | **Kalender dipertahankan**, pindah ke baris penuh | Grafik tren menjawab "naik atau turun", kalender menjawab "tanggal berapa persisnya dan layanan apa". Peran berbeda, dan kalender satu-satunya tempat informasi kedua itu ada. |
| D4 | **Tambah `count` + `layanan` ke respons `events()`** | Alternatifnya mengurai angka dari string tampilan `"Perpustakaan (3)"`, yang diam-diam salah begitu labelnya berubah. FullCalendar menyerap kunci tak dikenal ke `extendedProps`, jadi kalender tidak terpengaruh. |
| D5 | **Lengkapi peta warna 6 → 9 layanan** | Bug lama: `Dashboard.php:110-117` tidak memuat Konsultasi DTSEN, Daftar Antrian Offline, dan Lainnya Online, sehingga ketiganya jatuh ke abu-abu. Begitu dipakai grafik komposisi, warna abu-abu ganda jadi tidak terbaca. |
| D6 | **`events()` menghormati filter tanggal** | Sekarang hanya `stats` yang difilter, `events` selalu memuat semuanya — sorotan dan grafik akan bercerita tentang rentang berbeda di halaman yang sama. |

## 4. Tata letak

Empat lapis, dari paling penting ke paling rinci:

```
┌─ Dashboard ─────────────────────── [Dari] [Sampai] [Filter] [Reset] ─┐

┌──────────┬──────────┬──────────┬──────────┐   ← 4 SOROTAN
│  Total   │   Tamu   │ Tingkat  │ Rata-rata│      angka besar
│ Kunjungan│   Unik   │ Selesai  │  /Hari   │
└──────────┴──────────┴──────────┴──────────┘

┌────────────────────────────┬──────────────┐   ← GRAFIK
│  Tren Kunjungan            │  Komposisi   │
│  (area SVG)                │  Layanan     │
└────────────────────────────┴──────────────┘

┌───────────────────────────────────────────┐   ← 8 RINGKAS
│ Jumlah Hari · Hari Tersibuk · Periode ...  │      label + nilai
└───────────────────────────────────────────┘

┌───────────────────────────────────────────┐   ← KALENDER
│  Kalender Kunjungan (lebar penuh)         │
└───────────────────────────────────────────┘
```

**Sorotan (4):** `total_kunjungan`, `tamu_unik`, `tingkat_selesai`,
`rata_rata_per_hari` — menjawab berapa banyak, berapa orang, seberapa tuntas,
seberapa padat.

**Ringkas (8):** `jumlah_hari`, `hari_tersibuk`, `periode_aktif`, `selesai`,
`antri`, `rata_rata_durasi`, `layanan_terbanyak`, `instansi_terbanyak`.
Dirender sebagai pasangan label + nilai, bukan kartu berikon — sehingga nilai
teks panjang punya ruang dan tidak perlu lagi diperkecil otomatis.

Alternatif yang ditolak: menaruh grafik di kolom kanan menggantikan kalender.
Itu memaksa grafik ke lebar sempit, padahal tren butuh sumbu horizontal panjang
agar bentuknya terbaca.

## 5. Komponen baru

| Berkas | Tanggung jawab | Masukan |
| --- | --- | --- |
| `components/admin/TrendChart.tsx` | Area SVG: volume kunjungan sepanjang waktu | `{ label: string; value: number }[]` |
| `components/admin/ServiceBars.tsx` | Batang horizontal per layanan + persentase | `{ label: string; value: number; color: string }[]` |
| `components/admin/MiniStat.tsx` | Satu pasang label + nilai untuk baris ringkas | `label`, `value` |

Ketiganya menerima data yang **sudah jadi** — tidak ada satu pun yang memanggil
API atau tahu soal `CalendarEvent`. Agregasi dilakukan di `DashboardPage`
sebagai fungsi murni, sehingga komponennya bisa dipakai ulang dan dinalar
sendiri-sendiri.

Spec ini menetapkan **struktur dan data**, bukan detail rupa. Pilihan tipografi,
skala warna, spasi, dan perlakuan visual angka sorotan diputuskan saat
implementasi dengan skill `frontend-design` dan `dataviz` — keduanya wajib dimuat
sebelum baris pertama kode grafik ditulis. Batasannya: tetap memakai token warna
admin yang sudah ada (`--admin-primary`, `--admin-secondary`, `--admin-text`,
`--admin-text-muted`) dan kelas `admin-card`, supaya halaman ini menyatu dengan
Antrian PST, Antrian DTSEN, dan Layanan Online — bukan tampak seperti aplikasi lain.

### 5.1 Pengelompokan waktu pada TrendChart

Rentang tanpa filter mencakup ~14 bulan; menggambar ~430 titik harian di lebar
beberapa ratus piksel menghasilkan bentuk yang tidak terbaca. Aturannya:

- rentang **≤ 62 hari** → satu titik per **hari**
- rentang **> 62 hari** → satu titik per **bulan**

Rentang diukur dari tanggal paling awal sampai paling akhir yang benar-benar
ada di data, bukan dari isian filter — sehingga **tanpa filter** (mencakup
seluruh riwayat, ~14 bulan) grafik otomatis tampil **bulanan**.

Ambangnya dua bulan supaya perbandingan bulan-ke-bulan tetap tampil harian.
Label sumbu mengikuti pengelompokan yang aktif, dan judul kartu menyebutkan
satuannya ("per hari" / "per bulan") supaya pembaca tidak salah menafsirkan
tinggi grafik.

## 6. Perubahan backend

Hanya di `Dashboard::events()` — tidak ada endpoint baru, tidak ada perubahan
skema.

1. **Tambah dua field** ke tiap event: `count` (int) dan `layanan` (string).
   `title` dan `color` tetap apa adanya supaya kalender tidak berubah.
2. **Lengkapi peta warna** dari 6 menjadi 9 layanan, menambahkan
   `Konsultasi DTSEN`, `Daftar Antrian Offline`, dan `Lainnya Online`.
   Warna dipilih agar tetap terbedakan saat bersebelahan sebagai batang.
3. **Terima `date_from` / `date_to`** dengan semantik yang sama seperti
   `Dashboard::stats()`, sehingga sorotan dan grafik selalu bercerita tentang
   rentang yang sama.

Wrapper `frontend/src/api/dashboard.ts` menyesuaikan: `events()` menerima
parameter rentang, dan tipe `CalendarEvent` bertambah `count` serta `layanan`.

## 7. Keadaan kosong dan gagal

Ditangani eksplisit, bukan dibiarkan menghasilkan SVG kosong yang terlihat rusak:

- `events` kosong → kedua grafik menampilkan "Belum ada data pada rentang ini"
- satu titik data saja → area digambar sebagai garis datar, bukan NaN pada path
- `stats` belum tiba → skeleton mengikuti bentuk tata letak baru (4 sorotan +
  2 grafik + baris ringkas), bukan 12 kotak seragam seperti sekarang

## 8. Rencana verifikasi

Repo ini tidak punya tes otomatis (`.claude/rules/testing.md`), jadi verifikasi
bersifat manual:

- `php7.4 -l` pada `Dashboard.php`; `curl` endpoint → 401 tanpa auth, bukan 5xx
- `npm run lint` dan `npm run build` bersih
- Bandingkan angka sorotan dengan query MySQL setara
- Jumlah `count` seluruh event harus sama dengan `total_kunjungan` pada rentang
  yang sama — ini yang membuktikan D4 dan D6 benar
- **Kalender harus tetap berfungsi persis seperti sebelumnya** — pembuktian
  bahwa field tambahan tidak mengganggu FullCalendar
- Pemeriksaan visual di browser oleh pemilik repo, termasuk lebar sempit

## 9. Di luar lingkup

- Mengganti FullCalendar. D3 mempertahankannya; melepas ~3,5 MB dependensi itu
  pekerjaan tersendiri dengan pertimbangan tersendiri.
- Menambah metrik baru ke `Dashboard::stats()`. Rework ini menata ulang yang
  sudah ada, bukan memperluas cakupan datanya.
- Ekspor / cetak dashboard.
- Menyeragamkan taksonomi layanan FE↔BE secara menyeluruh. D5 hanya melengkapi
  peta warna sampai 9 layanan.
