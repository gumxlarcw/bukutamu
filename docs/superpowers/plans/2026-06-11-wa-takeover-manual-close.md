# WA Take-over + Manual Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the WhatsApp "Layanan Online" channel, stop auto-closing visits when a visitor submits their evaluation (which spawns a duplicate intake form on the next message), and add operator ownership ("Ambil alih") with a requester-facing notification.

**Architecture:** WA eval submit parks the visit in a new `evaluasi_selesai` status (still "active", so no new form is minted); an operator closes it manually (or a 3h safety auto-close fires). Operator ownership lives on `wa_sessions.assigned_to` (one row per request, pending or submitted); a claim is atomic and locked to the first operator (admin override only). All requester messages go through the existing `wa_outbox`.

**Tech Stack:** CodeIgniter 3 (PHP, JSON API), MySQL `db_tamdes` (hand-managed schema), React 19 + TypeScript + Vite, `@tanstack/react-query`, `sonner` toasts, `lucide-react`.

**Spec:** `docs/superpowers/specs/2026-06-11-wa-takeover-manual-close-design.md`

---

## ⚠️ Repo conventions every task must follow

- **No automated test suite.** "Testing" = `npm run lint` + `npm run build` (frontend), reading the diff end-to-end + targeted `curl`/`mysql` (backend). Do NOT invent `npm test`/PHPUnit. (See `.claude/rules/testing.md`.)
- **Mandatory per-file edit ritual** (global `~/.claude/CLAUDE.md`): before the FIRST edit of any existing file, `cp {file} {file}.backup`; after editing, `diff {file}.backup {file}`. `*.backup` is git-ignored.
- **Commits:** NO `Co-Authored-By: Claude` trailer (project rule). Commit only the source files (not `*.backup`).
- **FE↔BE parity:** backend + frontend land in the same effort (this plan).
- **Backend deploy:** PHP has no build; reload with `sudo apachectl -k graceful`. Frontend: `npm run build` then `pm2 restart bukutamu-frontend`. (Deploy is the final task; don't reload after every backend task.)

---

## File map

| File | Change |
| --- | --- |
| `docs/migrations/2026-06-11-wa-takeover-manual-close.sql` | **Create** — ENUM + `wa_sessions` cols + Irma backfill |
| `backend/.../controllers/Evaluations.php` | **Modify** — WA eval → `evaluasi_selesai`; accept re-submit |
| `backend/.../controllers/Wa.php` | **Modify** — `visit_selesai`, `session_assign`, helpers, 3h auto-close, inbox payload |
| `backend/application/config/routes.php` | **Modify** — 2 new routes (ordering matters) |
| `frontend/src/types/visit.ts` | **Modify** — add `evaluasi_selesai` to `VisitStatus` |
| `frontend/src/components/shared/StatusBadge.tsx` | **Modify** — badge for `evaluasi_selesai` |
| `frontend/src/types/wa.ts` | **Modify** — `WaInboxRow` gains `assigned_to`, `operator_nama` |
| `frontend/src/api/wa.ts` | **Modify** — `assign`, `markSelesai` |
| `frontend/src/pages/admin/LayananOnlineInboxPage.tsx` | **Modify** — Ambil alih / Ditangani chip / Selesai button / card |

---

## Task 1: Database migration (schema + Irma backfill)

**Files:**
- Create: `docs/migrations/2026-06-11-wa-takeover-manual-close.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 2026-06-11 — WA Layanan Online: manual completion + operator take-over.
-- Apply with: mysql db_tamdes < docs/migrations/2026-06-11-wa-takeover-manual-close.sql
-- (root creds in /root/.my.cnf; DB name db_tamdes — do NOT rename.)

-- 1. New intermediate status: evaluation filled by the WA visitor, awaiting
--    operator close. ENUM change → ALTER required (project rule).
ALTER TABLE tamdes_kunjungan MODIFY status
  ENUM('antri','dipanggil','proses','diproses','selesai','menunggu_evaluasi','evaluasi_selesai')
  NOT NULL DEFAULT 'antri';

-- 2. Operator claim on the session (single source of truth for pending + visit).
ALTER TABLE wa_sessions
  ADD COLUMN assigned_to INT NULL AFTER id_kunjungan,
  ADD COLUMN assigned_at DATETIME NULL AFTER assigned_to;

-- 3. Backfill ALL existing sessions (running AND selesai) to Irma (admin_users.id=3).
--    SILENT: pure DB assignment, enqueues NOTHING — no requester is notified.
UPDATE wa_sessions SET assigned_to = 3, assigned_at = NOW()
WHERE assigned_to IS NULL;
```

- [ ] **Step 2: Confirm Irma's id is 3 (do NOT hard-code blindly)**

Run: `mysql -e "SELECT id, username, nama, role FROM admin_users WHERE username='irma';" db_tamdes`
Expected: one row, `id = 3`. If it differs, edit the `3` in the migration to match before applying.

- [ ] **Step 3: Apply the migration**

Run: `mysql db_tamdes < docs/migrations/2026-06-11-wa-takeover-manual-close.sql`
Expected: no errors.

- [ ] **Step 4: Verify schema + backfill**

```bash
mysql -e "SHOW COLUMNS FROM tamdes_kunjungan LIKE 'status';" db_tamdes
mysql -e "SHOW COLUMNS FROM wa_sessions LIKE 'assigned_%';" db_tamdes
mysql -e "SELECT assigned_to, COUNT(*) c FROM wa_sessions GROUP BY assigned_to;" db_tamdes
```
Expected: status ENUM now includes `evaluasi_selesai`; `assigned_to` + `assigned_at` exist; every existing `wa_sessions` row has `assigned_to = 3` (none NULL).

- [ ] **Step 5: Commit**

```bash
git add docs/migrations/2026-06-11-wa-takeover-manual-close.sql
git commit -m "feat(wa): migration — evaluasi_selesai status + session operator claim + backfill to Irma"
```

---

## Task 2: WA eval submit → `evaluasi_selesai` (not `selesai`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Evaluations.php` (the `detail()` POST branch, ~lines 159-222)

- [ ] **Step 1: Backup**

Run: `cp backend/application/modules/api/controllers/Evaluations.php backend/application/modules/api/controllers/Evaluations.php.backup`

- [ ] **Step 2: Accept `evaluasi_selesai` in the re-submit gate**

Find (~line 163):
```php
            if (!in_array($visit->status, ['menunggu_evaluasi', 'selesai'], true)) {
```
Replace with:
```php
            if (!in_array($visit->status, ['menunggu_evaluasi', 'selesai', 'evaluasi_selesai'], true)) {
```

- [ ] **Step 3: Apply the re-submit cooldown to `evaluasi_selesai` too**

Find (~line 175):
```php
            if ($visit->status === 'selesai' && $visit->selesai_timestamp) {
```
Replace with:
```php
            if (in_array($visit->status, ['selesai', 'evaluasi_selesai'], true) && $visit->selesai_timestamp) {
```

- [ ] **Step 4: Branch the final status on channel (WA vs kiosk)**

Find (~lines 211-217):
```php
            // Update kunjungan: rating, status, selesai_timestamp, durasi_detik
            $selesai_timestamp = date('Y-m-d H:i:s');
            $update = [
                'rating_pengunjung'  => $skor_keseluruhan,
                'status'             => 'selesai',
                'selesai_timestamp'  => $selesai_timestamp,
            ];
```
Replace with:
```php
            // Update kunjungan: rating, status, selesai_timestamp, durasi_detik.
            // WA channel: park in 'evaluasi_selesai' (operator closes manually; keeps the
            // session "active" so post-eval chatter never mints a new intake form).
            // Kiosk/tablet SKD: unchanged — straight to 'selesai'.
            $is_wa = ($visit->created_by === 'whatsapp');
            $selesai_timestamp = date('Y-m-d H:i:s');
            $update = [
                'rating_pengunjung'  => $skor_keseluruhan,
                'status'             => $is_wa ? 'evaluasi_selesai' : 'selesai',
                'selesai_timestamp'  => $selesai_timestamp,
            ];
```

(`selesai_timestamp` + `durasi_detik` are still stamped here for WA — they mark
"evaluation completed at" and feed the 3h auto-close + duration. The manual close
in Task 3 only flips the status.)

- [ ] **Step 5: Verify diff**

Run: `diff backend/application/modules/api/controllers/Evaluations.php.backup backend/application/modules/api/controllers/Evaluations.php`
Expected: exactly the three hunks above; kiosk path still `'selesai'`.

- [ ] **Step 6: Commit**

```bash
git add backend/application/modules/api/controllers/Evaluations.php
git commit -m "fix(wa): eval submit parks WA visit in evaluasi_selesai (not selesai) — kills duplicate-form bug; kiosk unchanged"
```

---

## Task 3: Manual close endpoint + closing-message helper + route

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (add `visit_selesai()` + 2 private helpers)
- Modify: `backend/application/config/routes.php`

- [ ] **Step 1: Backup both files**

```bash
cp backend/application/modules/api/controllers/Wa.php backend/application/modules/api/controllers/Wa.php.backup
cp backend/application/config/routes.php backend/application/config/routes.php.backup
```

- [ ] **Step 2: Add the manual-close endpoint**

In `Wa.php`, immediately AFTER the `visit_proses($id)` method (it ends at `}` ~line 450, just before the `/* ── admin (Layanan Online inbox) ── */` comment), insert:

```php
    // POST /api/wa/visits/(:num)/selesai — operator menutup sesi WA secara manual
    // (evaluasi_selesai → selesai) + kirim pesan penutup. (auth + PST role)
    public function visit_selesai($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $id = (int) $id;
        $v = $this->db->select('status, created_by')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$v || $v->created_by !== 'whatsapp') $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        if ($v->status === 'selesai') {
            $this->json_response(['success' => true, 'data' => ['status' => 'selesai'], 'message' => 'Sudah selesai']);
        }
        if ($v->status !== 'evaluasi_selesai') {
            $this->json_response(['success' => false, 'message' => 'Belum bisa diselesaikan — evaluasi belum diisi pengunjung.'], 409);
        }
        $this->db->where('id_kunjungan', $id)->update('tamdes_kunjungan', ['status' => 'selesai']);
        $this->wa_closing_enqueue($id);
        $this->audit('wa_close', 'visit', $id, ['from' => 'evaluasi_selesai', 'to' => 'selesai']);
        $this->json_response(['success' => true, 'data' => ['status' => 'selesai'], 'message' => 'Sesi ditutup & pesan penutup dikirim']);
    }
```

- [ ] **Step 3: Add the closing-message helper**

In `Wa.php`, in the private-helpers area (e.g. right after `wa_notify_group_enqueue()` which ends ~line 886), insert:

```php
    // Pesan penutup formal saat sesi WA ditutup (manual operator ATAU auto 3 jam).
    // Ledger-dedup by msg_type='closing' → tak pernah ganda walau dipanggil dua jalur.
    private function wa_closing_enqueue($id_kunjungan) {
        $idk = (int) $id_kunjungan;
        $dup = $this->db->where('id_kunjungan', $idk)->where('msg_type', 'closing')->count_all_results('wa_outbox');
        if ($dup > 0) return;
        $info = $this->db->query(
            "SELECT b.notel,
                    (SELECT s.wa_chat_id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS wa_chat_id
             FROM tamdes_kunjungan k JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.id_kunjungan = ?", [$idk]
        )->row();
        if (!$info) return;
        $body = "Terima kasih telah menggunakan layanan data BPS Provinsi Maluku Utara. "
              . "Permintaan Anda telah selesai kami proses. Semoga data yang kami sampaikan bermanfaat. "
              . "Salam hangat, semoga hari Anda menyenangkan 🙂";
        $this->db->insert('wa_outbox', [
            'phone_raw' => $info->notel, 'wa_chat_id' => ($info->wa_chat_id ?: $info->notel),
            'msg_type'  => 'closing', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending',
        ]);
    }
```

- [ ] **Step 4: Register the route (ordering matters)**

In `routes.php`, find:
```php
$route['api/wa/visits/(:num)/proses'] = 'api/wa/visit_proses/$1'; // POST mark visit 'diproses' (auth+PST)
```
Add immediately AFTER it:
```php
$route['api/wa/visits/(:num)/selesai'] = 'api/wa/visit_selesai/$1'; // POST manual close (evaluasi_selesai → selesai)
```

- [ ] **Step 5: PHP lint both files**

```bash
php -l backend/application/modules/api/controllers/Wa.php
php -l backend/application/config/routes.php
```
Expected: `No syntax errors detected` for both.

- [ ] **Step 6: Verify diffs**

```bash
diff backend/application/modules/api/controllers/Wa.php.backup backend/application/modules/api/controllers/Wa.php
diff backend/application/config/routes.php.backup backend/application/config/routes.php
```
Expected: the `visit_selesai` method, the `wa_closing_enqueue` helper, and the one route line.

- [ ] **Step 7: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/config/routes.php
git commit -m "feat(wa): manual close endpoint (evaluasi_selesai → selesai) + formal closing message"
```

---

## Task 4: 3-hour safety auto-close in `wa_dispatch_scan`

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`wa_dispatch_scan()`, after step 4 ~line 803)

- [ ] **Step 1: Backup**

Run: `cp backend/application/modules/api/controllers/Wa.php backend/application/modules/api/controllers/Wa.php.backup`

- [ ] **Step 2: Add step 5 to `wa_dispatch_scan()`**

Find the end of step 4 (the `foreach ($stale as $v) { ... }` loop that closes ~line 803), and the method-closing `}` right after it. Insert this BEFORE that closing `}`:

```php

        // 5. Auto-close WA visits stuck in evaluasi_selesai (eval already filled) > 3 jam → selesai.
        //    Pengaman bila operator lupa klik "Selesai". selesai_timestamp dicap saat evaluasi
        //    disubmit (= waktu evaluasi selesai), jadi itulah acuan jeda 3 jam-nya.
        $stale_done = $this->db->query(
            "SELECT k.id_kunjungan FROM tamdes_kunjungan k
             WHERE k.created_by = 'whatsapp' AND k.status = 'evaluasi_selesai'
               AND k.selesai_timestamp IS NOT NULL AND k.selesai_timestamp < ?",
            [date('Y-m-d H:i:s', time() - 3 * 3600)]
        )->result();
        foreach ($stale_done as $v) {
            $idk = (int) $v->id_kunjungan;
            $this->db->where('id_kunjungan', $idk)->update('tamdes_kunjungan', ['status' => 'selesai']);
            $this->wa_closing_enqueue($idk);
            $this->audit_system('auto_close_wa_done', 'visit', $idk, ['from' => 'evaluasi_selesai', 'to' => 'selesai']);
        }
```

- [ ] **Step 3: PHP lint**

Run: `php -l backend/application/modules/api/controllers/Wa.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Verify diff**

Run: `diff backend/application/modules/api/controllers/Wa.php.backup backend/application/modules/api/controllers/Wa.php`
Expected: only the step-5 block added inside `wa_dispatch_scan`.

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): 3h safety auto-close for evaluated-but-unclosed WA sessions"
```

---

## Task 5: Take-over (assign) endpoint + operator-name helpers + inbox payload + route

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`session_assign()`, 2 helpers, `inbox()`)
- Modify: `backend/application/config/routes.php`

- [ ] **Step 1: Backup both files**

```bash
cp backend/application/modules/api/controllers/Wa.php backend/application/modules/api/controllers/Wa.php.backup
cp backend/application/config/routes.php backend/application/config/routes.php.backup
```

- [ ] **Step 2: Add the assign endpoint**

In `Wa.php`, insert AFTER the `visit_selesai($id)` method added in Task 3:

```php
    // POST /api/wa/sessions/(:num)/assign — operator "Ambil alih" sebuah sesi (pending atau visit).
    // Klaim ATOMIK (anti-TOCTOU): hanya yang pertama menang. Terkunci ke operator pertama;
    // hanya admin/superadmin yang boleh memindahkan (override). (auth + PST role)
    public function session_assign($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $sid  = (int) $id;
        $uid  = (int) ($this->current_user->id ?? 0);
        $role = $this->current_user->role ?? '';
        if ($uid <= 0) $this->json_response(['success' => false, 'message' => 'Akun ini tidak dapat mengambil alih sesi (gunakan akun operator).'], 403);
        $sess = $this->db->get_where('wa_sessions', ['id' => $sid])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        $now = date('Y-m-d H:i:s');
        // Klaim atomik untuk sesi yang belum dipegang siapa pun.
        $this->db->where('id', $sid)->where('assigned_to', null)
                 ->update('wa_sessions', ['assigned_to' => $uid, 'assigned_at' => $now]);
        $claimed = ($this->db->affected_rows() === 1);

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

        // Pesan "sedang ditangani" — HANYA dari aksi interaktif ini, tak pernah dari backfill.
        if ($sess->wa_chat_id) {
            $nama = $this->wa_operator_name($uid);
            $body = "Permintaan Anda sedang ditangani oleh *{$nama}*. Mohon menunggu, kami akan segera memproses permintaan Anda.";
            $this->db->insert('wa_outbox', [
                'phone_raw' => $sess->phone_raw, 'wa_chat_id' => $sess->wa_chat_id,
                'msg_type'  => 'ditangani', 'body' => $body,
                'id_kunjungan' => ($sess->id_kunjungan ?: null), 'status' => 'pending',
            ]);
        }
        $this->audit('wa_assign', 'wa_session', $sid, ['assigned_to' => $uid]);
        $this->json_response(['success' => true, 'data' => ['assigned_to' => $uid, 'operator_nama' => $this->wa_operator_name($uid)], 'message' => 'Anda mengambil alih sesi ini']);
    }
```

- [ ] **Step 3: Add the operator-name helpers**

In `Wa.php`, insert next to `wa_known_name()` (~line 878):

```php
    // Buang anotasi peran dalam kurung dari nama operator untuk tampilan/pesan ke pengguna:
    // "Irma (Petugas PST)" → "Irma". Nama tanpa kurung tetap utuh.
    private function wa_strip_role_annot($nama) {
        $n = trim(preg_replace('/\s*\(.*\)\s*$/u', '', (string) $nama));
        return $n !== '' ? $n : 'Petugas';
    }
    // Nama operator (admin_users.nama, dibersihkan) untuk uid tertentu.
    private function wa_operator_name($uid) {
        $u = $this->db->select('nama')->get_where('admin_users', ['id' => (int) $uid])->row();
        return $u ? $this->wa_strip_role_annot($u->nama) : 'Petugas';
    }
```

- [ ] **Step 4: Add operator + session_id to the inbox VISIT query**

In `inbox()`, find the visit query (~lines 468-476):
```php
        $visits = $this->db
            ->select('k.id_kunjungan, k.status, k.date_visit AS dt, b.nama, b.nama_instansi, b.notel')
            ->select("(SELECT GROUP_CONCAT(kp.rincian_data SEPARATOR ' · ') FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan) AS permintaan", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(200)
            ->get()->result();
```
Replace with:
```php
        $visits = $this->db
            ->select('k.id_kunjungan, k.status, k.date_visit AS dt, b.nama, b.nama_instansi, b.notel')
            ->select("(SELECT GROUP_CONCAT(kp.rincian_data SEPARATOR ' · ') FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan) AS permintaan", FALSE)
            ->select("(SELECT s.id FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS session_id", FALSE)
            ->select("(SELECT s.assigned_to FROM wa_sessions s WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS assigned_to", FALSE)
            ->select("(SELECT au.nama FROM wa_sessions s JOIN admin_users au ON au.id = s.assigned_to WHERE s.id_kunjungan = k.id_kunjungan ORDER BY s.id DESC LIMIT 1) AS operator_nama", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(200)
            ->get()->result();
```

- [ ] **Step 5: Emit the new fields in the VISIT item**

Find the visit item array (~lines 480-490):
```php
            $items[] = [
                'kind'          => 'visit',
                'id_kunjungan'  => (int) $v->id_kunjungan,
                'session_id'    => null,
                'status'        => $v->status,
                'date'          => $v->dt,
                'nama'          => $v->nama,
                'nama_instansi' => $v->nama_instansi,
                'notel'         => $v->notel,
                'permintaan'    => $v->permintaan,
            ];
```
Replace with:
```php
            $items[] = [
                'kind'          => 'visit',
                'id_kunjungan'  => (int) $v->id_kunjungan,
                'session_id'    => ($v->session_id !== null ? (int) $v->session_id : null),
                'status'        => $v->status,
                'date'          => $v->dt,
                'nama'          => $v->nama,
                'nama_instansi' => $v->nama_instansi,
                'notel'         => $v->notel,
                'permintaan'    => $v->permintaan,
                'assigned_to'   => ($v->assigned_to !== null ? (int) $v->assigned_to : null),
                'operator_nama' => ($v->operator_nama ? $this->wa_strip_role_annot($v->operator_nama) : null),
            ];
```

- [ ] **Step 6: Add operator fields to the PENDING query + item**

Find the pending query (~lines 494-496):
```php
        $pend = $this->db->select('id, phone_norm, last_inbound_at, link_sent_at, created_at')
                         ->where('state', 'awaiting_form')
                         ->order_by('id', 'DESC')->limit(100)->get('wa_sessions')->result();
```
Replace with:
```php
        $pend = $this->db->select('s.id, s.phone_norm, s.last_inbound_at, s.link_sent_at, s.created_at, s.assigned_to, au.nama AS operator_nama')
                         ->from('wa_sessions s')
                         ->join('admin_users au', 'au.id = s.assigned_to', 'left')
                         ->where('s.state', 'awaiting_form')
                         ->order_by('s.id', 'DESC')->limit(100)->get()->result();
```
Then find the pending item array (~lines 497-509):
```php
            $items[] = [
                'kind'          => 'pending',
                'id_kunjungan'  => null,
                'session_id'    => (int) $s->id,
                'status'        => 'menunggu_form',
                'date'          => $s->last_inbound_at ?: ($s->link_sent_at ?: $s->created_at),
                'nama'          => $this->wa_known_name($s->phone_norm),
                'nama_instansi' => null,
                'notel'         => $s->phone_norm,
                'permintaan'    => null,
            ];
```
Replace with:
```php
            $items[] = [
                'kind'          => 'pending',
                'id_kunjungan'  => null,
                'session_id'    => (int) $s->id,
                'status'        => 'menunggu_form',
                'date'          => $s->last_inbound_at ?: ($s->link_sent_at ?: $s->created_at),
                'nama'          => $this->wa_known_name($s->phone_norm),
                'nama_instansi' => null,
                'notel'         => $s->phone_norm,
                'permintaan'    => null,
                'assigned_to'   => ($s->assigned_to !== null ? (int) $s->assigned_to : null),
                'operator_nama' => ($s->operator_nama ? $this->wa_strip_role_annot($s->operator_nama) : null),
            ];
```

- [ ] **Step 7: Register the assign route BEFORE the generic sessions route**

In `routes.php`, find:
```php
$route['api/wa/sessions/(:num)'] = 'api/wa/session_delete/$1'; // DELETE pending session (admin only)
```
Insert immediately BEFORE it (more-specific path must win in CI3's ordered matching):
```php
$route['api/wa/sessions/(:num)/assign'] = 'api/wa/session_assign/$1'; // POST take-over (auth+PST)
```

- [ ] **Step 8: PHP lint + diffs**

```bash
php -l backend/application/modules/api/controllers/Wa.php
php -l backend/application/config/routes.php
diff backend/application/modules/api/controllers/Wa.php.backup backend/application/modules/api/controllers/Wa.php
diff backend/application/config/routes.php.backup backend/application/config/routes.php
```
Expected: no syntax errors; diffs show the assign method, 2 helpers, the inbox query/item edits, and the one route line.

- [ ] **Step 9: Smoke test (after a graceful reload) — inbox carries the new fields**

```bash
sudo apachectl -k graceful
# Unauth probe just confirms routing/JSON, not data:
curl -sS -o /dev/null -w "inbox http=%{http_code}\n" https://bukutamu.bpsmalut.com:460/api/wa/inbox
```
Expected: `inbox http=401` (auth required) — NOT 404/500. (Full payload check happens in the FE smoke test, Task 9.)

- [ ] **Step 10: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/config/routes.php
git commit -m "feat(wa): take-over (Ambil alih) — atomic operator claim, 'sedang ditangani' notice, inbox operator fields"
```

---

## Task 6: Frontend types + StatusBadge

**Files:**
- Modify: `frontend/src/types/visit.ts`
- Modify: `frontend/src/components/shared/StatusBadge.tsx`
- Modify: `frontend/src/types/wa.ts`

- [ ] **Step 1: Backup**

```bash
cp frontend/src/types/visit.ts frontend/src/types/visit.ts.backup
cp frontend/src/components/shared/StatusBadge.tsx frontend/src/components/shared/StatusBadge.tsx.backup
cp frontend/src/types/wa.ts frontend/src/types/wa.ts.backup
```

- [ ] **Step 2: Extend `VisitStatus`**

In `frontend/src/types/visit.ts` line 1, replace:
```ts
export type VisitStatus = 'antri' | 'dipanggil' | 'proses' | 'diproses' | 'menunggu_evaluasi' | 'selesai'
```
with:
```ts
export type VisitStatus = 'antri' | 'dipanggil' | 'proses' | 'diproses' | 'menunggu_evaluasi' | 'evaluasi_selesai' | 'selesai'
```

- [ ] **Step 3: Add the badge config**

In `StatusBadge.tsx`, find:
```ts
  menunggu_evaluasi: { label: 'Menunggu Evaluasi', className: 'bg-amber-500 text-white' },
  selesai:           { label: 'Selesai',             className: 'bg-green-500 text-white' },
```
Replace with:
```ts
  menunggu_evaluasi: { label: 'Menunggu Evaluasi', className: 'bg-amber-500 text-white' },
  evaluasi_selesai:  { label: 'Evaluasi Selesai',  className: 'bg-teal-500 text-white' },
  selesai:           { label: 'Selesai',             className: 'bg-green-500 text-white' },
```

- [ ] **Step 4: Extend `WaInboxRow`**

In `frontend/src/types/wa.ts`, find the `WaInboxRow` interface and replace its body:
```ts
export interface WaInboxRow {
  kind: 'pending' | 'visit'
  id_kunjungan: number | null   // null untuk pending (belum jadi visit)
  session_id: number | null     // diisi untuk pending
  status: string                // 'menunggu_form' untuk pending; status visit lainnya
  date: string
  nama: string | null
  nama_instansi: string | null
  notel: string | null
  permintaan: string | null
}
```
with:
```ts
export interface WaInboxRow {
  kind: 'pending' | 'visit'
  id_kunjungan: number | null   // null untuk pending (belum jadi visit)
  session_id: number | null     // diisi untuk pending DAN visit (untuk Ambil alih)
  status: string                // 'menunggu_form' untuk pending; status visit lainnya
  date: string
  nama: string | null
  nama_instansi: string | null
  notel: string | null
  permintaan: string | null
  assigned_to: number | null    // admin_users.id operator pemegang sesi (null = belum diambil)
  operator_nama: string | null  // nama operator (sudah dibersihkan), untuk chip "Ditangani"
}
```

- [ ] **Step 5: Lint + verify diffs**

```bash
cd frontend && npm run lint && cd ..
diff frontend/src/types/visit.ts.backup frontend/src/types/visit.ts
diff frontend/src/components/shared/StatusBadge.tsx.backup frontend/src/components/shared/StatusBadge.tsx
diff frontend/src/types/wa.ts.backup frontend/src/types/wa.ts
```
Expected: lint clean; the three edits present. (`StatusBadge`'s `Record<VisitStatus, …>` now type-checks because Task 2's status was added to `VisitStatus`.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/visit.ts frontend/src/components/shared/StatusBadge.tsx frontend/src/types/wa.ts
git commit -m "feat(wa): FE types + StatusBadge for evaluasi_selesai; WaInboxRow operator fields"
```

---

## Task 7: Frontend API wrappers

**Files:**
- Modify: `frontend/src/api/wa.ts`

- [ ] **Step 1: Backup**

Run: `cp frontend/src/api/wa.ts frontend/src/api/wa.ts.backup`

- [ ] **Step 2: Add `assign` + `markSelesai`**

In `frontend/src/api/wa.ts`, find the `markProses` wrapper (the last entry, ~lines 49-51):
```ts
  // Tandai visit 'diproses' saat petugas membuka popup Proses (antri/dipanggil → diproses).
  markProses: (idKunjungan: number) =>
    apiClient.post<ApiResponse<{ status: string }>>(`/api/wa/visits/${idKunjungan}/proses`),
}
```
Replace with:
```ts
  // Tandai visit 'diproses' saat petugas membuka popup Proses (antri/dipanggil → diproses).
  markProses: (idKunjungan: number) =>
    apiClient.post<ApiResponse<{ status: string }>>(`/api/wa/visits/${idKunjungan}/proses`),

  // Ambil alih sesi (klaim operator). Terkunci ke operator pertama; admin bisa override.
  assign: (sessionId: number) =>
    apiClient.post<ApiResponse<{ assigned_to: number; operator_nama: string }>>(`/api/wa/sessions/${sessionId}/assign`),

  // Tutup sesi WA secara manual (evaluasi_selesai → selesai) + kirim pesan penutup.
  markSelesai: (idKunjungan: number) =>
    apiClient.post<ApiResponse<{ status: string }>>(`/api/wa/visits/${idKunjungan}/selesai`),
}
```

- [ ] **Step 3: Lint + diff**

```bash
cd frontend && npm run lint && cd ..
diff frontend/src/api/wa.ts.backup frontend/src/api/wa.ts
```
Expected: lint clean; the two new wrappers added.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/wa.ts
git commit -m "feat(wa): FE api wrappers assign() + markSelesai()"
```

---

## Task 8: Inbox UI — Ambil alih / Ditangani chip / Selesai button / card

**Files:**
- Modify: `frontend/src/pages/admin/LayananOnlineInboxPage.tsx`

- [ ] **Step 1: Backup**

Run: `cp frontend/src/pages/admin/LayananOnlineInboxPage.tsx frontend/src/pages/admin/LayananOnlineInboxPage.tsx.backup`

- [ ] **Step 2: Import the two new icons**

Find the `lucide-react` import (line 15):
```ts
import { MessageSquare, MessageCircle, ExternalLink, Inbox, Clock, Hourglass, CircleCheck, Unplug, Send, Trash2, QrCode, Smartphone, Copy, Loader2, RefreshCw, ArrowRight } from 'lucide-react'
```
Replace with (adds `Hand`, `UserCheck`):
```ts
import { MessageSquare, MessageCircle, ExternalLink, Inbox, Clock, Hourglass, CircleCheck, Unplug, Send, Trash2, QrCode, Smartphone, Copy, Loader2, RefreshCw, ArrowRight, Hand, UserCheck } from 'lucide-react'
```

- [ ] **Step 3: Add assign + selesai mutations and the reassign flag**

Find the `openProses`/`closeProses` block (~lines 285-291) and, right AFTER `const closeProses = …` line, insert:
```tsx

  // Ambil alih (klaim) sebuah sesi/visit; backend kirim "sedang ditangani" ke pengguna.
  const assign = useMutation({
    mutationFn: (sessionId: number) => waApi.assign(sessionId),
    onSuccess: (res) => {
      toast.success(`Diambil alih oleh ${res.data.data?.operator_nama ?? 'Anda'}`)
      qc.invalidateQueries({ queryKey: ['wa-inbox'] })
    },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal mengambil alih')
    },
  })
  // Tutup sesi WA secara manual (muncul setelah pengunjung mengisi evaluasi).
  const selesai = useMutation({
    mutationFn: (idk: number) => waApi.markSelesai(idk),
    onSuccess: () => { toast.success('Sesi ditutup & pesan penutup dikirim'); qc.invalidateQueries({ queryKey: ['wa-inbox'] }) },
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal menutup sesi')
    },
  })
  const canReassign = user?.role === 'admin' || user?.role === 'superadmin'
```

- [ ] **Step 4: Add the "Evaluasi Selesai" count + card**

Find the `counts` object (~lines 301-307):
```tsx
  const counts = {
    form: rows.filter(r => r.kind === 'pending').length,
    baru: rows.filter(r => isVisit(r) && (r.status === 'antri' || r.status === 'dipanggil')).length,
    diproses: rows.filter(r => isVisit(r) && (r.status === 'proses' || r.status === 'diproses')).length,
    evaluasi: rows.filter(r => isVisit(r) && r.status === 'menunggu_evaluasi').length,
    selesai: rows.filter(r => isVisit(r) && r.status === 'selesai').length,
  }
```
Replace with:
```tsx
  const counts = {
    form: rows.filter(r => r.kind === 'pending').length,
    baru: rows.filter(r => isVisit(r) && (r.status === 'antri' || r.status === 'dipanggil')).length,
    diproses: rows.filter(r => isVisit(r) && (r.status === 'proses' || r.status === 'diproses')).length,
    evaluasi: rows.filter(r => isVisit(r) && r.status === 'menunggu_evaluasi').length,
    perluDitutup: rows.filter(r => isVisit(r) && r.status === 'evaluasi_selesai').length,
    selesai: rows.filter(r => isVisit(r) && r.status === 'selesai').length,
  }
```
Then find the summary grid (~lines 323-329):
```tsx
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatsCard label="Menunggu Form" value={counts.form} icon={<Send className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Baru" value={counts.baru} icon={<Inbox className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Diproses" value={counts.diproses} icon={<Clock className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Menunggu Evaluasi" value={counts.evaluasi} icon={<Hourglass className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Selesai" value={counts.selesai} icon={<CircleCheck className="w-5 h-5" />} accent="primary" />
      </div>
```
Replace with (grid → 6 cols, new card inserted before Selesai):
```tsx
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatsCard label="Menunggu Form" value={counts.form} icon={<Send className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Baru" value={counts.baru} icon={<Inbox className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Diproses" value={counts.diproses} icon={<Clock className="w-5 h-5" />} accent="primary" />
        <StatsCard label="Menunggu Evaluasi" value={counts.evaluasi} icon={<Hourglass className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Perlu Ditutup" value={counts.perluDitutup} icon={<CircleCheck className="w-5 h-5" />} accent="secondary" />
        <StatsCard label="Selesai" value={counts.selesai} icon={<CircleCheck className="w-5 h-5" />} accent="primary" />
      </div>
```

- [ ] **Step 5: Add the row actions (Ambil alih / chip + Selesai)**

Find the actions block inside the row map (~lines 378-387):
```tsx
                {!pending && (
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => openProses(r.id_kunjungan as number)}>
                    <ExternalLink className="w-3.5 h-3.5 mr-1" /> Proses
                  </Button>
                )}
                {r.notel && (
                  <Button size="sm" variant="outline" className="shrink-0" title="Buka chat WhatsApp" onClick={() => openChat(r.notel as string, r.nama)}>
                    <MessageCircle className="w-4 h-4" />
                  </Button>
                )}
```
Replace with (adds the take-over control before "Proses", and a "Selesai" button after it):
```tsx
                {r.assigned_to == null ? (
                  <Button size="sm" variant="outline" className="shrink-0"
                    disabled={assign.isPending || r.session_id == null}
                    title="Ambil alih sesi ini" onClick={() => { if (r.session_id != null) assign.mutate(r.session_id) }}>
                    <Hand className="w-3.5 h-3.5 mr-1" /> Ambil alih
                  </Button>
                ) : (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700"
                    style={canReassign ? { cursor: 'pointer' } : undefined}
                    title={canReassign ? 'Pindahkan penanganan ke Anda (admin)' : `Ditangani oleh ${r.operator_nama ?? '-'}`}
                    onClick={() => { if (canReassign && r.session_id != null && window.confirm(`Pindahkan penanganan dari ${r.operator_nama} ke Anda?`)) assign.mutate(r.session_id) }}
                  >
                    <UserCheck className="w-3.5 h-3.5" /> {r.operator_nama ?? 'Ditangani'}
                  </span>
                )}
                {!pending && (
                  <Button size="sm" variant="outline" className="shrink-0" onClick={() => openProses(r.id_kunjungan as number)}>
                    <ExternalLink className="w-3.5 h-3.5 mr-1" /> Proses
                  </Button>
                )}
                {!pending && r.status === 'evaluasi_selesai' && (
                  <Button size="sm" className="shrink-0"
                    disabled={selesai.isPending}
                    title="Tutup sesi & kirim pesan penutup"
                    onClick={() => { if (window.confirm('Tutup sesi ini & kirim pesan penutup ke pengguna?')) selesai.mutate(r.id_kunjungan as number) }}>
                    <CircleCheck className="w-3.5 h-3.5 mr-1" /> Selesai
                  </Button>
                )}
                {r.notel && (
                  <Button size="sm" variant="outline" className="shrink-0" title="Buka chat WhatsApp" onClick={() => openChat(r.notel as string, r.nama)}>
                    <MessageCircle className="w-4 h-4" />
                  </Button>
                )}
```

- [ ] **Step 6: Lint + build + diff**

```bash
cd frontend && npm run lint && npm run build && cd ..
diff frontend/src/pages/admin/LayananOnlineInboxPage.tsx.backup frontend/src/pages/admin/LayananOnlineInboxPage.tsx
```
Expected: lint clean; `tsc -b && vite build` succeeds (this is the real type-check); diff shows the import, mutations, counts/card, and row-action edits.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/admin/LayananOnlineInboxPage.tsx
git commit -m "feat(wa): inbox UI — Ambil alih / Ditangani chip / manual Selesai button + Perlu Ditutup card"
```

---

## Task 9: Deploy + full manual verification

**Files:** none (deploy + manual walk-through).

- [ ] **Step 1: Reload backend + (re)serve frontend**

```bash
sudo apachectl -k graceful
cd /var/www/html/bukutamu/frontend && npm run build && pm2 restart bukutamu-frontend && cd ..
pm2 logs bukutamu-frontend --lines 20   # confirm no startup errors
```
> NOTE: frontend deploys must bump `CACHE_NAME` in `frontend/public/sw.js` (hand-rolled service worker) or admins keep seeing pre-deploy code — see auto-memory `deploy_frontend_sw_cache_bump`. Bump it before `npm run build` if not already bumped this session.

- [ ] **Step 2: Verify the duplicate-form bug is fixed (the core ask)**

Walk one WA request end-to-end (use a test WhatsApp number):
1. Send a message → receive intake link → submit the form → WA-xxx appears in inbox.
2. Operator finishes the consultation (Proses popup) → status → `menunggu_evaluasi` → eval link sent.
3. Submit the evaluation via the WA eval link → in the inbox the row shows **"Evaluasi Selesai"** (NOT "Selesai").
4. From the test number, send "sudah saya isi kak" → **confirm NO new intake form is sent** (previously it was). ✅ bug fixed.

- [ ] **Step 3: Verify manual close**

Click **Selesai** on the `evaluasi_selesai` row → status → `Selesai`; the test number receives the formal closing message ending in 🙂. Clicking Selesai again is a no-op (idempotent).

- [ ] **Step 4: Verify 3h safety auto-close (optional, time-boxed)**

Either wait, or temporarily prove the path on one row:
```bash
# Pick an evaluasi_selesai visit id, then backdate its eval timestamp >3h:
mysql -e "UPDATE tamdes_kunjungan SET selesai_timestamp = NOW() - INTERVAL 4 HOUR WHERE id_kunjungan = <ID> AND status='evaluasi_selesai';" db_tamdes
# Wait for the connector's next poll (~30s), then:
mysql -e "SELECT status FROM tamdes_kunjungan WHERE id_kunjungan = <ID>;" db_tamdes
mysql -e "SELECT msg_type,status FROM wa_outbox WHERE id_kunjungan = <ID> AND msg_type='closing';" db_tamdes
```
Expected: status `selesai`; exactly one `closing` outbox row (deduped).

- [ ] **Step 5: Verify take-over (Ambil alih) + lock**

1. On an **unassigned** row (one not backfilled — i.e. a brand-new request after deploy), click **Ambil alih** as `irma` → toast "Diambil alih oleh Irma"; the test number receives *"…sedang ditangani oleh **Irma**…"*; row shows the **Irma** chip.
2. Log in as `nita`, click the chip's row's take-over path → **409 toast "Sudah ditangani oleh Irma"** (locked to first operator). No second WA message sent.
3. Log in as admin → click the chip (cursor pointer) → confirm reassign → moves to admin; one new "sedang ditangani" message sent.

- [ ] **Step 6: Verify backfill was silent**

```bash
# No 'ditangani' outbox row should have been created by the migration:
mysql -e "SELECT COUNT(*) ditangani_msgs FROM wa_outbox WHERE msg_type='ditangani' AND created_at < (SELECT MAX(assigned_at) FROM wa_sessions WHERE assigned_to=3);" db_tamdes
```
Expected: the only `ditangani` rows are from Step 5's interactive clicks — the backfill created none. Confirm every pre-existing session shows the **Irma** chip in the inbox.

- [ ] **Step 7: Kiosk regression (must NOT change)**

On a non-WA SKD visit, run a tablet evaluation → status must go straight to **`selesai`** (never `evaluasi_selesai`). The `evaluasi_selesai` state is WA-only.

- [ ] **Step 8: Final report**

Report: components deployed (backend Apache reload, frontend build+PM2), commit SHAs, smoke results, and explicitly what was NOT verified (e.g. real printer/kiosk hardware, the literal 3h wall-clock wait if you used the backdate shortcut).

---

## Self-review (author check against the spec)

- **Spec A (ENUM + cols + backfill):** Task 1. Backfill is `WHERE assigned_to IS NULL` (all rows) ✓, silent ✓.
- **Spec B1 (WA eval → evaluasi_selesai, kiosk unchanged):** Task 2 ✓ (gate + cooldown + status branch).
- **Spec B2 (manual close endpoint):** Task 3 ✓.
- **Spec B3 (closing message):** Task 3 `wa_closing_enqueue` ✓ (shared by B2 + B4, ledger-deduped).
- **Spec B4 (3h auto-close):** Task 4 ✓.
- **Spec C1 (atomic claim, lock-to-first, admin override):** Task 5 `session_assign` ✓.
- **Spec C2 (name strip):** Task 5 `wa_strip_role_annot`/`wa_operator_name` ✓; reused in inbox ✓.
- **Spec C3 ("sedang ditangani" message, interactive only):** Task 5 ✓ (never from backfill — Task 1 SQL touches no outbox).
- **Spec C4 (inbox payload session_id/assigned_to/operator_nama):** Task 5 Steps 4-6 ✓.
- **Spec D (FE types/badge/api/inbox UI):** Tasks 6-8 ✓.
- **Type consistency:** `session_id`, `assigned_to`, `operator_nama` names match across BE inbox payload (Task 5) ↔ `WaInboxRow` (Task 6) ↔ inbox UI (Task 8). `assign()`→`{assigned_to, operator_nama}`, `markSelesai()`→`{status}` match BE responses. `evaluasi_selesai` literal identical in migration, Evaluations.php, Wa.php, `VisitStatus`, StatusBadge, counts, row guard. ✓
- **Placeholder scan:** none — every code step has full content. ✓
