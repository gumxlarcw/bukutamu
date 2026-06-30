# Verifikator & Data Delivery (Phase 1: Online) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every data deliverable an operator sends a WhatsApp customer behind a `verifikator` (halima) who approves/revises from WhatsApp **and** a web panel, before it reaches the customer.

**Architecture:** A new first-class `data_deliveries` row is the source of truth. The operator's "Kirim Data" action creates it at `menunggu_verifikasi` (never touching `wa_messages`). On approval the backend *materializes* the deliverable into outbound `wa_messages` rows, so the existing wwebjs connector send/ACK/retry pipeline is reused **unchanged** (no `wa/server.js` edits in Phase 1). The verifier's WA reply is parsed inside the existing `/api/wa/ingest` branch and runs the same code path as the web verify endpoint.

**Tech Stack:** CodeIgniter 3 HMVC (PHP, JSON-API), MySQL `db_tamdes`, React 19 + Vite + TS + react-query, wwebjs WA connector (untouched), web-push notifier (one new rule).

**Spec:** `docs/superpowers/specs/2026-06-30-verifikator-data-delivery-design.md`

## Global Constraints

Every task implicitly includes these. Copied verbatim from project rules / spec / auto-memory.

- **No automated test suite.** Verification = `npm run lint` + `npm run build` (frontend), `curl` against the backend (backend), manual WA smoke on a **test number** (connector). Do NOT scaffold Vitest/PHPUnit without user sign-off (`.claude/rules/testing.md`).
- **Per-file edit ritual (mandatory):** Read the file → `cp {file} {file}.backup` immediately before the first edit → minimal targeted change matching surrounding style → `diff {file}.backup {file}`. `*.backup` is git-ignored. Do not use `rm -f` (a hook blocks it) — move backups to the scratchpad if you must clear them.
- **Commits:** NO `Co-Authored-By` trailer in this repo. Frequent, small commits. Work on branch `feat/verifikator-data-delivery`.
- **FE↔BE parity in the same session** for any domain-rule change.
- **Role ENUM gotcha:** `admin_users.role` is a MySQL ENUM — `ALTER TABLE` to add `verifikator` BEFORE any code writes that value, or MySQL silently coerces it to `''`. A verify-after-insert guard already exists in `Users.php`.
- **Production DB, no staging:** back up `db_tamdes` (fresh dump) before any schema/data write; confirm row-count scope.
- **PHP is live-on-edit:** apply migrations BEFORE the PHP that reads them goes live, or guard the query. Caused a ~40 min outage once.
- **Connector:** Phase 1 makes **zero** `wa/server.js` changes → no connector restart needed. Never restart a *warm* connector on a "tidak merespons" alert.
- **API envelope:** `{ success, data, message }` (+ `pagination` for lists). HTTP status reflects result. **Never return 200 with `success:false`.** `apiClient` does not unwrap — callers read `res.data.data`.
- **Invariants untouched:** SKD 3-layer `menunggu_evaluasi` finalization gate; DELETE-visit cascade (this plan ADDS `data_deliveries` to it).
- **Frontend deploy:** bump `CACHE_NAME` in `frontend/public/sw.js` or users keep pre-deploy code.
- **Ports:** backend `:60`/`:460`, frontend dev `:5173`, PM2 serve `:3060`. Root MySQL creds in `/root/.my.cnf` (use `mysql -e "…"`).

**Enums (single source of truth — reuse these exact spellings everywhere):**
- `data_deliveries.status`: `menunggu_verifikasi` · `revisi` · `disetujui` · `terkirim` · `dibatalkan`
- `data_deliveries.verif_decision`: `setuju` · `revisi` · `setuju_catatan`
- `data_deliveries.channel`: `online` · `offline`
- `data_deliveries.delivery_method`: `wa` · `flashdisk` · `printed`
- new `admin_users.role` value: `verifikator`
- new `wa_outbox.msg_type` value: `verif_request`

**Endpoint role allow-lists:**
- create / edit-resubmit / cancel → `['petugas_pst','operator','admin','superadmin']`
- verify → `['verifikator','admin','superadmin']`
- read (list / detail / file) → either of the above

---

## File Structure

**Backend (`backend/application/`)**
- `modules/api/controllers/Deliveries.php` — *new* resource controller (create/list/detail/file/verify/edit/cancel).
- `modules/api/models/Delivery_model.php` — *new* DB access for `data_deliveries` + the materialize-to-`wa_messages` helper.
- `modules/api/controllers/Wa.php` — *modify* `ingest()` (verifier-sender branch), add `verif_request` enqueue + bot-confirmation helper, reuse `wa_enqueue_user()`.
- `modules/api/controllers/Users.php` — *modify* role whitelist (2 spots) + `notel` field.
- `modules/api/controllers/Api_base.php` — *modify* role hierarchy (+`verifikator`); add a small role allow-list helper if none exists.
- `modules/api/controllers/Notifications.php` — *modify* `rules_for_role()` (+ verifikator queue, + operator-revisi).
- `config/routes.php` — *modify* add `api/deliveries/*` routes.
- `docs/migrations/2026-06-30-verifikator-data-delivery.sql` — *new* migration SQL (source of truth; also applied live).
- the visit-DELETE cascade controller (`Visits.php` — confirm) — *modify* add `data_deliveries` cascade + file unlink.

**Frontend (`frontend/src/`)**
- `api/deliveries.ts` — *new* axios wrapper.
- `types/delivery.ts` — *new* types.
- `api/auth.ts` — *modify* `UserRole` += `'verifikator'`.
- `pages/admin/VerifikasiPage.tsx` — *new* verifier panel.
- `pages/admin/UserManagementPage.tsx` — *modify* role option + `notel` field.
- `components/admin/TopNav.tsx` — *modify* Verifikasi nav item + verifikator-only gating.
- `components/wa/ChatPopup.tsx` — *modify* replace attachment with "Kirim Data" form + render deliverable bubbles/labels.
- `pages/admin/LayananOnlineInboxPage.tsx` — *modify* delivery-status badge on conversation rows.
- `App.tsx` (router) — *modify* add `/admin/verifikasi` route.
- `public/sw.js` — *modify* bump `CACHE_NAME` (deploy task only).

---

## Task 1: Database migrations + backup

**Files:**
- Create: `docs/migrations/2026-06-30-verifikator-data-delivery.sql`
- DB: `db_tamdes` (live apply)

**Interfaces:**
- Produces: table `data_deliveries` (schema below); `admin_users.notel`; role ENUM + `verifikator`; `wa_outbox.msg_type` + `verif_request`. All later tasks depend on these existing.

- [ ] **Step 1: Back up the database**

```bash
mkdir -p /var/www/html/bukutamu/docs/migrations
mysqldump db_tamdes > "/tmp/claude-0/-var-www-html-bukutamu/76eeb978-bf41-44e4-9978-d84f5f8ff2a9/scratchpad/db_tamdes_pre_verifikator_$(date +%Y%m%d_%H%M%S).sql"
ls -la /tmp/claude-0/-var-www-html-bukutamu/76eeb978-bf41-44e4-9978-d84f5f8ff2a9/scratchpad/db_tamdes_pre_verifikator_*.sql
```
Expected: a non-empty `.sql` dump file listed.

- [ ] **Step 2: Capture the current role ENUM (so the ALTER preserves every existing value)**

```bash
mysql -N -e "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='db_tamdes' AND TABLE_NAME='admin_users' AND COLUMN_NAME='role';"
mysql -N -e "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='db_tamdes' AND TABLE_NAME='wa_outbox' AND COLUMN_NAME='msg_type';"
```
Expected (role): `enum('superadmin','admin','operator','resepsionis','petugas_pst','pimpinan')`. If it differs, use the actual list + `verifikator` in Step 3. Same for `msg_type` — append `verif_request` to whatever is there.

- [ ] **Step 3: Write the migration file**

Create `docs/migrations/2026-06-30-verifikator-data-delivery.sql`:

```sql
-- Verifikator & Data Delivery — Phase 1
-- Apply order matters (role ENUM before any code writes 'verifikator').
-- Adjust the ENUM lists in 1) and 3) to match the ACTUAL current COLUMN_TYPE captured at apply time.

-- 1) Add the verifikator role (preserve all existing values).
ALTER TABLE admin_users
  MODIFY COLUMN role
  ENUM('superadmin','admin','operator','resepsionis','petugas_pst','pimpinan','verifikator')
  NOT NULL;

-- 2) Verifier WhatsApp number (also used for any future per-user contact).
ALTER TABLE admin_users
  ADD COLUMN notel VARCHAR(20) NULL AFTER nama;

-- 3) New outbox message type for the verification ping + bot confirmations.
ALTER TABLE wa_outbox
  MODIFY COLUMN msg_type
  ENUM('intake_link','confirmation','eval_link','thankyou','group_notify','menu','verif_request')
  NOT NULL;

-- 4) The unified delivery + verification record.
CREATE TABLE IF NOT EXISTS data_deliveries (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_kunjungan    INT NOT NULL,
  id_konsultasi   INT NULL,
  channel         ENUM('online','offline') NOT NULL DEFAULT 'online',
  link_url        TEXT NULL,
  media_path      VARCHAR(255) NULL,
  media_mime      VARCHAR(100) NULL,
  media_name      VARCHAR(200) NULL,
  note_operator   TEXT NULL,
  status          ENUM('menunggu_verifikasi','revisi','disetujui','terkirim','dibatalkan')
                    NOT NULL DEFAULT 'menunggu_verifikasi',
  verif_decision  ENUM('setuju','revisi','setuju_catatan') NULL,
  verif_note      TEXT NULL,
  id_verifikator  INT NULL,
  verified_at     DATETIME NULL,
  revisi_count    INT NOT NULL DEFAULT 0,
  short_code      VARCHAR(12) NULL,
  delivery_method ENUM('wa','flashdisk','printed') NULL,
  delivered_at    DATETIME NULL,
  delivered_by    INT NULL,
  created_by      INT NOT NULL,
  verif_outbox_id BIGINT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status (status),
  KEY idx_kunjungan (id_kunjungan),
  KEY idx_verif_pending (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 4: Apply the migration**

```bash
mysql db_tamdes < /var/www/html/bukutamu/docs/migrations/2026-06-30-verifikator-data-delivery.sql
```
Expected: no errors.

- [ ] **Step 5: Verify schema**

```bash
mysql -N -e "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='db_tamdes' AND TABLE_NAME='admin_users' AND COLUMN_NAME='role';"
mysql -e "DESCRIBE db_tamdes.admin_users;" | grep -E 'role|notel'
mysql -e "SHOW TABLES IN db_tamdes LIKE 'data_deliveries';"
mysql -e "DESCRIBE db_tamdes.data_deliveries;"
```
Expected: `role` ENUM now contains `verifikator`; `notel` column present; `data_deliveries` table exists with all columns.

- [ ] **Step 6: Commit**

```bash
git add docs/migrations/2026-06-30-verifikator-data-delivery.sql
git commit -m "feat(db): migration for verifikator role, notel, wa_outbox verif_request, data_deliveries"
```

---

## Task 2: Verifikator role plumbing (BE + FE, no UI nav yet)

**Files:**
- Modify: `backend/application/modules/api/controllers/Users.php` (role whitelist x2, `notel` read/write)
- Modify: `backend/application/modules/api/controllers/Api_base.php` (hierarchy + allow-list helper)
- Modify: `frontend/src/api/auth.ts` (`UserRole`)
- Modify: `frontend/src/pages/admin/UserManagementPage.tsx` (role option + `notel` field)

**Interfaces:**
- Produces (BE): `Api_base::require_role_in(array $roles)` helper returning/asserting the current user's role is in `$roles` (403 otherwise); `admin_users.notel` persisted on create/update.
- Produces (FE): `UserRole` includes `'verifikator'`; user form sends/edits `notel`.

- [ ] **Step 1: Backend — add `verifikator` to both role whitelists in `Users.php`**

Read `Users.php`. At the two `$valid_roles` arrays (create ~line 42, update ~line 83), add `'verifikator'`:

```php
$valid_roles = ['superadmin', 'admin', 'operator', 'petugas_pst', 'resepsionis', 'pimpinan', 'verifikator'];
```

- [ ] **Step 2: Backend — persist `notel` on create and update**

In `Users.php`, read `notel` from input alongside the existing fields and include it in the insert (create) and update data arrays. Normalize: trim; allow empty → store `NULL`. Follow the surrounding pattern, e.g.:

```php
$notel = trim((string) $this->input->post('notel'));
// ...in the insert/update $data array:
'notel' => ($notel === '' ? null : $notel),
```

- [ ] **Step 3: Backend — hierarchy + allow-list helper in `Api_base.php`**

Read `Api_base.php`. In the `$role_level` map (~line 106) add:

```php
'verifikator' => 1,
```

Then add a helper near `require_role()` (~line 102) for explicit allow-lists (the delivery endpoints use this, not numeric levels):

```php
/**
 * 403 unless the authenticated user's role is in $roles.
 * Call AFTER require_auth().
 */
protected function require_role_in(array $roles)
{
    $role = isset($this->current_user->role) ? $this->current_user->role : null;
    if (!in_array($role, $roles, true)) {
        $this->json_response(['success' => false, 'message' => 'Akses ditolak'], 403);
    }
}
```
(If a similar helper already exists, reuse it instead of adding a duplicate.)

- [ ] **Step 4: Frontend — extend `UserRole`**

`frontend/src/api/auth.ts`:
```ts
export type UserRole = 'superadmin' | 'admin' | 'operator' | 'resepsionis' | 'petugas_pst' | 'pimpinan' | 'verifikator'
```

- [ ] **Step 5: Frontend — role option + `notel` field in `UserManagementPage.tsx`**

Add to `ROLE_OPTIONS`:
```ts
{ value: 'verifikator', label: 'Verifikator' },
```
Add a `notel` text input to the create/edit form (place it after `nama`), wire it into the create payload (`POST /api/users`) and edit payload (`PUT /api/users/:id`) following the existing `nama` field's controlled-input pattern. Label it `No. WhatsApp` with placeholder `62812xxxxxxx`.

- [ ] **Step 6: Verify backend (curl) — create a verifikator with a phone**

```bash
# Log in as superadmin first to get the jwt_token cookie, then:
curl -sS -X POST https://bukutamu.bpsmalut.com:460/api/users \
  -b "jwt_token=<SUPERADMIN_JWT>" \
  -H 'Content-Type: application/json' \
  -d '{"username":"halima","password":"Verif1234","nama":"Halima","role":"verifikator","notel":"6285xxxxxxxxx"}' | head -c 400
mysql -e "SELECT id,username,role,notel FROM db_tamdes.admin_users WHERE username='halima';"
```
Expected: `success:true`; the row shows `role='verifikator'` (NOT empty — proves the ENUM ALTER worked) and the `notel` saved.

- [ ] **Step 7: Verify frontend**

```bash
cd /var/www/html/bukutamu/frontend && npm run lint && npm run build
```
Expected: lint clean, build passes.

- [ ] **Step 8: Commit**

```bash
git add backend/application/modules/api/controllers/Users.php backend/application/modules/api/controllers/Api_base.php frontend/src/api/auth.ts frontend/src/pages/admin/UserManagementPage.tsx
git commit -m "feat(roles): add verifikator role + admin_users.notel (BE whitelist/guard + FE form)"
```

---

## Task 3: Deliveries model + controller — CRUD core (no verification/WA yet)

**Files:**
- Create: `backend/application/modules/api/models/Delivery_model.php`
- Create: `backend/application/modules/api/controllers/Deliveries.php`
- Modify: `backend/application/config/routes.php`
- Create: `frontend/src/types/delivery.ts`
- Create: `frontend/src/api/deliveries.ts`

**Interfaces:**
- Produces (BE): `POST /api/deliveries` (multipart) → creates row `menunggu_verifikasi`, sets `short_code='V'+id`; `GET /api/deliveries?status=&id_kunjungan=` (paginated list); `GET /api/deliveries/:id`; `GET /api/deliveries/:id/file`; `DELETE /api/deliveries/:id` → `dibatalkan`.
- Produces (BE model): `Delivery_model::create($data):int`, `get($id):?object`, `list_filtered($filters,$page,$limit):array`, `update($id,$data):bool`, `with_context($id):?object` (joins guest + konsultasi for the verifier view).
- Produces (FE): `deliveriesApi` wrapper + `DataDelivery`, `DeliveryStatus`, `VerifDecision` types.
- Consumes: Task 1 schema; Task 2 `require_role_in`.

- [ ] **Step 1: Model — `Delivery_model.php`**

Create with CI3 Query Builder. Key methods (use bound params; cast ids to int in the controller):

```php
<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Delivery_model extends CI_Model
{
    public function create(array $data): int
    {
        $this->db->insert('data_deliveries', $data);
        return (int) $this->db->insert_id();
    }

    public function set_short_code(int $id): void
    {
        $this->db->where('id', $id)->update('data_deliveries', ['short_code' => 'V' . $id]);
    }

    public function get(int $id)
    {
        return $this->db->where('id', $id)->get('data_deliveries')->row();
    }

    public function update(int $id, array $data): bool
    {
        return (bool) $this->db->where('id', $id)->update('data_deliveries', $data);
    }

    // Oldest pending first — used by the verifier queue AND the WA FIFO mapping.
    public function list_filtered(array $f, int $page, int $limit): array
    {
        $this->db->from('data_deliveries d');
        if (!empty($f['status']))        $this->db->where('d.status', $f['status']);
        if (!empty($f['id_kunjungan']))  $this->db->where('d.id_kunjungan', (int) $f['id_kunjungan']);
        $total = $this->db->count_all_results('', false);   // keep query for the page fetch
        $rows = $this->db->order_by('d.created_at', 'ASC')
            ->limit($limit, ($page - 1) * $limit)->get()->result();
        return ['rows' => $rows, 'total' => (int) $total];
    }

    // Joined context for the verifier card: guest + the requested-data line.
    public function with_context(int $id)
    {
        $this->db->select('d.*, k.nomor_antrian, k.id_user, b.nama AS pemohon_nama, b.instansi, b.notel AS pemohon_notel,
                           kp.rincian_data, kp.wilayah_data, kp.tahun_awal, kp.tahun_akhir, kp.status_data')
            ->from('data_deliveries d')
            ->join('tamdes_kunjungan k', 'k.id_kunjungan = d.id_kunjungan', 'left')
            ->join('tamdes_buku b', 'b.id_user = k.id_user', 'left')
            ->join('konsultasi_pengunjung kp', 'kp.id = d.id_konsultasi', 'left')
            ->where('d.id', $id);
        return $this->db->get()->row();
    }
}
```
> Before writing, read an existing model (e.g. the consultations model) to confirm the real guest table/columns (`tamdes_buku`, `nama`, `instansi`, `notel`, `id_user`) and the visit join key (`tamdes_kunjungan.id_kunjungan`/`id_user`). Adjust names to match exactly.

- [ ] **Step 2: Controller — `Deliveries.php` (CRUD only; verify/materialize land in Task 4)**

Create `class Deliveries extends Api_base`. Reuse `Api_base` helpers: `require_auth()`, `require_role_in()`, `json_response()`, the WA media dir + MIME helpers from `Wa.php`'s pattern (re-implement small private helpers here or move shared ones — keep it DRY but don't over-refactor). Methods:

```php
// POST /api/deliveries  (multipart: id_kunjungan, id_konsultasi?, link_url?, note, file?)
public function index()
{
    $method = $this->input->method(true);
    if ($method === 'GET')  { return $this->_list(); }
    if ($method !== 'POST') { return $this->json_response(['success'=>false,'message'=>'Method not allowed'], 405); }

    $this->require_auth();
    $this->require_role_in(['petugas_pst','operator','admin','superadmin']);

    $id_kunjungan  = (int) $this->input->post('id_kunjungan');
    $id_konsultasi = $this->input->post('id_konsultasi') ? (int) $this->input->post('id_konsultasi') : null;
    $link_url      = trim((string) $this->input->post('link_url'));
    $note          = trim((string) $this->input->post('note'));

    if ($id_kunjungan <= 0) {
        return $this->json_response(['success'=>false,'message'=>'id_kunjungan wajib'], 422);
    }

    // Optional file (same rules as wa upload: <=25MB, finfo MIME whitelist).
    $media = $this->_store_upload_if_present();   // returns ['path','mime','name'] or null; 422-bails on bad file
    if ($link_url === '' && $media === null) {
        return $this->json_response(['success'=>false,'message'=>'Sertakan link atau file'], 422);
    }

    $this->load->model('delivery_model');
    $id = $this->delivery_model->create([
        'id_kunjungan'  => $id_kunjungan,
        'id_konsultasi' => $id_konsultasi,
        'channel'       => 'online',
        'link_url'      => $link_url === '' ? null : $link_url,
        'media_path'    => $media['path'] ?? null,
        'media_mime'    => $media['mime'] ?? null,
        'media_name'    => $media['name'] ?? null,
        'note_operator' => $note === '' ? null : $note,
        'status'        => 'menunggu_verifikasi',
        'created_by'    => (int) $this->current_user->id,
    ]);
    $this->delivery_model->set_short_code($id);

    // Task 5 hooks the verifier notification here:  $this->_notify_verifier($id);

    $this->_audit('delivery_create', $id);
    return $this->json_response(['success'=>true,'data'=>$this->delivery_model->get($id),'message'=>'OK'], 201);
}

public function detail($id)   // GET detail / PUT edit-resubmit (Task 4) / DELETE cancel
{ /* GET → with_context; DELETE → require operator role, set status='dibatalkan' (only if pending/revisi) */ }

public function file($id)     // GET /api/deliveries/:id/file  → serve media, path-traversal guarded (mirror Wa::media)
{ }

private function _list()      // GET list, paginated envelope
{ }
```
> `_store_upload_if_present()` and `file()` should mirror `Wa.php`'s upload/serve logic exactly (same `wa_media/` dir, `finfo` MIME authority, 25 MB cap, `bin2hex(random_bytes(16)).'.'.$ext` naming, `realpath` guard). Read `Wa::messages_upload()` and `Wa::media()` and follow them. Storing in `wa_media/` is deliberate — Task 4 reuses the file by inserting a `wa_messages` row that points at it.

- [ ] **Step 3: Routes — `config/routes.php`**

Add (place with the other `api/*` routes; order specific before generic):

```php
$route['api/deliveries']                 = 'api/deliveries/index';
$route['api/deliveries/(:num)/file']     = 'api/deliveries/file/$1';
$route['api/deliveries/(:num)/verify']   = 'api/deliveries/verify/$1';
$route['api/deliveries/(:num)']          = 'api/deliveries/detail/$1';
```

- [ ] **Step 4: Frontend types — `types/delivery.ts`**

```ts
export type DeliveryStatus = 'menunggu_verifikasi' | 'revisi' | 'disetujui' | 'terkirim' | 'dibatalkan'
export type VerifDecision = 'setuju' | 'revisi' | 'setuju_catatan'

export interface DataDelivery {
  id: number
  id_kunjungan: number
  id_konsultasi: number | null
  channel: 'online' | 'offline'
  link_url: string | null
  media_path: string | null
  media_mime: string | null
  media_name: string | null
  note_operator: string | null
  status: DeliveryStatus
  verif_decision: VerifDecision | null
  verif_note: string | null
  short_code: string | null
  created_at: string
}

// Joined verifier-card shape (GET /api/deliveries/:id)
export interface DataDeliveryDetail extends DataDelivery {
  nomor_antrian: string | null
  pemohon_nama: string | null
  instansi: string | null
  pemohon_notel: string | null
  rincian_data: string | null
  wilayah_data: string | null
  tahun_awal: number | null
  tahun_akhir: number | null
  status_data: number | null
}
```

- [ ] **Step 5: Frontend wrapper — `api/deliveries.ts`**

```ts
import apiClient from './client'
import type { ApiResponse, PaginatedResponse } from '@/types/api'
import type { DataDelivery, DataDeliveryDetail, VerifDecision } from '@/types/delivery'

export const deliveriesApi = {
  list: (params: { status?: string; id_kunjungan?: number; page?: number; limit?: number }) =>
    apiClient.get<PaginatedResponse<DataDelivery>>('/api/deliveries', { params }),
  get: (id: number) =>
    apiClient.get<ApiResponse<DataDeliveryDetail>>(`/api/deliveries/${id}`),
  fileUrl: (id: number) => `/api/deliveries/${id}/file`,
  create: (fd: FormData, onProgress?: (pct: number) => void) =>
    apiClient.post<ApiResponse<DataDelivery>>('/api/deliveries', fd, {
      onUploadProgress: onProgress ? (e) => onProgress(Math.round((e.loaded * 100) / (e.total || 1))) : undefined,
    }),
  verify: (id: number, decision: VerifDecision, note?: string) =>
    apiClient.put<ApiResponse<DataDelivery>>(`/api/deliveries/${id}/verify`, { decision, note }),
  resubmit: (id: number, fd: FormData) =>
    apiClient.put<ApiResponse<DataDelivery>>(`/api/deliveries/${id}`, fd),
  cancel: (id: number) =>
    apiClient.delete<ApiResponse<null>>(`/api/deliveries/${id}`),
}
```

- [ ] **Step 6: Verify backend (curl)**

```bash
# As an operator (petugas_pst) JWT:
curl -sS -X POST https://bukutamu.bpsmalut.com:460/api/deliveries \
  -b "jwt_token=<PST_JWT>" \
  -F "id_kunjungan=<REAL_VISIT_ID>" -F "link_url=https://drive.google.com/xyz" -F "note=Terlampir data final" | head -c 500
# Expect success:true, data.status=menunggu_verifikasi, data.short_code=V<id>

curl -sS -b "jwt_token=<PST_JWT>" "https://bukutamu.bpsmalut.com:460/api/deliveries?status=menunggu_verifikasi" | head -c 500
# Expect paginated list incl. the row

# Role gate: a resepsionis JWT must be rejected 403
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://bukutamu.bpsmalut.com:460/api/deliveries -b "jwt_token=<RESEPSIONIS_JWT>" -F "id_kunjungan=1" -F "link_url=x"
# Expect 403
```

- [ ] **Step 7: Verify frontend**

```bash
cd /var/www/html/bukutamu/frontend && npm run lint && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add backend/application/modules/api/controllers/Deliveries.php backend/application/modules/api/models/Delivery_model.php backend/application/config/routes.php frontend/src/types/delivery.ts frontend/src/api/deliveries.ts
git commit -m "feat(deliveries): data_deliveries CRUD resource + FE wrapper/types (online channel)"
```

---

## Task 4: Verify endpoint + approval materialization (BE)

**Files:**
- Modify: `backend/application/modules/api/controllers/Deliveries.php` (`verify()`, `detail()` PUT resubmit, `_materialize()`)
- Modify: `backend/application/modules/api/models/Delivery_model.php` (insert into `wa_messages`)

**Interfaces:**
- Produces: `PUT /api/deliveries/:id/verify {decision, note?}` applying the state machine and, on approval, inserting customer `wa_messages` rows; `PUT /api/deliveries/:id` (multipart) resubmitting a `revisi` row. A shared `Deliveries::apply_decision(int $id, string $decision, ?string $note, int $verifikator_id): array` that the WA reply path (Task 6) also calls.
- Consumes: Task 3 model; `wa_messages` table shape (`phone_norm`, `wa_chat_id`, `direction='out'`, `msg_type`, `body`, `media_path/mime/name`, `status='pending'`, `id_kunjungan`).

- [ ] **Step 1: Resolve the customer's WA address from the visit/session**

Add a model helper to find the session phone for a visit (so materialized messages go to the right address). Mirror how `Wa.php` resolves `phone_norm`/`wa_chat_id` for a visit (it links `wa_sessions.id_kunjungan` and `wa_messages`). Read `Wa.php` for the exact lookup and replicate:

```php
// Delivery_model.php
public function customer_addr(int $id_kunjungan)
{
    return $this->db->select('phone_norm, wa_chat_id')
        ->from('wa_sessions')->where('id_kunjungan', $id_kunjungan)
        ->order_by('id', 'DESC')->limit(1)->get()->row();
}

public function insert_wa_message(array $row): int
{
    $this->db->insert('wa_messages', $row);
    return (int) $this->db->insert_id();
}
```

- [ ] **Step 2: `apply_decision()` — the shared core (web + WA both call this)**

```php
// Deliveries.php
// Returns ['ok'=>bool,'status'=>string,'message'=>string] — caller renders to JSON (web) or WA text (Task 6).
public function apply_decision(int $id, string $decision, ?string $note, int $verifikator_id): array
{
    $this->load->model('delivery_model');
    $d = $this->delivery_model->get($id);
    if (!$d) return ['ok'=>false,'status'=>null,'message'=>'Pengiriman tidak ditemukan'];
    if ($d->status !== 'menunggu_verifikasi') {
        return ['ok'=>false,'status'=>$d->status,'message'=>'Pengiriman ini sudah diproses'];
    }
    $note = $note !== null ? trim($note) : null;
    if ($decision === 'revisi' && ($note === null || $note === '')) {
        return ['ok'=>false,'status'=>$d->status,'message'=>'Revisi wajib menyertakan catatan'];
    }

    $now = date('Y-m-d H:i:s');
    if ($decision === 'revisi') {
        $this->delivery_model->update($id, [
            'status'=>'revisi','verif_decision'=>'revisi','verif_note'=>$note,
            'id_verifikator'=>$verifikator_id,'verified_at'=>$now,
        ]);
        // Task 7 hooks operator notify here.
        $this->_audit('delivery_revisi', $id);
        return ['ok'=>true,'status'=>'revisi','message'=>"{$d->short_code} dikembalikan ke operator"];
    }

    // setuju | setuju_catatan → approve then materialize.
    $this->delivery_model->update($id, [
        'status'=>'disetujui','verif_decision'=>$decision,
        'verif_note'=>($decision==='setuju_catatan' ? $note : null),
        'id_verifikator'=>$verifikator_id,'verified_at'=>$now,
    ]);
    $this->_materialize($id);   // inserts wa_messages → connector sends
    $this->delivery_model->update($id, ['status'=>'terkirim']);
    $this->_audit('delivery_approve_' . $decision, $id);
    return ['ok'=>true,'status'=>'terkirim',
            'message'=>"{$d->short_code} disetujui & dikirim ke pemohon"];
}
```

- [ ] **Step 3: `_materialize()` — insert the customer wa_messages rows**

```php
// Deliveries.php
private function _materialize(int $id): void
{
    $this->load->model('delivery_model');
    $d = $this->delivery_model->get($id);
    $addr = $this->delivery_model->customer_addr((int) $d->id_kunjungan);
    if (!$addr) { log_message('error', "delivery $id: no wa address for kunjungan {$d->id_kunjungan}"); return; }

    $caption = (string) $d->note_operator;
    if ($d->link_url)        $caption = trim($caption . "\n" . $d->link_url);
    if ($d->verif_decision === 'setuju_catatan' && $d->verif_note) {
        $caption = trim($caption . "\nCatatan: " . $d->verif_note);
    }

    $base = [
        'phone_norm'   => $addr->phone_norm,
        'wa_chat_id'   => $addr->wa_chat_id,
        'id_kunjungan' => (int) $d->id_kunjungan,
        'direction'    => 'out',
        'status'       => 'pending',
    ];

    if ($d->media_path) {
        $type = strpos((string)$d->media_mime, 'image/') === 0 ? 'image' : 'document';
        $this->delivery_model->insert_wa_message($base + [
            'msg_type'=>$type, 'body'=>$caption,
            'media_path'=>$d->media_path, 'media_mime'=>$d->media_mime, 'media_name'=>$d->media_name,
        ]);
    } else {
        $this->delivery_model->insert_wa_message($base + ['msg_type'=>'text', 'body'=>$caption]);
    }
}
```
> Confirm `wa_messages` column names against `docs/migrations/2026-06-03-wa-messages.sql` before writing (esp. `phone_norm` vs `phone`). The connector already polls `direction='out' AND status='pending'` — no further wiring needed.

- [ ] **Step 4: `verify()` controller method (web entry to `apply_decision`)**

```php
public function verify($id)
{
    if ($this->input->method(true) !== 'PUT') return $this->json_response(['success'=>false,'message'=>'Method not allowed'],405);
    $this->require_auth();
    $this->require_role_in(['verifikator','admin','superadmin']);
    $decision = (string) $this->input->post('decision') ?: $this->_json_body('decision');
    $note     = $this->input->post('note') ?: $this->_json_body('note');
    if (!in_array($decision, ['setuju','revisi','setuju_catatan'], true)) {
        return $this->json_response(['success'=>false,'message'=>'decision tidak valid'],422);
    }
    $res = $this->apply_decision((int)$id, $decision, $note, (int)$this->current_user->id);
    return $this->json_response(
        ['success'=>$res['ok'], 'data'=>$this->delivery_model->get((int)$id), 'message'=>$res['message']],
        $res['ok'] ? 200 : 409
    );
}
```
> PUT bodies in CI3 aren't in `$this->input->post()` — read how other PUT endpoints (e.g. `Visits::status`) parse the JSON body and reuse that (`_json_body` placeholder above = that helper).

- [ ] **Step 5: `detail()` PUT — operator edit & resubmit a `revisi` row**

In `detail($id)`, on `PUT`: require operator allow-list; only allowed when `status='revisi'`; accept new `link_url`/`file`/`note`; update the row, `revisi_count = revisi_count + 1`, reset `status='menunggu_verifikasi'`, clear `verif_decision/verif_note/id_verifikator/verified_at`; re-fire the verifier notification (Task 5 hook). Show the same multipart handling as create.

- [ ] **Step 6: Verify (curl) — the three decisions**

```bash
# Setuju → terkirim, and a pending wa_messages row appears
curl -sS -X PUT https://bukutamu.bpsmalut.com:460/api/deliveries/<ID>/verify \
  -b "jwt_token=<VERIFIKATOR_JWT>" -H 'Content-Type: application/json' -d '{"decision":"setuju"}' | head -c 300
mysql -e "SELECT id,direction,msg_type,status,LEFT(body,40) FROM db_tamdes.wa_messages WHERE id_kunjungan=<VISIT_ID> ORDER BY id DESC LIMIT 3;"
mysql -e "SELECT id,status,verif_decision FROM db_tamdes.data_deliveries WHERE id=<ID>;"
# Expect delivery status=terkirim; a wa_messages out/pending row with the caption(+link).

# Revisi without note → 422
curl -sS -o /dev/null -w "%{http_code}\n" -X PUT .../api/deliveries/<ID2>/verify -b "jwt_token=<VERIFIKATOR_JWT>" -H 'Content-Type: application/json' -d '{"decision":"revisi"}'
# Expect 422

# Double-decision guard: verifying an already-terkirim row → 409
curl -sS -o /dev/null -w "%{http_code}\n" -X PUT .../api/deliveries/<ID>/verify -b "jwt_token=<VERIFIKATOR_JWT>" -H 'Content-Type: application/json' -d '{"decision":"setuju"}'
# Expect 409
```

- [ ] **Step 7: Commit**

```bash
git add backend/application/modules/api/controllers/Deliveries.php backend/application/modules/api/models/Delivery_model.php
git commit -m "feat(deliveries): verify endpoint + approval materialization into wa_messages; revisi resubmit"
```

---

## Task 5: Verifier WA notification on create/resubmit (BE)

**Files:**
- Modify: `backend/application/modules/api/controllers/Deliveries.php` (`_notify_verifier()` + call from create & resubmit)
- Modify (read/reuse): `backend/application/modules/api/controllers/Wa.php` (`wa_enqueue_user()` is `private` — add a thin reusable enqueue or a public wrapper; keep DRY)

**Interfaces:**
- Produces: on create/resubmit, a `wa_outbox` row (`msg_type='verif_request'`) to the verifier's `notel`, body per spec §4.2; `data_deliveries.verif_outbox_id` set to that row id.
- Consumes: `admin_users` where `role='verifikator'` (pick the active verifier's `notel`); `with_context()` for the body fields.

- [ ] **Step 1: Find the active verifier number**

```php
// Delivery_model.php
public function active_verifier()
{
    return $this->db->select('id, notel')->from('admin_users')
        ->where('role','verifikator')->where('active',1)
        ->where('notel IS NOT NULL')->order_by('id','ASC')->limit(1)->get()->row();
}
```
> Phase 1 assumes a single verifier (halima). Multi-verifier routing is future (spec §13).

- [ ] **Step 2: `_notify_verifier()` builds and enqueues the message**

```php
// Deliveries.php
private function _notify_verifier(int $id): void
{
    $this->load->model('delivery_model');
    $v = $this->delivery_model->active_verifier();
    if (!$v || !$v->notel) { log_message('error', "delivery $id: no active verifier notel"); return; }
    $d = $this->delivery_model->with_context($id);

    $parts = [];
    $parts[] = "🔔 Verifikasi Data  [{$d->short_code}]";
    $parts[] = "Pemohon : " . trim(($d->pemohon_nama ?: '-') . ($d->instansi ? " — {$d->instansi}" : ''));
    if ($d->nomor_antrian) $parts[] = "Antrian : {$d->nomor_antrian}";
    if ($d->rincian_data)  $parts[] = "Diminta : {$d->rincian_data}" . ($d->wilayah_data ? " ({$d->wilayah_data})" : '');
    $parts[] = "Disiapkan operator:";
    if ($d->link_url)   $parts[] = "  🔗 {$d->link_url}";
    if ($d->media_name) $parts[] = "  📎 {$d->media_name} (tinjau file di panel verifikasi)";
    if ($d->note_operator) $parts[] = "  Catatan: \"{$d->note_operator}\"";
    $parts[] = "Balas:  1 Setuju  ·  2 Revisi (mis. \"2 tahun 2023 belum ada\")  ·  3 Setuju+catatan";
    $body = implode("\n", $parts);

    // Reuse the existing outbox enqueue (add a public wrapper in Wa or duplicate the one-line insert).
    $this->db->insert('wa_outbox', [
        'phone_raw'=>$v->notel, 'wa_chat_id'=>$v->notel,
        'msg_type'=>'verif_request', 'body'=>$body,
        'id_kunjungan'=>(int)$d->id_kunjungan, 'status'=>'pending',
    ]);
    $this->delivery_model->update($id, ['verif_outbox_id'=>(int)$this->db->insert_id()]);
}
```

- [ ] **Step 3: Wire the hook**

In `index()` create (Task 3 Step 2) and `detail()` PUT resubmit (Task 4 Step 5), replace the `// Task 5 hooks…` comment with `$this->_notify_verifier($id);`.

- [ ] **Step 4: Verify (curl + DB)**

```bash
curl -sS -X POST https://bukutamu.bpsmalut.com:460/api/deliveries -b "jwt_token=<PST_JWT>" \
  -F "id_kunjungan=<VISIT_ID>" -F "link_url=https://drive.google.com/abc" -F "note=Data final" >/dev/null
mysql -e "SELECT id,phone_raw,msg_type,status,LEFT(body,80) FROM db_tamdes.wa_outbox WHERE msg_type='verif_request' ORDER BY id DESC LIMIT 1;"
mysql -e "SELECT id,verif_outbox_id FROM db_tamdes.data_deliveries ORDER BY id DESC LIMIT 1;"
```
Expected: one `verif_request` outbox row to halima's number with the formatted body; `verif_outbox_id` set on the delivery. (On a connected test connector, halima's phone receives the message.)

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Deliveries.php backend/application/modules/api/controllers/Wa.php
git commit -m "feat(deliveries): enqueue verifier WA notification (verif_request) on create/resubmit"
```

---

## Task 6: Verifier WA reply parsing (BE ingest branch)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`ingest()` — verifier-sender branch + parser + bot confirmation)

**Interfaces:**
- Produces: inbound messages from a `verifikator` `notel` are intercepted before the customer intake state machine; parsed as `1` / `2 <note>` / `3 <note>` (optional leading `short_code`); mapped FIFO to the oldest `menunggu_verifikasi`; applied via `Deliveries::apply_decision`; a confirmation enqueued back to the verifier. Non-verifier inbound is unchanged.
- Consumes: Task 4 `apply_decision`; Task 5 `active_verifier()`/oldest-pending lookup.

- [ ] **Step 1: Add a verifier-pending lookup to the model**

```php
// Delivery_model.php
public function oldest_pending_for_verifier(): ?object   // single-verifier Phase 1
{
    return $this->db->where('status','menunggu_verifikasi')
        ->order_by('created_at','ASC')->limit(1)->get('data_deliveries')->row();
}
public function by_short_code(string $code)
{
    return $this->db->where('short_code', $code)->where('status','menunggu_verifikasi')
        ->limit(1)->get('data_deliveries')->row();
}
public function is_verifier_phone(string $phone_norm): bool
{
    return (bool) $this->db->where('role','verifikator')->where('active',1)
        ->where("REPLACE(REPLACE(notel,'+',''),' ','') =", $phone_norm, false)
        ->count_all_results('admin_users');
}
```
> Match `is_verifier_phone` to the project's phone normalization (auto-memory `phone_cross_channel_identity`): normalize `notel` the SAME way inbound `phone_norm` is normalized. Prefer calling the existing normalize helper on both sides rather than SQL string-munging — read `Wa.php` for `normalize`/`phone_norm` and reuse it.

- [ ] **Step 2: Branch in `ingest()` — before the intake state machine**

Read `Wa.php::ingest()` to find where the normalized sender phone is known and BEFORE the wizard/state logic runs. Insert:

```php
// --- Verifier fast-path: a verifikator replying 1/2/3 is NOT a customer ---
$this->load->model('delivery_model');
if ($this->delivery_model->is_verifier_phone($phone_norm)) {
    $this->_handle_verifier_reply($phone_norm, $reply_to, trim((string) $body));
    return; // do NOT fall through to the customer intake state machine
}
```
(`$phone_norm`, `$reply_to` (the `wa_chat_id` to reply to), `$body` — use whatever the surrounding code already calls these.)

- [ ] **Step 3: The parser + confirmation**

```php
// Wa.php
private function _handle_verifier_reply(string $phone_norm, string $reply_to, string $text): void
{
    // Parse optional "V37" prefix, then a leading 1|2|3, then the rest as note.
    $target = null; $rest = $text;
    if (preg_match('/^\s*(V\d+)\b\s*(.*)$/i', $text, $m)) {
        $target = $this->delivery_model->by_short_code(strtoupper($m[1]));
        $rest = $m[2];
    }
    if (!preg_match('/^\s*([123])\b\s*(.*)$/s', $rest, $m2)) {
        return $this->_verifier_say($phone_norm, $reply_to,
            "Balas 1 (Setuju), 2 (Revisi) atau 3 (Setuju+catatan). Atau buka panel verifikasi di web.");
    }
    $digit = $m2[1]; $note = trim($m2[2]);
    if (!$target) $target = $this->delivery_model->oldest_pending_for_verifier();
    if (!$target) {
        return $this->_verifier_say($phone_norm, $reply_to, "Tidak ada permintaan verifikasi yang menunggu.");
    }

    $decision = ['1'=>'setuju','2'=>'revisi','3'=>'setuju_catatan'][$digit];
    if ($decision !== 'setuju' && $note === '') {
        return $this->_verifier_say($phone_norm, $reply_to,
            "Sertakan catatan, mis. \"{$digit} alasan/keterangan\". Atau gunakan panel web.");
    }

    $verifier = $this->delivery_model->active_verifier();
    $res = $this->_apply_delivery_decision((int)$target->id, $decision, ($decision==='setuju'?null:$note), (int)$verifier->id);
    $this->_verifier_say($phone_norm, $reply_to, $res['ok'] ? "✅ {$res['message']}" : "⚠️ {$res['message']}");
}

private function _verifier_say(string $phone_raw, string $reply_to, string $body): void
{
    $this->db->insert('wa_outbox', ['phone_raw'=>$phone_raw,'wa_chat_id'=>$reply_to,
        'msg_type'=>'verif_request','body'=>$body,'status'=>'pending']);
}
```
> `_apply_delivery_decision` calls `Deliveries::apply_decision`. Since that lives in another controller, either (a) move `apply_decision` + `_materialize` into `Delivery_model` (cleanest — both controllers then call the model), or (b) `require_once` and instantiate. **Recommended: refactor the decision/materialize logic into `Delivery_model` in Task 4** and have both `Deliveries::verify()` and this WA path call `delivery_model->apply_decision(...)`. Adjust Task 4 accordingly if you choose (a).

- [ ] **Step 4: Verify (simulate inbound) — the connector posts to `/api/wa/ingest` with an internal secret**

```bash
# Inspect ingest's expected payload first; then POST a synthetic verifier reply.
# Example shape (adapt field names to the real ingest contract):
curl -sS -X POST https://bukutamu.bpsmalut.com:460/api/wa/ingest \
  -H "X-Internal-Secret: <SECRET>" -H 'Content-Type: application/json' \
  -d '{"phone":"<HALIMA_PHONE_RAW>","body":"1","wa_chat_id":"<HALIMA_PHONE>@c.us"}' | head -c 300
mysql -e "SELECT id,status FROM db_tamdes.data_deliveries WHERE status='terkirim' ORDER BY id DESC LIMIT 1;"
mysql -e "SELECT msg_type,LEFT(body,40) FROM db_tamdes.wa_outbox ORDER BY id DESC LIMIT 1;"  # the ✅ confirmation
```
Expected: oldest pending → `terkirim`; a confirmation outbox row to halima. Test `2 kurang lengkap` (→ `revisi`) and a non-verifier phone (→ unchanged: still gets the intake wizard).

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/modules/api/models/Delivery_model.php
git commit -m "feat(wa): verifier reply fast-path (1/2/3 + inline note, FIFO/short-code) reusing apply_decision"
```

---

## Task 7: Web-push — verifier queue + operator revisi (BE)

**Files:**
- Modify: `backend/application/modules/api/controllers/Notifications.php` (`rules_for_role()`)
- Modify: `backend/application/modules/api/controllers/Deliveries.php` / `Delivery_model.php` (operator-revisi already runs in `apply_decision`; just ensure a notification surfaces)

**Interfaces:**
- Produces: `rules_for_role('verifikator')` returns a notification when `menunggu_verifikasi > 0`; operators get a `revisi` notification. The existing `notifier` service auto-pushes to `role=…` subscriptions.

- [ ] **Step 1: Add the verifikator rule**

Read `Notifications.php::rules_for_role()` (~line 91). Add a branch:

```php
if ($role === 'verifikator') {
    $cnt = (int) $this->db->where('status','menunggu_verifikasi')->count_all_results('data_deliveries');
    if ($cnt > 0) {
        $out[] = [
            'id'      => 'verif_pending',         // stable id; notifier diffs on (id,count)
            'type'    => 'verif_pending',
            'title'   => 'Verifikasi data menunggu',
            'message' => "$cnt permintaan menunggu verifikasi",
            'action_url' => '/admin/verifikasi',
            'count'   => $cnt,
            'ts'      => time(),
        ];
    }
}
```
> Match the exact return-shape and accumulation variable used by the other branches (the agent audit shows `{id,type,title,message,action_url,ts}` and an optional `count`). Follow them precisely.

- [ ] **Step 2: Operator revisi notification**

Add a rule so `petugas_pst` sees revisi bounce-backs (count of `status='revisi'` deliveries):

```php
// within the petugas_pst branch
$rev = (int) $this->db->where('status','revisi')->count_all_results('data_deliveries');
if ($rev > 0) {
    $out[] = ['id'=>'delivery_revisi','type'=>'delivery_revisi','title'=>'Data perlu revisi',
              'message'=>"$rev pengiriman dikembalikan verifikator",'action_url'=>'/admin/layanan-online',
              'count'=>$rev,'ts'=>time()];
}
```

- [ ] **Step 3: Verify (internal dispatch)**

```bash
curl -sS -X POST https://bukutamu.bpsmalut.com:460/api/notifications/dispatch \
  -H "X-Internal-Secret: <SECRET>" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('notifications_by_role',{}).get('verifikator'),indent=2))"
```
Expected: a `verif_pending` entry with the right count (after creating a pending delivery).

- [ ] **Step 4: Commit**

```bash
git add backend/application/modules/api/controllers/Notifications.php
git commit -m "feat(notifications): verifikator pending-queue push + operator revisi push"
```

---

## Task 8: Verifikasi web panel + nav gating (FE)

**Files:**
- Create: `frontend/src/pages/admin/VerifikasiPage.tsx`
- Modify: `frontend/src/App.tsx` (route `/admin/verifikasi`)
- Modify: `frontend/src/components/admin/TopNav.tsx` (nav item + verifikator-only filter)

**Interfaces:**
- Consumes: `deliveriesApi.list/get/verify/fileUrl`, `DataDeliveryDetail`.
- Produces: a working verifier queue UI; verifikator role sees ONLY the Verifikasi menu.

- [ ] **Step 1: `TopNav` — level + nav item + verifikator-only filter**

Add `verifikator: 1` to `ROLE_LEVEL`. Add a NAV item:
```ts
{ key: 'verifikasi', label: 'Verifikasi', to: '/admin/verifikasi', minRole: 'operator', allowedRoles: ['verifikator','admin','superadmin'] },
```
Then make verifikator see only items that explicitly allow it — in the `visibleItems` filter add, before the existing checks:
```ts
if (userRole === 'verifikator') return item.allowedRoles?.includes('verifikator') ?? false
```

- [ ] **Step 2: Router — add the route**

In `App.tsx`, register `<Route path="/admin/verifikasi" element={<VerifikasiPage />} />` inside the admin layout, following the existing admin routes' pattern (lazy import if the others are lazy).

- [ ] **Step 3: `VerifikasiPage.tsx`**

Build with react-query polling (mirror `LayananOnlineInboxPage`'s `refetchInterval`). Two lists: Menunggu (`status=menunggu_verifikasi`) and Riwayat (status in terkirim/revisi/dibatalkan — fetch separately or filter client-side). Each card renders pemohon/instansi/antrian/kontak, requested-data (`rincian_data`, `wilayah_data`, tahun range, `status_data`), the deliverable (link as `<a target=_blank>`, file via `<a href={apiClient defaults baseURL + deliveriesApi.fileUrl(id)}>` or an `<img>`/download), the operator note, and `short_code`. Actions:

```tsx
const verify = useMutation({
  mutationFn: (v: { id: number; decision: VerifDecision; note?: string }) =>
    deliveriesApi.verify(v.id, v.decision, v.note),
  onSuccess: () => { toast.success('Keputusan tersimpan'); qc.invalidateQueries({ queryKey: ['deliveries'] }) },
  onError: (e) => toast.error(getApiMessage(e)),
})
// Setuju → verify({id, decision:'setuju'})
// Revisi… / Setuju+Catatan… → open a textarea, then verify({id, decision, note})
```
Use `sonner` toasts, `clsx`/`cn` for status badge colors, no new state libs. Status badge colors: `menunggu_verifikasi`=amber, `revisi`=rose, `terkirim`=emerald, `dibatalkan`=zinc.

- [ ] **Step 4: Verify**

```bash
cd /var/www/html/bukutamu/frontend && npm run lint && npm run build
```
Then smoke at `localhost:5173`: log in as `halima` (verifikator) → only the **Verifikasi** menu shows → a pending card renders with the deliverable → click Setuju → it moves to Riwayat and (with a connected test connector) the customer receives the message.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/admin/VerifikasiPage.tsx frontend/src/App.tsx frontend/src/components/admin/TopNav.tsx
git commit -m "feat(verifikasi): verifier web panel + verifikator-only nav gating"
```

---

## Task 9: ChatPopup "Kirim Data" rework (FE)

**Files:**
- Modify: `frontend/src/components/wa/ChatPopup.tsx` (remove attachment/paste/drag-drop; add Kirim Data form; render deliverable bubbles)
- Modify: `frontend/src/pages/admin/LayananOnlineInboxPage.tsx` (status badge on conversation rows)

**Interfaces:**
- Consumes: `deliveriesApi.create/list`, the visit's `konsultasi_pengunjung` rows (existing `consultationsApi.../data` endpoint) for the bind dropdown, `DataDelivery`.
- Produces: operators send data only through the verified path; pending/revisi/terkirim deliverables are visible in-thread with labels.

- [ ] **Step 1: Remove ungated file sending**

Read `ChatPopup.tsx`. Remove: the paperclip button (~654-663), the hidden `<input type=file>` tied to `upload.mutate`, the Ctrl+V paste-to-send handler (~298-309), and any drag-drop handler. Keep the text composer + send button (`submitText`) untouched. Remove the now-unused `upload` mutation and `ALLOWED_MIME`/`fileRef` if nothing else uses them (let `npm run lint` flag leftovers).

- [ ] **Step 2: Add the "Kirim Data" button + form**

Add a button beside the send button that toggles a small inline panel (or a `@base-ui` dialog matching the codebase). Fields: Link (`<input type=url>`), File (`<input type=file accept={ALLOWED_MIME}>`, ≤25 MB — keep the existing size/MIME validation you removed, now scoped to this form), Note (`<textarea>`), and a Konsultasi `<select>` populated from the visit's requested-data lines. Submit:

```tsx
const create = useMutation({
  mutationFn: (fd: FormData) => deliveriesApi.create(fd, setPct),
  onSuccess: () => { toast.success('Data dikirim untuk verifikasi'); setForm(initial); qc.invalidateQueries({ queryKey: ['deliveries', phone] }) },
  onError: (e) => toast.error(getApiMessage(e)),
})
function submitKirimData() {
  if (!link && !file) return toast.error('Sertakan link atau file')
  const fd = new FormData()
  fd.append('id_kunjungan', String(idKunjungan))
  if (idKonsultasi) fd.append('id_konsultasi', String(idKonsultasi))
  if (link) fd.append('link_url', link)
  if (note) fd.append('note', note)
  if (file) fd.append('file', file)
  create.mutate(fd)
}
```
> `ChatPopup` must know `id_kunjungan` for the conversation — it already links visits via the session; pass it in from the inbox row (the session carries `id_kunjungan`). If a conversation has no visit yet, disable "Kirim Data" with a tooltip ("Pemohon belum mengisi formulir").

- [ ] **Step 3: Render deliverable bubbles with status labels**

Query `deliveriesApi.list({ id_kunjungan })` (polling) and render each as an operator-only bubble (visually distinct from `wa_messages`), showing the deliverable summary + a status chip:
```tsx
const LABEL: Record<DeliveryStatus,{t:string;c:string}> = {
  menunggu_verifikasi:{t:'⏳ Menunggu Verifikasi',c:'bg-amber-100 text-amber-800'},
  revisi:{t:'✏️ Revisi',c:'bg-rose-100 text-rose-800'},
  disetujui:{t:'✓ Disetujui',c:'bg-emerald-100 text-emerald-800'},
  terkirim:{t:'✓ Terkirim',c:'bg-emerald-100 text-emerald-800'},
  dibatalkan:{t:'Dibatalkan',c:'bg-zinc-100 text-zinc-600'},
}
```
For `revisi`, show `verif_note` and an "Edit & kirim ulang" action (`deliveriesApi.resubmit(id, fd)`). The actual customer-facing message still appears as a normal `wa_messages` bubble once `terkirim` (no special handling needed — it arrives via the existing message poll).

- [ ] **Step 4: Inbox row badge**

In `LayananOnlineInboxPage.tsx`, for each conversation show a small badge when it has a delivery in `menunggu_verifikasi`/`revisi` (a lightweight count from `deliveriesApi.list`, or fold counts into the existing inbox summary endpoint if cheaper). Keep it minimal.

- [ ] **Step 5: Verify**

```bash
cd /var/www/html/bukutamu/frontend && npm run lint && npm run build
```
Smoke at `localhost:5173` as `petugas_pst`: open a WA conversation with a visit → no paperclip/paste send remains → "Kirim Data" opens the form → submit link+note → a `⏳ Menunggu Verifikasi` bubble appears → (after halima approves) the real message bubble appears and the chip flips to `✓ Terkirim`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/wa/ChatPopup.tsx frontend/src/pages/admin/LayananOnlineInboxPage.tsx
git commit -m "feat(chat): replace attachment with verified Kirim Data flow + deliverable status bubbles"
```

---

## Task 10: DELETE-visit cascade + invariant check (BE)

**Files:**
- Modify: the visit-DELETE controller (confirm `backend/application/modules/api/controllers/Visits.php`)

**Interfaces:**
- Produces: deleting a visit also removes its `data_deliveries` rows AND unlinks their `media_path` files; existing child cascades + audit preserved.

- [ ] **Step 1: Locate the cascade**

```bash
grep -rn "delete" backend/application/modules/api/controllers/Visits.php | head -40
```
Find the DELETE handler that cascades to the 3 child tables + writes the audit log (auto-memory `admin_delete_visit`).

- [ ] **Step 2: Add the data_deliveries cascade (before deleting the visit)**

Inside the same transaction, before the parent delete:
```php
// unlink deliverable files, then delete rows
$dels = $this->db->select('media_path')->where('id_kunjungan',$id)
    ->where('media_path IS NOT NULL')->get('data_deliveries')->result();
foreach ($dels as $row) {
    $path = $this->wa_media_dir() . '/' . basename($row->media_path);   // basename guard
    if (is_file($path)) @unlink($path);
}
$this->db->where('id_kunjungan',$id)->delete('data_deliveries');
```
> Use the same media-dir helper the upload/serve code uses; `basename()` prevents traversal. Keep it inside the existing transaction so a failure rolls back with the rest.

- [ ] **Step 3: Verify**

```bash
# Create a throwaway visit + delivery with a file, capture the filename, delete the visit, confirm both gone.
mysql -e "SELECT id,id_kunjungan,media_path FROM db_tamdes.data_deliveries WHERE id_kunjungan=<TEST_VISIT_ID>;"
curl -sS -X DELETE https://bukutamu.bpsmalut.com:460/api/visits/<TEST_VISIT_ID> -b "jwt_token=<SUPERADMIN_JWT>" | head -c 200
mysql -e "SELECT COUNT(*) AS remaining FROM db_tamdes.data_deliveries WHERE id_kunjungan=<TEST_VISIT_ID>;"  # expect 0
# expect the media file no longer on disk
```

- [ ] **Step 4: Confirm the finalization gate is untouched**

Read the SKD status path — this feature must not let a visit reach `selesai` differently. Confirm no `data_deliveries` logic writes `tamdes_kunjungan.status`.

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Visits.php
git commit -m "feat(visits): cascade data_deliveries (+unlink files) on visit delete"
```

---

## Task 11: End-to-end smoke + deploy

**Files:** none (verification + deploy)

- [ ] **Step 1: Full FE gate**

```bash
cd /var/www/html/bukutamu/frontend && npm run lint && npm run build
```

- [ ] **Step 2: WA end-to-end on a test number** (connector connected to a test WA, halima = a test number)
  1. As `petugas_pst`, open a real WA conversation that has a visit → "Kirim Data" with a link + note.
  2. Confirm halima's test phone receives the `🔔 Verifikasi Data [V##]` message.
  3. Reply `1` → customer receives the link+note; delivery → `terkirim`; halima gets `✅ … disetujui`.
  4. New delivery → reply `2 data tahun 2023 belum ada` → customer receives nothing; operator sees `✏️ Revisi` + note; edit & resubmit → halima re-notified.
  5. New delivery → reply `3 data bersifat sementara` → customer receives the file/link **plus** `Catatan: data bersifat sementara`.
  6. Confirm a **non-verifier** number messaging the bot still gets the intake wizard (verifier branch didn't hijack everyone).

- [ ] **Step 3: Deploy (per the deploy skill)**
  - Migrations already applied (Task 1). **Backend:** `sudo apachectl -k graceful`; smoke `curl -o /dev/null -w "%{http_code}" https://bukutamu.bpsmalut.com:460/api/auth/check` → 401.
  - **Frontend:** bump `CACHE_NAME` in `frontend/public/sw.js`, `npm run build`, `pm2 restart bukutamu-frontend`, `pm2 logs --lines 30`.
  - **Connector:** no `wa/server.js` change → **do not restart** the warm connector.
  - **Notifier:** no restart needed (rules are read from the backend each poll); confirm `pm2 status bukutamu-notifier` healthy.

- [ ] **Step 4: Commit the SW bump**

```bash
git add frontend/public/sw.js
git commit -m "chore(deploy): bump SW CACHE_NAME for verifikator/data-delivery release"
```

- [ ] **Step 5: Report** — components touched, commit SHA, smoke results, and what was NOT verified (real customer flow, printer/offline — Phase 2).

---

## Self-Review (plan vs spec)

- **Spec coverage:** §3 model → Task 1; §4.1 operator UI → Task 9; §4.2 notif → Task 5; §4.3 reply parsing → Task 6; §4.4 materialize → Task 4; §5 role → Task 2 (+nav Task 8); §6 web panel → Task 8; §7 notifications → Task 7; §8 API → Tasks 3–4; §9 migrations/cascade/invariants → Tasks 1 & 10. Phase 2 (§10) intentionally out of scope.
- **Type consistency:** `apply_decision(id, decision, note, verifikator_id)` is defined in Task 4 and called in Task 6; decided to host it on `Delivery_model` so both controllers share it (noted in Task 6 Step 3). Status/decision/method enums use the single-source spellings in Global Constraints. `deliveriesApi` method names (`list/get/fileUrl/create/verify/resubmit/cancel`) defined in Task 3 and used in Tasks 8–9.
- **Open verification risks (flagged, not blocking):** exact `ingest()` payload field names, the PUT-body parse helper, and the guest table/columns must be confirmed against the real files at execution time — each such step says "read X and follow it." This is deliberate: the repo has no tests to catch a wrong column name, so the executor reads the actual file before writing.
- **Placeholder scan:** no TBD/TODO; every code step shows real code. The few `{ }`-bodied controller methods (Task 3 `detail/file/_list`) have their behavior fully specified in prose with the pattern to mirror — acceptable for a CRUD method whose twin (`Wa::media`) exists to copy.
