# Design Spec — WhatsApp Online Data-Request Channel (Layanan Online)

- **Date:** 2026-06-02
- **Status:** Draft for review (no code written yet)
- **Author:** brainstormed with Claude Code
- **Scope:** Add WhatsApp as an *online* intake channel for BPS Maluku Utara's
  data-service line (085176764422), folded into the existing buku tamu / PST
  system as a first-class channel — **without regressing** any offline behavior.
- **Revision:** v2 — incorporates the adversarial-review pass (eval token made a
  two-step exchange; physical-queue exclusion enumerated across 5 call sites;
  intake-token binding made non-circular; dispatch scan moved to an idempotent
  `POST`; intake field-trust hardened).

---

## 1. Context & problem

Buku tamu today records only **offline** visits (kiosk face check-in + admin
manual entry). The WhatsApp data-service line is a real PST service whose
traffic is invisible to the system: it isn't counted in `Queue_stats`, has no
visitor history, and produces no IKM/SKD evaluation data.

The WA line runs on the **free WhatsApp Business app** (the 6-field greeting is
the app's *pesan salam*). There is no official API. We will bridge it with
**whatsapp-web.js (wwebjs)** — an unofficial Web-automation library — isolated in
a single connector service, mirroring the existing `bukutamu-notifier`.

### Honest constraint (recorded, not a blocker)
wwebjs violates WhatsApp ToS and carries a non-zero **ban risk** for the 0851
number, needs a **persistent linked-device session** (one-time QR, headless
Chromium kept alive), and is **fragile** to WhatsApp Web UI changes. We accept
this deliberately and **isolate the entire risky surface in one PM2 service**;
if the number is jailed, bukutamu core is untouched. The official upgrade path
(Meta Cloud API) is out of scope (§12).

---

## 2. Goals / non-goals

### Goals
- Capture WA data-requests as **normal `tamdes_kunjungan` visits** so PST
  reporting, visitor history, and dedup unify automatically.
- The requester fills the **same questions as the kiosk `VisitorForm`** (minus
  biometric, phone auto-filled) **on a web form behind a link** — not via chat.
  Plus a **Permintaan Data** block (the structured ask).
- Identity keyed by **phone** (returning requester → pre-filled, low friction).
- Online **SKD** requests satisfy the `menunggu_evaluasi` gate **remotely** via a
  unique evaluation link — the SKD invariant is *preserved, not bypassed*.
- A dedicated **"Layanan Online" inbox** for triage; unified stats.
- **Zero regression** to the offline kiosk/queue/finalization flows.

### Non-goals (this iteration)
- No conversational/multi-turn bot Q&A (web form replaces chat parsing).
- No two-way status push beyond the 3 transactional messages (§6).
- No Meta Cloud API migration. No new `admin_users.role`. No new `status` enum.
- No new `jenis_layanan` value. **No modification to `Evaluations.php`.**

---

## 3. Key decisions (converged)

| # | Decision | Why (verified) |
|---|---|---|
| D1 | Link → **web form** intake (reuse `VisitorForm`), not chat parsing | Eliminates messy-text parsing; same validation as kiosk |
| D2 | WA request = **`jenis_layanan: "Konsultasi Statistik"`** (existing SKD inti) + channel marker, **hardcoded server-side** | A new service name breaks `validate_no_cross_layanan`/`validate_sarana_for_layanan`/`next_status_after_completion`/`layanan_requires_*` (Api_base hardcodes 7 names). Verified: `next_status_after_completion('Konsultasi Statistik')` → `menunggu_evaluasi` (Api_base.php:352-365) |
| D3 | Channel marker = **`created_by = 'whatsapp'`** (reuse existing column) | Mirrors `'kiosk'`/`'admin:user'`; avoids a NOT-NULL channel-column migration + NULL-backfill regression. `sarana = [2]` (PST Online) also marks it (verified in SKD whitelist `[1,2,4,9,16,32]`, Api_base.php:217-220) |
| D4 | Data-request rows stored in **`konsultasi_pengunjung`** (activate dormant cols) | The SKD form-complete gate counts `konsultasi_pengunjung`; a new table would read `COUNT=0` and block finalization |
| D5 | WA visits **excluded from every physical/operational queue view** (`nomor_antrian = NULL` + `created_by`-filter on 5 enumerated queries, §9) | A `status='antri'`/`menunggu_evaluasi` + `Konsultasi Statistik` row would otherwise leak into the PST queue, the bell count, the dashboard antri KPI, **and the kiosk eval tablet** |
| D6 | Remote eval = **two-step token**: link carries a durable `wa-eval-access` token (7d) → a new `GET /api/wa/eval/:id` mints a fresh short-lived `eval-submit` token (600s) **only while** `status='menunggu_evaluasi'` → eval page uses the **unchanged** `Evaluations` GET/POST | Keeps the submit token short (matches the existing 600s contract); a leaked/forwarded link can't submit after the eval is done or after auto-close; **`Evaluations.php` is not modified at all** |
| D7 | Pre-submit state in a **new `wa_sessions` staging table** (own status vocab, NOT the visit enum) | Keeps abandoned links out of `tamdes_kunjungan`/stats; no `status` enum pollution |
| D8 | Outbound via a **`wa_outbox` queue**; connector calls one **idempotent `POST /api/wa/poll`** (runs the dispatch scan + returns pending) then `POST /api/wa/ack` | Backend never depends on connector uptime; dedup via a sent-ledger; no GET-with-side-effects |
| D9 | Eval escape hatch = **remote link + system auto-close after 7 days (idempotent, audited) + existing admin/operator override** | petugas_pst cannot force SKD→selesai (soft-correct); 7-day system close is the fallback |

---

## 4. Architecture

```
                         SERVER (same host as backend; loopback only)
 ┌────────────┐  on('message')   ┌───────────────────────┐  X-Internal-Secret
 │ WhatsApp   │ ───────────────► │ bukutamu-wa (wwebjs)   │ ──── POST /wa/ingest ┐
 │ (0851...)  │ ◄─────────────── │  PM2 service, /wa dir  │ ─ POST /wa/poll ─────┤
 └────────────┘   sendMessage    │  LocalAuth session     │ ◄── pending msgs ────┤
       ▲                         └───────────────────────┘ ─ POST /wa/ack ──────┤
       │ link / confirm / eval-link / thankyou                                  │
       │                                                                        ▼
   ┌───┴───────────────┐   token-guarded web form (public)        ┌────────────────────────┐
   │ Requester browser │ ─ GET/POST /api/wa/session/:id ─────────►│ CI3 backend (Apache)   │
   │ /layanan-online/  │   (reuses VisitorForm + Permintaan Data)  │  NEW: api/wa/*          │
   │   :sessionId      │                                          │  REUSE (unchanged):     │
   │ /evaluasi/:id     │ ─ GET /api/wa/eval/:id (mint short tok) ─►│   Evaluations GET/POST, │
   │                   │ ─ then GET/POST /api/evaluations/:id ───►│   Visits/Consult/Dtsen, │
   └───────────────────┘   (UNCHANGED endpoints)                  │   Api_base guards       │
                                                                  └────────────────────────┘
                                                                            │
                                                          ┌─────────────────┴───────────────┐
                                                          │ db_tamdes                        │
                                                          │  REUSE: tamdes_buku,             │
                                                          │   tamdes_kunjungan,              │
                                                          │   konsultasi_pengunjung,         │
                                                          │   tamdes_evaluasi_detail         │
                                                          │  NEW: wa_sessions, wa_outbox     │
                                                          └──────────────────────────────────┘
```

### 4.1 Components
1. **`bukutamu-wa` connector** (new) — Node + `whatsapp-web.js`, PM2 process, in
   a new top-level `wa/` dir. `LocalAuth` persists the session (`wa/.wwebjs_auth/`,
   git-ignored). Config `wa/config.json` (git-ignored) reuses the **same**
   `push_internal_secret` and the backend base URL. Responsibilities:
   - `client.on('message')` for new inbound → `POST /api/wa/ingest`.
   - Each tick (30s, primed on startup like the notifier): `POST /api/wa/poll`
     (runs the idempotent dispatch scan, returns pending messages) →
     `client.sendMessage()` per message → `POST /api/wa/ack`.
   - Nothing else. No business logic, no DB access.
2. **`api/wa` backend module** (new controller `Wa.php`) — `ingest`, `poll`,
   `ack`, `session`, `eval` methods (§7). All visit/guest/consultation writes go
   through the **existing** validated helpers; this module is thin glue.
3. **Web pages** (new, thin) — `/layanan-online/:sessionId?t=…` reuses
   `VisitorForm` (no camera, phone prefilled) + a new `PermintaanDataForm` block;
   `/evaluasi/:id?t=…` reuses `EvaluationForm`, first exchanging the access token
   for a short `eval-submit` token via `GET /api/wa/eval/:id`.
4. **"Layanan Online" admin inbox** (new page) — filters visits by
   `created_by='whatsapp'`, own triage (new / diproses / menunggu_evaluasi /
   selesai). Offline Visit Log unchanged.

---

## 5. Data-model changes

### 5.1 New table `wa_sessions` (pre-submit / conversation state)
Keyed by phone + conversation; **own status vocab** (never the visit enum).

```sql
CREATE TABLE wa_sessions (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone_norm      VARCHAR(20) NOT NULL,          -- canonical 0xxx (see normalize_phone)
  phone_raw       VARCHAR(32) NOT NULL,          -- as seen on WA (62xxx/@c.us)
  state           ENUM('awaiting_form','submitted','expired') NOT NULL DEFAULT 'awaiting_form',
  id_kunjungan    INT NULL,                       -- set on submit (nullable; NOT a hard FK)
  link_sent_at    DATETIME NULL,
  submitted_at    DATETIME NULL,
  last_inbound_at DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (phone_norm, state),
  INDEX (id_kunjungan)
);
```
**Lifecycle (complete):**
- New inbound + **no open session** (`state='awaiting_form'`) for this phone →
  create session; mint `wa-intake` token bound to **`wa_sessions.id`**; enqueue
  `intake_link`. Inbound **while a session is open** → ignore (operator handles
  the conversation manually).
- On form submit → `state='submitted'`, set `id_kunjungan`, `submitted_at`.
  **Submitted sessions are kept** (history/audit), never auto-deleted.
- `awaiting_form` older than **48h** → `state='expired'` by the dispatch scan
  (idempotent); no visit created, no residue in `tamdes_kunjungan`.
- "Ask again" (§6.4): a closed/submitted session does **not** count as open, so
  the next inbound starts a fresh session → fresh link → new visit.
- Deleted via the DELETE cascade when its visit is deleted (R3).

### 5.2 New table `wa_outbox` (outbound queue + sent ledger)
```sql
CREATE TABLE wa_outbox (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone_raw     VARCHAR(32) NOT NULL,
  msg_type      ENUM('intake_link','confirmation','eval_link','thankyou') NOT NULL,
  body          TEXT NOT NULL,
  id_kunjungan  INT NULL,                         -- for confirmation/eval/thankyou
  status        ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at       DATETIME NULL,
  INDEX (status, created_at),
  INDEX (id_kunjungan, msg_type)                  -- dedup ledger: ≤1 eval_link / ≤1 thankyou per visit
);
```
- The `(id_kunjungan, msg_type)` index is the **dedup ledger**: the scan enqueues
  `eval_link`/`thankyou` only if no row already exists for that visit+type.

### 5.3 Reused columns — **no schema change**
- `tamdes_kunjungan.created_by` ← `'whatsapp'` (D3). `nomor_antrian` ← `NULL` (D5).
- `tamdes_buku.notel` ← stored canonical `0xxx`. **No UNIQUE constraint**
  (2 existing dupes; best-effort lookup like the kiosk's nama+notel dedup).
- `konsultasi_pengunjung` **dormant columns activated** for WA rows:
  `wilayah_data`, `tahun_awal`, `tahun_akhir`, `level_data`, `periode_data`
  (already nullable; the offline form leaves them null). `rincian_data` required;
  `status_data` default `4` (Belum Diperoleh); `hasil_konsultasi` filled by
  petugas later — same division of labor as offline. (The `Consultations::index`
  ghost-row filter keys on `rincian_data` non-empty (Consultations.php:31), which
  WA rows satisfy — no interference.)

### 5.4 Phone normalization (new helper, lookup-only)
`Api_base::normalize_phone($raw)` → canonical **local `0xxx`** form (matches
existing data + kiosk placeholder). Handles `+62xxx`, `62xxx`, `08xxx`, `8xxx`,
strips non-digits / `@c.us`. Used to set `wa_sessions.phone_norm`, look up an
existing guest by normalized `notel`, and store `notel` consistently.
**Not** enforced as a constraint.

### 5.5 The two existing duplicate `notel` rows
Verified: `082138077776`, `082213451083` (count=2 each). **Pre-launch work:**
inspect & merge/flag manually. Because lookup is best-effort (not UNIQUE), this
is *not* a hard blocker, but the lookup must handle "multiple matches"
explicitly (§6.1): pick most-recent + flag for the operator (never silently
merge or create a dup).

---

## 6. End-to-end flows

### 6.1 Intake (first-time or returning)
```
Visitor --(any msg)--> WA line
  connector on('message') → POST /api/wa/ingest {phone_raw, text}
    backend: normalize phone; open session for this phone?
      NO  → create wa_sessions(awaiting_form); mint token(purpose='wa-intake',
            bound_id = wa_sessions.id, ttl=48h);
            enqueue wa_outbox(intake_link, "https://…/layanan-online/{session.id}?t={token}")
      YES → no-op (operator handles continuation manually)
  connector (next poll) → sends ONE message: greeting + link

Visitor opens link → /layanan-online/:sessionId?t=… (web)
  GET /api/wa/session/:sessionId   [require_kiosk_token('wa-intake', sessionId); token in X-Kiosk-Token]
    backend guest lookup by normalized phone:
      1 match   → returning visitor: return prefilled Block A (locked/editable)
      >1 match  → return most-recent match + multi_match flag (operator reconciles)
      0 match   → new visitor: empty Block A
    always: empty Block B (Permintaan Data, multi-row)
  Submit → POST /api/wa/session/:sessionId   [same token + require_rate_limit('wa/intake',30)]
    backend (server-side authoritative — does NOT trust client for these):
      jenis_layanan := ["Konsultasi Statistik"]   (hardcoded, D2)
      sarana        := [2]                          (PST Online)
      created_by    := 'whatsapp'                   (hardcoded)
      nomor_antrian := NULL ; status := 'antri'     (hardcoded)
      validate_no_cross_layanan(jenis_layanan)      (defense-in-depth)
      validate_sarana_for_layanan(jenis_layanan, sarana)
      guest upsert by phone (LOCK TABLES, kiosk-style id_user generation)
      visit insert ; konsultasi_pengunjung rows from Block B
      wa_sessions → submitted + id_kunjungan
      enqueue wa_outbox(confirmation, "Terima kasih, tiket WA-{id_kunjungan}…")
  connector → sends confirmation
```
**Client field-trust rule (security):** the intake POST reads **only** Block A
guest fields + Block B consultation rows from the body. `status`, `created_by`,
`jenis_layanan`, `sarana`, `id_petugas`, `nomor_antrian` are **set by the
server**, never accepted from the request.

### 6.2 Handling (manual, petugas PST)
- WA visit appears in the **Layanan Online inbox** (`created_by='whatsapp'`), and
  is excluded from the physical PST queue / TV / bell / kiosk tablet (§9 R2).
- Petugas delivers data via **normal manual WA chat** (not automated), then
  records the outcome in the **existing** consultation UI: fills
  `hasil_konsultasi` + `status_data`, exactly like a walk-in. Saving runs the
  **unchanged** finalization gates →
  `next_status_after_completion('Konsultasi Statistik')` = **`menunggu_evaluasi`**.
- WA visits **skip `dipanggil`** (no queue call / no `nomor_antrian`) — legal,
  same as resepsionis visits. No `Consultations::call`.

### 6.3 Close + remote evaluation (SKD)
```
visit reaches menunggu_evaluasi (created_by='whatsapp')
  dispatch scan (POST /api/wa/poll): no eval_link ledger row for this visit?
    → mint_kiosk_token('wa-eval-access', id_kunjungan, ttl=7d)
      enqueue wa_outbox(eval_link, "Terima kasih + https://…/evaluasi/{id}?t={access_token}")
  connector → sends thank-you + eval link

Visitor opens /evaluasi/{id}?t={access_token}  (web, reuses EvaluationForm)
  GET /api/wa/eval/{id}            [require_kiosk_token('wa-eval-access', id)]
     backend: require created_by='whatsapp' AND status='menunggu_evaluasi'
              → mint_kiosk_token('eval-submit', id, 600) and return it
              (if status != menunggu_evaluasi → 409 "evaluasi sudah selesai/ditutup")
  GET  /api/evaluations/{id}   [X-Kiosk-Token = short eval-submit]   ← UNCHANGED endpoint
  POST /api/evaluations/{id}   [X-Kiosk-Token, all 16 indikator enforced FE-side]
       ← UNCHANGED endpoint → status menunggu_evaluasi → selesai
```
- **Non-SKD** (if petugas reclassified to DTSEN/Resepsionis via the existing
  service-change endpoint): no eval; on `selesai` the scan enqueues a plain
  `thankyou` (only when no `eval_link` row exists for the visit).

### 6.4 Repeat request
Same phone, **no open session**, new inbound → brand-new `wa_sessions` →
new link → new `tamdes_kunjungan` (same phone-matched guest). One guest, many
visits — existing model.

### 6.5 The idempotent dispatch scan (inside `POST /api/wa/poll`)
Runs every tick; **every step is idempotent and safe to repeat**:
1. **Expire sessions:** `UPDATE wa_sessions SET state='expired' WHERE
   state='awaiting_form' AND created_at < NOW() - INTERVAL 48 HOUR`.
2. **Enqueue eval_link:** for each `created_by='whatsapp'` visit with
   `status='menunggu_evaluasi'` and **no `eval_link` ledger row** → mint
   `wa-eval-access` (7d) + enqueue `eval_link`.
3. **Enqueue thankyou:** for each `created_by='whatsapp'` visit with
   `status='selesai'` and **no `eval_link` and no `thankyou` ledger row** →
   enqueue `thankyou` (covers non-SKD direct-close; SKD visits already got the
   eval_link which carries the thanks).
4. **Auto-close (D9):** `UPDATE … SET status='selesai', selesai_timestamp=NOW(),
   rating_pengunjung=NULL WHERE created_by='whatsapp' AND status='menunggu_evaluasi'
   AND NOT EXISTS(eval rows) AND eval_link.sent_at < NOW() - INTERVAL 7 DAY`, and
   write `tamdes_audit_log` (`action='auto_close_wa_eval'`) per affected row.
   **Idempotent:** once `selesai`, the row no longer matches.
5. Return `wa_outbox` rows with `status='pending'`.

*(This scan is the only place the WA feature writes a visit `status` directly. It
touches **only** `created_by='whatsapp'` rows and never the gate endpoints. Admin/
superadmin/operator manual override remains available as today.)*

---

## 7. API surface

### 7.1 New routes (`routes.php`, convention-matched, add after the kiosk routes)
```php
// internal-secret (connector ↔ backend, loopback only)
$route['api/wa/ingest']          = 'api/wa/ingest';        // POST  new inbound → maybe create session + enqueue intake_link
$route['api/wa/poll']            = 'api/wa/poll';          // POST  idempotent dispatch scan; returns pending outbox
$route['api/wa/ack']             = 'api/wa/ack';           // POST  mark messages sent

// public, kiosk-token-guarded (mirror api/evaluations/(:num) pattern: id in URL, token in X-Kiosk-Token)
$route['api/wa/session/(:num)']  = 'api/wa/session/$1';    // GET prefill / POST submit; token purpose 'wa-intake', bound to session id
$route['api/wa/eval/(:num)']     = 'api/wa/eval/$1';       // GET  exchange wa-eval-access → short eval-submit (if menunggu_evaluasi)
```
- Links sent to the requester: `…/layanan-online/{session_id}?t={wa-intake}` and
  `…/evaluasi/{id_kunjungan}?t={wa-eval-access}`. The numeric id in the URL is the
  **trusted** `bound_id`; the token (in `X-Kiosk-Token`) is validated against it —
  **not** circular (this is the `Evaluations::detail` pattern, Evaluations.php:102).

### 7.2 Reused endpoints (UNCHANGED — must not be modified)
- `GET /api/evaluations/{id}` + `POST /api/evaluations/{id}` — remote eval, driven
  by a short `eval-submit` token minted by `GET /api/wa/eval/:id`. `Evaluations.php`
  is **not edited**.
- Existing consultation/visit/service endpoints for petugas handling +
  reclassification. The WA module does **not** re-implement finalization.

### 7.3 Guard usage (verbatim reuse)
- `require_internal_secret()` — `ingest`, `poll`, `ack` (loopback + `X-Internal-Secret`, `hash_equals`; Api_base.php:551-564).
- `require_kiosk_token('wa-intake', session_id)` — `session` GET+POST.
- `require_kiosk_token('wa-eval-access', id_kunjungan)` — `eval` GET (then mints `eval-submit`, 600s).
- `require_rate_limit('wa/intake', 30)` — `session` POST (separate namespace from `kiosk/*`).

---

## 8. Invariants this design leans on (must NOT change)

(From the verification pass — `backend/application/modules/api/controllers/`)

- `Api_base::valid_statuses()` — 6 values; **no new status**.
- `Api_base::next_status_after_completion()` — SKD→`menunggu_evaluasi`,
  DTSEN/Resepsionis→`selesai`. **Verified** for `Konsultasi Statistik`. Reused unchanged.
- `Api_base::require_layanan_role()` bypass = admin/superadmin/operator;
  petugas_pst handles SKD. **No new role; no new bypass.**
- The 3-layer form-complete gates + soft-correct (SKD `selesai`→`menunggu_evaluasi`
  for non-bypass roles). WA goes **through** them, never around.
- `Evaluations.php` **entirely** — `pending`, `pending_list`, `detail` GET/POST,
  the `eval-submit` purpose, the status gate (`menunggu_evaluasi|selesai`), the
  30s re-submit cooldown. We add a WA `created_by` exclusion to `pending`/
  `pending_list` (R2) but do **not** change the token or submit logic. No JWT added.
- `Visits::detail` DELETE cascade (konsultasi_pengunjung, dtsen_konsultasi,
  tamdes_evaluasi_detail) — we **extend** it (R3), don't alter existing deletes.
- `validate_no_cross_layanan()` / `validate_sarana_for_layanan()` whitelist.
- `admin_users.role` enum (6 values) — unchanged.

---

## 9. Regression-prevention checklist (the "no regression" core)

**Governing principle:** *analytical/reporting* views **include + bucket** WA
(unified reporting is the goal); *operational/physical-queue* views **exclude**
WA (`created_by='whatsapp'`). Every row below is a verified risk + required fix.

| # | Risk (verified file:line) | Required mitigation |
|---|---|---|
| R1 | `Queue_stats.php:93-99` source split → `created_by='whatsapp'` silently lands in "Lainnya" | Init `'WhatsApp' => 0`; add `elseif ($cb === 'whatsapp')` bucket before the `else`. (Reporting view → WA included as its own bucket.) |
| R2 | **WA visits leak into 5 operational queries** | Add a `created_by <> 'whatsapp'` exclusion to **each**: ① `Consultations::index` (Consultations.php:24-42, before `order_by`) ② `Notifications::pst_queue_active` (Notifications.php:182-191, after the status filter) ③ `Dashboard::stats` **antri** count (Dashboard.php:51-52) ④ `Evaluations::pending` candidate query (Evaluations.php:32-35) ⑤ `Evaluations::pending_list` (Evaluations.php:80-86). **Pre-launch:** grep for any other `'antri'`/`'menunggu_evaluasi'` queue/TV feed and apply the same exclusion. |
| R3 | `wa_sessions`/`wa_outbox` not in DELETE cascade → orphans (`Visits.php:156-160`) | Add `->where('id_kunjungan',$id)->delete('wa_sessions')` and `…->delete('wa_outbox')` **before** deleting `tamdes_kunjungan` |
| R4 | Phone format mismatch (WA `62xxx` vs stored `0xxx`) → dedup misses | `normalize_phone()` at ingest + lookup; store canonical `0xxx` (§5.4) |
| R5 | 2 existing duplicate `notel` rows | Best-effort lookup (no UNIQUE); "multiple matches" → most-recent + `multi_match` flag surfaced to operator; manual pre-launch cleanup |
| R6 | New `jenis_layanan` would break 4 hardcoded validators | **Reuse `Konsultasi Statistik`**, hardcoded server-side (D2) |
| R7 | New table for request rows → SKD gate reads `COUNT=0` → finalization blocked | Store request rows in **`konsultasi_pengunjung`** (D4) |
| R8 | Intake trusting client for `status`/`created_by`/`jenis_layanan`/`sarana` | Server hardcodes them; body supplies only guest + consultation fields; validators still run (§6.1 field-trust rule) |
| R9 | `created_by` NULL on existing rows if a NOT-NULL channel column were added | Avoided: reuse `created_by` (D3), no channel-column migration |
| R10 | Connector restart re-sends queued outbound | Connector **primes** on startup (notifier pattern); `wa_outbox.status` ledger + `(id_kunjungan,msg_type)` dedup |
| R11 | Eval link leaked/forwarded | **Two-step token (D6)**: durable link token only *mints* a short submit token while `status='menunggu_evaluasi'`; after eval/auto-close the link is inert. Eval page shows visitor name/instansi for confirmation (existing). 30s cooldown still applies |
| R12 | `Guests::index` can't search by phone (`Guests.php:20-25`) | Add `->or_like('notel', $search)` to both search chains |
| R13 | Backend never enforces 16-indikator completeness (`Evaluations.php:187-196`) | Remote `EvaluationForm` enforces all-16 FE-side (reused), same as kiosk |
| R14 | `durasi_detik = selesai - date_visit`; meaningful only if `date_visit` is early | Set `date_visit` at visit-creation (intake submit) |
| R15 | WA rate-limit key collision with kiosk (same server IP) | Separate namespace `wa/intake` |
| R16 | WA using a different internal secret than the notifier | Reuse the **same** `push_internal_secret` |
| R17 | Admin panel renders dormant cols as "-" | Surface `wilayah_data`/`tahun`/`periode`/`level_data` in the consultation panel **when present** |
| R18 | Dispatch scan double-acting (re-close, re-send, re-expire) | All 5 scan steps idempotent (§6.5): auto-close filters `status='menunggu_evaluasi'`; enqueues gated by ledger; expire filters `awaiting_form` |

---

## 10. Security

- **Intake form is public** but kiosk-token-guarded (`wa-intake`, bound to the
  numeric `wa_sessions.id` from the URL — non-circular) + rate-limited
  (`wa/intake`, 30/min). Same posture as the kiosk public endpoints.
- **Internal endpoints** (`ingest`/`poll`/`ack`) are loopback-only +
  `X-Internal-Secret` (`require_internal_secret`, `hash_equals`). The connector
  runs on the **same host** as the backend (required for loopback), like the
  notifier — *not* on a kiosk.
- **Eval = two-step token (D6).** The durable link token (`wa-eval-access`, 7d,
  bound to `id_kunjungan`) **cannot itself submit** an evaluation; it only mints a
  short-lived `eval-submit` token (600s), and only while
  `status='menunggu_evaluasi'`. After the eval completes (→`selesai`) or after the
  7-day auto-close (→`selesai`), `GET /api/wa/eval/:id` returns 409 and no submit
  token is issued — so a forwarded/screenshotted link is inert past the window.
  This is strictly safer than a long-lived `eval-submit` token and keeps
  `Evaluations.php` untouched.
- **Secrets**: `wa/config.json` git-ignored (same convention as
  `notifier/config.json` and `backend/application/config/push.php`). Session auth
  state under `wa/.wwebjs_auth/` git-ignored.

---

## 11. UX notes
- The connector (not the Business-app *pesan salam*) sends the greeting + link,
  since wwebjs drives the account. Greeting text stays short.
- Returning requester (phone match) → Block A pre-filled; multi-match → operator
  reconciles (§6.1). New requester → full Block A.
- **Permintaan Data** block (multi-row "Tambah Data"): `rincian_data` (req),
  `level_data` (Nasional…Individu), `wilayah_data` (text), `periode_data`
  (Tahunan…Bulanan), `tahun_awal`/`tahun_akhir` (range). Specific months live in
  `rincian_data` text (no structured month column).
- **Eval link validity:** valid up to 7 days *and only until the eval is done /
  the visit auto-closes*. If a requester opens an expired/closed link, the page
  shows "evaluasi sudah ditutup"; an admin/operator can re-open via manual
  override if genuinely needed.

---

## 12. Out of scope / future
- **L3 two-way** (status push, conversational collection) — more outbound traffic
  (higher ban risk); revisit only if justified.
- **Meta Cloud API** migration — the compliant route; swaps the connector, keeps
  the backend/web-form/outbox/two-step-eval design intact.
- Re-opening eval **after** auto-close — not handled; auto-closed visits have
  `rating_pengunjung=NULL`.

---

## 13. Manual test plan (repo has no automated tests)

**Offline regression (must still pass unchanged):**
1. Kiosk check-in → face match → SKD service → ticket prints → **PST queue +
   TV + bell** show it → consultation → tablet eval → `selesai`. A WA visit must
   **not** appear in the PST queue, the bell count, the dashboard antri KPI, **or
   the kiosk eval tablet** (`Evaluations::pending`/`pending_list`).
2. DTSEN walk-in: prefix `D`, no eval, → `selesai`.
3. Resepsionis: keterangan gate, → `selesai`.
4. `Queue_stats` source split still shows Kiosk / Manual (Admin) correctly,
   **plus** a WhatsApp bucket once WA data exists.
5. Admin delete visit (offline) → cascade to 3 child tables intact. Delete a **WA**
   visit → `wa_sessions` + `wa_outbox` rows also deleted (no orphans).

**WA happy path:**
6. Message line → receive link → fill web form (new phone) → guest+visit created
   (`created_by='whatsapp'`, `nomor_antrian=NULL`, `status='antri'`) → confirmation
   received with `WA-{id}`. Confirm it appears in the **Layanan Online inbox**, not
   the PST queue.
7. Returning phone → link **prefills** Block A → only Permintaan Data → submit.
8. Petugas records hasil → `menunggu_evaluasi` → eval link received → open link →
   `GET /api/wa/eval/:id` issues a short token → web eval (16 indikator) →
   `selesai` → `Queue_stats` shows the **WhatsApp** bucket.
9. **Eval never opened → after 7 days** the scan auto-closes → `selesai`,
   `rating=NULL`, audit row `auto_close_wa_eval`. **9b. Idempotency:** re-run
   `POST /api/wa/poll` → the visit is **not** re-closed (`selesai_timestamp`
   unchanged), no duplicate audit row.
10. Abandoned link (no submit) → 48h → `wa_sessions.expired`, no visit row.

**Negative / security:**
11. Forged/expired `wa-intake` token, or `session_id` not matching the token's
    bound id → 403.
12. Intake POST attempting to set `status`/`created_by`/`jenis_layanan`/`sarana`
    in the body → ignored (server values win); cross-layanan/bad sarana → 400.
13. `ingest`/`poll`/`ack` without `X-Internal-Secret` or off-loopback → 403.
14. Eval link opened **after** the visit is `selesai`/auto-closed → `GET
    /api/wa/eval/:id` returns 409, **no** `eval-submit` token issued.
15. Connector restart → no duplicate outbound (priming + ledger).

---

## 14. Open questions for review
1. **Dashboard scope:** WA `selesai` visits currently count in the dashboard
   *total*/*completion %* (they're real services) but are excluded from the
   *antri* KPI (physical-queue depth). OK, or exclude WA from the offline
   dashboard entirely and rely on the WhatsApp bucket in `Queue_stats`?
2. **Auto-close reminder:** before the 7-day auto-close, send one reminder
   message, or close silently (current plan = silent, `rating=NULL`)?
3. **Greeting wording / link domain:** confirm the greeting text + that the form
   is served from `bukutamu.bpsmalut.com` (trusted origin) so WhatsApp link
   previews/warnings are minimized.
4. **Connector host & resources:** confirm headless Chromium on the backend host
   is acceptable (RAM/CPU) and the 0851 SIM is available to scan the QR.
5. **Multi-match phone reconciliation (R5):** is "most-recent + flag for operator"
   the desired behavior, or should the form ask the requester to disambiguate?
```
