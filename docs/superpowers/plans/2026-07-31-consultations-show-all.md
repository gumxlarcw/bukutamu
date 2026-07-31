# Antrian PST — Tampilkan Semua Kunjungan: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buka `/admin/consultations` agar menampilkan semua kunjungan — semua tanggal, semua layanan, semua kanal — dengan filter status dan paginasi server-side, tanpa merusak pemisahan tabel data antar-grup layanan.

**Architecture:** Buang tiga filter keras di `Consultations::index` dan filter role di client; ganti dengan parameter query + paginasi + role scoping server-side. Taksonomi role↔layanan dijadikan sumber tunggal di `Api_base`. Tombol "Mulai" dirutekan per grup layanan agar data DTSEN tidak tertulis ke tabel SKD.

**Tech Stack:** CodeIgniter 3 HMVC (PHP 7.4-FPM), React 19 + TypeScript 5.9 + Vite, `@tanstack/react-query` v5, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-07-31-consultations-show-all-design.md`

## Global Constraints

- **Repo ini tidak punya tes otomatis.** Tidak ada PHPUnit, Vitest, atau `npm test`. Jangan mengarang skrip tes. Verifikasi = `npm run lint`, `npm run build`, query MySQL, dan pemeriksaan browser. Lihat `.claude/rules/testing.md`.
- **Wajib backup sebelum tiap edit:** `cp {file} {file}.backup`, lalu `diff {file}.backup {file}` sesudahnya. `*.backup` sudah ada di `.gitignore`.
- **Commit TANPA trailer `Co-Authored-By`.** Aturan permanen repo ini.
- **PHP backend langsung live saat disimpan.** Tidak ada gerbang deploy. Jangan pernah menyimpan PHP yang mengacu ke kolom/tabel/method yang belum ada.
- **Task 1–2 (backend) dan Task 3–5 (frontend) harus dikerjakan dalam satu sesi berurutan.** Di antara keduanya, antrian akan menampilkan 25 baris lintas-tanggal tanpa kontrol paginasi — berfungsi, tapi asing bagi petugas. Jangan berhenti di tengah.
- **Nama database `db_tamdes`** — jangan diubah. Kredensial root ada di `/root/.my.cnf`, jadi `mysql -e "..."` bisa langsung dipakai.
- **Query builder CI3:** `count_all_results('', FALSE)` — argumen kedua `FALSE` wajib agar Query Builder tidak ter-reset. Ini penawar footgun yang menyebabkan insiden mass-update 2026-06-30.
- **Semua SQL pakai bound param / `$this->db->escape()`.** Jangan pernah menyambung input user ke string SQL.

---

### Task 1: Api_base — taksonomi layanan sebagai sumber tunggal

Taksonomi role↔layanan saat ini ditulis inline di `require_layanan_role`. Task ini mengangkatnya jadi tiga method yang bisa dipakai bersama, tanpa mengubah perilaku gerbang finalisasi yang sudah ada.

**Files:**
- Modify: `backend/application/modules/api/controllers/Api_base.php`

**Interfaces:**
- Produces:
  - `protected function layanan_role_map(): array` — `['petugas_pst' => string[], 'resepsionis' => string[]]`
  - `protected function all_known_services(): string[]` — gabungan rata kedua grup
  - `protected function services_visible_to_role(string $role): ?array` — `NULL` = tanpa batas (role bypass), `[]` = tidak melihat apa pun (fail-closed)
  - `protected function layanan_match_sql(string $name): string` — potongan SQL boolean, sudah ter-escape
- Consumes: —

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
cp Api_base.php Api_base.php.backup
```

- [ ] **Step 2: Catat perilaku gerbang SEBELUM diubah (baseline paritas)**

Ini yang harus tetap sama sesudahnya. Jalankan dan simpan hasilnya:

```bash
mysql db_tamdes -t -e "
SELECT
  SUM(COALESCE(TRIM(jenis_layanan),'') = 'Lainnya'
      OR jenis_layanan LIKE '%\"Lainnya\"%')            AS resep_lainnya,
  SUM(jenis_layanan LIKE '%\"Lainnya Online\"%')        AS pst_lainnya_online,
  SUM(COALESCE(TRIM(jenis_layanan),'') = ''
      OR jenis_layanan IS NULL)                         AS kosong,
  SUM(COALESCE(TRIM(jenis_layanan),'') = 'Pelayanan Statistik Terpadu') AS tak_dikenal
FROM tamdes_kunjungan;"
```

Nilai yang diharapkan per 2026-07-31: `resep_lainnya=264`, `pst_lainnya_online=1`, `kosong=9`, `tak_dikenal=3`.
Perhatikan `resep_lainnya` **tidak** menghitung `Lainnya Online` — itulah yang membuktikan pola berkutip bekerja.

- [ ] **Step 3: Tambahkan empat method baru**

Sisipkan tepat di atas `require_layanan_role` di `Api_base.php`:

```php
    /**
     * Sumber tunggal taksonomi role -> layanan.
     * Dibaca require_layanan_role() (gerbang tulis) dan Consultations::index()
     * (filter baca) supaya tidak lahir salinan ketiga di samping
     * frontend/src/lib/role-access.ts.
     *
     * 'Daftar Antrian Offline' disamakan dengan frontend (role-access.ts:26) —
     * sebelumnya hanya ada di FE sehingga menjadi drift diam-diam.
     */
    protected function layanan_role_map() {
        return [
            'petugas_pst' => [
                'Perpustakaan',
                'Konsultasi Statistik',
                'Rekomendasi Kegiatan Statistik',
                'Penjualan Produk Statistik',
                'Konsultasi DTSEN',
                'Lainnya Online',
            ],
            'resepsionis' => [
                'Lainnya',
                'Keperluan Pimpinan',
                'Daftar Antrian Offline',
            ],
        ];
    }

    /** Semua layanan yang dikenal salah satu grup role, rata. */
    protected function all_known_services() {
        $map = $this->layanan_role_map();
        return array_merge($map['petugas_pst'], $map['resepsionis']);
    }

    /**
     * Layanan yang boleh DILIHAT sebuah role di daftar antrian.
     * NULL  = tanpa batas (admin/superadmin/operator).
     * []    = tidak melihat apa pun (role tak dikenal; fail-closed, sejalan #23).
     */
    protected function services_visible_to_role($role) {
        if (in_array($role, ['admin', 'superadmin', 'operator'], true)) {
            return NULL;
        }
        $map = $this->layanan_role_map();
        return isset($map[$role]) ? $map[$role] : [];
    }

    /**
     * Potongan SQL boolean: "kunjungan ini mengandung layanan $name".
     *
     * Menangani DUA format penyimpanan yang sama-sama hidup di db_tamdes:
     *   - string polos : 'Lainnya'            (106 baris)
     *   - JSON array   : '["Lainnya"]'        (158 baris)
     *
     * Pola JSON memakai kutip ganda ('%"Lainnya"%') — BUKAN '%Lainnya%' —
     * karena 'Lainnya' adalah substring dari 'Lainnya Online' yang berada di
     * grup role BERBEDA. Tanpa kutip, resepsionis akan melihat layanan PST.
     *
     * COALESCE+TRIM menangani jenis_layanan NULL (1 baris) dan yang berspasi
     * atau bertab di ujung (6 baris 'Perpustakaan\t').
     */
    protected function layanan_match_sql($name) {
        $lit = $this->db->escape($name);
        $esc = $this->db->escape_like_str($name);
        return "(COALESCE(TRIM(k.jenis_layanan),'') = {$lit}"
             . " OR COALESCE(k.jenis_layanan,'') LIKE '%\"{$esc}\"%')";
    }
```

- [ ] **Step 4: Alihkan `require_layanan_role` ke sumber tunggal**

Di dalam `require_layanan_role`, ganti dua deklarasi array inline:

```php
        $pst_services = [
            'Perpustakaan',
            'Konsultasi Statistik',
            'Rekomendasi Kegiatan Statistik',
            'Penjualan Produk Statistik',
            'Konsultasi DTSEN',
            'Lainnya Online', // WA category #3 — PST-handled online, no eval
        ];
        $resepsionis_services = ['Lainnya', 'Keperluan Pimpinan'];
```

menjadi:

```php
        $map                  = $this->layanan_role_map();
        $pst_services         = $map['petugas_pst'];
        $resepsionis_services = $map['resepsionis'];
```

Sisa method (loop `foreach` dan dua `json_response` 403) **tidak diubah sama sekali**.

- [ ] **Step 5: Verifikasi diff dan sintaks**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
diff Api_base.php.backup Api_base.php
php7.4 -l Api_base.php
```

Diff harus menunjukkan hanya: empat method baru, dan dua array inline berganti jadi tiga baris `$map`. `php7.4 -l` harus mencetak `No syntax errors detected`.

Satu-satunya perubahan perilaku yang disengaja: `Daftar Antrian Offline` kini masuk daftar resepsionis di backend.

- [ ] **Step 6: Smoke test bahwa backend masih hidup**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:60/api/auth/check
```

Harus `401`. Apa pun yang 5xx berarti ada kesalahan sintaks — rollback dari `.backup` segera, ingat PHP di sini live saat disimpan.

- [ ] **Step 7: Commit**

```bash
cd /var/www/html/bukutamu
git add backend/application/modules/api/controllers/Api_base.php
git commit -m "refactor(api): taksonomi role-layanan jadi sumber tunggal di Api_base

Angkat daftar layanan PST/Resepsionis dari inline require_layanan_role
menjadi layanan_role_map(), plus helper all_known_services(),
services_visible_to_role(), dan layanan_match_sql().

layanan_match_sql memakai pola JSON berkutip karena 'Lainnya' adalah
substring 'Lainnya Online' yang beda grup role.

Samakan 'Daftar Antrian Offline' dengan frontend (role-access.ts:26)."
```

---

### Task 2: Consultations::index — filter, paginasi, role scoping server-side

**Files:**
- Modify: `backend/application/modules/api/controllers/Consultations.php:8-46`

**Interfaces:**
- Consumes: `services_visible_to_role()`, `all_known_services()`, `layanan_match_sql()` dari Task 1
- Produces: `GET /api/consultations` mengembalikan `PaginatedResponse<Visit>` — kunci `success`, `data`, `message`, `pagination{page,limit,total,totalPages}`

- [ ] **Step 1: Backup dan catat angka acuan**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
cp Consultations.php Consultations.php.backup

mysql db_tamdes -t -e "
SELECT COUNT(*) AS total_semua,
       SUM(status='antri') AS antri,
       SUM(status='menunggu_evaluasi') AS menunggu_evaluasi
FROM tamdes_kunjungan;"
```

Per 2026-07-31: `total_semua=490`, `antri=22`, `menunggu_evaluasi=4`. Angka ini dipakai di Step 5.

- [ ] **Step 2: Ganti seluruh isi method `index()`**

Ganti dari `public function index() {` sampai `}` penutupnya (saat ini baris 8–46) dengan:

```php
    public function index() {
        $this->require_auth();

        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        }

        // Filter dikendalikan petugas lewat query param — TIDAK ada lagi filter
        // keras tanggal/layanan/kanal. Kunjungan yang belum selesai dari hari
        // sebelumnya harus tetap terlihat dan bisa ditindak.
        $q       = $this->input->get('q');
        $status  = $this->input->get('status');
        $layanan = $this->input->get('layanan');
        $tahun   = $this->input->get('tahun');
        $bulan   = $this->input->get('bulan');

        $page  = (int) ($this->input->get('page') ?: 1);
        if ($page < 1) { $page = 1; }
        // Clamp limit: tanpa batas atas, satu pemanggil bisa meminta seluruh
        // tabel dan menghidupkan lagi masalah subquery-per-baris.
        $limit = (int) ($this->input->get('limit') ?: 25);
        if ($limit < 1)   { $limit = 1; }
        if ($limit > 100) { $limit = 100; }
        $offset = ($page - 1) * $limit;

        $this->db
            ->select('k.*, b.nama, b.nama_instansi, b.email, b.notel, b.jeniskelamin, b.pendidikan, b.pekerjaan, b.kategori_instansi')
            // has_konsultasi sadar-grup: SKD menulis ke konsultasi_pengunjung,
            // DTSEN ke dtsen_konsultasi. Dijumlah karena grup layanan mutually
            // exclusive (validate_no_cross_layanan menolak campuran). Tanpa suku
            // kedua, kunjungan DTSEN yang sudah terisi tampil bertombol "Mulai".
            // Arg kedua FALSE => CI3 tidak backtick-escape subquery-nya.
            ->select("((SELECT COUNT(*) FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data) <> '')"
                   . " + (SELECT COUNT(*) FROM dtsen_konsultasi dk WHERE dk.id_kunjungan = k.id_kunjungan)) AS has_konsultasi", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left');

        if ($q) {
            $this->db->group_start()
                     ->like('b.nama', $q)
                     ->or_like('b.nama_instansi', $q)
                     ->or_like('k.jenis_layanan', $q)
                     ->or_like('k.status', $q)
                     ->group_end();
        }
        if ($status)  { $this->db->where('k.status', $status); }
        if ($layanan) { $this->db->like('k.jenis_layanan', $layanan); }
        if ($tahun)   { $this->db->where('YEAR(k.date_visit)', (int) $tahun); }
        if ($bulan)   { $this->db->where('MONTH(k.date_visit)', (int) $bulan); }

        // Role scoping pindah dari client (dulu ConsultationQueuePage.tsx:29-32)
        // ke server, karena filter client SETELAH paginasi akan membuat halaman
        // berisi 25 baris menyisakan 3 baris.
        $role    = isset($this->current_user->role) ? $this->current_user->role : '';
        $visible = $this->services_visible_to_role($role);
        if ($visible !== NULL) {
            $mine = [];
            foreach ($visible as $name) {
                $mine[] = $this->layanan_match_sql($name);
            }
            // Layanan di luar kedua grup (mis. 'Pelayanan Statistik Terpadu',
            // string kosong, NULL) tetap terlihat oleh semua role — paritas
            // dengan canFinalizeLayanan yang mengembalikan true untuk layanan
            // tak dikenal. Tanpa cabang ini, 12 baris lama hilang dari layar
            // petugas, justru kebalikan dari tujuan perubahan ini.
            $none = [];
            foreach ($this->all_known_services() as $name) {
                $none[] = 'NOT ' . $this->layanan_match_sql($name);
            }
            $clause = $mine
                ? '((' . implode(' OR ', $mine) . ') OR (' . implode(' AND ', $none) . '))'
                : '(' . implode(' AND ', $none) . ')';
            $this->db->where($clause, NULL, FALSE);
        }

        $this->db->order_by('k.date_visit', 'DESC');
        // Arg kedua FALSE menahan reset Query Builder (footgun CI3 yang
        // menyebabkan insiden mass-update 2026-06-30).
        $total  = $this->db->count_all_results('', FALSE);
        $consultations = $this->db->limit($limit, $offset)->get()->result();

        $this->json_response([
            'success'    => true,
            'data'       => $consultations,
            'message'    => 'OK',
            'pagination' => [
                'page'       => $page,
                'limit'      => $limit,
                'total'      => $total,
                'totalPages' => max(1, ceil($total / $limit)),
            ],
        ]);
    }
```

- [ ] **Step 3: Verifikasi diff dan sintaks**

```bash
cd /var/www/html/bukutamu/backend/application/modules/api/controllers
diff Consultations.php.backup Consultations.php
php7.4 -l Consultations.php
```

Method lain (`detail`, `call`, `test_sound`, `data`, `proxy_antrian`) harus **tidak tersentuh** di diff.

- [ ] **Step 4: Smoke test backend hidup**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:60/api/auth/check
curl -sS -w "\n%{http_code}\n" http://127.0.0.1:60/api/consultations
```

Keduanya `401` (endpoint ini butuh login). 5xx = rollback dari `.backup` sekarang juga.

- [ ] **Step 5: Verifikasi hasil query lewat SQL setara**

Endpoint butuh cookie JWT, jadi verifikasi logikanya langsung di MySQL. Jalankan padanan query untuk role bypass (tanpa role scoping):

```bash
mysql db_tamdes -t -e "
SELECT COUNT(*) AS harus_490 FROM tamdes_kunjungan k;
SELECT COUNT(*) AS harus_22  FROM tamdes_kunjungan k WHERE k.status='antri';"
```

Lalu padanan role scoping `resepsionis` — inilah pembuktian bahwa `Lainnya` tidak menyerap `Lainnya Online`:

```bash
mysql db_tamdes -t -e "
SELECT COUNT(*) AS terlihat_resepsionis FROM tamdes_kunjungan k
WHERE (
  ((COALESCE(TRIM(k.jenis_layanan),'')='Lainnya'            OR COALESCE(k.jenis_layanan,'') LIKE '%\"Lainnya\"%')
   OR (COALESCE(TRIM(k.jenis_layanan),'')='Keperluan Pimpinan' OR COALESCE(k.jenis_layanan,'') LIKE '%\"Keperluan Pimpinan\"%')
   OR (COALESCE(TRIM(k.jenis_layanan),'')='Daftar Antrian Offline' OR COALESCE(k.jenis_layanan,'') LIKE '%\"Daftar Antrian Offline\"%'))
);
SELECT COUNT(*) AS lainnya_online_bocor FROM tamdes_kunjungan k
WHERE (COALESCE(TRIM(k.jenis_layanan),'')='Lainnya' OR COALESCE(k.jenis_layanan,'') LIKE '%\"Lainnya\"%')
  AND COALESCE(k.jenis_layanan,'') LIKE '%Lainnya Online%';"
```

`lainnya_online_bocor` **harus `0`**. Kalau bukan 0, pola berkutip di `layanan_match_sql` rusak — hentikan dan perbaiki sebelum lanjut.

- [ ] **Step 6: Commit**

```bash
cd /var/www/html/bukutamu
git add backend/application/modules/api/controllers/Consultations.php
git commit -m "feat(api): /api/consultations dukung filter, paginasi, role scoping

Buang tiga filter keras (DATE(date_visit)=hari ini, LIKE 4 layanan SKD,
created_by<>'whatsapp'). Ganti dengan param q/status/layanan/tahun/bulan/
page/limit dan amplop PaginatedResponse.

Role scoping pindah dari client ke server — filter client setelah paginasi
akan membuat halaman 25 baris menyisakan 3 baris. Layanan tak dikenal tetap
terlihat semua role, paritas dengan canFinalizeLayanan.

has_konsultasi kini menjumlah konsultasi_pengunjung + dtsen_konsultasi."
```

---

### Task 3: Frontend — wrapper API

**Files:**
- Modify: `frontend/src/api/consultations.ts:6`

**Interfaces:**
- Consumes: amplop `PaginatedResponse` dari Task 2
- Produces: `consultationsApi.list(params?)` mengembalikan `AxiosResponse<PaginatedResponse<Visit>>`

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src/api
cp consultations.ts consultations.ts.backup
```

- [ ] **Step 2: Ubah impor tipe dan signature `list`**

Baris 2 — tambahkan `PaginatedResponse`:

```ts
import type { ApiResponse, PaginatedResponse } from '@/types/api'
```

Baris 6 — ganti `list`:

```ts
  list: (params?: {
    q?: string; status?: string; layanan?: string
    tahun?: string; bulan?: string; page?: number; limit?: number
  }) => apiClient.get<PaginatedResponse<Visit>>('/api/consultations', { params }),
```

Method lain (`updateStatus`, `call`, `testSound`, `getData`, `saveData`) tidak diubah.

- [ ] **Step 3: Verifikasi diff**

```bash
cd /var/www/html/bukutamu/frontend/src/api
diff consultations.ts.backup consultations.ts
```

Harus hanya dua hunk: baris impor dan method `list`.

- [ ] **Step 4: Jangan commit dulu**

`tsc` akan gagal sampai Task 5 selesai karena `ConsultationQueuePage.tsx:23` masih membaca `r.data.data` sebagai array. Ini disengaja — Task 3, 4, 5 di-commit bersama di akhir Task 5.

---

### Task 4: Komponen bersama — QueueList & VisitFilters

Dua komponen yang dipakai bersama halaman lain. Keduanya diubah secara **aditif** agar halaman yang sudah ada tidak berubah perilakunya.

**Files:**
- Modify: `frontend/src/components/admin/QueueList.tsx`
- Modify: `frontend/src/components/admin/VisitFilters.tsx`

**Interfaces:**
- Produces: prop opsional `emptyMessage?: string` pada `QueueList`, default `'Tidak ada antrian hari ini.'`
- Produces: `VisitFilters` dengan dropdown status lengkap 7 nilai enum. Tipe `VisitFilterState` (`q`, `layanan`, `status`, `tahun`, `bulan`) sudah diekspor dari berkas ini dan dipakai apa adanya oleh Task 5.

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src/components/admin
cp QueueList.tsx QueueList.tsx.backup
```

- [ ] **Step 2: Tambah prop opsional**

Ubah interface:

```ts
interface QueueListProps {
  visits: Visit[]
  renderActions: (visit: Visit) => ReactNode
  /** Pesan saat daftar kosong. Default mempertahankan teks lama supaya
   *  DtsenQueuePage tidak ikut berubah. */
  emptyMessage?: string
}
```

Ubah signature dan blok kosongnya:

```ts
export function QueueList({
  visits,
  renderActions,
  emptyMessage = 'Tidak ada antrian hari ini.',
}: QueueListProps) {
  if (visits.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }
```

Sisa komponen tidak diubah.

- [ ] **Step 3: Lengkapi dropdown status di VisitFilters**

```bash
cd /var/www/html/bukutamu/frontend/src/components/admin
cp VisitFilters.tsx VisitFilters.tsx.backup
```

Dropdown status saat ini hanya memuat 4 dari 7 nilai enum. Yang hilang —
`dipanggil`, `diproses`, `evaluasi_selesai` — termasuk status 1 baris yang
tertahan sejak 2026-05-13 dan tak akan pernah bisa disaring tanpa ini.

Ganti isi `<select id="filter-status">`:

```tsx
          <option value="">Semua Status</option>
          <option value="antri">Antri</option>
          <option value="dipanggil">Dipanggil</option>
          <option value="proses">Proses</option>
          <option value="diproses">Diproses</option>
          <option value="menunggu_evaluasi">Menunggu Evaluasi</option>
          <option value="evaluasi_selesai">Evaluasi Selesai</option>
          <option value="selesai">Selesai</option>
```

Urutan dan nilainya mengikuti persis enum `tamdes_kunjungan.status`:
`antri`, `dipanggil`, `proses`, `diproses`, `selesai`, `menunggu_evaluasi`,
`evaluasi_selesai`. Perubahan ini murni aditif — VisitLogPage ikut mendapat
tiga opsi baru tanpa ada perilaku lama yang berubah.

- [ ] **Step 4: Verifikasi diff kedua komponen**

```bash
cd /var/www/html/bukutamu/frontend/src/components/admin
diff QueueList.tsx.backup QueueList.tsx
diff VisitFilters.tsx.backup VisitFilters.tsx
```

`DtsenQueuePage` tidak disentuh sama sekali — ia otomatis memakai default
`emptyMessage`. Diff `VisitFilters.tsx` harus hanya berisi tiga baris
`<option>` tambahan.

---

### Task 5: ConsultationQueuePage — filter, paginasi, routing per grup

**Files:**
- Modify: `frontend/src/pages/admin/ConsultationQueuePage.tsx`

**Interfaces:**
- Consumes: `consultationsApi.list(params)` (Task 3), prop `emptyMessage` (Task 4), `getActiveServiceGroup()` dari `@/lib/role-access:150`

- [ ] **Step 1: Backup**

```bash
cd /var/www/html/bukutamu/frontend/src/pages/admin
cp ConsultationQueuePage.tsx ConsultationQueuePage.tsx.backup
```

- [ ] **Step 2: Tambah impor**

```ts
import { useState, useEffect } from 'react'
import { canFinalizeLayanan, parseLayananForRole, nextStatusAfterCompletion, needsQueueCall, getActiveServiceGroup } from '@/lib/role-access'
import { VisitFilters, type VisitFilterState } from '@/components/admin/VisitFilters'
```

Perhatikan `canFinalizeLayanan` **tetap dipakai** — untuk tombol gembok (baris 151), bukan lagi untuk memfilter daftar.

`VisitFilters` dipakai ulang apa adanya, bukan dirakit sendiri. Ia sudah menjadi
pola filter mapan di repo ini (`VisitLogPage.tsx:755`) dan `VisitFilterState`-nya
persis cocok dengan parameter yang diterima `Consultations::index` di Task 2.

- [ ] **Step 3: Ganti blok query dan hapus filter role client**

Ganti baris 21–32 (blok `useQuery` sampai `const visits = ...`) dengan:

```ts
  const [filters, setFilters] = useState<VisitFilterState>({
    q: '', layanan: '', status: '', tahun: '', bulan: '',
  })
  const [debounced, setDebounced] = useState(filters)
  const [page, setPage] = useState(1)
  const limit = 25

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(filters); setPage(1) }, 400)
    return () => clearTimeout(t)
  }, [filters])

  const { data, isLoading } = useQuery({
    queryKey: ['consultations-queue', { ...debounced, page, limit }],
    queryFn: () =>
      consultationsApi
        .list({
          q: debounced.q || undefined,
          status: debounced.status || undefined,
          layanan: debounced.layanan || undefined,
          tahun: debounced.tahun || undefined,
          bulan: debounced.bulan || undefined,
          page,
          limit,
        })
        .then(r => r.data),
    refetchInterval: 30000,
  })

  // Role scoping kini dikerjakan backend (Consultations::index). Memfilter lagi
  // di sini akan merusak paginasi: halaman berisi 25 baris bisa menyisakan 3.
  const visits = data?.data ?? []
  const pagination = data?.pagination
```

- [ ] **Step 4: Rutekan `handleStart` per grup layanan**

Ganti `handleStart` (baris 57–67) dengan:

```ts
  const handleStart = async (visitId: number, currentStatus: string, jenisLayanan: string) => {
    if (currentStatus === 'antri' || currentStatus === 'dipanggil') {
      try {
        await consultationsApi.updateStatus(visitId, 'diproses')
        queryClient.invalidateQueries({ queryKey: ['consultations-queue'] })
      } catch {
        // Non-fatal: lanjut ke form meski transition gagal
      }
    }
    // Tiap grup menulis ke tabel berbeda: SKD -> konsultasi_pengunjung,
    // DTSEN -> dtsen_konsultasi. Salah rute = data tertulis ke tabel salah.
    // Resepsionis TIDAK ke form konsultasi karena ConsultationFormPage
    // mewajibkan >=1 baris kebutuhan_data, sedangkan gerbangnya hanya
    // menuntut keterangan — editornya ada di VisitLogPage.
    const group = getActiveServiceGroup(parseLayananForRole(jenisLayanan))
    if (group === 'DTSEN')            navigate(`/admin/dtsen/${visitId}/form`)
    else if (group === 'ONLINE')      navigate('/admin/layanan-online')
    else if (group === 'RESEPSIONIS') navigate('/admin/visits')
    else                              navigate(`/admin/consultations/${visitId}/form`)
  }
```

- [ ] **Step 5: Perbarui kedua pemanggil `handleStart`**

Baris 118 dan 127 saat ini memanggil dengan dua argumen. Ubah **keduanya** menjadi:

```tsx
onClick={() => handleStart(visit.id_kunjungan, visit.status, visit.jenis_layanan)}
```

- [ ] **Step 6: Perbarui judul, subtitle, dan bar filter**

Ganti blok judul (baris 72–75) dengan:

```tsx
        <div>
          <h1 className="admin-h1">Antrian PST — Semua Kunjungan</h1>
          <p className="admin-subtitle">Semua layanan, semua tanggal, semua kanal</p>
        </div>
```

Sisipkan bar filter tepat sebelum blok `{isLoading ? ... }` — satu baris,
memakai komponen bersama yang sudah dilengkapi di Task 4:

```tsx
      <VisitFilters filters={filters} onChange={setFilters} />
```

Jangan merakit input/select sendiri. Kelas `admin-input` **tidak ada** di
stylesheet repo ini; `VisitFilters` sudah membawa markup, label, dan kelas
Tailwind yang benar, dan menempatkan halaman ini pada pola filter yang sama
dengan `VisitLogPage.tsx:755`.

- [ ] **Step 7: Teruskan `emptyMessage` dan tambahkan kontrol paginasi**

Pada `<QueueList ... />` tambahkan prop:

```tsx
          emptyMessage="Tidak ada kunjungan yang cocok dengan filter."
```

Tepat setelah `</QueueList>` (setelah tag penutupnya), sisipkan:

```tsx
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            Halaman {pagination.page} dari {pagination.totalPages} — {pagination.total} kunjungan
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}>Sebelumnya</Button>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages}
                    onClick={() => setPage(p => p + 1)}>Berikutnya</Button>
          </div>
        </div>
      )}
```

- [ ] **Step 8: Lint dan build**

```bash
cd /var/www/html/bukutamu/frontend
npm run lint
npm run build
```

Keduanya harus bersih. `npm run build` menjalankan `tsc -b` — inilah yang membuktikan Task 3, 4, 5 konsisten satu sama lain. Ini pengganti terdekat dari test suite yang repo ini punya.

- [ ] **Step 9: Verifikasi diff ketiga berkas**

```bash
cd /var/www/html/bukutamu/frontend/src
diff api/consultations.ts.backup                      api/consultations.ts
diff components/admin/QueueList.tsx.backup            components/admin/QueueList.tsx
diff components/admin/VisitFilters.tsx.backup         components/admin/VisitFilters.tsx
diff pages/admin/ConsultationQueuePage.tsx.backup     pages/admin/ConsultationQueuePage.tsx
```

- [ ] **Step 10: Commit ketiganya bersama**

```bash
cd /var/www/html/bukutamu
git add frontend/src/api/consultations.ts \
        frontend/src/components/admin/QueueList.tsx \
        frontend/src/components/admin/VisitFilters.tsx \
        frontend/src/pages/admin/ConsultationQueuePage.tsx
git commit -m "feat(admin): Antrian PST tampilkan semua kunjungan

Pakai ulang VisitFilters (cari/layanan/status/tahun/bulan) plus paginasi
25/halaman, semuanya server-side. Hapus filter role client karena role
scoping sudah pindah ke backend — memfilter ulang setelah paginasi akan
menyisakan 3 baris di halaman berisi 25.

Tombol Mulai dirutekan per grup layanan: DTSEN ke form DTSEN, Online ke
inbox Layanan Online, Resepsionis ke Daftar Kunjungan, SKD ke form SKD.
Tanpa ini data DTSEN tertulis ke konsultasi_pengunjung.

QueueList dapat prop emptyMessage opsional supaya DtsenQueuePage tidak
ikut berubah. Dropdown status VisitFilters dilengkapi dari 4 jadi 7 nilai
enum — 'dipanggil' sebelumnya tak bisa disaring sama sekali."
```

---

### Task 6: Verifikasi menyeluruh dan persiapan rilis

**Files:**
- Modify: `frontend/public/sw.js` (bump `CACHE_NAME`)

- [ ] **Step 1: Naikkan versi cache service worker**

```bash
cd /var/www/html/bukutamu/frontend/public
cp sw.js sw.js.backup
```

Di `sw.js:11`, ubah:

```js
const CACHE_NAME = 'admin-bukutamu-8200-v66';
```

menjadi:

```js
const CACHE_NAME = 'admin-bukutamu-8200-v67';
```

**Wajib** — service worker ini cache-first bercakupan `/admin`; tanpa bump, petugas tetap melihat kode lama walau deploy sukses. Reload penuh memperbaiki satu pengguna, membuka ulang aplikasi tidak.

```bash
diff sw.js.backup sw.js
```

Diff harus tepat satu baris: `v66` → `v67`.

- [ ] **Step 2: Build ulang dan restart PM2**

```bash
cd /var/www/html/bukutamu/frontend
npm run build
pm2 restart bukutamu-frontend
pm2 logs bukutamu-frontend --lines 30 --nostream
```

PM2 menyajikan `dist/` hasil build. Lupa build = PM2 dengan senang hati menyajikan dist lama tanpa error apa pun.

- [ ] **Step 3: Smoke test HTTP**

```bash
curl -sS -o /dev/null -w "frontend=%{http_code}\n" http://localhost:3060/admin/consultations
curl -sS -o /dev/null -w "backend=%{http_code}\n" http://127.0.0.1:60/api/auth/check
```

Harapkan `frontend=200`, `backend=401`.

Catatan: jangan pakai `https://bukutamu.bpsmalut.com:460/...` untuk smoke test — domainnya kini hanya beresolusi ke IP Cloudflare yang tidak melayani port 460, sehingga curl akan menggantung ~270 detik lalu gagal. Pakai `127.0.0.1` seperti di atas.

- [ ] **Step 4: Walkthrough di browser** *(harus dikerjakan manusia)*

Buka `https://bukutamu.bpsmalut.com/admin/consultations` lalu periksa:

1. Daftar memuat dan menampilkan kunjungan lintas tanggal, bukan hanya hari ini.
2. Kontrol paginasi muncul; totalnya **490** untuk role admin.
3. Filter status `Antri` menyisakan **22** baris; `Menunggu Evaluasi` menyisakan **4**.
4. Pencarian nama mempersempit hasil dan mereset ke halaman 1.
5. Klik "Mulai" pada baris **DTSEN** → harus mendarat di `/admin/dtsen/:id/form`, **bukan** form SKD.
6. Klik "Buka Evaluasi" pada salah satu dari 4 baris `menunggu_evaluasi` → form evaluasi terbuka.
7. Login sebagai `petugas_pst` → daftar menyempit ke layanan PST; baris Resepsionis tidak muncul.
8. Buka `/admin/dtsen` → pesan kosongnya masih berbunyi "Tidak ada antrian hari ini." (bukti Task 4 tidak bocor).

- [ ] **Step 5: Commit bump service worker**

```bash
cd /var/www/html/bukutamu
git add frontend/public/sw.js
git commit -m "chore(frontend): bump CACHE_NAME service worker untuk rilis antrian PST"
```

- [ ] **Step 6: Bersihkan berkas backup**

```bash
cd /var/www/html/bukutamu
find . -name "*.backup" -newer docs/superpowers/plans/2026-07-31-consultations-show-all.md \
  -not -path "./node_modules/*" -print
```

Tinjau daftarnya, hapus yang berasal dari pengerjaan ini. `*.backup` ada di `.gitignore` sehingga tidak pernah masuk git, tapi membiarkannya menumpuk membuat pohon kerja berantakan.

---

## Catatan untuk pelaksana

**Tidak ada regression test.** Perubahan ini menyentuh gerbang finalisasi status dan taksonomi role — persis area yang paling diuntungkan oleh tes otomatis. Repo ini belum punya satu pun. Setelah rencana ini selesai, layak diusulkan ke pemilik repo untuk menjadikan `Consultations::index` sebagai tes PHPUnit pertama; pilihan framework mengunci tooling sehingga butuh persetujuan mereka lebih dulu (`.claude/rules/testing.md`).

**Rollback.** Tiap task menyimpan `.backup` di samping berkas aslinya. Untuk backend, memulihkan berkas sudah cukup — PHP di sini live saat disimpan, tidak perlu restart. Untuk frontend, pulihkan berkas lalu `npm run build && pm2 restart bukutamu-frontend`.

**Di luar lingkup.** 27 kunjungan tertahan itu sendiri tidak ditutup oleh rencana ini — ia hanya membuat mereka terlihat dan bisa ditindak. Menutupnya massal adalah penulisan ke basis data produksi dan butuh persetujuan terpisah beserta backup segar (`feedback_prod_write_safety`).
