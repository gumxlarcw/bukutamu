# Gerbang Wajib-Klaim Layanan Online (WA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Petugas wajib menekan "Ambil alih" sebelum dapat memproses, menutup, atau mengirim apa pun ke pemohon di `/admin/layanan-online`; admin menjadi pengawas yang melihat semua & bertindak bebas tapi tak pernah memiliki sesi.

**Architecture:** Membalik satu guard yang sudah ada (`wa_require_session_owner`) dari fail-open ke fail-closed, memasangnya di tiga endpoint yang selama ini polos, menukar hak admin "ambil alih" dengan "lepaskan", lalu mencerminkan aturan itu di UI dengan tombol nonaktif + keterangan tiga lapis. Mesin klaim (kolom `assigned_to`, endpoint `assign` atomik) sudah ada sejak audit `#17` — tak ada perubahan skema.

**Tech Stack:** CodeIgniter 3 HMVC (PHP 8.4, Apache), MySQL `db_tamdes`, Vite 8 + React 19 + TypeScript 5.9, TanStack Query v5, Tailwind 4, `sonner` (toast), `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-07-17-wa-claim-gate-design.md` (commit `3b0d07a`)

## Global Constraints

- **Produksi = working tree.** `DocumentRoot /var/www/html/bukutamu/backend` (`/etc/apache2/sites-enabled/bukutamu-60.conf`). `opcache.validate_timestamps=On`, `revalidate_freq=2` → **menyimpan file PHP tayang ke produksi dalam ±2 detik.** Karena itu Task 1 memindahkan seluruh pekerjaan ke worktree terisolasi. **Jangan pernah mengedit `/var/www/html/bukutamu/backend/**` langsung sampai Task 7.**
- **Tidak ada staging.** Produksi satu-satunya environment (`.claude/skills/deploy/SKILL.md`).
- **Tidak ada test otomatis.** Tak ada PHPUnit/Vitest/Playwright (`.claude/rules/testing.md`). **Jangan mengarang `npm test`.** Verifikasi = `php -l`, `npm run lint`, `npm run build`, curl, smoke manual.
- **Backup sebelum edit** (aturan global wajib): `cp {file} {file}.backup` tepat sebelum edit pertama tiap file; verifikasi `diff {file}.backup {file}`. `*.backup` sudah di `.gitignore`.
- **Commit TANPA trailer `Co-Authored-By`** — aturan permanen repo ini (`CLAUDE.md`, auto-memory `feedback_no_co_authored`).
- **Envelope API bukutamu:** `{ success: bool, data: mixed, message: string }` — bukan `{error:{code}}`. Jangan ubah bentuknya.
- **Warna frontend** lewat CSS var (`var(--admin-primary)`, `var(--admin-text)`, …), bukan hex mentah.
- **Paritas BE/FE:** perubahan aturan layanan harus menyentuh kedua sisi dalam sesi yang sama (auto-memory `feedback_backend_parity`).
- **Peran** (`admin_users.role`, kolom ENUM): `superadmin`, `admin`, `petugas_pst`, `operator`, `resepsionis`, `verifikator`, `pimpinan`. Jangan tambah peran tanpa `ALTER TABLE`.
- **Irma = `admin_users.id` 3**, role `petugas_pst` (terverifikasi 2026-07-17).

## File Structure

| Berkas | Tanggung jawab | Task |
| --- | --- | --- |
| `backend/application/modules/api/controllers/Wa.php` | Guard wajib-klaim, helper peran/pemetaan, endpoint `assign`/`release` | 2, 3 |
| `backend/application/config/routes.php` | Rute `release` | 3 |
| `frontend/src/api/wa.ts` | Pembungkus axios `release()` | 4 |
| `frontend/src/pages/admin/LayananOnlineInboxPage.tsx` | Turunan peran, gating tombol, keterangan, tombol Lepaskan | 4 |
| `frontend/src/components/wa/ChatPopup.tsx` | Panel 🔒 pengganti komposer, lewati `markSeen`, sembunyikan reaksi | 5 |
| `docs/migrations/2026-07-17-wa-claim-gate-backfill.sql` | Backfill sesi berjalan → Irma | 6 |

---

### Task 1: Worktree terisolasi (pengaman produksi)

**Files:**
- Create: `/root/bukutamu-worktrees/wa-claim-gate/` (worktree baru, branch `feat/wa-claim-gate`)

**Interfaces:**
- Consumes: —
- Produces: direktori kerja `/root/bukutamu-worktrees/wa-claim-gate` yang dipakai Task 2-6. Semua path relatif di task berikutnya berakar di sini.

**Kenapa task ini ada:** working tree `/var/www/html/bukutamu` adalah docroot Apache yang live. Mengedit `Wa.php` di sana menayangkan kode setengah jadi ke petugas dalam ±2 detik; satu `parse error` = seluruh API 500. Repo ini sudah memakai pola worktree (`/root/bukutamu-worktrees/responden`, `/verifikator`).

- [ ] **Step 1: Pastikan tree produksi bersih dari pekerjaan kita**

```bash
cd /var/www/html/bukutamu && git status --short && git branch --show-current
```
Expected: branch `main`. `wa/server.js` (modified) dan `scripts/ops/` (untracked) sudah kotor sebelum pekerjaan ini — **biarkan, jangan commit, jangan stash**. Tak boleh ada perubahan lain.

- [ ] **Step 2: Buat worktree**

Gunakan skill `superpowers:using-git-worktrees`. Bila membuat manual:

```bash
cd /var/www/html/bukutamu
git worktree add -b feat/wa-claim-gate /root/bukutamu-worktrees/wa-claim-gate main
```
Expected: `Preparing worktree (new branch 'feat/wa-claim-gate')` lalu `HEAD is now at 3b0d07a`.

- [ ] **Step 3: Sediakan dependensi frontend di worktree**

`node_modules` tak ikut worktree; `npm run lint`/`build` di Task 4-5 membutuhkannya.

```bash
cd /root/bukutamu-worktrees/wa-claim-gate/frontend && npm install
```
Expected: selesai tanpa `ERR!`.

- [ ] **Step 4: Pastikan baseline frontend hijau SEBELUM menyentuh apa pun**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate/frontend && npm run lint && npm run build
```
Expected: lint tanpa error; build berakhir `✓ built in …`. **Bila baseline sudah merah, berhenti dan laporkan** — jangan bangun di atas fondasi rusak.

- [ ] **Step 5: Commit penanda (tanpa perubahan kode)**

Tak ada yang di-commit di task ini; worktree bukan isi repo. Lanjut ke Task 2.

---

### Task 2: Backend — balik guard jadi fail-closed + pasang di tiga endpoint polos

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php:1556-1567` (isi `wa_require_session_owner`)
- Modify: `backend/application/modules/api/controllers/Wa.php:1554` (sisip `wa_can_claim` setelah `wa_can_write`)
- Modify: `backend/application/modules/api/controllers/Wa.php:1633` (sisip `wa_session_for_visit` setelah `wa_latest_session`)
- Modify: `backend/application/modules/api/controllers/Wa.php:260` (`send_data_form`)
- Modify: `backend/application/modules/api/controllers/Wa.php:681` (`visit_proses`)
- Modify: `backend/application/modules/api/controllers/Wa.php:698` (`visit_selesai`)

**Interfaces:**
- Consumes: `$this->current_user->{id,role}` (dari `Api_base::require_auth()`), `$this->json_response(array, int)`, `$this->db` (CI Query Builder).
- Produces:
  - `private function wa_require_session_owner($sess): void` — menolak & mengakhiri request bila penelepon bukan pemegang sesi. `$sess` = objek baris `wa_sessions` dengan properti `assigned_to`, atau `null`. Dipakai Task 3 tidak; sudah dipanggil `messages()`, `react()`, `messages_upload()`.
  - `private function wa_can_claim(): bool` — `true` hanya untuk `petugas_pst`/`operator`. **Dipakai Task 3.**
  - `private function wa_session_for_visit($idKunjungan): object|null` — baris `wa_sessions` terbaru (`id`, `assigned_to`) untuk sebuah kunjungan.

- [ ] **Step 1: Backup**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
cp backend/application/modules/api/controllers/Wa.php backend/application/modules/api/controllers/Wa.php.backup
```

- [ ] **Step 2: Ganti isi `wa_require_session_owner` (jantung perubahan)**

Ganti blok lama di `Wa.php:1556-1567` **seluruhnya**:

```php
    // #17 — a claimed session (assigned_to set) may only be written by its assignee; admin override.
    // Unclaimed sessions (or a null session) stay open to any write-role operator.
    private function wa_require_session_owner($sess) {
        if (!$sess) return;
        $assigned = (int) ($sess->assigned_to ?? 0);
        if ($assigned === 0) return;
        $uid  = (int) ($this->current_user->id ?? 0);
        $role = $this->current_user->role ?? '';
        if ($assigned === $uid) return;
        if (in_array($role, ['admin', 'superadmin'], true)) return;
        $this->json_response(['success' => false, 'message' => 'Sesi ini sedang ditangani operator lain.'], 403);
    }
```

menjadi:

```php
    // #claim-gate — gerbang wajib-klaim: sesi hanya boleh ditulis oleh pemegangnya. Sesi yang
    // BELUM diklaim kini TERTUTUP (dulu terbuka untuk siapa pun) — petugas harus menekan
    // "Ambil alih" dulu, agar tiap penanganan punya pemilik tercatat dan pemohon selalu tahu
    // siapa yang menanganinya. admin/superadmin dikecualikan: pengawas yang boleh bertindak
    // tanpa pernah memiliki sesi (mereka memakai "Lepaskan", bukan "Ambil alih").
    // 409 = belum diklaim (petugas bisa memulihkan sendiri); 403 = milik orang lain (tidak bisa).
    private function wa_require_session_owner($sess) {
        $role = $this->current_user->role ?? '';
        if (in_array($role, ['admin', 'superadmin'], true)) return;
        if (!$sess) {
            $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
        }
        $assigned = (int) ($sess->assigned_to ?? 0);
        if ($assigned === 0) {
            $this->json_response(['success' => false, 'message' => 'Ambil alih sesi ini dulu sebelum memproses atau membalas chat.'], 409);
        }
        if ($assigned !== (int) ($this->current_user->id ?? 0)) {
            $this->json_response(['success' => false, 'message' => 'Sesi ini sedang ditangani operator lain.'], 403);
        }
    }
```

- [ ] **Step 3: Tambah `wa_can_claim()` tepat setelah `wa_can_write()`**

Sisipkan setelah baris penutup `}` milik `wa_can_write()` (`Wa.php:1554`):

```php

    // #claim-gate — klaim adalah milik petugas lapangan. admin/superadmin pengawas: melihat
    // semua & boleh bertindak, tapi tak pernah memiliki sesi. pimpinan read-only.
    private function wa_can_claim() {
        return in_array($this->current_user->role ?? '', ['petugas_pst', 'operator'], true);
    }
```

- [ ] **Step 4: Tambah `wa_session_for_visit()` tepat setelah `wa_latest_session()`**

Sisipkan setelah baris penutup `}` milik `wa_latest_session()` (`Wa.php:1633`):

```php

    // Sesi terbaru milik sebuah kunjungan. Klaim hidup di wa_sessions, sedangkan
    // visit_proses/visit_selesai hanya menerima id_kunjungan — cermin subquery di inbox().
    private function wa_session_for_visit($idKunjungan) {
        return $this->db->select('id, assigned_to')->where('id_kunjungan', (int) $idKunjungan)
                        ->order_by('id', 'DESC')->limit(1)->get('wa_sessions')->row();
    }
```

- [ ] **Step 5: Pagari `send_data_form()`**

Di `Wa.php:260`, setelah cek 404 dan **sebelum** cek kategori:

```php
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
        $this->wa_require_session_owner($sess); // #claim-gate — wajib klaim sebelum mengirim apa pun ke pemohon
        // Hanya alihkan sesi Antrian Offline / Lainnya — JANGAN reset sesi data yang sedang diproses.
```

- [ ] **Step 6: Pagari `visit_proses()`**

Di `Wa.php:681`, setelah cek kunjungan ada:

```php
        if (!$v) $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        $this->wa_require_session_owner($this->wa_session_for_visit($id)); // #claim-gate — wajib klaim sebelum memproses
        if (in_array($v->status, ['antri', 'dipanggil'], true)) {
```

- [ ] **Step 7: Pagari `visit_selesai()`**

Di `Wa.php:698`, setelah cek `created_by === 'whatsapp'` dan **sebelum** cek status `selesai`:

```php
        if (!$v || $v->created_by !== 'whatsapp') $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        $this->wa_require_session_owner($this->wa_session_for_visit($id)); // #claim-gate — wajib klaim sebelum menutup sesi (D5)
        if ($v->status === 'selesai') {
```

- [ ] **Step 8: Verifikasi sintaks (pengganti test — repo tanpa test otomatis)**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
php -l backend/application/modules/api/controllers/Wa.php
```
Expected: `No syntax errors detected in backend/application/modules/api/controllers/Wa.php`

- [ ] **Step 9: Verifikasi guard terpasang persis 6 kali**

```bash
grep -c "wa_require_session_owner" backend/application/modules/api/controllers/Wa.php
```
Expected: `7` (1 definisi + 6 pemanggilan: messages, react, messages_upload, send_data_form, visit_proses, visit_selesai)

- [ ] **Step 10: Verifikasi diff sesuai harapan**

```bash
diff backend/application/modules/api/controllers/Wa.php.backup backend/application/modules/api/controllers/Wa.php
```
Expected: hanya 6 hunk di atas. Tak ada `return;` tersisa pada cabang `!$sess` / `$assigned === 0`.

- [ ] **Step 11: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): gerbang wajib-klaim — guard fail-closed + pagari proses/selesai/form-data

wa_require_session_owner dibalik dari fail-open ke fail-closed: sesi yang belum
diklaim kini menolak (409) alih-alih terbuka untuk siapa pun. Dipasang juga di
visit_proses, visit_selesai, dan send_data_form yang selama ini tanpa guard.
admin/superadmin dikecualikan (pengawas)."
```

---

### Task 3: Backend — larang admin klaim + endpoint "Lepaskan"

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php:717` (gerbang peran `session_assign`)
- Modify: `backend/application/modules/api/controllers/Wa.php:731-742` (hapus cabang admin-override)
- Modify: `backend/application/modules/api/controllers/Wa.php:756` (sisip `session_release` setelah `session_assign`)
- Modify: `backend/application/config/routes.php:116` (rute `release`)

**Interfaces:**
- Consumes: `wa_can_claim()` (Task 2), `require_role_in(array)` & `audit($action, $entity, $id, $meta)` dari `Api_base.php` (pola persis seperti `session_delete`, `Wa.php:453-455`), `wa_operator_name($uid)` (`Wa.php:1364`).
- Produces: `POST /api/wa/sessions/{id}/release` → `200 { success: true, data: { assigned_to: null }, message: string }`. Dikonsumsi Task 4 sebagai `waApi.release(sessionId)`.

- [ ] **Step 1: Backup**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
cp backend/application/config/routes.php backend/application/config/routes.php.backup
```
(`Wa.php.backup` dari Task 2 dipertahankan — satu backup per berkas, sesuai aturan global.)

- [ ] **Step 2: Larang admin mengklaim**

Di `session_assign()`, ganti baris `Wa.php:717`:

```php
        if (!$this->wa_can_write()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403); // #5 pimpinan read-only
```

menjadi:

```php
        // #claim-gate — admin/superadmin tak pernah memiliki sesi; mereka memakai "Lepaskan".
        // Pesan dibedakan agar admin tahu jalan yang benar, bukan sekadar "Akses ditolak".
        if (in_array($this->current_user->role ?? '', ['admin', 'superadmin'], true)) {
            $this->json_response(['success' => false, 'message' => 'Admin tidak mengambil alih sesi. Gunakan "Lepaskan" untuk membebaskan sesi yang macet.'], 403);
        }
        if (!$this->wa_can_claim()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
```

- [ ] **Step 3: Hapus cabang admin-override (kini tak terjangkau)**

Ganti blok `Wa.php:731-742`:

```php
        if (!$claimed) {
            $cur    = $this->db->select('assigned_to')->get_where('wa_sessions', ['id' => $sid])->row();
            $holder = (int) ($cur->assigned_to ?? 0);
            if ($holder === $uid) {
                $this->json_response(['success' => true, 'data' => ['assigned_to' => $uid, 'operator_nama' => $this->wa_operator_name($uid)], 'message' => 'Sudah Anda tangani']);
            }
            if (!in_array($role, ['admin', 'superadmin'], true)) {
                $this->json_response(['success' => false, 'message' => 'Sudah ditangani oleh ' . $this->wa_operator_name($holder)], 409);
            }
            // Admin override → pindahkan ke admin yang meminta.
            $this->db->where('id', $sid)->update('wa_sessions', ['assigned_to' => $uid, 'assigned_at' => $now]);
        }
```

menjadi:

```php
        if (!$claimed) {
            $cur    = $this->db->select('assigned_to')->get_where('wa_sessions', ['id' => $sid])->row();
            $holder = (int) ($cur->assigned_to ?? 0);
            if ($holder === $uid) {
                $this->json_response(['success' => true, 'data' => ['assigned_to' => $uid, 'operator_nama' => $this->wa_operator_name($uid)], 'message' => 'Sudah Anda tangani']);
            }
            // Terkunci ke pemegang pertama. Hanya admin yang bisa membebaskan, lewat "Lepaskan".
            $this->json_response(['success' => false, 'message' => 'Sudah ditangani oleh ' . $this->wa_operator_name($holder)], 409);
        }
```

- [ ] **Step 4: Bersihkan variabel `$role` yang jadi yatim**

Di `session_assign()` (`Wa.php:720`) ada `$role = $this->current_user->role ?? '';`. Setelah Step 3, `$role` tak lagi dipakai di fungsi ini (Step 2 membaca peran langsung). **Hapus baris itu** agar tak ada variabel mati.

- [ ] **Step 5: Tambah endpoint `session_release`**

Sisipkan tepat setelah penutup `}` milik `session_assign()` (`Wa.php:756`), sebelum komentar `/* ── admin (Layanan Online inbox) ── */`:

```php

    // POST /api/wa/sessions/(:num)/release — admin membebaskan sesi macet (pemegangnya resign,
    // tak masuk, atau salah klaim) agar petugas lain bisa mengambil alih. Ini katup pengaman
    // dari larangan admin-klaim: tanpanya, sesi milik petugas yang menghilang terkunci selamanya.
    // TANPA pesan WA — pengklaim berikutnya yang mengirim "sedang ditangani oleh". (admin only)
    public function session_release($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        $this->require_role_in(['admin', 'superadmin']);
        $sid  = (int) $id;
        $sess = $this->db->select('id, assigned_to')->get_where('wa_sessions', ['id' => $sid])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);
        $holder = (int) ($sess->assigned_to ?? 0);
        if ($holder === 0) {
            $this->json_response(['success' => true, 'data' => ['assigned_to' => null], 'message' => 'Sesi memang belum dipegang siapa pun']);
        }
        $this->db->where('id', $sid)->update('wa_sessions', ['assigned_to' => null, 'assigned_at' => null]);
        $this->audit('wa_release', 'wa_session', $sid, ['from' => $holder]);
        $this->json_response(['success' => true, 'data' => ['assigned_to' => null], 'message' => 'Sesi dilepaskan — petugas lain dapat mengambil alih.']);
    }
```

- [ ] **Step 6: Daftarkan rute**

Di `backend/application/config/routes.php`, sisipkan tepat **setelah** baris 116 (rute `assign`) — rute lebih spesifik harus mendahului `api/wa/sessions/(:num)` di baris 118:

```php
$route['api/wa/sessions/(:num)/release'] = 'api/wa/session_release/$1'; // POST admin-only (bebaskan sesi macet)
```

- [ ] **Step 7: Verifikasi sintaks kedua berkas**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
php -l backend/application/modules/api/controllers/Wa.php && php -l backend/application/config/routes.php
```
Expected: `No syntax errors detected` untuk keduanya.

- [ ] **Step 8: Verifikasi urutan rute (spesifik sebelum umum)**

```bash
grep -n "api/wa/sessions" backend/application/config/routes.php
```
Expected: `assign` lalu `release` lalu `send-data-form`, dan `api/wa/sessions/(:num)` (delete) **terakhir**.

- [ ] **Step 9: Verifikasi tak ada sisa admin-override**

```bash
grep -n "Admin override" backend/application/modules/api/controllers/Wa.php
```
Expected: tak ada keluaran.

- [ ] **Step 10: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/config/routes.php
git commit -m "feat(wa): admin tak bisa klaim + endpoint Lepaskan

session_assign menolak admin/superadmin (403) dengan pesan yang mengarahkan ke
Lepaskan; cabang admin-override dihapus karena tak terjangkau. session_release
baru (admin only) mengosongkan assigned_to agar petugas lain bisa klaim ulang —
katup pengaman untuk sesi milik petugas yang menghilang. Tanpa pesan WA."
```

---

### Task 4: Frontend — pembungkus API, gating tombol, keterangan wajib-klaim

**Files:**
- Modify: `frontend/src/api/wa.ts:71` (tambah `release`)
- Modify: `frontend/src/pages/admin/LayananOnlineInboxPage.tsx` (import ikon, turunan peran, mutasi `release`, `onError` `markProses`, keterangan header, gating tombol, prop `ChatPopup`)

**Interfaces:**
- Consumes: `POST /api/wa/sessions/{id}/release` (Task 3); `WaInboxRow.{assigned_to, session_id, operator_nama}` (`types/wa.ts:57-64`, sudah ada); `AuthUser.{id, role}` (`api/auth.ts:6-11`, sudah ada); `getApiErrorMessage(e, fallback)` (`lib/apiError`).
- Produces: `waApi.release(sessionId: number)`; prop `locked` / `sessionId` / `onClaim` yang diteruskan ke `ChatPopup` (dipakai Task 5).

- [ ] **Step 1: Backup**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
cp frontend/src/api/wa.ts frontend/src/api/wa.ts.backup
cp frontend/src/pages/admin/LayananOnlineInboxPage.tsx frontend/src/pages/admin/LayananOnlineInboxPage.tsx.backup
```

- [ ] **Step 2: Tambah `release` ke `waApi`**

Di `frontend/src/api/wa.ts`, sisipkan tepat setelah blok `assign` (baris 66-68), sebelum `sendDataForm`:

```ts
  // Lepaskan sesi macet (admin only) → assigned_to = NULL, petugas lain bisa klaim ulang.
  release: (sessionId: number) =>
    apiClient.post<ApiResponse<{ assigned_to: null }>>(`/api/wa/sessions/${sessionId}/release`),
```

- [ ] **Step 3: Tambah ikon `Lock` & `Unlock`**

Di `LayananOnlineInboxPage.tsx:17`, tambahkan `Lock` dan `Unlock` di akhir daftar impor `lucide-react`:

```ts
import { MessageSquare, MessageCircle, ExternalLink, Inbox, Clock, Hourglass, CircleCheck, Unplug, Send, Trash2, QrCode, Smartphone, Copy, Loader2, RefreshCw, ArrowRight, Hand, UserCheck, Lock, Unlock } from 'lucide-react'
```

- [ ] **Step 4: Turunkan peran & kepemilikan**

Di `LayananOnlineInboxPage.tsx`, tepat setelah `const canDelete = user?.role === 'admin' || user?.role === 'superadmin'` (baris 282), sisipkan:

```ts
  // #claim-gate — petugas wajib memegang sesi sebelum boleh memproses/menutup/mengirim.
  // admin/superadmin = pengawas: melihat & bertindak bebas, tapi tak pernah memiliki sesi.
  const isAdmin  = user?.role === 'admin' || user?.role === 'superadmin'
  const canClaim = user?.role === 'petugas_pst' || user?.role === 'operator'
  const isMine   = (r: WaInboxRow) => r.assigned_to != null && r.assigned_to === user?.id
  const isLocked = (r: WaInboxRow) => !isAdmin && !isMine(r)
```

- [ ] **Step 5: Hapus `canReassign` (digantikan `isAdmin` + Lepaskan)**

Hapus baris 335 seluruhnya:

```ts
  const canReassign = user?.role === 'admin' || user?.role === 'superadmin'
```

- [ ] **Step 6: Beri `markProses` penanganan error**

Mutasi ini kini bisa gagal 409. Tanpa `onError`, kegagalan tertelan diam-diam sementara popup tetap terbuka — petugas mengira berhasil. Ganti blok baris 301-304:

```ts
  const markProses = useMutation({
    mutationFn: (idk: number) => waApi.markProses(idk),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-inbox'] }),
    onError: (e: unknown) => toast.error(getApiErrorMessage(e, 'Gagal memproses')),
  })
```

- [ ] **Step 7: Tambah mutasi `release`**

Sisipkan tepat setelah blok mutasi `assign` (baris 309-318):

```ts
  // Admin melepaskan sesi macet → assigned_to NULL; petugas lain bisa mengambil alih.
  const release = useMutation({
    mutationFn: (sessionId: number) => waApi.release(sessionId),
    onSuccess: () => {
      toast.success('Sesi dilepaskan — petugas lain dapat mengambil alih')
      qc.invalidateQueries({ queryKey: ['wa-inbox'] })
    },
    onError: (e: unknown) => {
      toast.error(getApiErrorMessage(e, 'Gagal melepaskan sesi'))
    },
  })
```

- [ ] **Step 8: Keterangan wajib-klaim di header (lapis 1)**

Ganti blok judul (baris 372-375):

```tsx
        <div>
          <h1 className="admin-h1">Layanan Online</h1>
          <p className="admin-subtitle">Permintaan data via WhatsApp — antrian online PST, diperbarui otomatis</p>
        </div>
```

menjadi:

```tsx
        <div>
          <h1 className="admin-h1">Layanan Online</h1>
          <p className="admin-subtitle">Permintaan data via WhatsApp — antrian online PST, diperbarui otomatis</p>
          {canClaim && (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
               style={{ background: 'var(--admin-primary-light)', color: 'var(--admin-primary)' }}>
              <Lock className="w-3.5 h-3.5 shrink-0" />
              Ambil alih permintaan dulu sebelum bisa memproses atau membalas chat.
            </p>
          )}
        </div>
```

- [ ] **Step 9: Ganti blok Ambil alih / chip / Lepaskan**

Ganti blok baris 439-454 seluruhnya:

```tsx
                {r.assigned_to == null ? (
                  canClaim ? (
                    <Button size="sm" variant="outline" className="shrink-0"
                      disabled={assign.isPending || r.session_id == null}
                      title="Ambil alih sesi ini agar bisa memproses & membalas chat"
                      onClick={() => { if (r.session_id != null) assign.mutate(r.session_id) }}>
                      <Hand className="w-3.5 h-3.5 mr-1" /> Ambil alih
                    </Button>
                  ) : (
                    <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                      Belum ditangani
                    </span>
                  )
                ) : (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700"
                    title={`Ditangani oleh ${r.operator_nama ?? '-'}`}>
                    <UserCheck className="w-3.5 h-3.5" /> {r.operator_nama ?? 'Ditangani'}
                  </span>
                )}
                {isAdmin && r.assigned_to != null && r.session_id != null && (
                  <Button size="sm" variant="outline" className="shrink-0"
                    disabled={release.isPending}
                    title="Lepaskan sesi ini agar petugas lain bisa mengambil alih"
                    onClick={() => {
                      if (r.session_id != null && window.confirm(`Lepaskan sesi ini dari ${r.operator_nama ?? 'petugas'}?\n\nPetugas lain akan bisa mengambil alih.`)) release.mutate(r.session_id)
                    }}>
                    <Unlock className="w-3.5 h-3.5 mr-1" /> Lepaskan
                  </Button>
                )}
```

- [ ] **Step 10: Kunci tombol Proses (lapis 2 — tooltip)**

Ganti blok baris 455-459:

```tsx
                {!pending && (
                  <Button size="sm" variant="outline" className="shrink-0"
                    disabled={isLocked(r)}
                    title={isLocked(r) ? 'Ambil alih sesi ini dulu untuk memproses' : 'Proses permintaan'}
                    onClick={() => openProses(r.id_kunjungan as number)}>
                    <ExternalLink className="w-3.5 h-3.5 mr-1" /> Proses
                  </Button>
                )}
```

- [ ] **Step 11: Kunci tombol Selesai (D5)**

Ganti blok baris 460-467:

```tsx
                {!pending && r.status === 'evaluasi_selesai' && (
                  <Button size="sm" className="shrink-0"
                    disabled={selesai.isPending || isLocked(r)}
                    title={isLocked(r) ? 'Ambil alih sesi ini dulu untuk menutup' : 'Tutup sesi & kirim pesan penutup'}
                    onClick={() => { if (window.confirm('Tutup sesi ini & kirim pesan penutup ke pengguna?')) selesai.mutate(r.id_kunjungan as number) }}>
                    <CircleCheck className="w-3.5 h-3.5 mr-1" /> Selesai
                  </Button>
                )}
```

- [ ] **Step 12: Kunci tombol Form Data**

Ganti blok baris 481-488:

```tsx
                {(r.category === 'offline' || r.category === 'lainnya') && r.session_id != null && (
                  <Button size="sm" variant="outline" className="shrink-0"
                    disabled={sendDataForm.isPending || isLocked(r)}
                    title={isLocked(r) ? 'Ambil alih sesi ini dulu untuk mengirim form' : 'Alihkan ke Permintaan Data — kirim tautan form data ke pemohon'}
                    onClick={() => { if (r.session_id != null) sendDataForm.mutate(r.session_id) }}>
                    <Send className="w-3.5 h-3.5 mr-1" /> Form Data
                  </Button>
                )}
```

- [ ] **Step 13: Teruskan status kunci ke `ChatPopup` (reaktif)**

Ganti blok baris 505-507:

```tsx
      {chats.map((c, i) => (
        <ChatPopup key={c.phone} phone={c.phone} nama={c.nama} index={i} idKunjungan={c.idKunjungan} onClose={() => closeChat(c.phone)} />
      ))}
```

menjadi:

```tsx
      {/* locked/sessionId diturunkan dari `rows` (bukan disimpan di state `chats`) agar popup
          langsung membuka kunci begitu klaim berhasil, tanpa perlu ditutup-buka ulang.
          Baris tak ditemukan → anggap terkunci (fail-closed). */}
      {chats.map((c, i) => {
        const row = rows.find((r) => r.notel === c.phone)
        return (
          <ChatPopup key={c.phone} phone={c.phone} nama={c.nama} index={i} idKunjungan={c.idKunjungan}
            locked={row ? isLocked(row) : true}
            sessionId={row?.session_id ?? null}
            onClaim={() => { if (row?.session_id != null) assign.mutate(row.session_id) }}
            onClose={() => closeChat(c.phone)} />
        )
      })}
```

- [ ] **Step 14: Verifikasi lint & build**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate/frontend && npm run lint && npm run build
```
Expected: lint bersih; build `✓ built in …`.
**Catatan:** `locked`/`sessionId`/`onClaim` belum ada di `ChatPopupProps` sampai Task 5 → `tsc -b` **akan gagal** dengan `Object literal may only specify known properties`. Ini diharapkan. Selesaikan Task 5 lalu jalankan ulang perintah ini sebelum commit Task 4 & 5. **Bila mengeksekusi per-task, gabungkan commit Task 4 dan 5** (lihat Task 5 Step 6).

- [ ] **Step 15: Verifikasi diff**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
diff frontend/src/api/wa.ts.backup frontend/src/api/wa.ts
diff frontend/src/pages/admin/LayananOnlineInboxPage.tsx.backup frontend/src/pages/admin/LayananOnlineInboxPage.tsx
```
Expected: hanya perubahan di atas; `canReassign` hilang seluruhnya.

---

### Task 5: Frontend — panel 🔒 di ChatPopup (lapis 3 keterangan)

**Files:**
- Modify: `frontend/src/components/wa/ChatPopup.tsx:183-191` (props + signature)
- Modify: `frontend/src/components/wa/ChatPopup.tsx:266` dan `:280` (lewati `markSeen`)
- Modify: `frontend/src/components/wa/ChatPopup.tsx:507` dan `:597` (sembunyikan `BubbleActions`)
- Modify: `frontend/src/components/wa/ChatPopup.tsx:742-774` (komposer → panel terkunci)

**Interfaces:**
- Consumes: `locked`, `sessionId`, `onClaim` dari `LayananOnlineInboxPage` (Task 4). Ketiganya **opsional dengan default** agar pemanggil lain (jika ada) tak rusak.
- Produces: — (komponen daun)

- [ ] **Step 1: Backup**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
cp frontend/src/components/wa/ChatPopup.tsx frontend/src/components/wa/ChatPopup.tsx.backup
```

- [ ] **Step 2: Tambah props**

Ganti baris 183-191:

```ts
interface ChatPopupProps {
  phone: string
  nama: string | null
  index?: number
  onClose: () => void
  idKunjungan?: number | null  // null/absent = no visit yet; disables Kirim Data
  // #claim-gate — true = petugas ini bukan pemegang sesi → hanya boleh membaca.
  // Baca sengaja tetap terbuka (peran 'pimpinan' read-only bergantung padanya).
  locked?: boolean
  sessionId?: number | null    // untuk tombol "Ambil alih" di panel terkunci
  onClaim?: () => void         // memanggil mutasi assign milik halaman inbox
}

export function ChatPopup({ phone, nama, index = 0, onClose, idKunjungan = null, locked = false, sessionId = null, onClaim }: ChatPopupProps) {
```

- [ ] **Step 3: Lewati `markSeen` saat terkunci**

Petugas yang sekadar mengintip tak boleh menghapus badge belum-dibaca milik calon pemegang, dan pemohon tak boleh menerima centang biru dari orang yang tak menanganinya.

Baris 266 — ganti:
```ts
    waApi.markSeen(phone).catch(() => { /* best-effort */ }) // buka chat → tandai dibaca (centang biru visitor)
```
menjadi:
```ts
    if (!locked) waApi.markSeen(phone).catch(() => { /* best-effort */ }) // buka chat → tandai dibaca (centang biru visitor)
```

Baris 280 — ganti:
```ts
    if (atBottomRef.current && last.direction === 'in') waApi.markSeen(phone).catch(() => { /* best-effort */ })
```
menjadi:
```ts
    if (!locked && atBottomRef.current && last.direction === 'in') waApi.markSeen(phone).catch(() => { /* best-effort */ })
```

**Penting:** tambahkan `locked` ke array dependensi kedua `useEffect` tersebut bila `react-hooks/exhaustive-deps` mengeluh saat lint.

- [ ] **Step 4: Sembunyikan aksi per-bubble saat terkunci**

`BubbleActions` memberi balas + reaksi; keduanya aksi tulis. Backend sudah menolaknya, tapi tombol yang selalu gagal adalah UI yang bohong.

Baris 506 (pesan keluar) — ganti:
```tsx
                        {out && (
```
menjadi:
```tsx
                        {out && !locked && (
```

Baris 595 (pesan masuk) — ganti:
```tsx
                        {!out && (
```
menjadi:
```tsx
                        {!out && !locked && (
```

Verifikasi keduanya tergarap:
```bash
grep -n "out && !locked" frontend/src/components/wa/ChatPopup.tsx
```
Expected: 2 baris (506 dan 595).

- [ ] **Step 5: Ganti komposer dengan panel terkunci**

Ganti blok baris 742-774 (`{/* ── Composer ── */}` sampai `</div>` penutupnya) menjadi:

```tsx
            {/* ── Composer ── #claim-gate: hanya pemegang sesi (atau admin) yang boleh mengirim.
                 Riwayat di atas tetap terbaca penuh — baca sengaja terbuka. */}
            {locked ? (
              <div className="px-3 py-3 border-t flex flex-col items-center gap-2 text-center"
                   style={{ borderColor: 'var(--admin-border)', background: '#faf7f2' }}>
                <p className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--admin-text-secondary)' }}>
                  <Lock className="w-3.5 h-3.5 shrink-0" />
                  Ambil alih dulu untuk bisa chat dengan pemohon ini
                </p>
                {onClaim && sessionId != null && (
                  <button
                    onClick={onClaim}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-transform active:scale-95"
                    style={{ background: 'var(--admin-primary)' }}
                  >
                    <Hand className="w-3.5 h-3.5" /> Ambil alih
                  </button>
                )}
              </div>
            ) : (
            <div className="flex items-end gap-1.5 px-2.5 py-2 border-t" style={{ borderColor: 'var(--admin-border)', background: '#fff' }}>
              <button
                onClick={() => { if (kirimDataOpen) { setKirimDataOpen(false); resetKdForm() } else setKirimDataOpen(true) }}
                disabled={!idKunjungan}
                aria-label="Kirim Data"
                title={idKunjungan ? 'Kirim data via jalur terverifikasi' : 'Pemohon belum mengisi formulir'}
                className="p-2 rounded-full shrink-0 transition-colors hover:bg-[var(--admin-primary-light)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: kirimDataOpen ? 'var(--admin-primary)' : 'var(--admin-text-secondary)' }}
              >
                <Database className="w-5 h-5" />
              </button>
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText() } }}
                placeholder="Ketik pesan…"
                className="flex-1 resize-none px-3 py-2 text-sm rounded-2xl outline-none leading-snug"
                style={{ background: '#f3eee6', color: 'var(--admin-text)', maxHeight: 120 }}
              />
              <button
                onClick={submitText}
                disabled={busy || text.trim() === ''}
                aria-label="Kirim"
                className="p-2.5 rounded-full shrink-0 text-white transition-transform active:scale-90 disabled:opacity-40 disabled:active:scale-100"
                style={{ background: 'var(--admin-primary)' }}
                title="Kirim"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            )}
```

Tombol pembuka "Kirim Data" ikut hilang saat terkunci (ia hidup di dalam komposer), sehingga panel pengiriman data terverifikasi tak bisa dibuka petugas non-pemegang.

- [ ] **Step 6: Tambah ikon `Lock` & `Hand` ke impor `lucide-react`**

Ganti blok impor di `ChatPopup.tsx:6-9`:

```ts
import {
  Send, Database, X, Minus, FileText, Clock, Check, CheckCheck,
  AlertCircle, MessageCircle, Download, ChevronDown, Reply, SmilePlus, MapPin, User,
} from 'lucide-react'
```

menjadi:

```ts
import {
  Send, Database, X, Minus, FileText, Clock, Check, CheckCheck,
  AlertCircle, MessageCircle, Download, ChevronDown, Reply, SmilePlus, MapPin, User,
  Lock, Hand,
} from 'lucide-react'
```

- [ ] **Step 7: Verifikasi lint & build (kini Task 4 + 5 lengkap)**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate/frontend && npm run lint && npm run build
```
Expected: lint bersih; build `✓ built in …`. Bila `tsc` mengeluh soal `locked`/`sessionId`/`onClaim`, props di Step 2 belum benar.

- [ ] **Step 8: Verifikasi diff**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
diff frontend/src/components/wa/ChatPopup.tsx.backup frontend/src/components/wa/ChatPopup.tsx
```

- [ ] **Step 9: Commit (Task 4 + 5 bersama — build hanya hijau bila keduanya ada)**

```bash
git add frontend/src/api/wa.ts frontend/src/pages/admin/LayananOnlineInboxPage.tsx frontend/src/components/wa/ChatPopup.tsx
git commit -m "feat(wa): UI gerbang wajib-klaim — tombol terkunci, panel chat, Lepaskan

Proses/Selesai/Form Data nonaktif sampai petugas memegang sesi; komposer chat
diganti panel 'Ambil alih dulu untuk bisa chat' (riwayat tetap terbaca);
keterangan di header untuk petugas. Ambil alih disembunyikan dari admin,
diganti tombol Lepaskan. markSeen & aksi bubble dilewati saat terkunci.
markProses kini memunculkan toast saat gagal (dulu tertelan diam-diam)."
```

---

### Task 6: Migrasi backfill

**Files:**
- Create: `docs/migrations/2026-07-17-wa-claim-gate-backfill.sql`

**Interfaces:**
- Consumes: tabel `wa_sessions` (`assigned_to`, `assigned_at` — sudah ada sejak `2026-06-11-wa-takeover-manual-close.sql`), `tamdes_kunjungan.status`.
- Produces: berkas SQL yang **dijalankan di Task 7**, bukan sekarang.

- [ ] **Step 1: Tulis berkas migrasi**

```sql
-- 2026-07-17 — Gerbang wajib-klaim Layanan Online (WA)
-- Spec: docs/superpowers/specs/2026-07-17-wa-claim-gate-design.md
--
-- Tanpa perubahan skema: assigned_to/assigned_at sudah ada sejak
-- 2026-06-11-wa-takeover-manual-close.sql. Ini murni backfill data.
--
-- Sesi yang penanganannya SUDAH berjalan tapi belum punya pemilik tercatat
-- dialihkan ke Irma (admin_users.id = 3) — penangan dominan (6 dari 7 klaim
-- yang ada per 2026-07-17). Tanpa backfill, sesi-sesi ini akan terkunci dari
-- semua petugas begitu gerbang menyala.
--
-- TANPA pemberitahuan ke responden: pesan "sedang ditangani oleh" hanya
-- disisipkan session_assign() ke wa_outbox, dan tak ada trigger apa pun pada
-- wa_sessions (diverifikasi via SHOW TRIGGERS LIKE 'wa_%', 2026-07-17) — jadi
-- UPDATE langsung ini dijamin senyap.
--
-- Sesi berstatus 'antri'/'dipanggil' sengaja DIBIARKAN NULL: penanganannya
-- belum dimulai, jadi petugas harus mengklaimnya sendiri seperti sesi baru.
--
-- Dampak terukur saat perencanaan (2026-07-17): 1 baris — sesi #636,
-- WA-990645, status 'diproses', a.n. Sariyani Basir.
--
-- assigned_at = NOW() mencatat kapan backfill dijalankan, bukan kapan
-- penanganan sebenarnya dimulai (tak ada sumber data untuk itu). Kolom ini
-- hanya catatan; tak ada logika yang membacanya.

-- Pratinjau — jalankan dulu, harus cocok dengan angka di atas:
-- SELECT s.id, s.id_kunjungan, k.status
--   FROM wa_sessions s JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
--  WHERE s.assigned_to IS NULL AND k.status NOT IN ('antri', 'dipanggil');

UPDATE wa_sessions s
  JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
   SET s.assigned_to = 3,
       s.assigned_at = NOW()
 WHERE s.assigned_to IS NULL
   AND k.status NOT IN ('antri', 'dipanggil');

-- Rollback (bila perlu): kembalikan HANYA baris yang backfill ini sentuh.
-- Ganti '<waktu_backfill>' dengan assigned_at hasil UPDATE di atas.
-- UPDATE wa_sessions SET assigned_to = NULL, assigned_at = NULL
--  WHERE assigned_to = 3 AND assigned_at = '<waktu_backfill>';
```

- [ ] **Step 2: Verifikasi berkas terbaca & tak mengandung DDL**

```bash
cd /root/bukutamu-worktrees/wa-claim-gate
grep -icE "drop|alter|truncate|delete" docs/migrations/2026-07-17-wa-claim-gate-backfill.sql
```
Expected: `0` — migrasi ini hanya `UPDATE`.

- [ ] **Step 3: Commit**

```bash
git add docs/migrations/2026-07-17-wa-claim-gate-backfill.sql
git commit -m "chore(db): migrasi backfill assigned_to sesi berjalan ke Irma

Sesi yang penanganannya sudah berjalan tapi assigned_to NULL dialihkan ke Irma
(id 3) agar tak terkunci saat gerbang wajib-klaim menyala. Sesi antri/dipanggil
dibiarkan NULL. Senyap: tak ada trigger di wa_sessions, pesan 'ditangani' hanya
lahir dari session_assign()."
```

---

### Task 7: Deploy ke produksi (WAJIB konfirmasi pengguna dulu)

**Files:**
- Modify: `/var/www/html/bukutamu` (merge `feat/wa-claim-gate` → `main`)
- Runs: `docs/migrations/2026-07-17-wa-claim-gate-backfill.sql`

**Interfaces:**
- Consumes: branch `feat/wa-claim-gate` (Task 2-6), semua verifikasi hijau.
- Produces: fitur tayang di `bukutamu.bpsmalut.com`.

> **GERBANG:** task ini mengubah **produksi dan data produksi**. Sesuai `CLAUDE.md`
> dan skill `deploy`, **tanya pengguna dulu** dan tunggu persetujuan eksplisit.
> Jangan jalankan satu langkah pun tanpa itu.

**Urutan sengaja dipilih.** Backfill **dulu**, backend **kemudian**: di bawah kode lama, mengisi `assigned_to` hanya mengunci sesi #636 ke Irma — yang memang keadaan akhir yang diinginkan. Sebaliknya, bila backend menyala lebih dulu, sesi #636 sesaat terkunci dari semua orang termasuk Irma.

Jendela antara backend (Task 7 Step 4, tayang ±2 dtk) dan frontend (Step 5, ±1 mnt) **anggun**: SPA lama menampilkan tombol aktif, tapi backend membalas 409 dengan pesan *"Ambil alih sesi ini dulu…"* yang muncul sebagai toast, dan tombol "Ambil alih" sudah ada di UI lama. Petugas terarah, bukan tersesat.

- [ ] **Step 1: Backup database (wajib sebelum menyentuh data)**

```bash
mysqldump db_tamdes wa_sessions > /root/backup-wa_sessions-$(date +%F-%H%M).sql
ls -la /root/backup-wa_sessions-*.sql | tail -1
```
Expected: berkas > 0 byte. Sebagai `root`, `mysql`/`mysqldump` terautentikasi lewat unix socket — tanpa flag kredensial (terverifikasi 2026-07-17: `mysql db_tamdes -e "SELECT COUNT(*) FROM wa_sessions"` → `14`).

- [ ] **Step 2: Pratinjau baris yang akan tersentuh**

Jalankan blok `SELECT` yang dikomentari di berkas migrasi.
Expected: **1 baris** — sesi `636`, kunjungan `990645`, status `diproses`. **Bila jumlahnya berbeda jauh, berhenti dan laporkan ke pengguna** sebelum melanjutkan.

- [ ] **Step 3: Jalankan backfill**

```bash
mysql db_tamdes < /root/bukutamu-worktrees/wa-claim-gate/docs/migrations/2026-07-17-wa-claim-gate-backfill.sql
```
Verifikasi:
```sql
SELECT id, id_kunjungan, assigned_to, assigned_at FROM wa_sessions WHERE id = 636;
```
Expected: `assigned_to = 3`, `assigned_at` = waktu sekarang.
Lalu pastikan senyap:
```sql
SELECT COUNT(*) FROM wa_outbox WHERE msg_type = 'ditangani' AND created_at > (NOW() - INTERVAL 5 MINUTE);
```
Expected: `0`.

- [ ] **Step 4: Merge ke main (backend tayang ±2 detik setelah ini)**

```bash
cd /var/www/html/bukutamu
git merge --no-ff feat/wa-claim-gate -m "merge: gerbang wajib-klaim Layanan Online (WA)"
git log --oneline -1
```
Smoke backend segera:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://bukutamu.bpsmalut.com:460/api/auth/check
```
Expected: `401` (tanpa auth). **Apa pun 5xx → rollback segera** (`git reset --hard ORIG_HEAD`; PHP kembali dalam ±2 dtk).

- [ ] **Step 5: Build & sajikan frontend**

```bash
cd /var/www/html/bukutamu/frontend && npm run build
pm2 restart bukutamu-frontend && pm2 status bukutamu-frontend
```
Expected: build `✓ built in …`; PM2 `online`.

- [ ] **Step 6: Smoke manual di browser** — jalankan daftar verifikasi §8 spec

Buka `https://bukutamu.bpsmalut.com/admin/layanan-online`:
1. Login `petugas_pst` (mis. `wisnu`) → sesi belum diklaim: Proses/Selesai/Form Data nonaktif; keterangan tampil di header.
2. Buka chat sesi belum diklaim → riwayat terbaca, komposer diganti panel 🔒 + tombol Ambil alih.
3. Klik "Ambil alih" → tombol hidup, komposer muncul **tanpa perlu tutup-buka popup**, pemohon menerima "sedang ditangani oleh Wisnu".
4. Login petugas lain → kirim chat ke sesi itu ditolak, toast "Sesi ini sedang ditangani operator lain."
5. Login `admin` → tombol "Ambil alih" **tidak** ada di baris mana pun; "Lepaskan" muncul pada sesi yang dipegang; Proses & chat tetap jalan tanpa klaim.
6. Klik "Lepaskan" → chip hilang, "Ambil alih" muncul lagi bagi petugas.
7. Sesi #636 tampil "Ditangani Irma"; login `irma` → Proses & chat langsung hidup tanpa klaim ulang.

- [ ] **Step 7: Bersihkan worktree**

```bash
cd /var/www/html/bukutamu
git worktree remove /root/bukutamu-worktrees/wa-claim-gate
git worktree list
```

- [ ] **Step 8: Push**

```bash
cd /var/www/html/bukutamu && git push origin main
```
Catatan: commit spec `3b0d07a` ikut terdorong (belum pernah di-push).

---

## Catatan risiko yang dibawa dari spec

- **Admin bertindak tanpa jejak pemilik** (D3, pilihan pengguna): admin memproses sesi tak-diklaim → `assigned_to` tetap NULL → inbox tetap tampak "belum ditangani" dan pemohon tak menerima "sedang ditangani oleh". Diterima: persis perilaku hari ini.
- **`POST /api/wa/seen` sengaja tak dipagari backend** (spec §10). Frontend melewatinya saat terkunci; pemanggilan langsung via curl masih mungkin, dampak sebatas centang biru.
- **Celah test otomatis.** `.claude/rules/testing.md` meminta agar hal ini diangkat: perubahan ini adalah **gerbang otorisasi**, jenis kode yang paling pantas punya test regresi, di sistem produksi tanpa staging. Spec §10 sengaja menaruhnya di luar cakupan. **Tawarkan ke pengguna** setelah deploy: menulis test PHP pertama repo ini (mis. `wa_require_session_owner` dengan `current_user` palsu) sebagai pekerjaan terpisah.
