# Arsitektur Sistem BukuTamu

> Dokumen ini menjelaskan **bagaimana sistem dirakit**: komponen, alur data, integrasi eksternal, dan keputusan desain. Untuk panduan setup, lihat [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md). Untuk endpoint API spesifik, lihat [API.md](./API.md).

## 1. Pola Arsitektur

BukuTamu menggunakan pola **Strangler Fig** — aplikasi monolith CodeIgniter 3 lama "dicekik" perlahan dengan menambahkan REST API layer; UI publik dan admin dipindah ke React SPA terpisah. Hasilnya: 2 codebase, 1 domain, dengan Apache sebagai reverse proxy yang membagi traffic.

### Diagram High-Level

```
┌──────────────────────────────────────────────────────────────────┐
│                Pengguna (browser, tablet kiosk)                  │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│   Apache 2.4  (port 60 HTTP / 460 HTTPS)                         │
│   ServerName: bukutamu.bpsmalut.com                              │
│   DocumentRoot: /var/www/html/tamdes-web                         │
│                                                                  │
│   Routing rules (RewriteRule order matters):                     │
│   1. /video/*  → static file dari tamdes-frontend/dist/video     │
│   2. /hls/*    → static file dari tamdes-frontend/dist/hls       │
│   3. /api/*    → PHP-FPM (CodeIgniter)                           │
│   4. /index.php → PHP-FPM (CodeIgniter)                          │
│   5. /*        → reverse proxy ke 127.0.0.1:3060 (React SPA)     │
└──────────┬───────────────────────────┬───────────────────────────┘
           │                           │
           ▼                           ▼
┌──────────────────────┐    ┌────────────────────────────────────┐
│ PHP-FPM 7.4          │    │ PM2: tamdes-frontend (port 3060)   │
│ /var/www/html/       │    │ npx serve dist (built by Vite)     │
│   tamdes-web         │    │ /var/www/html/tamdes-frontend      │
│                      │    │                                    │
│ CodeIgniter 3 + HMVC │    │ React 19 + Vite 8 + TS             │
│ Modular Extensions   │    │ TanStack Query, React Router 7     │
│ JWT auth, .env       │    │ Tailwind v4, base-ui               │
└──────────┬───────────┘    └────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│ MySQL/MariaDB        │
│ DB: db_tamdes        │
└──────────────────────┘
```

### Layanan Pendukung (Auxiliary Services)

```
┌──────────────────┐  HTTP POST  ┌────────────────────────────────────┐
│ tamdes-web (CI3) │ ──────────▶ │ dashboard-pst.bpsmalut.com         │
│ Consultations    │             │ /update-antrian (layar antrian TV) │
│ ::call($id)      │             └────────────────────────────────────┘
└──────────────────┘

┌──────────────────┐  HTTP POST  ┌────────────────────────────────────┐
│ tamdes-web (CI3) │ ──────────▶ │ localhost:5000/print               │
│ Kiosk            │             │ Local print server (thermal)       │
│ ::print_ticket() │             └────────────────────────────────────┘
└──────────────────┘
```

## 2. Pembagian Tanggung Jawab

| Komponen | Tanggung Jawab | Tidak Bertanggung Jawab |
|---|---|---|
| **tamdes-web** | REST API, business logic, validasi, akses DB, JWT, audit log, integrasi eksternal (call antrian, print) | UI rendering, asset bundling, client-side routing |
| **tamdes-frontend** | UI/SPA (kiosk + admin), state management, validasi sisi klien, face detection (webcam), CSV export | Akses database langsung, hashing password, business rules |
| **Apache** | TLS termination, routing, static media (video/HLS), reverse proxy ke FPM dan Node | Auth, business logic |
| **MySQL** | Persistensi data tamu, kunjungan, evaluasi, audit, sesi login | (database murni) |
| **PHP-FPM 7.4** | Eksekusi script CI3 | (worker pool) |
| **PM2** | Manage Node process untuk serve frontend | (process supervisor) |

> ⚠️ **PHP 7.4 sudah End-of-Life sejak November 2022.** Tidak ada lagi security patch resmi. Migrasi ke PHP 8.2+ direkomendasikan dalam roadmap.

## 3. Struktur Backend (tamdes-web)

```
tamdes-web/
├── application/
│   ├── config/
│   │   ├── config.php          base_url, encryption_key
│   │   ├── database.php        kredensial DB (atau via .env)
│   │   └── routes.php          ⭐ peta URL → controller
│   ├── controllers/
│   │   └── Evaluasi.php        controller global lama (legacy)
│   ├── core/
│   │   ├── MY_Controller.php   override CI base
│   │   ├── MY_Loader.php       support HMVC modules
│   │   └── MY_Router.php       support HMVC routing
│   ├── helpers/
│   │   └── konsultasi_helper.php
│   ├── libraries/
│   │   ├── JWT_Helper.php      ⭐ encode/decode JWT HS256
│   │   └── Layout.php          legacy view wrapper
│   ├── modules/                ⭐ HMVC modules
│   │   ├── api/                ⭐ ACTIVE (semua endpoint REST)
│   │   │   └── controllers/
│   │   │       ├── Api_base.php       parent class (CORS, auth, audit)
│   │   │       ├── Auth.php           login/logout/check
│   │   │       ├── Guests.php         CRUD tamu
│   │   │       ├── Visits.php         kunjungan + status
│   │   │       ├── Consultations.php  antrian konsultasi
│   │   │       ├── Evaluations.php    IKM evaluasi
│   │   │       ├── Kiosk.php          self-service tamu
│   │   │       └── Dashboard.php      stats homepage admin
│   │   ├── admin/              LEGACY — view PHP lama (tidak diakses dari URL)
│   │   ├── selamat_datang/     LEGACY — kiosk lama (tidak diakses dari URL)
│   │   ├── recognize/          LEGACY
│   │   └── layanan/            LEGACY
│   ├── third_party/MX/         Modular Extensions (HMVC)
│   └── views/                  global views (errors, evaluasi/*)
├── system/                     CodeIgniter core (jangan diubah)
├── .env                        ⭐ kredensial (TIDAK di-commit)
├── .htaccess                   redirect ke index.php
├── index.php                   entry point CI3
└── docs/                       dokumentasi (file ini)
```

**Convention:** Semua endpoint baru dibuat di `application/modules/api/controllers/` extending `Api_base`. View PHP di modul lain (`admin`, `selamat_datang`, dll) sudah dead code dari sisi domain — tertangkap RewriteRule SPA, tidak pernah dieksekusi.

## 4. Struktur Frontend (tamdes-frontend)

```
tamdes-frontend/
├── src/
│   ├── api/                    ⭐ axios clients per resource
│   │   ├── client.ts           base axios instance (withCredentials)
│   │   ├── auth.ts             /api/auth/*
│   │   ├── guests.ts           /api/guests/*
│   │   ├── visits.ts           /api/visits/*
│   │   ├── consultations.ts    /api/consultations/*
│   │   ├── evaluations.ts      /api/evaluations/*
│   │   ├── kiosk.ts            /api/kiosk/*
│   │   ├── services.ts         /api/services
│   │   └── dashboard.ts        /api/dashboard/*
│   ├── pages/
│   │   ├── kiosk/              9 halaman alur kiosk
│   │   ├── admin/              13 halaman dashboard
│   │   ├── LandingPage.tsx     redirect logic
│   │   └── NotFoundPage.tsx
│   ├── layouts/
│   │   ├── KioskLayout.tsx     wrapper kiosk (header polos, fullscreen)
│   │   └── AdminLayout.tsx     wrapper admin (sidebar, topnav)
│   ├── providers/
│   │   ├── AuthProvider.tsx    context user + JWT cookie
│   │   ├── QueryProvider.tsx   TanStack Query setup
│   │   └── ThemeProvider.tsx   dark/light mode
│   ├── hooks/
│   │   ├── useAuth.ts          state auth admin
│   │   ├── usePrint.ts         trigger /api/kiosk/print
│   │   ├── useCamera.ts        webcam + getUserMedia
│   │   └── useInactivityTimeout.ts  auto-reset kiosk
│   ├── lib/
│   │   ├── face-detection.ts   wrapper face-api.js
│   │   ├── export-csv.ts       CSV export tamu/visit
│   │   └── utils.ts            cn() classNames helper
│   ├── components/
│   │   ├── ui/                 base-ui + shadcn-like primitives
│   │   ├── admin/              komponen spesifik admin
│   │   └── shared/             ErrorBoundary, LoadingSpinner
│   ├── types/                  TS interfaces (api, guest, visit, evaluation)
│   ├── App.tsx                 router + providers
│   └── main.tsx                ReactDOM root
├── public/
│   └── serve.json              konfigurasi `serve` (SPA fallback)
├── dist/                       hasil build (di-serve PM2)
├── ecosystem.config.cjs        konfigurasi PM2
├── vite.config.ts              proxy /api → :8080 (dev only)
└── package.json
```

## 5. Skema Database

Database: `db_tamdes` (MySQL/MariaDB).

### 5.1 Tabel Utama

#### `tamdes_buku` — Master Data Tamu

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id_user` | INT PK | Manual ID, mulai dari **8200001** |
| `nama` | VARCHAR | |
| `email`, `notel` | VARCHAR | |
| `jeniskelamin` | ENUM | `L` / `P` |
| `umur`, `disabilitas`, `jenis_disabilitas` | INT | |
| `pendidikan`, `pekerjaan`, `pekerjaan_lainnya` | VARCHAR | |
| `kategori_instansi`, `kategori_lainnya`, `nama_instansi` | VARCHAR | |
| `pemanfaatan`, `pemanfaatan_lainnya`, `pengaduan` | TEXT | |
| `foto` | LONGBLOB | foto wajah JPEG (kiosk) |
| `face_descriptor` | TEXT (JSON) | vektor 128-d hasil face-api.js |
| `biometric_consent` | TINYINT | 1 jika tamu setuju data biometrik disimpan |
| `consent_timestamp` | DATETIME | |
| `tgldatang` | DATE | tanggal pertama daftar |
| `registered_via` | VARCHAR | `kiosk` / `admin:<username>` |

#### `tamdes_kunjungan` — Log Kunjungan

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id_kunjungan` | INT PK AUTO | |
| `id_user` | INT FK → tamdes_buku | |
| `jenis_layanan` | TEXT (JSON array) | bisa multi-layanan |
| `layanan_lainnya` | VARCHAR | |
| `sarana` | TEXT (JSON array) | sarana yang dipakai |
| `sarana_lainnya` | VARCHAR | |
| `date_visit` | DATETIME | mulai kunjungan |
| `selesai_timestamp` | DATETIME | saat status → selesai |
| `durasi_detik` | INT | dihitung otomatis |
| `nomor_antrian` | VARCHAR | format `[A-Z]\d{3}` (mis. `K001`, `P012`) |
| `status` | ENUM | `antri`, `dipanggil`, `diproses`, `menunggu_evaluasi`, `selesai` |
| `rating_pengunjung` | INT 1-10 | skor kepuasan keseluruhan |
| `created_by` | VARCHAR | `kiosk` / `admin:<username>` |

#### `konsultasi_pengunjung` — Hasil & Kebutuhan Data

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | INT PK | |
| `id_kunjungan` | INT FK → tamdes_kunjungan | |
| `hasil_konsultasi` | TEXT | ringkasan dari operator |
| `rincian_data` | TEXT | indikator/data yang diminta |
| `wilayah_data` | VARCHAR | level wilayah |
| `tahun_awal`, `tahun_akhir` | INT | rentang tahun |
| `level_data`, `periode_data`, `status_data` | VARCHAR | |
| `jenis_publikasi`, `judul_publikasi`, `tahun_publikasi` | VARCHAR | |
| `digunakan_nasional` | TINYINT | flag SKD (data digunakan untuk publikasi nasional) |
| `kualitas` | VARCHAR | rating kualitas pelayanan |
| `tanggal_input` | DATETIME | |

#### `tamdes_evaluasi_detail` — Skor IKM per Indikator

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | INT PK | |
| `id_kunjungan` | INT FK | |
| `indikator_id` | TINYINT 1-16 | lihat daftar di `Evaluations::indikator_list()` |
| `kepentingan` | TINYINT NULL | **Deprecated** (sejak 2026-04-30). Kolom dipertahankan untuk historical data; submission baru selalu NULL. |
| `kepuasan` | TINYINT 1-10 | skor kepuasan, skala Likert 1-10 (1 = sangat tidak puas, 10 = sangat puas) |

**Blok II. Kepuasan terhadap Pelayanan Data dan Informasi Statistik BPS — 16 Indikator:**
1. Informasi pelayanan pada unit layanan ini tersedia melalui media elektronik maupun non elektronik.
2. Persyaratan pelayanan yang ditetapkan mudah dipenuhi/disiapkan oleh konsumen.
3. Prosedur/alur pelayanan yang ditetapkan mudah diikuti/dilakukan.
4. Jangka waktu penyelesaian pelayanan yang diterima sesuai dengan yang ditetapkan.
5. Biaya pelayanan yang dibayarkan sesuai dengan biaya yang ditetapkan.
6. Produk pelayanan yang diterima sesuai dengan yang dijanjikan.
7. Sarana dan prasarana pendukung pelayanan memberikan kenyamanan.
8. Data BPS mudah diakses melalui sarana utama yang digunakan.
9. Petugas pelayanan dan/atau aplikasi pelayanan online merespon dengan baik.
10. Petugas pelayanan dan/atau aplikasi pelayanan online mampu memberikan informasi yang jelas.
11. Fasilitas pengaduan PST mudah diakses (Kotak saran, https://webapps.bps.go.id/pengaduan, bpshq@bps.go.id).
12. Tidak ada diskriminasi dalam pelayanan.
13. Tidak ada pelayanan di luar prosedur/kecurangan pelayanan.
14. Tidak ada penerimaan gratifikasi.
15. Tidak ada pungutan liar (pungli) dalam pelayanan.
16. Tidak ada praktik percaloan dalam pelayanan.

### 5.2 Tabel Pendukung

#### `admin_users` — User Login Admin
| Kolom | Tipe |
|---|---|
| `id` | INT PK |
| `username` | VARCHAR UNIQUE |
| `password_hash` | VARCHAR (bcrypt $2y$12) |
| `nama` | VARCHAR |
| `role` | ENUM: `operator` (legacy), `resepsionis`, `petugas_pst`, `admin`, `superadmin` |
| `active` | TINYINT |
| `last_login` | DATETIME |

#### `tamdes_audit_log` — Jejak Audit Admin
| Kolom | Tipe |
|---|---|
| `id` | INT PK |
| `admin_user` | VARCHAR |
| `action` | VARCHAR (`login`, `logout`, `update`, `delete`, `update_status`, dll) |
| `target_type` | VARCHAR (`auth`, `guest`, `visit`, `consultation`) |
| `target_id` | INT |
| `detail` | TEXT (JSON diff) |
| `ip_address` | VARCHAR |
| `created_at` | TIMESTAMP DEFAULT CURRENT |

#### `tamdes_login_attempts` — Rate Limiting
| Kolom | Tipe |
|---|---|
| `id` | INT PK |
| `ip_address` | VARCHAR |
| `username` | VARCHAR |
| `success` | TINYINT (0/1) |
| `created_at` | TIMESTAMP |

Threshold: **5 percobaan gagal dalam 15 menit per IP** → response 429 (Too Many Requests).

#### `tamdes_responden_tahunan` — Survei Responden Tahunan
Khusus survei responden internal BPS (per tahun, terkait SKD). Ditulis bersama dengan `LOCK TABLES` di `Kiosk::register()` untuk konsistensi.

### 5.3 Hubungan Antar Tabel

```
admin_users ── 1:N ──▶ tamdes_audit_log
                 │
                 ▼ generated by
tamdes_buku ── 1:N ──▶ tamdes_kunjungan ── 1:N ──▶ konsultasi_pengunjung
                                       └──▶ 1:N ──▶ tamdes_evaluasi_detail
```

## 6. Alur Autentikasi (JWT)

```
┌──────────┐  POST /api/auth/login   ┌────────────────────────┐
│ Browser  │ ────(JSON)─────────────▶│ Auth::login()          │
│ (admin)  │                         │ 1. Cek rate limit IP   │
│          │                         │ 2. Cek admin_users     │
│          │                         │ 3. Fallback .env hash  │
│          │                         │ 4. password_verify()   │
│          │                         │ 5. Log ke tamdes_login │
│          │                         │ 6. JWT_Helper::encode  │
│          │  Set-Cookie: jwt_token  │    HS256, exp 4h       │
│          │ ◀───────────────────────│                        │
│          │  (httpOnly, samesite=Strict, secure if HTTPS)    │
└──────────┘                         └────────────────────────┘
     │
     │ Berikutnya: setiap request kirim cookie otomatis
     ▼
┌──────────┐  GET /api/visits        ┌────────────────────────┐
│ Browser  │ ────────(cookie)───────▶│ Api_base::             │
│          │                         │   require_auth()       │
│          │                         │   ── decode token      │
│          │                         │   ── set current_user  │
│          │  data: [...]            │ Visits::index()        │
│          │ ◀───────────────────────│                        │
└──────────┘                         └────────────────────────┘
```

**Catatan keamanan:**
- Token disimpan di **cookie httpOnly** (bukan localStorage) → tidak bisa diakses dari JS, kebal XSS exfiltration.
- `samesite=Strict` → tidak terkirim dalam permintaan cross-origin → kebal CSRF.
- `secure` → cookie hanya dikirim via HTTPS (produksi).
- Endpoint kiosk publik (`/api/kiosk/*`) **tidak butuh auth** — kios fisik di front office, akses kontrol melalui device fingerprint dan jaringan internal.
- Role hierarchy:
  ```
  operator (1) ≈ resepsionis (1) ≈ petugas_pst (1)  <  admin (2)  <  superadmin (3)
  ```
  Tiga role di tier 1 punya level sama tapi **scope berbeda** — bukan hierarki ortogonal.
- **`Api_base::require_role($min)`** — cek tier numerik (mis. `require_role('admin')` blokir tier 1).
- **`Api_base::require_layanan_role($jenis_layanan)`** — cek scope per jenis layanan:
  - `petugas_pst` boleh: Perpustakaan, Konsultasi Statistik, Rekomendasi, Penjualan,
    Konsultasi DTSEN, **Lainnya Online**
  - `resepsionis` boleh: **Lainnya**, Keperluan Pimpinan, Daftar Antrian Offline
  - ⚠️ `Lainnya` (front-office) ≠ `Lainnya Online` (WA). Kunjungan WA yang salah
    berlabel `Lainnya` membuat petugas PST yang menanganinya kena 403 dan sesinya
    mustahil ditutup — lihat kunjungan 990699 (2026-08-04)
  - `admin`, `superadmin`, `operator` (legacy) → bypass full access
  - Mismatch role-layanan → 403 dengan pesan jelas
- **`Api_base::next_status_after_completion($jenis_layanan, $created_by = null)`** — tentukan status finalisasi:
  - SKD (4 inti) → `menunggu_evaluasi` (perlu evaluasi tablet)
  - `created_by='whatsapp'` → `menunggu_evaluasi` apa pun labelnya (tautan evaluasi
    dikirim ke chat); **kecuali** Konsultasi DTSEN yang tetap `selesai`
  - Resepsionis (Lainnya/Keperluan Pimpinan) → `selesai` langsung (skip evaluasi)
  - Multi-layanan: jika ada satu SKD → `menunggu_evaluasi`
  - Syarat kanal sengaja BUKAN entri di `$skd_services`: daftar itu juga menentukan
    cakupan kuesioner/rekap SKD. "Wajib evaluasi" ≠ "termasuk SKD" (2026-08-04)

## 7. Alur Bisnis Utama

### 7.1 Tamu Baru di Kiosk (jalur "ABCDEF")

```
A. /kiosk (WelcomePage)
     │ tap "Mulai"
     ▼
B. /kiosk/status — pilih status (Mahasiswa / Pemerintah / Swasta / Umum)
     │
     ▼
C. /kiosk/service — pilih jenis layanan (multi-pilih ok)
     │
     ▼
D. /kiosk/form — isi data diri (nama, instansi, dll)
     │
     ├── [opsi 1] /kiosk/recognize — face recognition (kalau pernah daftar)
     │       │ POST /api/kiosk/face-data → cocokkan vektor 128-d
     │       │ kalau cocok → langsung ke step F
     │
     ▼
E. /kiosk/capture — ambil foto wajah, hitung descriptor (face-api.js)
     │ POST /api/kiosk/register {nama, ..., foto base64, face_descriptor}
     │ → dapat id_user (8200xxx) + id_kunjungan + nomor_antrian
     ▼
F. /kiosk/ticket/:id — tampilkan tiket
     │ POST /api/kiosk/print → thermal printer
     ▼
   [tamu menunggu]
```

### 7.2 Tamu Lama (sudah pernah daftar) — jalur cepat

```
/kiosk → /kiosk/recognize
         │
         │ webcam → face-api.js detect → POST /api/kiosk/face-data
         │ cocokkan threshold L2 distance < 0.5
         ▼
         match? ── YA ──▶ /api/kiosk/profile-gaps/:id_user
         │                │ ada field kosong? ── YA ──▶ patch via /profile-update
         │                │
         │                ▼
         │              POST /api/kiosk/visit (id_user, jenis_layanan)
         │                │
         │                ▼
         │              /kiosk/ticket/:id
         │
         └─ TIDAK ──▶ kembali ke /kiosk/form (jalur tamu baru)
```

### 7.3 Operator Memanggil Antrian

```
admin/consultations          POST /api/consultations/:id/call
   (queue list)        ────▶  │
                              ├── ambil nomor_antrian dari DB
                              ├── proxy POST ke
                              │   dashboard-pst.bpsmalut.com/update-antrian
                              │   {nomor: "K001"}
                              ▼
                          [layar TV antrian update + audio TTS]

Selesai konsultasi:
admin/consultations/:id/form (isi data konsultasi)
   ────▶ POST /api/consultations/:id/data
            ├── delete row lama (replace strategy)
            ├── insert per-rincian_data ke konsultasi_pengunjung
   ────▶ PUT /api/visits/:id/status {status: "menunggu_evaluasi"}
            (tamu diarahkan ke tablet evaluasi)
```

### 7.4 Tamu Mengisi Evaluasi (Tablet di Front Office)

```
Tablet polling: GET /api/evaluations/pending
   │
   │ ada visit dengan status='menunggu_evaluasi'? (FIFO oleh id ASC)
   ▼
Render /kiosk/evaluasi/:id
   │ form: skor_keseluruhan (1-10) + 17 indikator (kepentingan & kepuasan 1-4)
   ▼
POST /api/evaluations/:id
   │ insert per indikator → tamdes_evaluasi_detail
   │ update tamdes_kunjungan: status=selesai, rating, durasi_detik
   ▼
[tablet kembali ke standby]
```

## 8. Generasi Nomor Antrian

Logic di `Api_base::generate_queue_number($jenis_layanan)`:

```
prefix = strtoupper(substr($jenis_layanan, 0, 1))   // huruf pertama, kapital
counter = COUNT(tamdes_kunjungan WHERE 
            DATE(date_visit) = today 
            AND jenis_layanan = $jenis_layanan) + 1
nomor = prefix + str_pad(counter, 3, '0', LEFT)      // mis. "K012"
```

**Pengecualian:** Jenis layanan `'Lainnya'` dan `'Keperluan Pimpinan'` (case-insensitive) **tidak mendapat nomor antrian** (return `null`).

**Contoh:**
- Pertama datang "Konsultasi Statistik" hari ini → `K001`
- Kelima "Penjualan Produk Statistik" → `P005`
- Keduapuluh "Perpustakaan" → `P020` (perhatikan: **bisa konflik dengan Penjualan!**)

> ⚠️ **Bug Potensial:** Prefix berdasarkan huruf pertama saja, jadi "Perpustakaan" dan "Penjualan Produk Statistik" sama-sama prefix `P`. Counter dipisah per jenis_layanan tapi prefix bertabrakan. Ini perlu evaluasi: apakah operator manusia dapat membedakan? Lihat issue tracker / commit `12ea135` (tertulis "shared queue number").

## 9. Integrasi Eksternal

### 9.1 Layar Antrian (`dashboard-pst.bpsmalut.com`)

- **Endpoint:** `POST https://dashboard-pst.bpsmalut.com/update-antrian`
- **Payload:** `{"nomor": "K001"}` atau `{"nomor": "TES"}` (untuk test sound)
- **Dipanggil dari:** `Consultations::call()` dan `Consultations::test_sound()`
- **Tujuan:** Update layar TV di ruang tunggu + voice TTS panggil nomor.

### 9.2 Print Server Lokal

- **Endpoint:** `POST http://localhost:5000/print`
- **Payload:** seluruh body request dari frontend (typically `{nomor, nama, jenis_layanan, ...}`)
- **Dipanggil dari:** `Kiosk::print_ticket()`
- **Tujuan:** Cetak tiket via printer thermal.
- **Catatan:** Print server berjalan terpisah (Python Flask atau Node) di port 5000 — tidak include di repo ini.

### 9.3 .env Configuration

File: `tamdes-web/.env` (TIDAK di-commit ke git).

```dotenv
# Database
DB_HOSTNAME=localhost
DB_USERNAME=root
DB_PASSWORD=<rahasia>
DB_DATABASE=db_tamdes

# CodeIgniter
CI_ENCRYPTION_KEY=<32+ char hex>

# Admin login (fallback, jika admin_users table kosong)
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH='$2y$12$...'   # bcrypt password hash

# JWT
JWT_SECRET=<32+ karakter random>

# Frontend URL (untuk CORS)
FRONTEND_URL=https://bukutamu.bpsmalut.com
```

## 10. Keputusan Desain & Trade-off

### 10.1 Mengapa JWT, bukan Session CI3?

- React SPA di-serve oleh PM2 (port 3060), CI3 di FPM. Session CI3 tergantung disk file/Redis dan path cookie tricky cross-process.
- JWT stateless → CI3 tidak perlu session storage. Cookie dibaca FPM, decode in-memory.
- Trade-off: revoke token sulit (harus tunggu expiry 4 jam atau ganti `JWT_SECRET`).

### 10.2 Mengapa Cookie httpOnly, bukan Header `Authorization`?

- Mencegah XSS exfiltration (token tidak terjangkau oleh JS).
- Frontend pakai `axios.create({ withCredentials: true })` → cookie otomatis ikut.
- Trade-off: butuh `samesite=Strict` agar tidak vulnerable CSRF; akibatnya tidak bisa embed dari domain lain.

### 10.3 Mengapa LongBlob untuk Foto, bukan Storage File?

- Volume kecil (per foto ~30-100 KB, target <1000 tamu/tahun).
- Sederhana — backup database = backup foto.
- Trade-off: `tamdes_buku` jadi besar; query dengan `SELECT *` mahal. Solusinya `Guests` controller pakai whitelist `$safe_columns` agar foto tidak ikut di-fetch kecuali via endpoint khusus `/photo`.

### 10.4 Mengapa Static Media via Apache, bukan PM2?

Lihat `bukutamu-60.conf`:
```apache
Alias /video /var/www/html/tamdes-frontend/dist/video
Alias /hls /var/www/html/tamdes-frontend/dist/hls
```
- Apache native support HTTP Range Requests (`Accept-Ranges bytes`) → seek video tanpa download ulang.
- Node `serve` kurang optimal untuk streaming.
- Trade-off: video harus ada di `dist/` saat build (atau di-symlink).

### 10.5 Mengapa Replace-Strategy untuk konsultasi_pengunjung?

`Consultations::data()` melakukan `DELETE WHERE id_kunjungan` lalu `INSERT` ulang semua row. Lebih simpel daripada compute diff (insert/update/delete per row). Trade-off: kalau koneksi terputus di tengah, data lama hilang.

### 10.6 Mengapa LOCK TABLES di Kiosk::register?

Generate `id_user` manual dengan `MAX(id_user) + 1`. Tanpa lock, dua kiosk yang submit bersamaan bisa dapat `id_user` sama → `Duplicate entry`. `LOCK TABLES` mencegah itu, dengan biaya: serialize semua registrasi (tapi volume rendah, tidak masalah).

## 11. Decision Records (penting untuk new developer)

| Keputusan | Kapan | Alasan | Dokumen |
|---|---|---|---|
| Pisah backend/frontend (Strangler Fig) | 2026-Q1 | View PHP CI3 sulit dimodernisasi, tablet kiosk butuh UX touch-friendly | `docs/superpowers/plans/2026-03-12-tamdes-react-frontend-redesign.md` |
| JWT stateless via cookie | 2026-Q1 | Hindari session shared state antara FPM & Node | `JWT_Helper.php` |
| Admin user di DB, fallback .env | 2026 | Backward compat bagi instalasi yang belum migrasi tabel admin_users | `Auth::login()` |
| Audit log di tabel sendiri | 2026 | Forensik & compliance, tidak bercampur dengan log CI3 | `Api_base::audit()` |
| Face recognition client-side | 2026 | Privasi (descriptor dihitung di browser), bandwidth (tidak upload foto utuh) | `lib/face-detection.ts` |

## 12. Roadmap Teknis

| Prioritas | Item | Catatan |
|---|---|---|
| 🔴 Tinggi | Upgrade PHP 7.4 → 8.2 | EOL sejak Nov 2022, security risk |
| 🟡 Sedang | Hapus modul legacy (`admin/views/*`, `selamat_datang/views/*`, dll) | Sudah dead code, bersihkan supaya tidak menyesatkan dev baru |
| 🟡 Sedang | Migrate ke monorepo (lihat saran arsitektur) | Atomic commits backend+frontend |
| 🟢 Rendah | TypeScript types generated dari skema DB | Hindari drift |
| 🟢 Rendah | Refresh token mechanism | Saat ini hard expiry 4 jam, user harus login ulang |
