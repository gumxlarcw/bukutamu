# WhatsApp Layanan Online — Category Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before sending any intake form, ask a WhatsApp user — in chat, by numbered reply — which service they want, and route each of three categories to the right flow.

**Architecture:** Add a pre-form `awaiting_category` state to the `wa_sessions` machine. `Wa.php::ingest()` sends a numbered menu to new contacts and parses the reply: `1` → existing data form; `2` → Data-Diri-only form → kiosk check-in (physical queue); `3` → no form, minimal `Lainnya Online` visit + live-chat handoff. A mitigation path lets a mis-categorized user (or petugas) switch to the data form, converting the existing visit instead of duplicating it. New service labels are registered as **no-eval** in both BE and FE taxonomy, and the kiosk check-in is filtered to offline pre-registrations only.

**Tech Stack:** CodeIgniter 3 (PHP, `Wa.php`/`Api_base.php`/`Kiosk.php`), MySQL `db_tamdes`, React 19 + TS + Vite (`frontend/src`), whatsapp-web.js connector (`wa/server.js`, unchanged here).

**Spec:** `docs/superpowers/specs/2026-06-29-wa-category-gate-design.md`

## Global Constraints

- **No automated test suite** (`testing.md`). Each task verifies via `php -l`, `npm run lint` + `npm run build`, `curl`, and SQL checks. Do NOT add a test framework without user sign-off.
- **Backend PHP is live-on-edit** (memory `infra_php_live_on_edit`): apply the migration in the SAME step as the code that depends on it; never deploy code that reads `wa_sessions.category` before the column exists.
- **FE↔BE parity** (memory `feedback_backend_parity`): taxonomy changes touch both sides in the same session.
- **Backup before edit** (CLAUDE.md): `cp {file} {file}.backup` immediately before the first edit of each file; `diff` after.
- **Commits:** NO `Co-Authored-By` trailer (project rule). Conventional `fix(wa):` / `feat(wa):` style.
- **Do NOT restart the warm WA connector** (memory `wa_connector_resilience`). This plan requires **no `wa/server.js` change**; the connector already forwards `text` to `/api/wa/ingest`.
- **Exact new `jenis_layanan` labels (verbatim):** `Daftar Antrian Offline`, `Lainnya Online`. Both must be **no-eval** (never added to any `$skd_services` array).
- **Menu = numbered text reply** (`1`/`2`/`3`), plus keyword `menu`/`0` to re-show. No interactive buttons.
- **Category values (verbatim):** `data`, `offline`, `lainnya`.
- **DB:** name is `db_tamdes`; root creds in `/root/.my.cnf` (`mysql db_tamdes -e "…"`).
- **Message copy:** Bahasa Indonesia, per spec §13.

---

### Task 1: DB migration — `wa_sessions.category` column + `wa_outbox.msg_type` ENUM 'menu'

**Files:**
- Modify (DB): table `wa_sessions`, table `wa_outbox`
- Create: `docs/migrations/2026-06-29-wa-category-gate.sql`

**Interfaces:**
- Produces: column `wa_sessions.category VARCHAR(16) NULL`; `wa_outbox.msg_type` accepts `'menu'`. All later backend tasks read/write these.

- [ ] **Step 1: Inspect current schema**

Run:
```bash
mysql db_tamdes -e "SHOW COLUMNS FROM wa_sessions; SHOW COLUMNS FROM wa_outbox LIKE 'msg_type';"
```
Expected: no `category` column; `msg_type` enum WITHOUT `'menu'`.

- [ ] **Step 2: Write the migration file**

Create `docs/migrations/2026-06-29-wa-category-gate.sql`:
```sql
-- WA Layanan Online category gate (2026-06-29)
ALTER TABLE wa_sessions
  ADD COLUMN category VARCHAR(16) NULL DEFAULT NULL COMMENT 'data|offline|lainnya — chosen in chat menu' AFTER state;

ALTER TABLE wa_outbox
  MODIFY COLUMN msg_type ENUM('intake_link','confirmation','eval_link','thankyou','group_notify','menu') NOT NULL;
```

- [ ] **Step 3: Apply the migration**

Run:
```bash
mysql db_tamdes < /var/www/html/bukutamu/docs/migrations/2026-06-29-wa-category-gate.sql
```

- [ ] **Step 4: Verify**

Run:
```bash
mysql db_tamdes -e "SHOW COLUMNS FROM wa_sessions LIKE 'category'; SHOW COLUMNS FROM wa_outbox LIKE 'msg_type';"
```
Expected: `category varchar(16) YES NULL`; `msg_type` enum now ends with `,'menu')`.

- [ ] **Step 5: Commit**

```bash
cd /var/www/html/bukutamu
git add docs/migrations/2026-06-29-wa-category-gate.sql
git commit -m "feat(wa): migration — wa_sessions.category + wa_outbox msg_type 'menu'"
```

---

### Task 2: Backend taxonomy/eval parity — register new labels as no-eval (`Api_base.php`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Api_base.php` (role→services list ≈148-151; leave all `$skd_services` arrays untouched)

**Interfaces:**
- Consumes: label strings `Daftar Antrian Offline`, `Lainnya Online`.
- Produces: petugas_pst role can see `Lainnya Online`; both labels excluded from SKD eval derivation (so `derive_status_after_*` returns `selesai`, never `menunggu_evaluasi`).

- [ ] **Step 1: Read the role/eval logic**

Run:
```bash
sed -n '120,210p;330,372p' backend/application/modules/api/controllers/Api_base.php
```
Confirm: `$skd_services` lists (≈190, 226, 289, 350) contain only the 4 inti; the role→services list (≈148-151) enumerates PST-visible services; eval derivation (≈349-358) returns `menunggu_evaluasi` only when a service is in `$skd_services`.

- [ ] **Step 2: Backup**

```bash
cp backend/application/modules/api/controllers/Api_base.php backend/application/modules/api/controllers/Api_base.php.backup
```

- [ ] **Step 3: Add `Lainnya Online` to the petugas_pst role-visible services**

In the PST role services array (≈148-151, the list that currently holds `'Konsultasi Statistik'`, `'Perpustakaan'`, `'Rekomendasi Kegiatan Statistik'`, `'Penjualan Produk Statistik'`, `'Konsultasi DTSEN'`), append `'Lainnya Online'`:
```php
            'Konsultasi Statistik',
            'Rekomendasi Kegiatan Statistik',
            'Penjualan Produk Statistik',
            'Konsultasi DTSEN',
            'Lainnya Online', // WA category #3 — PST-handled online, no eval
```
Do NOT add either new label to any `$skd_services` array (keeping them out is what makes them no-eval). `Daftar Antrian Offline` needs no role entry: pre-arrival it lives in the created_by='whatsapp' online inbox; after kiosk promotion its label is overwritten with the real service.

- [ ] **Step 4: Verify no eval leak + lint**

Run:
```bash
php -l backend/application/modules/api/controllers/Api_base.php
grep -n "Lainnya Online\|Daftar Antrian Offline" backend/application/modules/api/controllers/Api_base.php
grep -n "skd_services" backend/application/modules/api/controllers/Api_base.php
```
Expected: lint clean; `Lainnya Online` appears ONLY in the role list (never inside an `$skd_services = [...]`).

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Api_base.php
git commit -m "feat(wa): taxonomy — Lainnya Online visible to PST, no-eval; Daftar Antrian Offline no-eval"
```

---

### Task 3: Frontend taxonomy parity (`types/visit.ts` + `lib/role-access.ts`)

**Files:**
- Modify: `frontend/src/types/visit.ts` (`SERVICE_OPTIONS`)
- Modify: `frontend/src/lib/role-access.ts` (group sets)

**Interfaces:**
- Consumes: label strings (Task 2).
- Produces: FE renders/labels/routes both new services; `Lainnya Online` classified PST/no-eval, `Daftar Antrian Offline` front-office/no-eval.

- [ ] **Step 1: Read current taxonomy**

Run:
```bash
sed -n '1,30p' frontend/src/lib/role-access.ts
grep -n "SERVICE_OPTIONS" frontend/src/types/visit.ts
```

- [ ] **Step 2: Backup both**

```bash
cp frontend/src/types/visit.ts frontend/src/types/visit.ts.backup
cp frontend/src/lib/role-access.ts frontend/src/lib/role-access.ts.backup
```

- [ ] **Step 3: Add labels to `SERVICE_OPTIONS`**

In `frontend/src/types/visit.ts`, append to the `SERVICE_OPTIONS` array (after `'Konsultasi DTSEN'`):
```ts
  'Daftar Antrian Offline',
  'Lainnya Online',
```

- [ ] **Step 4: Classify in `role-access.ts`**

Add `'Lainnya Online'` to the same set/array that `'Konsultasi DTSEN'` belongs to **if** that set means "PST role, no SKD eval"; otherwise add a no-eval PST grouping. Add `'Daftar Antrian Offline'` to `RESEPSIONIS_SERVICES`. Concretely, alongside the existing arrays:
```ts
// WA online category labels (no SKD eval):
//  - 'Lainnya Online'        → PST handles via chat, finishes to 'selesai'
//  - 'Daftar Antrian Offline'→ front-office pre-registration (overwritten at kiosk)
export const RESEPSIONIS_SERVICES = [...] // add 'Daftar Antrian Offline'
```
Ensure neither label lands in `SKD_SERVICES` (that drives the FE eval expectation).

- [ ] **Step 5: Lint + build**

Run:
```bash
cd frontend && npm run lint && npm run build && cd ..
```
Expected: clean; no "service not assignable" type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/visit.ts frontend/src/lib/role-access.ts
git commit -m "feat(wa): FE taxonomy — add Daftar Antrian Offline + Lainnya Online (no-eval)"
```

---

### Task 4: Backend — send menu on new contact + add `awaiting_category` to active-session query (`Wa.php::ingest()`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`ingest()` ≈29-75; add helpers near `wa_menu_text`)

**Interfaces:**
- Consumes: `wa_sessions.category` (Task 1), `msg_type='menu'` (Task 1).
- Produces: helpers `wa_menu_text()`, `wa_enqueue_user($phone_raw,$reply_to,$type,$body)`; new contacts land in `state='awaiting_category'`; the active-session query returns `awaiting_category` rows with `phone_raw,phone_norm,category,id_kunjungan`.

- [ ] **Step 1: Backup**

```bash
cp backend/application/modules/api/controllers/Wa.php backend/application/modules/api/controllers/Wa.php.backup
```

- [ ] **Step 2: Add the two helpers** (place beside `wa_notify_group_enqueue`, ≈1133)

```php
    // Pesan menu kategori (balasan angka) — dikirim ke pemohon sebelum form apa pun.
    private function wa_menu_text() {
        return "Selamat datang di Layanan Online BPS Maluku Utara 👋\n\n"
             . "Silakan pilih layanan (balas dengan ANGKA):\n"
             . "*1.* Permintaan Data / Konsultasi Statistik\n"
             . "*2.* Daftar Antrian Offline (datang ke kantor)\n"
             . "*3.* Lainnya";
    }

    // Enqueue pesan ke PEMOHON (bukan grup). msg_type harus valid ENUM wa_outbox.
    private function wa_enqueue_user($phone_raw, $reply_to, $type, $body) {
        $this->db->insert('wa_outbox', ['phone_raw' => $phone_raw, 'wa_chat_id' => $reply_to, 'msg_type' => $type, 'body' => $body, 'status' => 'pending']);
    }
```

- [ ] **Step 3: Extend the active-session query** (≈29-37) to also match `awaiting_category` and to SELECT the fields the parser (Task 5) needs

Replace the query with:
```php
        $open = $this->db->query(
            "SELECT s.id, s.state, s.phone_raw, s.phone_norm, s.category, s.id_kunjungan
             FROM wa_sessions s
             LEFT JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
             WHERE s.phone_norm = ?
               AND ( (s.state IN ('awaiting_category','awaiting_form') AND s.created_at > (NOW() - INTERVAL 48 HOUR))
                     OR (s.state = 'submitted' AND k.status IS NOT NULL AND k.status <> 'selesai') )
             ORDER BY s.id DESC LIMIT 1",
            [$phone_norm]
        )->row();
```
(The active-session BODY at ≈38-41 is replaced in Task 5; leave it for now — it will still return `new=false`.)

- [ ] **Step 4: New contact → `awaiting_category` + send menu** (replace the new-session block ≈44-73)

```php
        // Kontak baru → state awaiting_category, kirim MENU (belum kirim link form).
        // Ping grup "Kontak Baru" DITUNDA sampai kategori dipilih (lihat parser) → kurangi noise.
        $this->db->insert('wa_sessions', [
            'phone_norm'      => $phone_norm,
            'phone_raw'       => $phone_raw,
            'wa_chat_id'      => $reply_to,
            'state'           => 'awaiting_category',
            'last_inbound_at' => date('Y-m-d H:i:s'),
        ]);
        $sid = (int) $this->db->insert_id();
        $this->wa_enqueue_user($phone_raw, $reply_to, 'menu', $this->wa_menu_text());

        $this->json_response(['success' => true, 'data' => ['session_id' => $sid, 'new' => true], 'message' => 'OK']);
```

- [ ] **Step 5: Lint**

Run: `php -l backend/application/modules/api/controllers/Wa.php`
Expected: No syntax errors.

- [ ] **Step 6: Smoke-test a new contact** (simulate the connector; use the internal secret from `push.php`)

```bash
SECRET=$(php -r '$c=include "backend/application/config/push.php"; echo $GLOBALS["config"]["push_internal_secret"] ?? "";' 2>/dev/null)
# If the one-liner is empty, read the value manually from backend/application/config/push.php.
curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" \
  -H 'Content-Type: application/json' -d '{"phone":"628111000001","wa_id":"628111000001@c.us","text":"halo"}'
mysql db_tamdes -e "SELECT id,state,category FROM wa_sessions WHERE phone_norm='628111000001'; SELECT msg_type,LEFT(body,30) FROM wa_outbox WHERE phone_raw='628111000001';"
```
Expected: session `state='awaiting_category'`, `category NULL`; one `wa_outbox` row `msg_type='menu'` containing the menu. Clean up after: `mysql db_tamdes -e "DELETE FROM wa_outbox WHERE phone_raw='628111000001'; DELETE FROM wa_sessions WHERE phone_norm='628111000001';"`

- [ ] **Step 7: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): send category menu on new contact; awaiting_category state"
```

---

### Task 5: Backend — category reply parser + `#3` visit creation + group pings (`Wa.php::ingest()`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (active-session body ≈38-41; add private handlers)

**Interfaces:**
- Consumes: `wa_menu_text()`, `wa_enqueue_user()` (Task 4); `wa_notify_group_enqueue()`, `wa_known_name()`, `wa_public_base()`, `mint_kiosk_token()` (existing).
- Produces: handlers `wa_handle_category_choice($sess,$reply_to,$text)`, `wa_create_lainnya_visit($sess,$reply_to)`; sessions transition to `awaiting_form` (data/offline) or `submitted` (lainnya).

- [ ] **Step 1: Replace the active-session body** (≈38-41) with keyword + parser routing

```php
        if ($open) {
            $this->db->where('id', $open->id)->update('wa_sessions', ['last_inbound_at' => date('Y-m-d H:i:s'), 'wa_chat_id' => $reply_to]);
            $text = strtolower(trim((string) ($input['text'] ?? '')));

            // Mitigasi: keyword global → kembali ke menu kapan saja.
            if (in_array($text, ['menu', '0'], true)) {
                $this->db->where('id', $open->id)->update('wa_sessions', ['state' => 'awaiting_category', 'category' => null]);
                $this->wa_enqueue_user($open->phone_raw, $reply_to, 'menu', $this->wa_menu_text());
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // Sedang memilih kategori → proses pilihan.
            if ($open->state === 'awaiting_category') {
                $this->wa_handle_category_choice($open, $reply_to, $text);
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // Mitigasi: dari chat #2/#3, balas "1" → beralih ke form Permintaan Data (lihat Task 7).
            if ($text === '1' && in_array($open->category, ['offline', 'lainnya'], true)) {
                $this->wa_switch_to_data($open, $reply_to); // defined in Task 7
                $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
            }
            // awaiting_form / submitted lain → diam (petugas tangani live-chat).
            $this->json_response(['success' => true, 'data' => ['session_id' => (int) $open->id, 'new' => false], 'message' => 'OK']);
        }
```
(The `wa_switch_to_data` call is wired in Task 7; if implementing Task 5 alone, temporarily stub it as a re-prompt — but normal execution order does Task 7 next, so prefer to leave the call.)

- [ ] **Step 2: Add `wa_handle_category_choice()`** (beside the other helpers)

```php
    private function wa_handle_category_choice($sess, $reply_to, $text) {
        $sid = (int) $sess->id;
        if ($text === '1') {
            $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'data', 'link_sent_at' => date('Y-m-d H:i:s')]);
            $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
            $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
            $body  = "Baik 🙏 untuk *Permintaan Data / Konsultasi*. Mohon lengkapi formulir berikut (berlaku 48 jam):\n" . $link;
            $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', $body);
            return; // ping grup tetap saat submit (existing "Permintaan Data Online Masuk")
        }
        if ($text === '2') {
            $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'offline', 'link_sent_at' => date('Y-m-d H:i:s')]);
            $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
            $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
            $body  = "Baik 🙏 untuk *Daftar Antrian Offline*. Mohon lengkapi data diri Anda dulu (berlaku 48 jam):\n" . $link;
            $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', $body);
            return;
        }
        if ($text === '3') {
            $this->wa_create_lainnya_visit($sess, $reply_to);
            return;
        }
        // Tidak dikenali → ulangi menu.
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'menu', "Mohon balas dengan angka *1*, *2*, atau *3*.\n\n" . $this->wa_menu_text());
    }
```

- [ ] **Step 2b: Add `wa_create_lainnya_visit()`** (idempotent: re-check session not already submitted)

```php
    private function wa_create_lainnya_visit($sess, $reply_to) {
        $sid = (int) $sess->id;
        // Guard TOCTOU: kalau sudah submitted (balasan ganda), jangan buat visit kedua.
        $fresh = $this->db->select('state, id_kunjungan')->get_where('wa_sessions', ['id' => $sid])->row();
        if ($fresh && $fresh->state === 'submitted' && $fresh->id_kunjungan) return;

        $existing = $this->db->where('notel', $sess->phone_norm)->order_by('id_user', 'DESC')->limit(1)->get('tamdes_buku')->row();
        if ($existing) {
            $id_user = (int) $existing->id_user;
        } else {
            $max     = $this->db->select_max('id_user')->get('tamdes_buku')->row()->id_user;
            $id_user = $max ? $max + 1 : 8200001;
            $this->db->insert('tamdes_buku', ['id_user' => $id_user, 'nama' => ($this->wa_known_name($sess->phone_norm) ?: ''), 'notel' => $sess->phone_norm]);
        }
        $this->db->insert('tamdes_kunjungan', [
            'id_user' => $id_user, 'jenis_layanan' => json_encode(['Lainnya Online']), 'sarana' => json_encode([2]),
            'date_visit' => date('Y-m-d H:i:s'), 'status' => 'antri', 'nomor_antrian' => null, 'created_by' => 'whatsapp',
        ]);
        $idk = (int) $this->db->insert_id();
        $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'submitted', 'category' => 'lainnya', 'id_kunjungan' => $idk, 'submitted_at' => date('Y-m-d H:i:s')]);

        $body = "Baik 🙏 permintaan Anda sudah kami terima. Petugas kami akan membalas Anda di chat ini pada jam layanan (Sen–Jum 08.00–15.30 WIT).\n\n_Kalau ternyata Anda butuh data secara online, balas *1* untuk form Permintaan Data._";
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'confirmation', $body);
        $g = $this->wa_known_name($sess->phone_norm) ?: 'Pemohon';
        $this->wa_notify_group_enqueue("💬 *Lainnya — minta ditangani*\nNama: {$g}\nNomor: {$sess->phone_norm}\nTiket: WA-{$idk}\n" . $this->wa_public_base() . "/admin/layanan-online");
    }
```

- [ ] **Step 3: Lint**

Run: `php -l backend/application/modules/api/controllers/Wa.php`
Expected: clean.

- [ ] **Step 4: Smoke-test all three branches** (new contact → menu, then reply 1/2/3 on three separate phones)

```bash
SECRET=... # from push.php
ING() { curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "$1" >/dev/null; }
for p in 628111000011 628111000012 628111000013; do ING "{\"phone\":\"$p\",\"wa_id\":\"$p@c.us\",\"text\":\"halo\"}"; done
ING '{"phone":"628111000011","wa_id":"628111000011@c.us","text":"1"}'
ING '{"phone":"628111000012","wa_id":"628111000012@c.us","text":"2"}'
ING '{"phone":"628111000013","wa_id":"628111000013@c.us","text":"3"}'
mysql db_tamdes -e "SELECT phone_norm,state,category,id_kunjungan FROM wa_sessions WHERE phone_norm LIKE '6281110000%';"
mysql db_tamdes -e "SELECT k.id_kunjungan,k.jenis_layanan,k.status FROM tamdes_kunjungan k JOIN wa_sessions s ON s.id_kunjungan=k.id_kunjungan WHERE s.phone_norm='628111000013';"
```
Expected: `…011` → `awaiting_form/data` + an `intake_link` outbox; `…012` → `awaiting_form/offline` + `intake_link`; `…013` → `submitted/lainnya` with a `Lainnya Online` kunjungan (`status='antri'`) + a `confirmation` outbox + a `group_notify`. Clean up the three phones + their visits/guests afterward.

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): parse category reply (1/2/3, menu/0); create Lainnya Online visit + pings"
```

---

### Task 6: Backend — submit branching (offline = Data Diri only) + prefill returns `category` (`Wa.php`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`GET /api/wa/session/:id` prefill ≈720-745; submit handler ≈748-881, esp. the hardcode at ≈765-768 and inserts ≈798-875)

**Interfaces:**
- Consumes: `wa_sessions.category`.
- Produces: prefill JSON includes `"category"`; submit creates the correct visit per category (data: today's `Konsultasi Statistik`/sarana 2 + rows; offline: `Daftar Antrian Offline`/sarana 2, **no** rows, offline confirmation + ping).

- [ ] **Step 1: Prefill returns category** — in the GET handler (≈720-745), load the session row and add `category` to the JSON `data`. Add near the existing prefill response:
```php
        $sess = $this->db->select('category')->get_where('wa_sessions', ['id' => $id])->row();
        // …include in the response data array:
        'category' => $sess ? ($sess->category ?: 'data') : 'data',
```

- [ ] **Step 2: Read session category in the submit handler** — near the top of the POST branch (after the session is loaded, ≈752), capture:
```php
        $category = ($sess && !empty($sess->category)) ? $sess->category : 'data';
```
(Ensure the submit handler's session SELECT includes `category` — extend it if it only selects `state,id_kunjungan`.)

- [ ] **Step 3: Make service assignment category-aware** — replace the hardcode (≈765-768):
```php
            if ($category === 'offline') {
                $jenis_layanan = ['Daftar Antrian Offline'];
                $sarana        = [2]; // placeholder; di-overwrite saat wa_promote di kiosk
            } else { // 'data'
                $jenis_layanan = ['Konsultasi Statistik'];
                $sarana        = [2];
            }
```

- [ ] **Step 4: Skip data-only work for offline** — the permintaan-rows loop (≈821-850) iterates `$input['permintaan']`; for offline the FE sends none, so it inserts 0 rows automatically. Make the two confirmations + group ping branch on `$category`:
```php
            if ($category === 'offline') {
                $body = "Terdaftar ✅ untuk *Antrian Offline*.\nSaat tiba di kantor, di kiosk pilih *\"Sudah Daftar via WhatsApp\"*, masukkan nomor HP ini, lalu pindai wajah — Anda langsung masuk antrian.\nJam layanan: Sen–Jum 08.00–15.30 WIT.\n\n_Kalau ternyata Anda butuh data secara online, balas *1*._";
                $this->wa_enqueue_user($sess->phone_raw, $sess->wa_chat_id, 'confirmation', $body);
                $g_nama = trim((string) ($input['nama'] ?? '')) ?: ($this->wa_known_name($sess->phone_norm) ?: 'Pemohon');
                $this->wa_notify_group_enqueue("🗓️ *Daftar Antrian Offline*\nNama: {$g_nama}\nNomor: {$sess->phone_norm}\nTiket: WA-{$id_kunjungan}\n" . $this->wa_public_base() . "/admin/layanan-online");
            } else {
                // … existing 'data' confirmation (≈854-857) + "✅ Permintaan Data Online Masuk" ping (≈859-865) unchanged …
            }
```
(Confirm `$sess` carries `phone_raw`, `phone_norm`, `wa_chat_id` in the submit handler's session SELECT; extend it if needed.)

- [ ] **Step 5: Lint**

Run: `php -l backend/application/modules/api/controllers/Wa.php`

- [ ] **Step 6: Smoke-test offline submit** — drive a phone to `offline`, fetch its token, POST a Data-Diri-only payload:

```bash
SECRET=... ; P=628111000022
curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$P\",\"wa_id\":\"$P@c.us\",\"text\":\"halo\"}" >/dev/null
curl -s -X POST http://127.0.0.1:60/api/wa/ingest -H "X-Internal-Secret: $SECRET" -H 'Content-Type: application/json' -d "{\"phone\":\"$P\",\"wa_id\":\"$P@c.us\",\"text\":\"2\"}" >/dev/null
SID=$(mysql -N db_tamdes -e "SELECT id FROM wa_sessions WHERE phone_norm='$P' ORDER BY id DESC LIMIT 1")
TOK=$(php -r '...mint or read from wa-intake flow...') # or fetch via GET prefill token path used by the FE
# Submit Data-Diri only (no 'permintaan'):
curl -s -X POST "http://127.0.0.1:60/api/wa/session/$SID" -H 'Content-Type: application/json' \
  -d "{\"t\":\"$TOK\",\"nama\":\"Uji Offline\",\"notel\":\"$P\",\"permintaan\":[]}"
mysql db_tamdes -e "SELECT k.jenis_layanan,k.sarana,k.status,(SELECT COUNT(*) FROM konsultasi_pengunjung c WHERE c.id_kunjungan=k.id_kunjungan) rows FROM tamdes_kunjungan k JOIN wa_sessions s ON s.id_kunjungan=k.id_kunjungan WHERE s.phone_norm='$P';"
```
Expected: visit `jenis_layanan=["Daftar Antrian Offline"]`, `rows=0`, an offline `confirmation` + `group_notify`. Clean up afterward. (Token plumbing mirrors the FE `waApi.submitSession` call — reuse the exact param name the controller expects, `t`.)

- [ ] **Step 7: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): submit branches by category (offline = data-diri only); prefill returns category"
```

---

### Task 7: Backend — convert-on-switch (anti-duplicate mitigation) (`Wa.php`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (add `wa_switch_to_data()`; adjust submit to convert when a prior visit exists)

**Interfaces:**
- Consumes: parser routing (Task 5) calls `wa_switch_to_data($sess,$reply_to)` when `text==='1'` and `category∈{offline,lainnya}`.
- Produces: switching reuses the same `id_kunjungan`; submit converts an existing non-data visit instead of inserting a duplicate.

- [ ] **Step 1: Add `wa_switch_to_data()`**

```php
    private function wa_switch_to_data($sess, $reply_to) {
        $sid = (int) $sess->id;
        // Tidak bisa dialihkan kalau sudah check-in kiosk (sudah dilayani langsung).
        if (!empty($sess->id_kunjungan)) {
            $v = $this->db->select('created_by,status')->get_where('tamdes_kunjungan', ['id_kunjungan' => (int) $sess->id_kunjungan])->row();
            if ($v && ($v->created_by === 'wa_kiosk' || in_array($v->status, ['selesai', 'evaluasi_selesai'], true))) {
                $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'confirmation', "Mohon maaf, kunjungan Anda sudah diproses langsung sehingga tidak bisa dialihkan ke layanan online. Silakan mulai permintaan baru dengan membalas *menu*.");
                return;
            }
        }
        // Alihkan: kategori → data, kembali ke awaiting_form (id_kunjungan dipertahankan untuk konversi saat submit).
        $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'data', 'link_sent_at' => date('Y-m-d H:i:s')]);
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $this->wa_enqueue_user($sess->phone_raw, $reply_to, 'intake_link', "Baik 🙏 beralih ke *Permintaan Data*. Mohon lengkapi formulir berikut (berlaku 48 jam):\n" . $link);
    }
```

- [ ] **Step 2: Convert instead of insert in submit** — in the submit handler, where the visit is INSERTed (≈798-808), guard with the existing session `id_kunjungan`:
```php
        if (!empty($sess->id_kunjungan)) {
            // Konversi visit lama (#2/#3) → data: re-label + lanjut isi rows di bawah.
            $id_kunjungan = (int) $sess->id_kunjungan;
            $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', [
                'jenis_layanan' => json_encode($jenis_layanan), 'sarana' => json_encode($sarana),
                'status' => 'antri', 'created_by' => 'whatsapp', 'date_visit' => date('Y-m-d H:i:s'),
            ]);
        } else {
            // … existing INSERT (≈798-808) …
            $id_kunjungan = (int) $this->db->insert_id();
        }
```
The existing idempotency check (≈752-754) must NOT short-circuit a switch: only return the existing ticket when `state='submitted'` AND `category` is unchanged. Adjust that guard to `if ($fresh->state==='submitted' && $fresh->id_kunjungan && $fresh->category===$category)`.

- [ ] **Step 3: Lint**

Run: `php -l backend/application/modules/api/controllers/Wa.php`

- [ ] **Step 4: Smoke-test switch** — drive a phone to `lainnya` (creates a `Lainnya Online` visit), reply `1`, then submit a data payload; assert the SAME `id_kunjungan` is now `Konsultasi Statistik` with rows, and there is exactly ONE visit for that guest.

```bash
# … reuse the ING helper; pick P=628111000033; text "halo"→"3"→"1"; capture id_kunjungan before/after; submit with permintaan rows …
mysql db_tamdes -e "SELECT id_kunjungan,jenis_layanan FROM tamdes_kunjungan WHERE id_kunjungan=<idk>; SELECT COUNT(*) FROM tamdes_kunjungan k JOIN wa_sessions s ON s.id_kunjungan=k.id_kunjungan WHERE s.phone_norm='628111000033';"
```
Expected: same `id_kunjungan`, label now `Konsultasi Statistik`, rows>0, count=1 (no duplicate). Clean up.

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "feat(wa): mitigation — switch to data form converts existing visit (no duplicate)"
```

---

### Task 8: Backend — dispatch_scan expiry covers `awaiting_category` (`Wa.php`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (`wa_dispatch_scan()` session-expiry step ≈972-974)

**Interfaces:**
- Consumes: nothing new.
- Produces: stale `awaiting_category` sessions expire at 48h, like `awaiting_form`.

- [ ] **Step 1: Broaden the expiry `where`** — change the state match from `'awaiting_form'` to both:
```php
        $this->db->where_in('state', ['awaiting_form', 'awaiting_category'])
                 ->where('created_at <', date('Y-m-d H:i:s', time() - 48 * 3600))
                 ->update('wa_sessions', ['state' => 'expired']);
```

- [ ] **Step 2: Lint + verify**

Run: `php -l backend/application/modules/api/controllers/Wa.php`
Quick check: `grep -n "awaiting_category" backend/application/modules/api/controllers/Wa.php` shows it in the expiry, the active-session query, and the parser.

- [ ] **Step 3: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php
git commit -m "fix(wa): expire stale awaiting_category sessions at 48h"
```

---

### Task 9: Frontend — `LayananOnlinePage` offline mode + types (`frontend/src`)

**Files:**
- Modify: `frontend/src/pages/wa/LayananOnlinePage.tsx` (mode switch)
- Modify: `frontend/src/types/wa.ts` (add `category` to the prefill/session type)
- Modify: `frontend/src/api/wa.ts` (type the prefill response with `category`)

**Interfaces:**
- Consumes: prefill `category` (Task 6).
- Produces: when `category==='offline'`, the wizard shows ONLY Data Diri and submits `permintaan: []`.

- [ ] **Step 1: Backups**

```bash
cp frontend/src/pages/wa/LayananOnlinePage.tsx frontend/src/pages/wa/LayananOnlinePage.tsx.backup
cp frontend/src/types/wa.ts frontend/src/types/wa.ts.backup
cp frontend/src/api/wa.ts frontend/src/api/wa.ts.backup
```

- [ ] **Step 2: Add `category` to the session/prefill type** in `types/wa.ts`:
```ts
export type WaCategory = 'data' | 'offline' | 'lainnya'
// add to the prefill/session response interface:
  category?: WaCategory
```

- [ ] **Step 3: Read `category` and branch the wizard** in `LayananOnlinePage.tsx`:
- Derive `const isOffline = prefill?.category === 'offline'`.
- When `isOffline`: render only the **Data Diri** step (`VisitorForm`); do NOT render the "Data yang Dibutuhkan" step (`PermintaanDataForm`); change the step labels/progress to a single step; the submit sends `permintaan: []`.
```tsx
const isOffline = prefill?.category === 'offline'
// in submit mutation payload:
permintaan: isOffline ? [] : rows,
// in step rendering: guard the PermintaanDataForm step with `!isOffline`,
// and when isOffline, the Data Diri "lanjut" button submits directly.
```
- Header copy when offline: e.g. "Pendaftaran Antrian Offline — lengkapi data diri; saat tiba, check-in di kiosk."

- [ ] **Step 4: Lint + build**

Run: `cd frontend && npm run lint && npm run build && cd ..`
Expected: clean.

- [ ] **Step 5: Browser smoke** — open the offline link (`/layanan-online/<sid>?t=<token>` for an `offline` session) at `localhost:5173`; confirm only Data Diri shows and submit works; open a `data` session and confirm the 2-step form is unchanged.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/wa/LayananOnlinePage.tsx frontend/src/types/wa.ts frontend/src/api/wa.ts
git commit -m "feat(wa): offline mode in LayananOnlinePage (Data Diri only)"
```

---

### Task 10: Kiosk — `wa_lookup` offline-only filter (`Kiosk.php`)

**Files:**
- Modify: `backend/application/modules/api/controllers/Kiosk.php` (`wa_lookup()` visit query ≈404-409)

**Interfaces:**
- Consumes: `jenis_layanan` label `Daftar Antrian Offline`.
- Produces: kiosk check-in matches only offline pre-registrations.

- [ ] **Step 1: Backup**

```bash
cp backend/application/modules/api/controllers/Kiosk.php backend/application/modules/api/controllers/Kiosk.php.backup
```

- [ ] **Step 2: Add the offline filter** to the visit lookup (≈404-409):
```php
        $visit = $this->db->select('id_kunjungan, status')
                          ->where('id_user', $guest->id_user)
                          ->where('created_by', 'whatsapp')
                          ->like('jenis_layanan', 'Daftar Antrian Offline') // hanya pra-daftar OFFLINE yang boleh check-in kiosk
                          ->order_by('id_kunjungan', 'DESC')
                          ->limit(1)
                          ->get('tamdes_kunjungan')->row();
        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Tidak ada pendaftaran antrian offline untuk nomor ini. Untuk permintaan data online, balasan diproses lewat WhatsApp.'], 404);
        }
```

- [ ] **Step 3: Lint**

Run: `php -l backend/application/modules/api/controllers/Kiosk.php`

- [ ] **Step 4: Smoke-test** — create one `offline` visit and one `data` visit for two different phones; call `wa-lookup` for each:
```bash
curl -s -X POST http://127.0.0.1:60/api/kiosk/wa-lookup -H 'Content-Type: application/json' -d '{"phone":"<offline-phone>"}'   # expect success + id_kunjungan
curl -s -X POST http://127.0.0.1:60/api/kiosk/wa-lookup -H 'Content-Type: application/json' -d '{"phone":"<data-phone>"}'      # expect 404 "Tidak ada pendaftaran antrian offline"
```
Clean up the test rows.

- [ ] **Step 5: Commit**

```bash
git add backend/application/modules/api/controllers/Kiosk.php
git commit -m "fix(kiosk): wa-lookup only matches offline pre-registrations"
```

---

### Task 11: Mitigation — petugas "Kirim Form Permintaan Data" (BE endpoint + FE inbox button)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (new method `send_data_form($sid)`)
- Modify: `backend/application/config/routes.php` (register the route)
- Modify: admin Layanan Online inbox component (locate in Step 1) + `frontend/src/api/wa.ts`

**Interfaces:**
- Consumes: existing auth (`require_auth` + PST role check, mirror `qr_state` GET ≈926-927), `mint_kiosk_token('wa-intake',…)`.
- Produces: `POST /api/wa/sessions/:id/send-data-form` → sends the #1 form link to the visitor, sets `category='data'`, `state='awaiting_form'`.

- [ ] **Step 1: Locate the admin inbox component**

Run:
```bash
grep -rln "layanan-online\|LayananOnline\|wa_sessions\|wa-chat" frontend/src/pages/admin frontend/src/components 2>/dev/null | grep -vi backup
```
Note the inbox page/component file path for Step 5.

- [ ] **Step 2: Add the backend method** (`Wa.php`, near `qr_state`)

```php
    // POST /api/wa/sessions/(:num)/send-data-form (auth + PST) — petugas alihkan pemohon ke form Permintaan Data.
    public function send_data_form($sid) {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') $this->json_response(['success' => false, 'message' => 'Method not allowed'], 405);
        $this->require_auth();
        if (!$this->wa_is_pst_role()) $this->json_response(['success' => false, 'message' => 'Akses ditolak.'], 403);
        $sid  = (int) $sid;
        $sess = $this->db->get_where('wa_sessions', ['id' => $sid])->row();
        if (!$sess) $this->json_response(['success' => false, 'message' => 'Sesi tidak ditemukan'], 404);

        $this->db->where('id', $sid)->update('wa_sessions', ['state' => 'awaiting_form', 'category' => 'data', 'link_sent_at' => date('Y-m-d H:i:s')]);
        $token = $this->mint_kiosk_token('wa-intake', $sid, 48 * 3600);
        $link  = $this->wa_public_base() . '/layanan-online/' . $sid . '?t=' . rawurlencode($token);
        $this->wa_enqueue_user($sess->phone_raw, ($sess->wa_chat_id ?: $sess->phone_raw), 'intake_link', "Silakan lengkapi formulir Permintaan Data berikut (berlaku 48 jam):\n" . $link);
        $this->json_response(['success' => true, 'data' => null, 'message' => 'Form Permintaan Data dikirim.']);
    }
```

- [ ] **Step 3: Register the route** in `routes.php` (near the other `api/wa/*` routes):
```php
$route['api/wa/sessions/(:num)/send-data-form'] = 'api/wa/send_data_form/$1';
```

- [ ] **Step 4: Lint + curl**

Run: `php -l backend/application/modules/api/controllers/Wa.php`
Then `curl` the route with a valid admin `jwt_token` cookie (PST role) against a known `offline`/`lainnya` session; expect `success:true` and a new `intake_link` outbox row + session `category='data'`.

- [ ] **Step 5: FE — add the api wrapper + inbox button**

In `frontend/src/api/wa.ts`:
```ts
  sendDataForm: (sessionId: number) =>
    apiClient.post<ApiResponse<null>>(`/api/wa/sessions/${sessionId}/send-data-form`),
```
In the inbox component (from Step 1), add a button "Kirim Form Permintaan Data" (visible on `offline`/`lainnya` sessions) that calls `waApi.sendDataForm(sessionId)` via `useMutation`, toasts on success (`sonner`), and invalidates the relevant react-query key.

- [ ] **Step 6: Lint + build**

Run: `cd frontend && npm run lint && npm run build && cd ..`

- [ ] **Step 7: Commit**

```bash
git add backend/application/modules/api/controllers/Wa.php backend/application/config/routes.php frontend/src/api/wa.ts <inbox-component>
git commit -m "feat(wa): petugas action — Kirim Form Permintaan Data (re-route to #1)"
```

---

### Task 12: End-to-end manual verification (spec §16)

**Files:** none (verification + optional CHANGELOG note)

- [ ] **Step 1:** New WA DM → receives the **menu** (not a form link).
- [ ] **Step 2:** Reply `1` → data form → submit → `Konsultasi Statistik` visit + "Permintaan Data Online Masuk" ping + SKD eval flow intact (status reaches `menunggu_evaluasi`).
- [ ] **Step 3:** Reply `2` → Data-Diri-only form → submit → `Daftar Antrian Offline` visit (0 rows) + offline confirmation. `wa-lookup` finds it; a `data`/`lainnya` phone returns 404. `wa-promote` (face) overwrites the service, assigns `nomor_antrian`, `created_by='wa_kiosk'`.
- [ ] **Step 4:** Reply `3` → no form → `Lainnya Online` visit + "Lainnya" ping; petugas take over in inbox; verify dispatch_scan never enqueues an `eval_link` for `Daftar Antrian Offline`/`Lainnya Online` (they are no-eval).
- [ ] **Step 5:** Mitigation — from a #2/#3 chat reply `1` (and `menu`→`1`): same `id_kunjungan` converted (no duplicate). Petugas "Kirim Form Permintaan Data" sends the link.
- [ ] **Step 6:** Unrecognized reply re-prompts; 48h expiry sweeps `awaiting_category`; `php -l` on all changed controllers; `cd frontend && npm run lint && npm run build` clean.
- [ ] **Step 7 (deploy):** No connector restart needed (no `wa/server.js` change). Backend is live on save; `sudo apachectl -k graceful` optional. Build the FE (`npm run build`) and `pm2 restart bukutamu-frontend` to ship the wizard/inbox changes (see deploy skill).

---

## Self-Review

**Spec coverage:** §3 menu → T4; §4 #1/#2/#3 → T5/T6; §5 mitigation → T5/T7/T11; §6 state machine → T4/T5/T8; §7 data model → T1; §8 taxonomy parity → T2/T3; §9 kiosk filter → T10; §10 BE summary → T4-T8; §11 FE summary → T9/T11; §13 copy → T4/T5/T6; §14 edge cases → T5 (re-prompt/TOCTOU), T7 (post-kiosk block), T8 (expiry). All covered.

**Placeholder scan:** The only intentionally-deferred bits are smoke-test token plumbing in T6 Step 6 (mirrors the FE `submitSession` param `t`) and the inbox component path in T11 (a real grep step locates it). No "add error handling"/"TODO" placeholders.

**Type/name consistency:** helpers `wa_menu_text`, `wa_enqueue_user`, `wa_handle_category_choice`, `wa_create_lainnya_visit`, `wa_switch_to_data`, `send_data_form` used consistently; category values `data`/`offline`/`lainnya` and labels `Daftar Antrian Offline`/`Lainnya Online` verbatim throughout; `WaCategory` type matches.
