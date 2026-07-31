# Rekomendasi Lewati Blok 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kunjungan `Rekomendasi Kegiatan Statistik` berjalan langsung dari pemanggilan ke evaluasi tablet tanpa mengisi form Blok 3, sementara tiga layanan SKD lain tetap terkunci seperti sekarang.

**Architecture:** `Api_base::layanan_requires_skd_form()` mengerjakan dua pekerjaan berbeda di bawah satu nama dan punya lima pemanggil. Ia dipecah menjadi `layanan_requires_blok3()` (3 layanan) dan `layanan_requires_evaluasi()` (4 layanan), tiap pemanggil diarahkan ke fungsi yang sesuai maksudnya, dan nama lama dihapus. Frontend mendapat cermin `requiresBlok3()` yang menyembunyikan tombol form — bukan membuatnya opsional.

**Tech Stack:** CodeIgniter 3 (PHP 7.4-FPM), React 19 + TypeScript 5.9, Vite.

**Spec:** `docs/superpowers/specs/2026-07-31-rekomendasi-skip-blok3-design.md`

## Global Constraints

- **`Rekomendasi Kegiatan Statistik` TETAP layanan SKD.** Ia tetap di `SKD_SERVICES` (frontend), `layanan_role_map()`, `validate_no_cross_layanan()`, `validate_sarana_for_layanan()`, dan `next_status_after_completion()`. Yang berubah HANYA kewajiban form Blok 3. Mengeluarkannya dari daftar-daftar itu akan merusak keanggotaan grup, whitelist sarana, dan menghapus kewajiban evaluasi yang justru harus dipertahankan.
- **JEBAKAN UTAMA:** `Evaluations::pending()` dan `Evaluations::pending_list()` memakai gerbang lama sebagai penentu kelayakan **tablet**. Kalau keduanya diarahkan ke `layanan_requires_blok3()`, kunjungan Rekomendasi akan berpindah ke `menunggu_evaluasi` tapi tidak pernah muncul di tablet — terjebak permanen. Keduanya WAJIB memakai `layanan_requires_evaluasi()`.
- **Repo ini tidak punya tes otomatis.** Tidak ada PHPUnit/Vitest/`npm test`. Verifikasi = `php7.4 -l`, `npm run lint`, `npx tsc -b`, `curl`, query MySQL.
- **Backup sebelum tiap edit:** `cp {file} {file}.backup`, lalu `diff`. KECUALI di `frontend/public/` — Vite menyalinnya ke `dist/` yang diterbitkan PM2, jadi backup di sana bisa diunduh publik. Untuk `sw.js`, backup ke `/tmp/`.
- **Repo ini punya hook yang MEMBLOKIR `rm -f` dan `rm -rf`** (`.claude/hooks/validate-bash.sh`). Hook mencocokkan STRING pada seluruh perintah, jadi menuliskan polanya di dalam heredoc pun ikut ditolak. Pakai `mv` ke direktori lain.
- **PHP backend langsung live saat disimpan** — DocumentRoot Apache adalah `/var/www/html/bukutamu/backend`. Jalankan `php7.4 -l` segera setelah menyimpan; kalau error, pulihkan dari `.backup` saat itu juga.
- **`npm run build` BUKAN perintah baca-saja.** Vite mengosongkan `dist/` yang sedang dilayani PM2 → 404 nyata, dan 404 di bawah `/assets/` ter-cache setahun (`immutable`). Selalu build ke `dist-staging` lalu salin atomik.
- **Commit TANPA trailer `Co-Authored-By`.** Aturan permanen repo ini.
- Jangan menyentuh `wa/server.js` maupun direktori untracked `scripts/ops/`.

---

### Task 1: Backend — pecah gerbang jadi dua

**Files:**
- Modify: `backend/application/modules/api/controllers/Api_base.php` (fungsi `layanan_requires_skd_form`, sekitar baris 374-387)
- Modify: `backend/application/modules/api/controllers/Consultations.php:196`
- Modify: `backend/application/modules/api/controllers/Visits.php:263`
- Modify: `backend/application/modules/api/controllers/Dtsen.php:181`
- Modify: `backend/application/modules/api/controllers/Evaluations.php:22` dan `:95`

**Interfaces:**
- Produces:
  - `protected function layanan_requires_blok3($jenis_layanan_raw): bool` — true untuk 3 layanan (TANPA Rekomendasi)
  - `protected function layanan_requires_evaluasi($jenis_layanan_raw): bool` — true untuk 4 layanan SKD (DENGAN Rekomendasi)
  - `layanan_requires_skd_form()` DIHAPUS

- [ ] **Step 1: Backup dan catat pemanggil**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
for f in Api_base.php Consultations.php Visits.php Dtsen.php Evaluations.php; do cp "$f" "$f.backup"; done
grep -rn "layanan_requires_skd_form" *.php | grep -v "\.backup"
```

Harus muncul tepat **6 baris**: definisinya di `Api_base.php:380` plus lima pemanggil. Kalau jumlahnya berbeda, ada pemanggil yang tidak terduga — hentikan dan laporkan sebelum mengubah apa pun.

- [ ] **Step 2: Ganti fungsi lama dengan dua fungsi baru**

Di `Api_base.php`, ganti seluruh blok berikut (docblock + fungsi):

```php
    /**
     * Apakah visit ini WAJIB punya form konsultasi PST (≥1 baris kebutuhan_data + hasil_konsultasi)
     * sebelum bisa di-transition ke menunggu_evaluasi/selesai?
     * True untuk 4 layanan inti SKD. DTSEN PST-role tapi punya tabel sendiri.
     */
    protected function layanan_requires_skd_form($jenis_layanan_raw) {
        $skd = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if (in_array($l, $skd, true)) return true;
        }
        return false;
    }
```

dengan:

```php
    /**
     * Apakah visit ini WAJIB mengisi form Blok 3 (≥1 baris kebutuhan_data +
     * hasil_konsultasi) sebelum bisa di-transition ke menunggu_evaluasi/selesai?
     *
     * TIGA layanan — Rekomendasi Kegiatan Statistik TIDAK termasuk: tamu datang
     * meminta rekomendasi kegiatan, bukan meminta angka, sehingga "kebutuhan data"
     * tidak berlaku baginya. Rekomendasi TETAP layanan SKD dalam segala hal lain
     * (grup, sarana, dan terutama kewajiban evaluasi tablet).
     *
     * JANGAN satukan lagi dengan layanan_requires_evaluasi(). Dulu keduanya satu
     * fungsi bernama layanan_requires_skd_form(), dan itu membuat "lewati form"
     * mustahil dibedakan dari "lewati evaluasi".
     */
    protected function layanan_requires_blok3($jenis_layanan_raw) {
        $svc = ['Perpustakaan', 'Konsultasi Statistik', 'Penjualan Produk Statistik'];
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if (in_array($l, $svc, true)) return true;
        }
        return false;
    }

    /**
     * Apakah visit ini WAJIB melewati evaluasi tablet?
     * EMPAT layanan inti SKD — Rekomendasi TETAP termasuk.
     *
     * Dipakai Evaluations::pending() (menerbitkan token kiosk) dan
     * Evaluations::pending_list() (menyaring antrean tablet). Kalau Rekomendasi
     * dikeluarkan dari sini, ia akan berpindah ke menunggu_evaluasi tapi tidak
     * pernah muncul di tablet — terjebak permanen.
     */
    protected function layanan_requires_evaluasi($jenis_layanan_raw) {
        $svc = ['Perpustakaan', 'Konsultasi Statistik', 'Rekomendasi Kegiatan Statistik', 'Penjualan Produk Statistik'];
        foreach ($this->decode_layanan_list($jenis_layanan_raw) as $l) {
            if (in_array($l, $svc, true)) return true;
        }
        return false;
    }
```

- [ ] **Step 3: Arahkan tiga gerbang FORM ke `layanan_requires_blok3`**

Ganti `layanan_requires_skd_form` menjadi `layanan_requires_blok3` di **tiga** tempat:

- `Consultations.php:196` — Gate 2
- `Visits.php:263` — Gate 2
- `Dtsen.php:181` — Gate 2

Ketiganya berpola sama: `if ($this->layanan_requires_skd_form($visit->jenis_layanan)) {` diikuti hitungan baris `konsultasi_pengunjung` dengan `rincian_data` tidak kosong. Hanya nama fungsinya yang berubah; badan `if`-nya tidak disentuh.

- [ ] **Step 4: Arahkan dua situs EVALUASI ke `layanan_requires_evaluasi`**

Ganti `layanan_requires_skd_form` menjadi `layanan_requires_evaluasi` di **dua** tempat:

- `Evaluations.php:22` — di dalam `pending()`, pada kondisi yang menerbitkan `kiosk_token`
- `Evaluations.php:95` — di dalam `pending_list()`, pada callback `array_filter`

**Ini langkah paling penting di seluruh rencana.** Salah mengarahkan salah satunya akan membuat kunjungan Rekomendasi terjebak di `menunggu_evaluasi` selamanya.

- [ ] **Step 5: Pastikan nama lama benar-benar hilang**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
grep -rn "layanan_requires_skd_form" *.php | grep -v "\.backup" || echo "  BERSIH — nama lama sudah tidak ada"
echo "--- sebaran fungsi baru (harus blok3=4, evaluasi=3) ---"
grep -rc "layanan_requires_blok3" Api_base.php Consultations.php Visits.php Dtsen.php Evaluations.php | grep -v "\.backup"
grep -rc "layanan_requires_evaluasi" Api_base.php Evaluations.php
```

`layanan_requires_blok3` harus muncul 1× di `Api_base.php` (definisi) + 1× masing-masing di `Consultations/Visits/Dtsen`. `layanan_requires_evaluasi` harus muncul 1× di `Api_base.php` + 2× di `Evaluations.php`.

- [ ] **Step 6: Sintaks dan smoke test**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
for f in Api_base.php Consultations.php Visits.php Dtsen.php Evaluations.php; do php7.4 -l "$f"; done
curl -sS -o /dev/null -w "auth=%{http_code}\n" http://127.0.0.1:60/api/auth/check
curl -sS -o /dev/null -w "consultations=%{http_code}\n" http://127.0.0.1:60/api/consultations
```

Kelimanya `No syntax errors`; `auth=401`, `consultations=401`. 5xx apa pun berarti pulihkan dari `.backup` saat itu juga — `Api_base.php` diwarisi SELURUH controller API, jadi kesalahan di sana melumpuhkan seluruh API, bukan satu endpoint.

- [ ] **Step 7: Buktikan lewat data**

```bash
mysql db_tamdes -t -e "
SELECT
  SUM(jenis_layanan LIKE '%Rekomendasi Kegiatan Statistik%')                              AS rekomendasi,
  SUM(jenis_layanan LIKE '%Perpustakaan%' OR jenis_layanan LIKE '%Konsultasi Statistik%'
      OR jenis_layanan LIKE '%Penjualan Produk Statistik%')                               AS tiga_lain
FROM tamdes_kunjungan;"
```

Angka ini hanya konteks: ada 25 kunjungan Rekomendasi dan nol di antaranya punya Blok 3, jadi tidak ada data yang perlu dimigrasi. Pembuktian perilaku sesungguhnya ada di Task 3.

- [ ] **Step 8: Commit**

```bash
cd /var/www/html/bukutamu
git add backend/application/modules/api/controllers/Api_base.php \
        backend/application/modules/api/controllers/Consultations.php \
        backend/application/modules/api/controllers/Visits.php \
        backend/application/modules/api/controllers/Dtsen.php \
        backend/application/modules/api/controllers/Evaluations.php
git commit -m "feat(api): pecah gerbang SKD jadi blok3 (3 layanan) + evaluasi (4 layanan)

layanan_requires_skd_form() mengerjakan DUA pekerjaan di bawah satu nama dan
punya LIMA pemanggil: tiga sebagai gerbang form Blok 3, dua di Evaluations
sebagai penentu kelayakan TABLET.

Rekomendasi Kegiatan Statistik tidak lagi wajib mengisi Blok 3 — tamu datang
meminta rekomendasi kegiatan, bukan meminta angka. Tapi ia TETAP wajib melewati
evaluasi tablet, jadi kedua situs Evaluations diarahkan ke fungsi 4-layanan.
Menyatukannya akan membuat Rekomendasi terjebak di menunggu_evaluasi selamanya.

Nama lama dihapus supaya tidak bisa dipanggil lagi."
```

---

### Task 2: Frontend — cermin dan sembunyikan tombol form

**Files:**
- Modify: `frontend/src/lib/role-access.ts`
- Modify: `frontend/src/pages/admin/ConsultationQueuePage.tsx`

**Interfaces:**
- Consumes: perilaku backend dari Task 1
- Produces: `export function requiresBlok3(layanan_list: string[]): boolean`

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src
cp lib/role-access.ts lib/role-access.ts.backup
cp pages/admin/ConsultationQueuePage.tsx pages/admin/ConsultationQueuePage.tsx.backup
```

- [ ] **Step 2: Tambah konstanta dan helper di `role-access.ts`**

Sisipkan tepat SETELAH deklarasi `SKD_SERVICES` (baris 4-9). **Jangan mengubah `SKD_SERVICES`** — ia tetap berisi empat layanan dan tetap menyetir `getServiceGroup`, `nextStatusAfterCompletion`, `needsQueueCall`, dan `SARANA_BY_GROUP`.

```ts
// Layanan yang WAJIB mengisi form Blok 3 (rincian kebutuhan data).
// Sengaja BERBEDA dari SKD_SERVICES: 'Rekomendasi Kegiatan Statistik' tetap
// layanan SKD — tetap satu grup, tetap sarana SKD, tetap wajib evaluasi tablet —
// tapi tamunya datang meminta rekomendasi kegiatan, bukan meminta angka,
// sehingga "kebutuhan data" tidak berlaku baginya.
// Cermin Api_base::layanan_requires_blok3().
const BLOK3_SERVICES = [
  'Perpustakaan',
  'Konsultasi Statistik',
  'Penjualan Produk Statistik',
] as const
```

Lalu tambahkan helper-nya tepat setelah `isSkdLayanan()` (baris 79-81):

```ts
/**
 * Apakah kombinasi layanan ini wajib mengisi form Blok 3?
 * Cermin Api_base::layanan_requires_blok3(). Dipakai Antrian PST untuk
 * memutuskan apakah tombol "Mulai / Lihat / Edit" dirender sama sekali.
 */
export function requiresBlok3(layanan_list: string[]): boolean {
  return layanan_list.some(l => (BLOK3_SERVICES as readonly string[]).includes(l))
}
```

- [ ] **Step 3: Impor helper di halaman antrian**

Di `ConsultationQueuePage.tsx`, tambahkan `requiresBlok3` ke impor `@/lib/role-access` yang sudah ada (baris 13). Impornya saat ini memuat `canFinalizeLayanan, parseLayananForRole, nextStatusAfterCompletion, needsQueueCall, getActiveServiceGroup, SKD_SERVICES` — tambahkan satu nama, jangan menghapus yang lain.

- [ ] **Step 4: Sembunyikan tombol form untuk layanan tanpa Blok 3**

Di `renderActions`, ganti blok komentar + ternary di **baris 161-182** (dari
`{/* Sudah ada data konsultasi tersimpan → ... */}` sampai `)}` penutup ternary,
tepat sebelum `{visit.status === 'menunggu_evaluasi' && (`) dengan:

```tsx
                {/* Tombol form hanya untuk layanan yang WAJIB mengisi Blok 3.
                    Rekomendasi Kegiatan Statistik dilewati sepenuhnya — skip,
                    bukan opsional: form yang boleh kosong akan tetap kosong
                    sambil menyisakan langkah yang membingungkan.
                    Sudah ada data tersimpan → "Lihat / Edit", belum → "Mulai".
                    Tetap lewat handleStart supaya transisi antri/dipanggil →
                    diproses tidak hilang (hanya label/ikon yang berubah). */}
                {requiresBlok3(parseLayananForRole(visit.jenis_layanan)) && (
                  Number(visit.has_konsultasi) > 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleStart(visit.id_kunjungan, visit.status, visit.jenis_layanan)}
                    >
                      <ClipboardCheck className="w-3.5 h-3.5 mr-1" />
                      Lihat / Edit
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleStart(visit.id_kunjungan, visit.status, visit.jenis_layanan)}
                    >
                      <ClipboardList className="w-3.5 h-3.5 mr-1" />
                      Mulai
                    </Button>
                  )
                )}
```

Isi kedua tombol **byte-identik** dengan yang sekarang — hanya dibungkus, dan
komentarnya diperluas. Untuk Rekomendasi tombolnya hilang; yang tersisa
"Panggil" dan "Selesai".

Tombol "Panggil", "Buka Evaluasi", dan "Selesai" **tidak disentuh**. `needsQueueCall` masih true untuk Rekomendasi karena `SKD_SERVICES` tidak berubah.

- [ ] **Step 5: Lint dan type-check**

```bash
cd /var/www/html/bukutamu/frontend
npm run lint 2>&1 | tail -3
npx tsc -b 2>&1 | tail -3
diff src/lib/role-access.ts.backup src/lib/role-access.ts
diff src/pages/admin/ConsultationQueuePage.tsx.backup src/pages/admin/ConsultationQueuePage.tsx
```

`npm run lint` harus **0 error**. Diff `role-access.ts` harus murni aditif — `SKD_SERVICES` tidak boleh muncul sebagai baris yang berubah.

- [ ] **Step 6: Commit**

```bash
cd /var/www/html/bukutamu
git add frontend/src/lib/role-access.ts frontend/src/pages/admin/ConsultationQueuePage.tsx
git commit -m "feat(admin): sembunyikan tombol form Blok 3 untuk Rekomendasi

Tombol Mulai / Lihat-Edit hanya dirender bila requiresBlok3() true. Skip, bukan
opsional: form yang boleh kosong akan tetap kosong — persis nasib Blok 3 selama
delapan bulan — sambil menyisakan langkah yang membingungkan.

BLOK3_SERVICES adalah konstanta BARU, bukan perubahan SKD_SERVICES. Rekomendasi
tetap di SKD_SERVICES sehingga grup, sarana, tombol Panggil, dan kewajiban
evaluasi tablet tidak berubah."
```

---

### Task 3: Verifikasi perilaku dan rilis

**Files:**
- Modify: `frontend/public/sw.js` (bump `CACHE_NAME`)

- [ ] **Step 1: Bump service worker**

```bash
cd /var/www/html/bukutamu/frontend
cp public/sw.js /tmp/sw.js.backup     # JANGAN backup di dalam public/
```

Di `public/sw.js` baris 11, ubah `admin-bukutamu-8200-v77` menjadi
`admin-bukutamu-8200-v78` (nilai saat ini sudah diperiksa: **v77**). Lalu:

```bash
node --check public/sw.js
diff /tmp/sw.js.backup public/sw.js
```

Diff harus tepat satu baris.

- [ ] **Step 2: Build ke staging**

```bash
cd /var/www/html/bukutamu/frontend
npx tsc -b && npx vite build --outDir dist-staging
[ -f dist-staging/index.html ] && echo "staging OK: $(ls dist-staging/assets | wc -l) aset"
for a in $(grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' dist-staging/index.html | sort -u); do
  [ -f "dist-staging/$a" ] || echo "HILANG $a"
done
```

- [ ] **Step 3: Salin atomik ke dist**

```bash
cd /var/www/html/bukutamu/frontend
for f in dist-staging/assets/*; do
  b=$(basename "$f"); cp "$f" "dist/assets/.tmp-$b" && mv -f "dist/assets/.tmp-$b" "dist/assets/$b"
done
for item in dist-staging/*; do
  b=$(basename "$item"); [ "$b" = "index.html" ] && continue; [ "$b" = "assets" ] && continue
  cp -r "$item" dist/
done
cp dist-staging/index.html dist/.tmp-index.html && mv -f dist/.tmp-index.html dist/index.html
find dist -name "*.backup" -o -name ".tmp-*" | head
```

Perintah terakhir harus tidak mengeluarkan apa pun.

- [ ] **Step 4: Smoke test**

```bash
curl -sS -o /dev/null -w "frontend=%{http_code} " http://localhost:3060/admin/consultations
curl -sS -o /dev/null -w "backend=%{http_code}\n" http://127.0.0.1:60/api/auth/check
for a in $(curl -sS https://bukutamu.bpsmalut.com/ 2>/dev/null | grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' | sort -u); do
  C=$(curl -sS -o /dev/null -w "%{http_code}" "https://bukutamu.bpsmalut.com/$a"); [ "$C" = "200" ] || echo "GAGAL $C $a"
done
```

Harapkan `frontend=200 backend=401`, tanpa baris GAGAL. Jangan memakai
`https://bukutamu.bpsmalut.com:460/...` — hostname itu hanya beresolusi ke IP
Cloudflare yang tidak melayani port 460, jadi curl menggantung ~270 detik lalu gagal.

- [ ] **Step 5: Walkthrough perilaku** *(harus manusia — ini pembuktian sesungguhnya)*

Buka `https://bukutamu.bpsmalut.com/admin/consultations` dan kerjakan berurutan:

1. Cari baris berlayanan **Rekomendasi Kegiatan Statistik** (ada 10 berstatus `antri`).
   Tombol **"Mulai" / "Lihat / Edit" harus HILANG**; "Panggil" dan "Selesai" tetap ada.
2. Cari baris **Perpustakaan / Konsultasi Statistik / Penjualan Produk Statistik**.
   Tombol form **harus MASIH ADA** — ini membuktikan perubahannya tidak melebar.
3. Tekan **Selesai** pada satu kunjungan Rekomendasi. Statusnya harus menjadi
   **`menunggu_evaluasi`**, bukan `selesai`, dan **bukan** ditolak dengan pesan
   "Form konsultasi SKD belum lengkap".
4. **Pemeriksaan terpenting:** pada baris yang sama, tombol **"Buka Evaluasi"**
   harus muncul dan benar-benar membuka form evaluasi — bukan halaman kosong.
   Inilah yang membuktikan Rekomendasi tidak terjebak.
5. Coba tekan **Selesai** pada kunjungan **Perpustakaan** yang belum diisi
   formnya. Harus **DITOLAK** dengan pesan "Form konsultasi SKD belum lengkap."

- [ ] **Step 6: Konfirmasi lewat data setelah walkthrough**

```bash
mysql db_tamdes -t -e "
SELECT k.id_kunjungan, k.status,
  EXISTS(SELECT 1 FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan=k.id_kunjungan
         AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data)<>'') AS punya_blok3
FROM tamdes_kunjungan k
WHERE k.jenis_layanan LIKE '%Rekomendasi Kegiatan Statistik%'
  AND k.status IN ('menunggu_evaluasi','selesai')
ORDER BY k.id_kunjungan DESC LIMIT 5;"
```

Kunjungan yang baru Anda selesaikan harus muncul dengan `status = menunggu_evaluasi`
dan `punya_blok3 = 0` — bukti bahwa ia lolos gerbang tanpa mengisi Blok 3.

- [ ] **Step 7: Commit**

```bash
cd /var/www/html/bukutamu
git add frontend/public/sw.js
git commit -m "chore(frontend): bump CACHE_NAME service worker untuk rilis Rekomendasi"
```

---

## Catatan untuk pelaksana

**Satu langkah menentukan seluruh rencana ini.** Task 1 Step 4 mengarahkan dua situs `Evaluations.php` ke `layanan_requires_evaluasi()`. Kalau salah satunya keliru diarahkan ke `layanan_requires_blok3()`, kunjungan Rekomendasi akan berpindah ke `menunggu_evaluasi` lalu tidak pernah muncul di tablet — terjebak permanen, dan tidak ada `php -l`, lint, maupun review diff yang akan menangkapnya. Hanya Step 5 poin 4 di Task 3 yang membuktikannya.

**Rollback.** `.backup` tersimpan di samping tiap berkas (kecuali `sw.js`, di `/tmp`). Backend cukup dipulihkan berkasnya — PHP live saat disimpan. Frontend: pulihkan berkas lalu ulangi Task 3 Step 2-3.

**Di luar lingkup**, tercatat di spec §8: menyatukan lima daftar 4-layanan yang tersebar di `Api_base.php`; melonggarkan validasi `Consultations::data`; dan kewajiban `status_data` yang saat ini tidak pernah divalidasi dan hanya terisi lewat nilai default.
