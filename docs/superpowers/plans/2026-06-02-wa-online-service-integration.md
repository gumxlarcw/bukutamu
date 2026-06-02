# WhatsApp Online Data-Request Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the WhatsApp data-service line (085176764422) into buku tamu as an online channel — a wwebjs connector sends a link, the requester fills a web form that reuses the kiosk `VisitorForm` (+ a data-request block), it becomes a `created_by='whatsapp'` visit, the petugas handles it, and SKD requests are evaluated remotely — with zero regression to offline flows.

**Architecture:** A new isolated `bukutamu-wa` PM2 connector (whatsapp-web.js) mirrors `bukutamu-notifier`: it reports inbound messages to `POST /api/wa/ingest`, and each tick calls `POST /api/wa/poll` (idempotent dispatch scan → pending outbox) then `POST /api/wa/ack`. A new CI3 `Wa.php` controller does all DB work through existing, verified Api_base helpers. Two new tables (`wa_sessions`, `wa_outbox`) hold pre-submit + outbound state. The remote eval uses a two-step token (`wa-eval-access` link → short `eval-submit` minted on demand) so `Evaluations.php` is never touched.

**Tech Stack:** CodeIgniter 3 (PHP) JSON API · MySQL `db_tamdes` (hand-managed schema) · React 19 + TS + Vite + react-query · Node 18+ (`whatsapp-web.js`, `qrcode-terminal`) · PM2.

**Source of truth:** the spec at `docs/superpowers/specs/2026-06-02-wa-online-service-integration-design.md` (read it first). Decisions D1–D9 and regression rules R1–R18 are referenced by id below.

---

## ⚠️ Conventions for every task (read once)

- **Per the global rule:** before editing ANY existing file, run `cp <file> <file>.backup`, make the change, then `diff <file>.backup <file>` to confirm. `*.backup` is git-ignored.
- **No automated tests exist** (see `.claude/rules/testing.md`). Each task's verification is **manual** (`curl` / `mysql` / browser). Do **not** invent `npm test`.
- **Commit messages:** conventional style, **no `Co-Authored-By` trailer** (project rule).
- **Backend reload:** after editing PHP, `sudo apachectl -k graceful`. **Frontend:** `cd frontend && npm run lint && npm run build`.
- **MySQL:** `/root/.my.cnf` is configured — run `mysql db_tamdes -e "..."` directly.
- **Internal secret** (for connector↔backend curl tests): `PUSH_INTERNAL_SECRET_HERE` (from `backend/application/config/push.php` → `push_internal_secret`; reused verbatim, R16).
- The backend listens on `http://127.0.0.1:60` (loopback).

---

## Phase A — Database + phone helper

### Task A1: Create the two new tables

**Files:**
- Create: `docs/migrations/2026-06-02-wa-online.sql`

- [ ] **Step 1: Write the migration SQL**

`docs/migrations/2026-06-02-wa-online.sql`:
```sql
-- WhatsApp online data-request channel: pre-submit sessions + outbound queue.
-- Schema is hand-managed (no migrations CLI). Apply with:
--   mysql db_tamdes < docs/migrations/2026-06-02-wa-online.sql

CREATE TABLE IF NOT EXISTS wa_sessions (
  id              BIGINT NOT NULL AUTO_INCREMENT,
  phone_norm      VARCHAR(20)  NOT NULL,                 -- canonical 0xxx
  phone_raw       VARCHAR(32)  NOT NULL,                 -- as seen on WA (62xxx)
  state           ENUM('awaiting_form','submitted','expired') NOT NULL DEFAULT 'awaiting_form',
  id_kunjungan    INT NULL,                              -- set on submit (not a hard FK)
  link_sent_at    DATETIME NULL,
  submitted_at    DATETIME NULL,
  last_inbound_at DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_phone_state (phone_norm, state),
  KEY idx_kunjungan (id_kunjungan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wa_outbox (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  phone_raw     VARCHAR(32) NOT NULL,
  msg_type      ENUM('intake_link','confirmation','eval_link','thankyou') NOT NULL,
  body          TEXT NOT NULL,
  id_kunjungan  INT NULL,
  status        ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at       DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_status (status, created_at),
  KEY idx_kunjungan_type (id_kunjungan, msg_type)        -- dedup ledger: <=1 eval_link/thankyou per visit
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Apply it**

Run: `mysql db_tamdes < docs/migrations/2026-06-02-wa-online.sql`
Expected: no output (success).

- [ ] **Step 3: Verify the tables exist with the right shape**

Run: `mysql db_tamdes -e "SHOW TABLES LIKE 'wa\_%'; DESCRIBE wa_sessions; DESCRIBE wa_outbox;"`
Expected: both tables listed; columns match the DDL above.

- [ ] **Step 4: Commit**
```bash
git add docs/migrations/2026-06-02-wa-online.sql
git commit -m "feat(wa): add wa_sessions + wa_outbox tables"
```

### Task A2: Add `normalize_phone()` to Api_base

**Files:**
- Modify: `backend/application/modules/api/controllers/Api_base.php` (insert after `require_internal_secret()`, which ends at line 564)

- [ ] **Step 1: Back up** — `cp backend/application/modules/api/controllers/Api_base.php backend/application/modules/api/controllers/Api_base.php.backup`

- [ ] **Step 2: Insert the helper** immediately after the closing `}` of `require_internal_secret()` (line 564), before the class-closing brace:
```php
    /**
     * Canonicalize an Indonesian phone number to local 0xxx form.
     * Handles +62xxx / 62xxx / 0062xxx / 08xxx / 8xxx / WA "62xxx@c.us".
     * Lookup-only — NOT enforced as a DB constraint (notel has known dupes).
     */
    protected function normalize_phone($raw) {
        $d = preg_replace('/\D/', '', (string) $raw); // strip @c.us, +, spaces, dashes
        $d = ltrim($d, '0');                          // drop leading 0 / 00
        if (strpos($d, '62') === 0) $d = substr($d, 2); // drop country code
        if ($d === '') return '';
        return '0' . $d;
    }
```

- [ ] **Step 3: Reload + sanity-check it parses**

Run: `sudo apachectl -k graceful && php -l backend/application/modules/api/controllers/Api_base.php`
Expected: `No syntax errors detected`.

- [ ] **Step 4: Verify the normalization logic** with a throwaway PHP one-liner:

Run:
```bash
php -r '$f=function($raw){$d=preg_replace("/\D/","",(string)$raw);$d=ltrim($d,"0");if(strpos($d,"62")===0)$d=substr($d,2);return $d===""?"":"0".$d;}; foreach(["6281234","+62 812-34","081234","81234","081234@c.us","6281234567890"] as $x) echo "$x => ".$f($x)."\n";'
```
Expected: every input maps to `0812...` form (e.g. `6281234 => 081234`, `081234@c.us => 081234`).

- [ ] **Step 5: Commit**
```bash
git add backend/application/modules/api/controllers/Api_base.php
git commit -m "feat(wa): add normalize_phone helper to Api_base"
```

---

## Phase B — Regression-prevention edits (R1, R2, R3, R12)

> These make the system **channel-aware** before any WA data exists. After each edit: `cp` backup, edit, `diff`, `sudo apachectl -k graceful`. Group verification is at the end of the phase.

### Task B1: Queue_stats — add the WhatsApp source bucket (R1)

**Files:** Modify `backend/application/modules/api/controllers/Queue_stats.php:93-99`

- [ ] **Step 1: Back up**, then replace this exact block:
```php
		$sources_map = ['Kiosk' => 0, 'Manual (Admin)' => 0, 'Lainnya' => 0];
		foreach ($source_rows as $r) {
			$cb = (string) $r->created_by;
			if ($cb === 'kiosk')                 $sources_map['Kiosk']           += (int) $r->jumlah;
			elseif (strpos($cb, 'admin:') === 0) $sources_map['Manual (Admin)'] += (int) $r->jumlah;
			else                                  $sources_map['Lainnya']        += (int) $r->jumlah;
		}
```
with:
```php
		$sources_map = ['Kiosk' => 0, 'Manual (Admin)' => 0, 'WhatsApp' => 0, 'Lainnya' => 0];
		foreach ($source_rows as $r) {
			$cb = (string) $r->created_by;
			if ($cb === 'kiosk')                 $sources_map['Kiosk']           += (int) $r->jumlah;
			elseif ($cb === 'whatsapp')          $sources_map['WhatsApp']        += (int) $r->jumlah;
			elseif (strpos($cb, 'admin:') === 0) $sources_map['Manual (Admin)'] += (int) $r->jumlah;
			else                                  $sources_map['Lainnya']        += (int) $r->jumlah;
		}
```

- [ ] **Step 2: `diff` the backup, `php -l`, reload.**

### Task B2: Consultations::index — exclude WA from the PST queue (R2 ①)

**Files:** Modify `backend/application/modules/api/controllers/Consultations.php` (the `index()` query, ~line 40)

- [ ] **Step 1: Back up**, then add a `->where(...)` line immediately **after** `->group_end()` and **before** `->order_by('k.date_visit', 'DESC')`:
```php
			->group_end()
			->where('k.created_by <>', 'whatsapp')   // WA visits live in Layanan Online inbox, not the PST queue
			->order_by('k.date_visit', 'DESC')
```

- [ ] **Step 2: `diff`, `php -l`, reload.**

### Task B3: Notifications::pst_queue_active — exclude WA from the bell count (R2 ②)

**Files:** Modify `backend/application/modules/api/controllers/Notifications.php` (the `pst_queue_active()` query, ~line 184)

- [ ] **Step 1: Back up**, then add a `->where(...)` line immediately **after** `->where_in('status', ['antri', 'dipanggil', 'proses'])` and **before** `->group_start()`:
```php
			->where_in('status', ['antri', 'dipanggil', 'proses'])
			->where('created_by <>', 'whatsapp')   // WA visits are not in the physical antrian
			->group_start()
```

- [ ] **Step 2: `diff`, `php -l`, reload.**

### Task B4: Dashboard::stats — exclude WA from the antri KPI (R2 ③)

**Files:** Modify `backend/application/modules/api/controllers/Dashboard.php:51`

- [ ] **Step 1: Back up**, then replace:
```php
		$this->db->where($where)->where('status', 'antri');
		$antri = $this->db->count_all_results('tamdes_kunjungan');
```
with (WA `selesai`/total intentionally still counted — they are real services; only the physical-queue KPI excludes WA, per spec §14 Q1):
```php
		$this->db->where($where)->where('status', 'antri')->where('created_by <>', 'whatsapp');
		$antri = $this->db->count_all_results('tamdes_kunjungan');
```

- [ ] **Step 2: `diff`, `php -l`, reload.**

### Task B5: Evaluations — keep WA off the kiosk eval tablet (R2 ④⑤)

**Files:** Modify `backend/application/modules/api/controllers/Evaluations.php` — `pending()` (two spots) and `pending_list()`

- [ ] **Step 1: Back up.**

- [ ] **Step 2:** In `pending()`, the `?id=` targeted branch, add `created_by` to the eligibility check. Replace:
```php
			if ($visit && $visit->status === 'menunggu_evaluasi' && $this->layanan_requires_skd_form($visit->jenis_layanan)) {
```
with:
```php
			if ($visit && $visit->created_by !== 'whatsapp' && $visit->status === 'menunggu_evaluasi' && $this->layanan_requires_skd_form($visit->jenis_layanan)) {
```

- [ ] **Step 3:** In `pending()`, the FIFO candidates query, replace:
```php
		$candidates = $this->db
			->order_by('id_kunjungan', 'ASC')
			->get_where('tamdes_kunjungan', ['status' => 'menunggu_evaluasi'])
			->result();
```
with:
```php
		$candidates = $this->db
			->where('created_by <>', 'whatsapp')   // WA evals are remote-only, never on the kiosk tablet
			->order_by('id_kunjungan', 'ASC')
			->get_where('tamdes_kunjungan', ['status' => 'menunggu_evaluasi'])
			->result();
```

- [ ] **Step 4:** In `pending_list()`, replace:
```php
			->where('k.status', 'menunggu_evaluasi')
			->order_by('k.id_kunjungan', 'ASC')
```
with:
```php
			->where('k.status', 'menunggu_evaluasi')
			->where('k.created_by <>', 'whatsapp')   // WA evals are remote-only
			->order_by('k.id_kunjungan', 'ASC')
```

- [ ] **Step 5: `diff`, `php -l`, reload.**

### Task B6: Visits::detail DELETE — cascade to wa tables (R3)

**Files:** Modify `backend/application/modules/api/controllers/Visits.php` (DELETE branch, ~line 159)

- [ ] **Step 1: Back up**, then insert two delete lines between the `tamdes_evaluasi_detail` delete and the `tamdes_kunjungan` delete:
```php
			$this->db->where('id_kunjungan', $id)->delete('tamdes_evaluasi_detail');
			$this->db->where('id_kunjungan', $id)->delete('wa_sessions');
			$this->db->where('id_kunjungan', $id)->delete('wa_outbox');
			$this->db->where('id_kunjungan', $id)->delete('tamdes_kunjungan');
```

- [ ] **Step 2: `diff`, `php -l`, reload.**

### Task B7: Guests::index — searchable by phone (R12)

**Files:** Modify `backend/application/modules/api/controllers/Guests.php` (the `index()` GET branch has **two** identical search blocks — update both)

- [ ] **Step 1: Back up**, then in **both** `group_start() … group_end()` search blocks add `->or_like('notel', $search)` after the `nama_instansi` line:
```php
				$this->db->group_start()
						 ->like('nama', $search)
						 ->or_like('email', $search)
						 ->or_like('nama_instansi', $search)
						 ->or_like('notel', $search)
						 ->group_end();
```

- [ ] **Step 2: `diff`, `php -l`, reload.**

### Task B8: Phase-B group verification (insert a fake WA visit, prove exclusion, clean up)

- [ ] **Step 1: Insert a throwaway WA visit in `menunggu_evaluasi` + `antri`** (reuse any existing guest id_user):
```bash
mysql db_tamdes -e "SET @u := (SELECT id_user FROM tamdes_buku LIMIT 1);
INSERT INTO tamdes_kunjungan (id_user,jenis_layanan,sarana,date_visit,status,nomor_antrian,created_by)
VALUES (@u,'[\"Konsultasi Statistik\"]','[2]',NOW(),'menunggu_evaluasi',NULL,'whatsapp'),
       (@u,'[\"Konsultasi Statistik\"]','[2]',NOW(),'antri',NULL,'whatsapp');
SELECT id_kunjungan,status FROM tamdes_kunjungan WHERE created_by='whatsapp';"
```

- [ ] **Step 2: Confirm the kiosk eval tablet does NOT see the WA visit:**

Run: `curl -s http://127.0.0.1:60/api/evaluations/pending-list`
Expected: the WA `id_kunjungan` from Step 1 is **absent** from `data`.

- [ ] **Step 3: Confirm Queue_stats has a WhatsApp bucket** (authenticated endpoint — easiest to eyeball via the admin UI `/admin/queue-stats`, or note that the `sources` array now contains `{"source":"WhatsApp",...}` when WA rows exist). Manual check.

- [ ] **Step 4: Clean up the throwaway rows:**
```bash
mysql db_tamdes -e "DELETE FROM tamdes_kunjungan WHERE created_by='whatsapp';"
```

- [ ] **Step 5: Confirm offline flows unchanged** — load `/admin/consultations` (PST queue) and the bell; the SKD walk-in queue still renders normally.

- [ ] **Step 6: Commit the whole phase**
```bash
git add backend/application/modules/api/controllers/Queue_stats.php \
        backend/application/modules/api/controllers/Consultations.php \
        backend/application/modules/api/controllers/Notifications.php \
        backend/application/modules/api/controllers/Dashboard.php \
        backend/application/modules/api/controllers/Evaluations.php \
        backend/application/modules/api/controllers/Visits.php \
        backend/application/modules/api/controllers/Guests.php
git commit -m "fix(wa): make queues/stats/eval channel-aware (exclude created_by=whatsapp)"
```

---

## Phase C — WA backend module (`Wa.php`) + routes + config

### Task C1: Add the `wa_public_base` config knob

**Files:** Modify `backend/application/config/push.php` (git-ignored operator file)

- [ ] **Step 1:** Append one line (set to the trusted SPA origin, spec §14 Q3):
```php
$config['wa_public_base'] = 'https://bukutamu.bpsmalut.com';
```

- [ ] **Step 2: Verify it loads:** `mysql`/curl not applicable — just `php -l` is N/A for config; confirm via the controller test in C4.

### Task C2: Register the routes

**Files:** Modify `backend/application/config/routes.php` (append after the kiosk block, line 84)

- [ ] **Step 1: Back up**, then append:
```php

// WhatsApp online data-request channel (api/wa/*)
$route['api/wa/ingest']          = 'api/wa/ingest';        // POST internal-secret
$route['api/wa/poll']            = 'api/wa/poll';          // POST internal-secret (dispatch scan + pending)
$route['api/wa/ack']             = 'api/wa/ack';           // POST internal-secret
$route['api/wa/inbox']           = 'api/wa/inbox';         // GET  admin (Layanan Online list)
$route['api/wa/session/(:num)']  = 'api/wa/session/$1';    // GET prefill / POST submit (kiosk-token wa-intake)
$route['api/wa/eval/(:num)']     = 'api/wa/eval_access/$1';// GET  exchange wa-eval-access -> eval-submit
```
> Note: the controller method is `eval_access` (PHP forbids a method literally named `eval`).

- [ ] **Step 2: `diff`, reload.**

### Task C3: Create the `Wa.php` controller

**Files:** Create `backend/application/modules/api/controllers/Wa.php`

- [ ] **Step 1: Write the controller** (every DB write goes through verified Api_base helpers; client never sets `status`/`created_by`/`jenis_layanan`/`sarana` — R8):
```php
<?php
defined('BASEPATH') OR exit('No direct script access allowed');

require_once APPPATH . 'modules/api/controllers/Api_base.php';

class Wa extends Api_base {

    /* ───────────────────────── internal-secret (connector ↔ backend) ───────────────────────── */

    // POST /api/wa/ingest  { phone, text }
    public function ingest() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $input     = $this->get_json_input();
        $phone_raw = trim((string) ($input['phone'] ?? ''));
        if ($phone_raw === '') $this->json_response(['success' => false, 'message' => 'phone diperlukan'], 400);
        $phone_norm = $this->normalize_phone($phone_raw);

        // Open (awaiting_form) session already? → continuation, no new link.
        $open = $this->db->where('phone_norm', $phone_norm)->where('state', 'awaiting_form')
                         ->order_by('id', 'DESC')->limit(1)->get('wa_sessions')->row();
        if ($open) {
            $this->db->where('id', $open->id)->update('wa_sessions', ['last_inbound_at' => date('Y-m-d H:i:s')]);
            $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
        }

        // New session → mint link token (48h) → enqueue intake_link.
        $this->db->insert('wa_sessions', [
            'phone_norm'      => $phone_norm,
            'phone_raw'       => $phone_raw,
            'state'           => 'awaiting_form',
            'last_inbound_at' => date('Y-m-d H:i:s'),
        ]);
        $sid   = (int) $this->db->insert_id();
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $this->db->where('id', $sid)->update('wa_sessions', ['link_sent_at' => date('Y-m-d H:i:s')]);

        $body = "Halo #SahabatData, terima kasih telah menghubungi BPS Provinsi Maluku Utara.\n"
              . "Silakan lengkapi permintaan data Anda melalui tautan berikut (berlaku 48 jam):\n" . $link;
        $this->db->insert('wa_outbox', ['phone_raw' => $phone_raw, 'msg_type' => 'intake_link', 'body' => $body, 'status' => 'pending']);

        $this->json_response(['success' => true, 'data' => ['session_id' => $sid, 'new' => true], 'message' => 'OK']);
    }

    // POST /api/wa/poll  → idempotent dispatch scan, then return pending outbox
    public function poll() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $this->wa_dispatch_scan();

        $pending = $this->db->where('status', 'pending')->order_by('id', 'ASC')->limit(50)->get('wa_outbox')->result();
        $messages = array_map(function ($m) {
            return ['id' => (int) $m->id, 'phone' => $m->phone_raw, 'body' => $m->body];
        }, $pending);
        $this->json_response(['success' => true, 'data' => ['messages' => $messages], 'message' => 'OK']);
    }

    // POST /api/wa/ack  { ids:[...] }
    public function ack() {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_internal_secret();

        $input = $this->get_json_input();
        $ids   = (isset($input['ids']) && is_array($input['ids'])) ? array_map('intval', $input['ids']) : [];
        if ($ids) $this->db->where_in('id', $ids)->update('wa_outbox', ['status' => 'sent', 'sent_at' => date('Y-m-d H:i:s')]);
        $this->json_response(['success' => true, 'data' => ['acked' => count($ids)], 'message' => 'OK']);
    }

    /* ───────────────────────── admin (Layanan Online inbox) ───────────────────────── */

    // GET /api/wa/inbox  — WA visits with guest + request summary
    public function inbox() {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();

        $rows = $this->db
            ->select('k.id_kunjungan, k.status, k.date_visit, k.selesai_timestamp, b.nama, b.nama_instansi, b.notel')
            ->select("(SELECT COUNT(*) FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan AND kp.rincian_data IS NOT NULL AND TRIM(kp.rincian_data) <> '') AS has_konsultasi", FALSE)
            ->select("(SELECT GROUP_CONCAT(kp.rincian_data SEPARATOR ' · ') FROM konsultasi_pengunjung kp WHERE kp.id_kunjungan = k.id_kunjungan) AS permintaan", FALSE)
            ->from('tamdes_kunjungan k')
            ->join('tamdes_buku b', 'k.id_user = b.id_user', 'left')
            ->where('k.created_by', 'whatsapp')
            ->order_by('k.id_kunjungan', 'DESC')
            ->limit(200)
            ->get()->result();

        $this->json_response(['success' => true, 'data' => $rows, 'message' => 'OK']);
    }

    /* ───────────────────────── public, kiosk-token guarded (requester browser) ───────────────────────── */

    // GET prefill / POST submit : /api/wa/session/(:num)
    public function session($id) {
        $id = (int) $id;
        $this->require_kiosk_token('wa-intake', $id);

        $sess = $this->db->get_where('wa_sessions', ['id' => $id])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        if ($_SERVER['REQUEST_METHOD'] === 'GET') {
            $matches = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->get('tamdes_buku')->result();
            $guest = null; $multi = false;
            if (count($matches) === 1)      { $guest = $matches[0]; }
            elseif (count($matches) > 1)    { $guest = $matches[0]; $multi = true; } // R5: most-recent + flag
            $this->json_response(['success' => true, 'data' => [
                'session_id'  => $id,
                'phone'       => $sess->phone_norm,
                'state'       => $sess->state,
                'guest'       => $guest,
                'multi_match' => $multi,
            ], 'message' => 'OK']);
        }

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $this->require_rate_limit('wa/intake', 30);

            // Idempotent: already submitted → return existing ticket.
            if ($sess->state === 'submitted' && $sess->id_kunjungan) {
                $this->json_response(['success' => true, 'data' => ['id_kunjungan' => (int) $sess->id_kunjungan, 'ticket' => 'WA-' . $sess->id_kunjungan], 'message' => 'Sudah dikirim']);
            }

            $input = $this->get_json_input();

            // SERVER-AUTHORITATIVE — never trust client for these (R8, D2/D3/D5).
            $jenis_layanan = ['Konsultasi Statistik'];
            $sarana        = [2];
            $this->validate_no_cross_layanan($jenis_layanan);
            $this->validate_sarana_for_layanan($jenis_layanan, $sarana);

            // Guest upsert by phone (LOCK pattern from Kiosk::register).
            $this->db->query('LOCK TABLES tamdes_buku WRITE, tamdes_kunjungan WRITE, tamdes_responden_tahunan WRITE');
            $existing = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->limit(1)->get('tamdes_buku')->row();
            if ($existing) {
                $id_user = (int) $existing->id_user;
                $patch   = $this->wa_profile_patch($existing, $input); // progressive profiling: fill empties only
                if ($patch) $this->db->where('id_user', $id_user)->update('tamdes_buku', $patch);
            } else {
                $max     = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
                $id_user = $max ? $max + 1 : 8200001;
                $this->db->insert('tamdes_buku', $this->wa_guest_data($id_user, $sess->phone_norm, $input));
                if ($this->db->affected_rows() < 1) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal menyimpan data tamu'], 500); }
            }

            $this->db->insert('tamdes_kunjungan', [
                'id_user'       => $id_user,
                'jenis_layanan' => json_encode($jenis_layanan),
                'sarana'        => json_encode($sarana),
                'date_visit'    => date('Y-m-d H:i:s'),
                'status'        => 'antri',
                'nomor_antrian' => null,
                'created_by'    => 'whatsapp',
            ]);
            $id_kunjungan = (int) $this->db->insert_id();
            if (!$id_kunjungan) { $this->db->query('UNLOCK TABLES'); $this->json_response(['success' => false, 'message' => 'Gagal membuat kunjungan'], 500); }
            $this->db->query('UNLOCK TABLES');

            // Permintaan Data rows (Block B) → konsultasi_pengunjung (D4).
            $rows = (isset($input['permintaan']) && is_array($input['permintaan'])) ? $input['permintaan'] : [];
            $inserted = 0;
            foreach ($rows as $r) {
                $rincian = trim((string) ($r['rincian_data'] ?? ''));
                if ($rincian === '') continue;
                $this->db->insert('konsultasi_pengunjung', [
                    'id_kunjungan' => $id_kunjungan,
                    'rincian_data' => $rincian,
                    'wilayah_data' => (isset($r['wilayah_data']) && $r['wilayah_data'] !== '') ? $r['wilayah_data'] : null,
                    'tahun_awal'   => !empty($r['tahun_awal'])   ? (int) $r['tahun_awal']   : null,
                    'tahun_akhir'  => !empty($r['tahun_akhir'])  ? (int) $r['tahun_akhir']  : null,
                    'level_data'   => !empty($r['level_data'])   ? (int) $r['level_data']   : null,
                    'periode_data' => !empty($r['periode_data']) ? (int) $r['periode_data'] : null,
                    'status_data'  => 4, // Belum Diperoleh (petugas fills outcome later)
                ]);
                $inserted++;
            }

            $this->db->where('id', $id)->update('wa_sessions', ['state' => 'submitted', 'id_kunjungan' => $id_kunjungan, 'submitted_at' => date('Y-m-d H:i:s')]);
            $this->audit_system('create_wa', 'visit', $id_kunjungan, ['id_user' => $id_user, 'konsultasi_rows' => $inserted]);

            $body = "Terima kasih, permintaan data Anda telah kami terima.\nNomor tiket: WA-{$id_kunjungan}.\n"
                  . "Akan kami proses pada jam operasional layanan (Senin–Jumat 08.00–15.30 WIT).";
            $this->db->insert('wa_outbox', ['phone_raw' => $sess->phone_raw, 'msg_type' => 'confirmation', 'body' => $body, 'id_kunjungan' => $id_kunjungan, 'status' => 'pending']);

            $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id_kunjungan, 'ticket' => 'WA-' . $id_kunjungan], 'message' => 'Permintaan terkirim']);
        }

        $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
    }

    // GET /api/wa/eval/(:num) → exchange a durable wa-eval-access token for a short eval-submit token (D6)
    public function eval_access($id) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $id = (int) $id;
        $this->require_kiosk_token('wa-eval-access', $id);

        $visit = $this->db->get_where('tamdes_kunjungan', ['id_kunjungan' => $id])->row();
        if (!$visit || $visit->created_by !== 'whatsapp') $this->json_response(['success' => false, 'message' => 'Kunjungan tidak ditemukan'], 404);
        if ($visit->status !== 'menunggu_evaluasi') $this->json_response(['success' => false, 'message' => 'Evaluasi sudah selesai atau ditutup'], 409);

        $eval_token = $this->mint_kiosk_token('eval-submit', $id, 600); // short; used against UNCHANGED /api/evaluations/{id}
        $this->json_response(['success' => true, 'data' => ['id_kunjungan' => $id, 'kiosk_token' => $eval_token], 'message' => 'OK']);
    }

    /* ───────────────────────── private helpers ───────────────────────── */

    private function wa_dispatch_scan() {
        $now = date('Y-m-d H:i:s');

        // 1. Expire stale sessions (>48h awaiting_form).
        $this->db->where('state', 'awaiting_form')
                 ->where('created_at <', date('Y-m-d H:i:s', time() - 48 * 3600))
                 ->update('wa_sessions', ['state' => 'expired']);

        // 2. Enqueue eval_link for WA SKD visits newly menunggu_evaluasi (ledger-dedup).
        $need_eval = $this->db->query(
            "SELECT k.id_kunjungan, b.notel FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')"
        )->result();
        foreach ($need_eval as $v) {
            $idk = (int) $v->id_kunjungan;
            $tok = $this->mint_kiosk_token('wa-eval-access', $idk, 7 * 24 * 3600);
            $link = $this->wa_public_base() . '/evaluasi/' . $idk . '?t=' . rawurlencode($tok);
            $body = "Terima kasih telah menggunakan layanan kami. Mohon kesediaan Anda mengisi evaluasi singkat (berlaku 7 hari):\n" . $link;
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'msg_type' => 'eval_link', 'body' => $body, 'id_kunjungan' => $idk, 'status' => 'pending']);
        }

        // 3. Enqueue thankyou for WA visits selesai with no eval_link and no thankyou (non-SKD path).
        $need_ty = $this->db->query(
            "SELECT k.id_kunjungan, b.notel FROM tamdes_kunjungan k
             JOIN tamdes_buku b ON b.id_user = k.id_user
             WHERE k.created_by = 'whatsapp' AND k.status = 'selesai'
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link')
               AND NOT EXISTS (SELECT 1 FROM wa_outbox o WHERE o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'thankyou')"
        )->result();
        foreach ($need_ty as $v) {
            $body = "Terima kasih telah menghubungi BPS Provinsi Maluku Utara. Permintaan Anda telah selesai kami proses.";
            $this->db->insert('wa_outbox', ['phone_raw' => $v->notel, 'msg_type' => 'thankyou', 'body' => $body, 'id_kunjungan' => (int) $v->id_kunjungan, 'status' => 'pending']);
        }

        // 4. Auto-close eval timeouts (>7d since eval_link sent, no eval rows). Idempotent: only menunggu_evaluasi rows match.
        $stale = $this->db->query(
            "SELECT k.id_kunjungan FROM tamdes_kunjungan k
             JOIN wa_outbox o ON o.id_kunjungan = k.id_kunjungan AND o.msg_type = 'eval_link'
             WHERE k.created_by = 'whatsapp' AND k.status = 'menunggu_evaluasi'
               AND o.sent_at IS NOT NULL AND o.sent_at < ?
               AND NOT EXISTS (SELECT 1 FROM tamdes_evaluasi_detail e WHERE e.id_kunjungan = k.id_kunjungan)",
            [date('Y-m-d H:i:s', time() - 7 * 24 * 3600)]
        )->result();
        foreach ($stale as $v) {
            $idk = (int) $v->id_kunjungan;
            $this->db->where('id_kunjungan', $idk)->update('tamdes_kunjungan', [
                'status' => 'selesai', 'selesai_timestamp' => $now, 'rating_pengunjung' => null,
            ]);
            $this->audit_system('auto_close_wa_eval', 'visit', $idk, ['from' => 'menunggu_evaluasi', 'to' => 'selesai']);
        }
    }

    private function wa_public_base() {
        return rtrim($this->push_config('wa_public_base') ?: 'https://bukutamu.bpsmalut.com', '/');
    }

    // audit() reads current_user->username; internal calls have no JWT user → write 'system' directly.
    private function audit_system($action, $type, $id, $detail) {
        $this->db->insert('tamdes_audit_log', [
            'admin_user'  => 'system',
            'action'      => $action,
            'target_type' => $type,
            'target_id'   => $id,
            'detail'      => $detail ? json_encode($detail) : null,
            'ip_address'  => $this->input->ip_address(),
        ]);
    }

    // New guest from WA intake (mirrors Kiosk::register guest_data, minus biometric; notel = canonical phone).
    private function wa_guest_data($id_user, $phone_norm, $input) {
        return [
            'id_user'             => $id_user,
            'nama'                => $input['nama'] ?? '',
            'email'               => $input['email'] ?? '',
            'notel'               => $phone_norm,
            'jeniskelamin'        => $input['jeniskelamin'] ?? '',
            'umur'                => !empty($input['umur']) ? (int) $input['umur'] : null,
            'disabilitas'         => !empty($input['disabilitas']) ? (int) $input['disabilitas'] : null,
            'jenis_disabilitas'   => !empty($input['jenis_disabilitas']) ? (int) $input['jenis_disabilitas'] : null,
            'pendidikan'          => $input['pendidikan'] ?? '',
            'pekerjaan'           => $input['pekerjaan'] ?? '',
            'pekerjaan_lainnya'   => $input['pekerjaan_lainnya'] ?? null,
            'kategori_instansi'   => $input['kategori_instansi'] ?? '',
            'kategori_lainnya'    => $input['kategori_lainnya'] ?? null,
            'nama_instansi'       => $input['nama_instansi'] ?? '',
            'pemanfaatan'         => $input['pemanfaatan'] ?? '',
            'pemanfaatan_lainnya' => $input['pemanfaatan_lainnya'] ?? null,
            'pengaduan'           => $input['pengaduan'] ?? '',
            'tgldatang'           => date('Y-m-d'),
            'registered_via'      => 'whatsapp',
        ];
    }

    // Progressive profiling for returning guests: only fill columns that are currently empty.
    private function wa_profile_patch($existing, $input) {
        $patch = [];
        $fields = ['nama','email','jeniskelamin','umur','pendidikan','pekerjaan','kategori_instansi','nama_instansi','pemanfaatan'];
        foreach ($fields as $f) {
            $cur = $existing->$f ?? null;
            $new = $input[$f] ?? null;
            if (($cur === null || $cur === '' || $cur === 0 || $cur === '0') && $new !== null && $new !== '') {
                $patch[$f] = in_array($f, ['umur'], true) ? (int) $new : $new;
            }
        }
        return $patch;
    }
}
```

- [ ] **Step 2: Lint + reload:** `php -l backend/application/modules/api/controllers/Wa.php && sudo apachectl -k graceful`. Expected: `No syntax errors detected`.

- [ ] **Step 3: Commit**
```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/config/routes.php
git commit -m "feat(wa): Wa controller (ingest/poll/ack/inbox/session/eval) + routes"
```

### Task C4: End-to-end backend verification via curl + mysql

- [ ] **Step 1: Guard checks (should all 403/401 without secret/token):**
```bash
curl -s -o /dev/null -w "ingest(no-secret)=%{http_code}\n" -X POST http://127.0.0.1:60/api/wa/ingest
curl -s -o /dev/null -w "poll(no-secret)=%{http_code}\n"   -X POST http://127.0.0.1:60/api/wa/poll
curl -s -o /dev/null -w "session(no-token)=%{http_code}\n"     http://127.0.0.1:60/api/wa/session/1
```
Expected: `ingest=403`, `poll=403`, `session=401`.

- [ ] **Step 2: Ingest a new session** (creates session + intake_link):
```bash
SECRET=PUSH_INTERNAL_SECRET_HERE
curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" \
  -H 'Content-Type: application/json' -d '{"phone":"6281299990000","text":"halo"}'
```
Expected: `{"success":true,"data":{"session_id":N,"new":true},...}`.

- [ ] **Step 3: Confirm the session + the queued link, and grab the token:**
```bash
mysql db_tamdes -e "SELECT id,phone_norm,state FROM wa_sessions ORDER BY id DESC LIMIT 1;
                    SELECT id,msg_type,status,body FROM wa_outbox ORDER BY id DESC LIMIT 1;"
```
Expected: session `phone_norm=081299990000`, `state=awaiting_form`; an `intake_link` outbox row `status=pending` whose `body` contains `/layanan-online/<id>?t=<token>`.

- [ ] **Step 4: Re-ingest same phone → no duplicate link (dedup):**
```bash
curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" \
  -H 'Content-Type: application/json' -d '{"phone":"081299990000","text":"masih saya"}'
mysql db_tamdes -e "SELECT COUNT(*) AS intake_links FROM wa_outbox WHERE msg_type='intake_link';"
```
Expected: `new:false`; `intake_links` unchanged (still 1 for this phone).

- [ ] **Step 5: Prefill GET with the token** (copy `<id>` and `<token>` from Step 3's body):
```bash
curl -s "http://127.0.0.1:60/api/wa/session/<id>" -H "X-Kiosk-Token: <token>"
```
Expected: `{"success":true,"data":{"session_id":<id>,"phone":"081299990000","guest":null,"multi_match":false},...}` (new phone → no guest).

- [ ] **Step 6: Submit the form** (creates guest + visit + konsultasi row, returns ticket):
```bash
curl -s -X POST "http://127.0.0.1:60/api/wa/session/<id>" -H "X-Kiosk-Token: <token>" \
  -H 'Content-Type: application/json' -d '{
    "nama":"Uji WA","email":"uji@wa.test","jeniskelamin":"Laki-laki","umur":3,
    "pendidikan":3,"pekerjaan":1,"kategori_instansi":6,"nama_instansi":"Universitas Khairun","pemanfaatan":4,"pengaduan":"Tidak",
    "permintaan":[{"rincian_data":"Indeks Pembangunan Manusia","wilayah_data":"Maluku Utara, Ternate","level_data":3,"periode_data":4,"tahun_awal":2020,"tahun_akhir":2024}]
  }'
```
Expected: `{"success":true,"data":{"id_kunjungan":K,"ticket":"WA-K"},...}`.

- [ ] **Step 7: Verify the visit shape + confirmation queued + session submitted:**
```bash
mysql db_tamdes -e "SELECT id_kunjungan,created_by,status,nomor_antrian,jenis_layanan FROM tamdes_kunjungan WHERE created_by='whatsapp' ORDER BY id_kunjungan DESC LIMIT 1;
  SELECT id_kunjungan,rincian_data,wilayah_data,tahun_awal,tahun_akhir,level_data,periode_data,status_data FROM konsultasi_pengunjung ORDER BY id DESC LIMIT 1;
  SELECT msg_type,status FROM wa_outbox WHERE msg_type='confirmation' ORDER BY id DESC LIMIT 1;
  SELECT state,id_kunjungan FROM wa_sessions WHERE id=<id>;"
```
Expected: visit `created_by=whatsapp`, `status=antri`, `nomor_antrian=NULL`; konsultasi row has the activated dormant columns populated, `status_data=4`; a `confirmation` outbox row pending; session `state=submitted`.

- [ ] **Step 8: Drive to menunggu_evaluasi, then poll → eval_link enqueued:**
```bash
mysql db_tamdes -e "UPDATE tamdes_kunjungan SET status='menunggu_evaluasi' WHERE id_kunjungan=<K>;"
curl -s -X POST http://127.0.0.1:60/api/wa/poll -H "X-Internal-Secret: $SECRET" | head -c 400; echo
mysql db_tamdes -e "SELECT msg_type,status,body FROM wa_outbox WHERE id_kunjungan=<K> AND msg_type='eval_link';"
```
Expected: an `eval_link` row with body containing `/evaluasi/<K>?t=<accessToken>`.

- [ ] **Step 9: Idempotency — poll again → still exactly one eval_link:**
```bash
curl -s -X POST http://127.0.0.1:60/api/wa/poll -H "X-Internal-Secret: $SECRET" >/dev/null
mysql db_tamdes -e "SELECT COUNT(*) AS eval_links FROM wa_outbox WHERE id_kunjungan=<K> AND msg_type='eval_link';"
```
Expected: `eval_links = 1`.

- [ ] **Step 10: Two-step eval exchange** (use `<accessToken>` from Step 8):
```bash
curl -s "http://127.0.0.1:60/api/wa/eval/<K>?dummy=1" -H "X-Kiosk-Token: <accessToken>"
```
Expected: `{"success":true,"data":{"id_kunjungan":<K>,"kiosk_token":"<shortEvalToken>"},...}`. Then set the visit to `selesai` and confirm the same call now returns **409**:
```bash
mysql db_tamdes -e "UPDATE tamdes_kunjungan SET status='selesai' WHERE id_kunjungan=<K>;"
curl -s -o /dev/null -w "after_selesai=%{http_code}\n" "http://127.0.0.1:60/api/wa/eval/<K>" -H "X-Kiosk-Token: <accessToken>"
```
Expected: `after_selesai=409`.

- [ ] **Step 11: Clean up the test data:**
```bash
mysql db_tamdes -e "DELETE kp FROM konsultasi_pengunjung kp JOIN tamdes_kunjungan k ON k.id_kunjungan=kp.id_kunjungan WHERE k.created_by='whatsapp';
  DELETE FROM wa_outbox; DELETE FROM wa_sessions;
  DELETE FROM tamdes_kunjungan WHERE created_by='whatsapp';
  DELETE FROM tamdes_buku WHERE registered_via='whatsapp';"
```

- [ ] **Step 12: Commit** (nothing to commit if only data changed — this task is verification only). If you adjusted code to fix a failure, commit it now.

---

## Phase D — Frontend: public web intake form

### Task D1: API wrapper + types

**Files:**
- Create: `frontend/src/api/wa.ts`
- Create: `frontend/src/types/wa.ts`

- [ ] **Step 1: Types** — `frontend/src/types/wa.ts`:
```ts
import type { GuestFormData } from '@/types/guest'

export interface WaPermintaanRow {
  rincian_data: string
  wilayah_data: string
  level_data: number | null
  periode_data: number | null
  tahun_awal: number | null
  tahun_akhir: number | null
}

export interface WaGuestMatch {
  id_user: number
  nama: string
  email: string
  notel: string
  jeniskelamin: string
  umur: number | null
  pendidikan: number | null
  pekerjaan: number | null
  kategori_instansi: number | null
  nama_instansi: string
  pemanfaatan: number | null
}

export interface WaSessionPrefill {
  session_id: number
  phone: string
  state: 'awaiting_form' | 'submitted' | 'expired'
  guest: WaGuestMatch | null
  multi_match: boolean
}

export interface WaIntakePayload extends Partial<GuestFormData> {
  permintaan: WaPermintaanRow[]
}

export interface WaInboxRow {
  id_kunjungan: number
  status: string
  date_visit: string
  selesai_timestamp: string | null
  nama: string
  nama_instansi: string
  notel: string
  has_konsultasi: number
  permintaan: string | null
}
```

- [ ] **Step 2: API wrapper** — `frontend/src/api/wa.ts` (mirrors `evaluations.ts` token header):
```ts
import apiClient from './client'
import type { ApiResponse } from '@/types/api'
import type { WaSessionPrefill, WaIntakePayload, WaInboxRow } from '@/types/wa'

export const waApi = {
  getSession: (sessionId: number, token: string) =>
    apiClient.get<ApiResponse<WaSessionPrefill>>(`/api/wa/session/${sessionId}`, {
      headers: { 'X-Kiosk-Token': token },
    }),
  submitSession: (sessionId: number, token: string, payload: WaIntakePayload) =>
    apiClient.post<ApiResponse<{ id_kunjungan: number; ticket: string }>>(
      `/api/wa/session/${sessionId}`, payload, { headers: { 'X-Kiosk-Token': token } },
    ),
  getEvalToken: (id: number, token: string) =>
    apiClient.get<ApiResponse<{ id_kunjungan: number; kiosk_token: string }>>(
      `/api/wa/eval/${id}`, { headers: { 'X-Kiosk-Token': token } },
    ),
  inbox: () => apiClient.get<ApiResponse<WaInboxRow[]>>('/api/wa/inbox'),
}
```

- [ ] **Step 3: Lint** — `cd frontend && npm run lint`. Expected: clean (no new errors in these files).

- [ ] **Step 4: Commit**
```bash
git add frontend/src/api/wa.ts frontend/src/types/wa.ts
git commit -m "feat(wa): frontend api wrapper + types"
```

### Task D2: Permintaan Data block component

**Files:** Create `frontend/src/components/wa/PermintaanDataForm.tsx`

- [ ] **Step 1: Write the component** (multi-row, reuses `LEVEL_DATA_OPTIONS`/`PERIODE_DATA_OPTIONS` from `types/visit`):
```tsx
import { LEVEL_DATA_OPTIONS, PERIODE_DATA_OPTIONS } from '@/types/visit'
import type { WaPermintaanRow } from '@/types/wa'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Trash2 } from 'lucide-react'

export function emptyPermintaanRow(): WaPermintaanRow {
  return { rincian_data: '', wilayah_data: '', level_data: null, periode_data: null, tahun_awal: null, tahun_akhir: null }
}

interface Props {
  rows: WaPermintaanRow[]
  onChange: (rows: WaPermintaanRow[]) => void
}

export function PermintaanDataForm({ rows, onChange }: Props) {
  const update = (i: number, patch: Partial<WaPermintaanRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () => onChange([...rows, emptyPermintaanRow()])

  const selectClass = 'w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 bg-white appearance-none'

  return (
    <div className="space-y-4">
      {rows.map((row, idx) => (
        <div key={idx} className="border rounded-xl p-4 space-y-3 bg-muted/20">
          <div className="flex items-center justify-between">
            <p className="font-bold text-sm">Permintaan No. {idx + 1}</p>
            {rows.length > 1 && (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(idx)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>

          <div className="space-y-1">
            <Label>Data / indikator yang dibutuhkan <span className="text-red-500">*</span></Label>
            <Input value={row.rincian_data} onChange={e => update(idx, { rincian_data: e.target.value })}
                   placeholder="Contoh: Indeks Pembangunan Manusia" />
          </div>

          <div className="space-y-1">
            <Label>Cakupan wilayah</Label>
            <select className={selectClass} value={row.level_data ?? ''}
                    onChange={e => update(idx, { level_data: e.target.value ? Number(e.target.value) : null })}>
              <option value="">-- Pilih level --</option>
              {LEVEL_DATA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <Input className="mt-2" value={row.wilayah_data} onChange={e => update(idx, { wilayah_data: e.target.value })}
                   placeholder="Wilayah spesifik (mis. Maluku Utara, Ternate, Tidore)" />
          </div>

          <div className="space-y-1">
            <Label>Periode data</Label>
            <select className={selectClass} value={row.periode_data ?? ''}
                    onChange={e => update(idx, { periode_data: e.target.value ? Number(e.target.value) : null })}>
              <option value="">-- Pilih periode --</option>
              {PERIODE_DATA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <Label>Tahun awal</Label>
              <Input type="number" min={2000} max={2100} value={row.tahun_awal ?? ''}
                     onChange={e => update(idx, { tahun_awal: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div className="flex-1 space-y-1">
              <Label>Tahun akhir</Label>
              <Input type="number" min={2000} max={2100} value={row.tahun_akhir ?? ''}
                     onChange={e => update(idx, { tahun_akhir: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
        </div>
      ))}

      <Button variant="outline" onClick={add} className="w-full border-dashed">
        <Plus className="w-4 h-4 mr-2" /> Tambah Permintaan
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Lint.** Expected: clean.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/components/wa/PermintaanDataForm.tsx
git commit -m "feat(wa): Permintaan Data block component"
```

### Task D3: The public intake page + routes

**Files:**
- Create: `frontend/src/pages/wa/LayananOnlinePage.tsx`
- Modify: `frontend/src/App.tsx` (add lazy import + route)

- [ ] **Step 1: Write the page** (reuses `VisitorForm` verbatim for Block A; phone is prefilled into `notel` from the session — the field shows pre-filled, deliberate per spec; token read from `?t=`):
```tsx
import { useState, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { VisitorForm } from '@/components/kiosk/VisitorForm'
import { PermintaanDataForm, emptyPermintaanRow } from '@/components/wa/PermintaanDataForm'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { GuestFormData } from '@/types/guest'
import type { WaPermintaanRow } from '@/types/wa'

function blankGuest(phone: string): GuestFormData {
  return {
    tgldatang: '', nama: '', email: '', notel: phone, jeniskelamin: 'Laki-laki',
    umur: 0, disabilitas: 2, jenis_disabilitas: 0, pendidikan: 0, pekerjaan: 0,
    pekerjaan_lainnya: '', kategori_instansi: 0, kategori_lainnya: '',
    nama_instansi: '', pemanfaatan: 0, pemanfaatan_lainnya: '', pengaduan: 'Tidak',
  }
}

export default function LayananOnlinePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [params] = useSearchParams()
  const token = params.get('t') ?? ''

  const { data: prefill, isLoading, isError } = useQuery({
    queryKey: ['wa-session', sessionId, token],
    queryFn: () => waApi.getSession(Number(sessionId), token).then(r => r.data.data),
    enabled: !!sessionId && !!token,
    retry: false,
  })

  const initialGuest = useMemo<GuestFormData>(() => {
    const phone = prefill?.phone ?? ''
    const g = prefill?.guest
    if (!g) return blankGuest(phone)
    return {
      ...blankGuest(phone),
      nama: g.nama ?? '', email: g.email ?? '', jeniskelamin: (g.jeniskelamin as GuestFormData['jeniskelamin']) || 'Laki-laki',
      umur: g.umur ?? 0, pendidikan: g.pendidikan ?? 0, pekerjaan: g.pekerjaan ?? 0,
      kategori_instansi: g.kategori_instansi ?? 0, nama_instansi: g.nama_instansi ?? '', pemanfaatan: g.pemanfaatan ?? 0,
    }
  }, [prefill])

  const [guest, setGuest] = useState<GuestFormData | null>(null)
  const [rows, setRows] = useState<WaPermintaanRow[]>([emptyPermintaanRow()])
  const [ticket, setTicket] = useState<string | null>(null)
  const effGuest = guest ?? initialGuest

  const submit = useMutation({
    mutationFn: () =>
      waApi.submitSession(Number(sessionId), token, { ...effGuest, permintaan: rows }).then(r => r.data.data),
    onSuccess: (d) => setTicket(d?.ticket ?? null),
    onError: (e: unknown) => {
      const msg = e && typeof e === 'object' && 'response' in e
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (e as any).response?.data?.message : null
      toast.error(msg || 'Gagal mengirim permintaan')
    },
  })

  if (!token) return <p className="p-8 text-center">Tautan tidak valid.</p>
  if (isLoading) return <LoadingSpinner className="min-h-screen" />
  if (isError || !prefill) return <p className="p-8 text-center">Tautan kedaluwarsa atau tidak valid. Silakan kirim pesan ulang ke WhatsApp layanan.</p>
  if (prefill.state === 'submitted' || ticket) {
    return (
      <div className="max-w-md mx-auto p-8 text-center space-y-2">
        <h1 className="text-xl font-bold">Permintaan terkirim ✅</h1>
        <p>Nomor tiket Anda: <b>{ticket ?? `WA-${prefill.session_id}`}</b></p>
        <p className="text-sm text-muted-foreground">Akan kami proses pada jam operasional layanan (Senin–Jumat 08.00–15.30 WIT).</p>
      </div>
    )
  }

  const canSubmit = effGuest.nama.trim() !== '' && rows.some(r => r.rincian_data.trim() !== '')

  return (
    <div className="max-w-md mx-auto p-4 space-y-6">
      <header className="text-center">
        <h1 className="text-lg font-bold">Layanan Data BPS Maluku Utara</h1>
        <p className="text-sm text-muted-foreground">Lengkapi data berikut untuk kami proses.</p>
        {prefill.multi_match && (
          <p className="text-xs text-amber-600 mt-1">Beberapa profil terkait nomor ini — petugas akan memverifikasi.</p>
        )}
      </header>

      <section>
        <h2 className="font-semibold mb-2">A. Identitas</h2>
        <VisitorForm value={effGuest} onChange={setGuest} />
      </section>

      <section>
        <h2 className="font-semibold mb-2">B. Permintaan Data</h2>
        <PermintaanDataForm rows={rows} onChange={setRows} />
      </section>

      <Button className="w-full" disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? 'Mengirim…' : 'Kirim Permintaan'}
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Register the route in `App.tsx`** — add the lazy import alongside the other kiosk lazies (after line ~37):
```tsx
const LayananOnlinePage = lazyRetry(() => import('@/pages/wa/LayananOnlinePage'))
```
and add the public route just after the `/kiosk/evaluasi/:id` route (line ~77):
```tsx
                <Route path="/layanan-online/:sessionId" element={<LayananOnlinePage />} />
```

- [ ] **Step 3: Build** — `cd frontend && npm run lint && npm run build`. Expected: type-checks + bundles cleanly.

- [ ] **Step 4: Browser smoke test** — recreate a session via the Phase-C curl (Steps 2–3), copy the `/layanan-online/<id>?t=<token>` URL, open it at `http://localhost:5173/layanan-online/<id>?t=<token>` (dev) and confirm Block A + Block B render and submitting shows the ticket screen. Clean up the test rows after.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/pages/wa/LayananOnlinePage.tsx frontend/src/App.tsx
git commit -m "feat(wa): public Layanan Online intake page + route"
```

---

## Phase E — Frontend: remote evaluation page

### Task E1: Remote eval page (two-step token → reuse EvaluationForm)

**Files:**
- Create: `frontend/src/pages/wa/EvaluasiOnlinePage.tsx`
- Modify: `frontend/src/App.tsx` (lazy import + route)

- [ ] **Step 1: Write the page** (exchanges the access token for a short `eval-submit` token via `waApi.getEvalToken`, then reuses the existing `evaluationsApi.getForm/submit` + `EvaluationForm`):
```tsx
import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { waApi } from '@/api/wa'
import { evaluationsApi } from '@/api/evaluations'
import { EvaluationForm } from '@/components/kiosk/EvaluationForm'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { EvaluationSubmission } from '@/types/evaluation'

export default function EvaluasiOnlinePage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const accessToken = params.get('t') ?? ''
  const [evalToken, setEvalToken] = useState<string | undefined>()
  const [done, setDone] = useState(false)
  const [closed, setClosed] = useState(false)

  // Exchange the durable access token for a short eval-submit token.
  useEffect(() => {
    if (!id || !accessToken) return
    let cancelled = false
    waApi.getEvalToken(Number(id), accessToken)
      .then(r => { if (!cancelled) setEvalToken(r.data.data?.kiosk_token) })
      .catch((e) => { if (!cancelled) { if (e?.response?.status === 409) setClosed(true); } })
    return () => { cancelled = true }
  }, [id, accessToken])

  const { data: formData, isLoading } = useQuery({
    queryKey: ['wa-eval-form', id, evalToken],
    queryFn: () => evaluationsApi.getForm(Number(id), evalToken!).then(r => r.data.data),
    enabled: !!id && !!evalToken,
  })

  const submit = useMutation({
    mutationFn: (data: EvaluationSubmission) => evaluationsApi.submit(Number(id), data, evalToken!),
    onSuccess: () => setDone(true),
    onError: () => toast.error('Gagal mengirim evaluasi'),
  })

  if (!accessToken) return <p className="p-8 text-center">Tautan tidak valid.</p>
  if (closed) return <p className="p-8 text-center">Evaluasi untuk permintaan ini sudah ditutup. Terima kasih.</p>
  if (done) return <p className="p-8 text-center text-lg font-semibold">Terima kasih atas penilaian Anda! 🙏</p>
  if (isLoading || !formData) return <LoadingSpinner className="min-h-screen" />

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-lg font-bold text-center mb-4">Evaluasi Layanan</h1>
      <EvaluationForm
        indicators={formData.indicators}
        konsultasiKualitas={formData.konsultasiKualitas}
        onSubmit={(d) => submit.mutate(d)}
        isSubmitting={submit.isPending}
      />
    </div>
  )
}
```
> **Verified props** (from `frontend/src/components/kiosk/EvaluationForm.tsx:9-14`): `EvaluationForm` takes `indicators: EvaluationIndicator[]`, `konsultasiKualitas?: KonsultasiKualitas[]`, `onSubmit: (data: EvaluationSubmission) => void`, `isSubmitting?: boolean`. `evaluationsApi.getForm` returns `EvaluationFormData = { indicators, konsultasiKualitas, visitor }`, so the two array props come straight off `formData`. The component is reused verbatim — do not fork it. It already enforces the all-16-indicator gate (R13).

- [ ] **Step 2: Register route in `App.tsx`** — lazy import:
```tsx
const EvaluasiOnlinePage = lazyRetry(() => import('@/pages/wa/EvaluasiOnlinePage'))
```
public route (after the Layanan Online route):
```tsx
                <Route path="/evaluasi/:id" element={<EvaluasiOnlinePage />} />
```

- [ ] **Step 3: Build** — `npm run lint && npm run build`. Fix any prop-name mismatch surfaced by `tsc`.

- [ ] **Step 4: Browser smoke test** — using a WA visit in `menunggu_evaluasi` + its `eval_link` URL (Phase-C Step 8), open `/evaluasi/<K>?t=<accessToken>`, confirm the 16-indicator form renders and submitting moves the visit to `selesai` (`mysql … SELECT status`). Then confirm reopening the link shows "sudah ditutup" (409). Clean up.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/pages/wa/EvaluasiOnlinePage.tsx frontend/src/App.tsx
git commit -m "feat(wa): remote evaluation page (two-step token, reuses EvaluationForm)"
```

---

## Phase F — Frontend: admin "Layanan Online" inbox

### Task F1: Inbox page + nav + route

**Files:**
- Create: `frontend/src/pages/admin/LayananOnlineInboxPage.tsx`
- Modify: `frontend/src/components/admin/Sidebar.tsx` (NAV_ITEMS)
- Modify: `frontend/src/App.tsx` (lazy import + admin route)

- [ ] **Step 1: Write the inbox page** (mirrors `ConsultationQueuePage`; rows link to the existing consultation form `/admin/consultations/:id/form`, which finalizes via the unchanged gates):
```tsx
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { waApi } from '@/api/wa'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageSquare, ExternalLink } from 'lucide-react'
import type { WaInboxRow } from '@/types/wa'

const STATUS_LABEL: Record<string, string> = {
  antri: 'Baru', dipanggil: 'Baru', proses: 'Diproses', diproses: 'Diproses',
  menunggu_evaluasi: 'Menunggu Evaluasi', selesai: 'Selesai',
}

export default function LayananOnlineInboxPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['wa-inbox'],
    queryFn: () => waApi.inbox().then(r => r.data.data),
    refetchInterval: 30000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  const rows = data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-5 h-5 text-emerald-600" />
        <h1 className="text-xl font-bold">Layanan Online (WhatsApp)</h1>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Belum ada permintaan online.</p>}
      <div className="space-y-2">
        {rows.map((r: WaInboxRow) => (
          <div key={r.id_kunjungan} className="border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold truncate">{r.nama || '(tanpa nama)'} <span className="text-xs text-muted-foreground">· {r.nama_instansi}</span></p>
              <p className="text-xs text-muted-foreground truncate">{r.permintaan || '—'}</p>
              <p className="text-[11px] text-muted-foreground">{r.notel} · WA-{r.id_kunjungan} · {STATUS_LABEL[r.status] ?? r.status}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate(`/admin/consultations/${r.id_kunjungan}/form`)}>
              <ExternalLink className="w-4 h-4 mr-1" /> Proses
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the nav item** in `frontend/src/components/admin/Sidebar.tsx` — import an icon and add to `NAV_ITEMS` after `'Daftar Kunjungan'`:
```tsx
  { to: '/admin/layanan-online', label: 'Layanan Online', icon: MessageSquare, allowedRoles: PST_DTSEN_ROLES },
```
(ensure `MessageSquare` is imported from `lucide-react` at the top of the file.)

- [ ] **Step 3: Register the admin route in `App.tsx`** — lazy import + route inside the `<AdminLayout>` block:
```tsx
const LayananOnlineInboxPage = lazyRetry(() => import('@/pages/admin/LayananOnlineInboxPage'))
```
```tsx
                  <Route path="/admin/layanan-online" element={<LayananOnlineInboxPage />} />
```

- [ ] **Step 4: Build** — `npm run lint && npm run build`. Expected: clean.

- [ ] **Step 5: Browser smoke test** — create one WA visit (Phase-C Steps 2–6), log into `/admin`, confirm "Layanan Online" appears in the sidebar, the request shows in the inbox, and "Proses" opens the existing consultation form. Fill it, save → confirm the visit moves to `menunggu_evaluasi` (it must NOT appear in `/admin/consultations`). Clean up.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/pages/admin/LayananOnlineInboxPage.tsx frontend/src/components/admin/Sidebar.tsx frontend/src/App.tsx
git commit -m "feat(wa): admin Layanan Online inbox page + nav"
```

---

## Phase G — The wwebjs connector (`wa/` service)

### Task G1: Connector files

**Files:**
- Create: `wa/server.js`
- Create: `wa/package.json`
- Create: `wa/config.json` (git-ignored)
- Create: `wa/.gitignore`

- [ ] **Step 1: `wa/.gitignore`**:
```
node_modules/
config.json
.wwebjs_auth/
*.log
*.backup
```

- [ ] **Step 2: `wa/package.json`**:
```json
{
  "name": "bukutamu-wa",
  "version": "1.0.0",
  "private": true,
  "description": "WhatsApp online data-request connector for bukutamu (whatsapp-web.js). Isolated; mirrors bukutamu-notifier.",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "whatsapp-web.js": "^1.26.0",
    "qrcode-terminal": "^0.12.0"
  }
}
```

- [ ] **Step 3: `wa/config.json`** (internalSecret = the SAME `push_internal_secret`, R16):
```json
{
  "apiBase": "http://127.0.0.1:60",
  "internalSecret": "PUSH_INTERNAL_SECRET_HERE",
  "pollIntervalMs": 30000
}
```

- [ ] **Step 4: `wa/server.js`** (mirrors `notifier/server.js`: inbound → ingest; tick → poll/send/ack; primed by the connection-ready gate):
```js
'use strict';

/*
 | bukutamu-wa — WhatsApp online data-request connector (whatsapp-web.js).
 | Isolated, ToS-risky surface. Mirrors bukutamu-notifier's loopback + internal-secret pattern.
 |   - on('message')  → POST {apiBase}/api/wa/ingest  {phone,text}   (backend decides new vs continuation)
 |   - every poll     → POST {apiBase}/api/wa/poll                    (idempotent dispatch scan; returns pending)
 |                      → client.sendMessage(jid, body) per message
 |                      → POST {apiBase}/api/wa/ack  {ids:[...]}
 | First QR scan links the BPS 0851 number as a WhatsApp linked device. Session persists in .wwebjs_auth/.
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL = cfg.pollIntervalMs || 30000;
const BASE = String(cfg.apiBase || 'http://127.0.0.1:60').replace(/\/$/, '');
const INGEST_URL = BASE + '/api/wa/ingest';
const POLL_URL = BASE + '/api/wa/poll';
const ACK_URL = BASE + '/api/wa/ack';

function log(...a) { console.log(new Date().toISOString(), ...a); }
if (typeof fetch !== 'function') { log('FATAL: need Node >= 18 (global fetch)'); process.exit(1); }

function jidFromLocal(phone) {
  // Accept stored 0xxx or raw 62xxx; emit 62xxx@c.us.
  const d = String(phone).replace(/\D/g, '').replace(/^0/, '62');
  return d + '@c.us';
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let ready = false;
client.on('qr', (qr) => { log('Scan this QR with the BPS WhatsApp (0851...) to link as a device:'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => { ready = true; log('WA client ready'); });
client.on('auth_failure', (m) => log('auth_failure', m));
client.on('disconnected', (r) => { ready = false; log('disconnected', r); });

client.on('message', async (msg) => {
  try {
    if (typeof msg.from !== 'string' || msg.from.endsWith('@g.us')) return; // ignore groups
    if (msg.isStatus) return;
    const phone = msg.from.replace(/@c\.us$/, '');
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
      body: JSON.stringify({ phone, text: msg.body || '' }),
    });
    if (!res.ok) log('ingest http', res.status);
  } catch (e) { log('ingest error', e.message); }
});

let busy = false;
async function tick() {
  if (busy || !ready) return;
  busy = true;
  try {
    const res = await fetch(POLL_URL, { method: 'POST', headers: { 'X-Internal-Secret': cfg.internalSecret } });
    if (!res.ok) { log('poll http', res.status); return; }
    const body = await res.json();
    const messages = (body.data && body.data.messages) || [];
    const sent = [];
    for (const m of messages) {
      try { await client.sendMessage(jidFromLocal(m.phone), m.body); sent.push(m.id); }
      catch (e) { log('send error id', m.id, e.message); }
    }
    if (sent.length) {
      await fetch(ACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.internalSecret },
        body: JSON.stringify({ ids: sent }),
      });
      log('sent+acked', sent.length);
    }
  } catch (e) { log('tick error', e.message); }
  finally { busy = false; }
}

log('bukutamu-wa start; poll', POLL, 'ms;', POLL_URL);
client.initialize();
setInterval(tick, POLL);
```

- [ ] **Step 5: Install deps** — `cd wa && npm install`. Expected: `whatsapp-web.js` + `qrcode-terminal` installed (pulls a Chromium for Puppeteer; needs network + ~300MB).

- [ ] **Step 6: Verify it boots + shows a QR** — `cd wa && node server.js`. Expected: logs `bukutamu-wa start…` then prints a QR block (`qr` event). Do **not** scan yet on a shared dev box; Ctrl-C. (Scanning the BPS number is an operator step — see Deploy.)

- [ ] **Step 7: Commit** (config.json is git-ignored — confirm it is NOT staged):
```bash
git add wa/server.js wa/package.json wa/.gitignore
git status --short   # confirm wa/config.json + wa/.wwebjs_auth/ are NOT listed
git commit -m "feat(wa): whatsapp-web.js connector service (isolated, notifier-mirror)"
```

### Task G2: PM2 entry

**Files:** Modify `ecosystem.config.cjs`

- [ ] **Step 1: Back up**, then add a third app entry after `bukutamu-notifier`:
```js
    {
      // WhatsApp online data-request connector (whatsapp-web.js). Reads the
      // git-ignored wa/config.json (internalSecret = push_internal_secret).
      // ToS-risky surface, isolated here; if the number is jailed, bukutamu core is untouched.
      name: 'bukutamu-wa',
      script: 'server.js',
      cwd: '/var/www/html/bukutamu/wa',
      autorestart: true,
      max_restarts: 20,
    },
```

- [ ] **Step 2: `diff` the backup.** Do NOT `pm2 start` here (that's a deploy step requiring the QR scan).

- [ ] **Step 3: Commit**
```bash
git add ecosystem.config.cjs
git commit -m "chore(wa): add bukutamu-wa PM2 app"
```

---

## Phase H — Deploy & full-path verification (operator-run)

> These are operator/deploy actions (and the wwebjs link needs a phone). List them; don't run blindly.

- [ ] **H1.** Backend already reloaded per-task. Confirm: `curl -sS -o /dev/null -w "%{http_code}\n" https://bukutamu.bpsmalut.com:460/api/auth/check` → expect `401`.
- [ ] **H2.** Frontend: `cd frontend && npm run build && pm2 restart bukutamu-frontend && pm2 logs bukutamu-frontend --lines 20`. Bump `frontend/public/sw.js` `CACHE_NAME` (per `deploy_frontend_sw_cache_bump`) so users get the new routes.
- [ ] **H3.** Connector: `cd wa && npm install`, set `wa/config.json` (`apiBase`, `internalSecret`, `pollIntervalMs`), then **operator scans the QR** with the BPS 0851 number: `pm2 start ecosystem.config.cjs --only bukutamu-wa && pm2 logs bukutamu-wa` (scan the printed QR once). `pm2 save`.
- [ ] **H4.** Confirm `push.php` has `wa_public_base` set to the public origin serving the SPA (so links are clickable & trusted).
- [ ] **H5.** **Live full path:** from a test phone, message the 0851 line → receive link → fill the web form → receive `WA-#` confirmation → petugas processes it in Layanan Online → `menunggu_evaluasi` → receive eval link → submit eval → `selesai` → confirm it shows in `/admin/queue-stats` under the **WhatsApp** bucket and never appeared in the PST queue / TV / kiosk eval tablet.
- [ ] **H6.** Leave one eval unfilled; after 7 days confirm the dispatch scan auto-closed it (`status=selesai`, audit `auto_close_wa_eval`).

---

## Spec coverage check (self-review)

- D1 web-form intake → Phase D. D2 `Konsultasi Statistik` hardcoded → C3 `session()`. D3 `created_by='whatsapp'` → C3. D4 rows in `konsultasi_pengunjung` → C3. D5 excluded from queues → Phase B + `nomor_antrian=NULL` in C3. D6 two-step eval → C3 `eval_access()` + E1. D7 `wa_sessions` → A1/C3. D8 `wa_outbox` + `poll` → A1/C3. D9 7-day auto-close → C3 `wa_dispatch_scan()` step 4.
- R1 → B1. R2 (5 sites) → B2,B3,B4,B5. R3 → B6. R4 → A2 + C3 lookup. R5 → C3 `multi_match`. R6 → C3 hardcoded service. R7 → C3 konsultasi rows. R8 → C3 server-authoritative fields. R9 → reuse `created_by` (no migration). R10 → G1 `ready` gate + ledger. R11 → C3/E1 two-step. R12 → B7. R13 → E1 reuses `EvaluationForm` (FE enforces 16). R14 → C3 sets `date_visit` at submit. R15 → C3 `wa/intake` namespace. R16 → G1 shared secret. R17 → **GAP, see below**. R18 → C3 idempotent scan + C4 Step 9.
- **R17 (admin panel renders the now-populated dormant konsultasi columns):** the existing consultation panel shows `wilayah_data`/`tahun`/`periode`/`level_data` as "-" when null; for WA visits they're populated. Verify during F1 Step 5 that they render. If the panel hides them entirely, add a small display tweak in `ConsultationFormPage`/`VisitLogPage` — **flagged for the implementer to confirm during F1**, not a blocker.

---

## Execution Handoff

(Provided after you approve — see the message accompanying this plan.)
