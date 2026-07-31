# Sidebar Admin — Rework

- **Tanggal:** 2026-07-31
- **Status:** Disetujui, siap direncanakan
- **Komponen terdampak:** `frontend/src/components/admin/Sidebar.tsx`,
  CSS sidebar di `frontend/src/layouts/AdminLayout.tsx`

## 1. Masalah

**Empat belas item dalam satu daftar rata.** `NAV_ITEMS` (`Sidebar.tsx:55-70`)
dirender sebagai satu `nav` dengan `gap: 2px` seragam dari Dashboard sampai
Tentang. Tidak ada pengelompokan, tidak ada jeda, tidak ada titik masuk untuk
mata. Jumlah yang benar-benar terlihat per role:

| Role | Menu terlihat |
| --- | --- |
| superadmin | 14 |
| admin | 13 |
| pimpinan | 11 |
| operator / petugas_pst | 8 |
| resepsionis | 5 |
| verifikator | **1** |

**Label tidak konsisten dalam tiga cara sekaligus.** Ada singkatan (`PST`,
`DTSEN`) berdampingan dengan frasa (`Daftar Tamu`, `Layanan Online`); ada satu
label Inggris (`Users`) di tengah label Indonesia (`Kunjungan`, `Tambah Manual`,
`Tentang`, `Keluar`); dan tingkat kedetailannya berbeda-beda (`Analisis` yang
umum vs `Responden SKD` yang spesifik).

**Hanya 4 dari 14 label cocok dengan judul halaman tujuannya.** Petugas mengklik
`PST` lalu mendarat di halaman berjudul "Antrian PST — Semua Tanggal"; mengklik
`Users` lalu mendarat di "Manajemen User".

| Label sidebar | Judul halaman |
| --- | --- |
| `PST` | Antrian PST — Semua Tanggal |
| `DTSEN` | Antrian Konsultasi DTSEN |
| `Verifikasi` | Verifikasi Data |
| `Kunjungan` | Daftar Kunjungan |
| `Tambah Manual` | Tambah Kunjungan Manual |
| `Evaluasi` | Hasil Evaluasi Layanan |
| `Analisis` | Analisis Kunjungan & Antrian |
| `Users` | Manajemen User |
| `Audit` | Audit Log |
| `Tentang` | Tentang Aplikasi |

## 2. Tujuan

Sidebar yang bisa dipindai: item berkelompok menurut pekerjaan, label yang
menepati janjinya terhadap halaman tujuan, dan ritme visual yang membedakan
kelompok dari isinya.

## 3. Keputusan yang diambil

| # | Keputusan | Alasan |
| --- | --- | --- |
| S1 | **Kelompokkan menu, rapikan label, poles gaya** | Menjawab ketiga masalah. Poles gaya saja tidak menyentuh 14-item-satu-daftar maupun label yang meleset. |
| S2 | **Logika gerbang role TIDAK disentuh** | `visibleItems`, `ROLE_LEVEL`, `minRole`, `allowedRoles`, dan kasus khusus verifikator dibiarkan apa adanya. Siapa melihat apa tetap identik, sehingga perubahan ini tidak punya permukaan keamanan sama sekali. |
| S3 | **Dashboard berdiri sendiri tanpa judul kelompok** | Ia beranda, bukan anggota kategori. Memberinya judul kelompok berisi satu item hanya menambah baris tanpa menambah makna. |
| S4 | **Label = bentuk terpendek yang tidak ambigu dari judul halaman, seluruhnya Indonesia** | Satu aturan yang sekaligus menghapus campur bahasa dan singkatan sembarang. |
| S5 | **Kelompok tanpa item terlihat disembunyikan beserta judulnya** | Wajib, bukan pemanis: `resepsionis` tidak punya satu pun item Pelayanan maupun Laporan, dan `verifikator` hanya punya satu item di seluruh sidebar. |
| S6 | **Di rail terciut, judul kelompok jadi garis pemisah** | Judul itu teks dan rail hanya selebar ikon. `.admin-shell.is-collapsed` sudah menyembunyikan `.admin-side-label` dengan pola yang sama. |

## 4. Struktur menu

```
  Dashboard                    ← tanpa judul kelompok

  PELAYANAN
    Antrian PST                /admin/consultations
    Antrian DTSEN              /admin/dtsen
    Layanan Online             /admin/layanan-online
    Verifikasi Data            /admin/verifikasi

  DATA KUNJUNGAN
    Daftar Tamu                /admin/guests
    Daftar Kunjungan           /admin/visits
    Tambah Kunjungan           /admin/manual-entry

  LAPORAN
    Hasil Evaluasi             /admin/evaluations
    Responden SKD              /admin/responden
    Analisis Antrian           /admin/queue-stats

  SISTEM
    Manajemen Pengguna         /admin/users
    Log Audit                  /admin/audit
    Tentang                    /admin/tentang
```

Posisi absolut sebagian item **memang berubah** — pengelompokan tidak mungkin
tanpa itu. Contohnya `Daftar Tamu` yang sekarang berada di urutan kedua turun ke
kelompok Data Kunjungan, di bawah seluruh kelompok Pelayanan.

Yang dipertahankan adalah **urutan relatif di dalam tiap kelompok**, mengikuti
urutan `NAV_ITEMS` sekarang: Data Kunjungan tetap Daftar Tamu → Daftar Kunjungan
→ Tambah Kunjungan, persis seperti kemunculannya hari ini. Petugas yang hafal
"Tamu sebelum Kunjungan" tetap benar; yang berubah hanya di mana blok itu duduk.

### 4.1 Perubahan label

| Dari | Menjadi | Alasan |
| --- | --- | --- |
| `PST` | `Antrian PST` | Singkatan telanjang; butuh "Antrian" agar terbedakan dari Layanan Online yang juga PST |
| `DTSEN` | `Antrian DTSEN` | Sama |
| `Verifikasi` | `Verifikasi Data` | Menepati judul halaman |
| `Kunjungan` | `Daftar Kunjungan` | Menepati judul halaman; membedakan dari "Tambah Kunjungan" |
| `Tambah Manual` | `Tambah Kunjungan` | "Manual" menjelaskan cara, bukan objeknya |
| `Evaluasi` | `Hasil Evaluasi` | Halaman berisi hasil, bukan formulir evaluasi |
| `Analisis` | `Analisis Antrian` | "Analisis" sendirian tidak menyebut apa yang dianalisis |
| `Users` | `Manajemen Pengguna` | Satu-satunya label Inggris di seluruh sidebar |
| `Audit` | `Log Audit` | Menepati judul halaman, urutan kata Indonesia |

Tidak berubah: `Dashboard`, `Daftar Tamu`, `Layanan Online`, `Responden SKD`,
`Tentang`. `Dashboard` dipertahankan sebagai serapan yang sudah mapan.

Label terpanjang setelah perubahan adalah `Manajemen Pengguna`. Pada 13px di
sidebar 240px, dengan ikon 18px + gap 11px + padding 22px, ia masih muat tanpa
terpotong — diverifikasi saat implementasi.

## 5. Perilaku

**Kelompok kosong hilang seluruhnya.** Setelah `visibleItems` disaring, tiap
kelompok dihitung; yang tidak menyisakan item tidak dirender — judulnya juga
tidak. Contoh nyata: `verifikator` hanya menampilkan kelompok Pelayanan berisi
satu item; `resepsionis` menampilkan Dashboard, Data Kunjungan (3 item), dan
Sistem (1 item: Tentang).

**Rail terciut.** Judul kelompok disembunyikan lewat kelas yang mengikuti pola
`.admin-shell.is-collapsed` yang sudah ada, digantikan garis 1px
`var(--admin-border)` agar ritme kelompok tetap terasa saat hanya ikon yang
tampak.

**Drawer mobile** tidak berubah perilakunya: `onNavigate` tetap menutup drawer
saat sebuah tautan ditekan.

## 6. Gaya

- Judul kelompok: 11px, uppercase, `letter-spacing` lebar, `--admin-text-muted`,
  `font-weight` 600.
- Jeda antar-kelompok lebih besar daripada jeda antar-item (sekarang seragam
  `gap: 2px`), sehingga kelompok terbaca sebagai kelompok.
- Keadaan aktif **tidak diubah**: `--admin-primary` di atas
  `--admin-primary-light` sudah bekerja dan sudah dikenali petugas.
- Tidak ada token warna baru, tidak ada hex hardcoded, tidak ada gaya mode gelap
  (shell admin tidak punya mode gelap — token `--admin-*` didefinisikan inline di
  `AdminLayout.tsx:29-45` tanpa varian `.dark`).

## 7. Rencana verifikasi

Repo ini tidak punya tes otomatis (`.claude/rules/testing.md`), jadi verifikasi
bersifat manual:

- `npm run lint` dan `npx tsc -b` bersih
- **Jumlah menu per role tidak berubah** dari angka di §1 — inilah yang
  membuktikan S2, bahwa logika gerbang benar-benar tidak tersentuh. Diperiksa
  dengan menjalankan ulang penghitungan yang sama terhadap `NAV_ITEMS` yang baru.
- Tiap tautan mendarat di halaman yang judulnya sesuai labelnya
- Rail terciut: judul kelompok hilang, garis pemisah muncul, ikon tidak bergeser
- Drawer mobile masih menutup otomatis saat tautan ditekan
- Pemeriksaan visual di browser oleh pemilik repo, termasuk sebagai `resepsionis`
  dan `verifikator` yang kelompoknya paling banyak kosong

## 8. Di luar lingkup

- Membersihkan logika gerbang role. 9 dari 14 item membawa `minRole` yang tidak
  pernah mengecualikan siapa pun, `allowedRoles` selalu menimpa `minRole` di mana
  keduanya ada, dan ada kasus khusus `verifikator` yang di-hardcode di
  `Sidebar.tsx:89`. Semuanya nyata dan layak dibereskan — tapi itu menyentuh kode
  yang menentukan siapa melihat apa, dan pantas mendapat spec serta verifikasi
  ketujuh-role sendiri.
- Menambah atau menghapus item menu.
- Mengubah urutan item di dalam kelompok.
- Mengubah bagian aksi bawah (lonceng notifikasi, tombol pasang PWA, nama
  pengguna, Keluar).
