# Verifikator & Data Delivery — Design Spec

- **Date:** 2026-06-30
- **Status:** Approved design (pre-implementation)
- **Author:** brainstormed with user (wisnucandragumelar)
- **Scope:** Phase 1 = verifikator foundation + online (WhatsApp) delivery gate. Phase 2 = offline (flashdisk/printed) delivery menu (sketched, detailed later).

---

## 1. Problem & goal

PST delivers requested data **products** to customers two ways: **online** (via WhatsApp) and **offline** (physical / flashdisk / printed). Today, when an operator sends a file or link in the WA chat (`ChatPopup` paperclip / Ctrl+V paste / drag-drop → `POST /api/wa/messages/upload` → `wa_messages` row → connector sends), it reaches the customer **immediately, ungated**.

We want a **verifikator** (user `halima`) to approve every data deliverable before it reaches the customer. The verifier can decide:

1. **Setuju** — send the deliverable to the customer as-is.
2. **Revisi dengan catatan** — do NOT send; bounce back to the operator with a note to fix and resubmit.
3. **Setuju dengan tambahan catatan** — send the deliverable to the customer **with** the verifier's extra note shown to the customer.

The verifier acts from **WhatsApp** (quick reply `1` / `2 <note>` / `3 <note>`) **and** from a **web panel**. A tiny status label is visible to operators throughout.

### Goals (Phase 1)
- Add a `verifikator` role; store the verifier's WA number.
- Replace the chat attachment button with a verified **"Kirim Data"** button (link and/or file + note). Remove copy-paste / drag-drop file sending.
- Gate every online deliverable behind verification; deliver to the customer only on approval.
- Notify the verifier on WhatsApp (+ web-push) with customer detail, requested data, and the 1/2/3 menu.
- Web panel for the verifier to review and decide.
- Status labels on the deliverable in the chat and inbox.

### Non-goals (Phase 1)
- The offline PST delivery menu (Phase 2 — sketched in §10).
- Multi-attachment packages (one file + one link + note per delivery in v1).
- Re-sending uploaded **files** to the verifier's WhatsApp (she reviews files in the web panel; only links are tappable in the WA notif).

---

## 2. Settled decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Verifier approval channel | **WA reply + Web UI** (both authoritative; web is source of truth, WA is convenience) |
| 2 | Online vs offline | **Unified record** — one `data_deliveries` table + one verification pipeline; `channel` field distinguishes |
| 3 | Build order | **Foundation + Online first** (Phase 1), offline second (Phase 2) |
| 4 | Category semantics | `1` send as-is · `2` bounce to operator with note (no send) · `3` send **with verifier note shown to the customer** |
| 5 | WA note entry | **Inline one line** — `2 <note>` / `3 <note>`; everything after the digit is the note |
| 6 | Deliverable contents | **Link and/or file + note** (any combination, one file max in v1) |
| 7 | Verifier reviews files | In the **web panel** (links are tappable in the WA notif; files are not re-sent to her number) |
| 8 | Who can create deliveries | `petugas_pst`, `operator`, `admin`, `superadmin` (not `resepsionis`) |

---

## 3. Core architecture — the unified record

Insert a verification gate **between "operator prepares a deliverable" and "customer receives it."** The deliverable becomes a first-class row (`data_deliveries`); the `wa_messages` send becomes a **side effect of approval**, so the connector's send/ACK/retry pipeline is reused unchanged.

### New table `data_deliveries`

```sql
CREATE TABLE data_deliveries (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_kunjungan    INT NOT NULL,                 -- → tamdes_kunjungan
  id_konsultasi   INT NULL,                     -- → konsultasi_pengunjung (the specific requested-data line)
  channel         ENUM('online','offline') NOT NULL DEFAULT 'online',

  -- deliverable
  link_url        TEXT NULL,
  media_path      VARCHAR(255) NULL,            -- filename in backend/assets/wa_media/ (reused so connector can read it)
  media_mime      VARCHAR(100) NULL,
  media_name      VARCHAR(200) NULL,
  note_operator   TEXT NULL,                    -- operator's accompanying note/caption

  -- verification
  status          ENUM('menunggu_verifikasi','revisi','disetujui','terkirim','dibatalkan')
                    NOT NULL DEFAULT 'menunggu_verifikasi',
  verif_decision  ENUM('setuju','revisi','setuju_catatan') NULL,
  verif_note      TEXT NULL,                    -- cat2 → note to operator; cat3 → note to customer
  id_verifikator  INT NULL,                     -- admin_users.id who decided
  verified_at     DATETIME NULL,
  revisi_count    INT NOT NULL DEFAULT 0,
  short_code      VARCHAR(12) NULL,             -- human ref in WA notif, e.g. 'V37' (derived from id)

  -- delivery
  delivery_method ENUM('wa','flashdisk','printed') NULL,
  delivered_at    DATETIME NULL,
  delivered_by    INT NULL,

  -- bookkeeping
  created_by      INT NOT NULL,                 -- operator (admin_users.id)
  verif_outbox_id BIGINT NULL,                  -- the wa_outbox row that pinged the verifier
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_status (status),
  KEY idx_kunjungan (id_kunjungan),
  KEY idx_verif_pending (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`short_code` is set after insert as `'V' || id` (unique, human-friendly).

### Status lifecycle (shared online + offline)

```
                          ┌─ verifier: 1 Setuju ───────────► disetujui ─[online auto-send]─► terkirim
operator "Kirim Data"     │
  creates deliverable ──► menunggu_verifikasi ─ 3 Setuju+catatan ─► disetujui(+note to cust) ─► terkirim
  (notif → verifier)      │
                          └─ verifier: 2 Revisi ─► revisi ─► operator edits & resubmits
                                                   (verif_note = note to OPERATOR)  ↑ back to menunggu_verifikasi
        operator can cancel any pending → dibatalkan
```

- `revisi` **reuses the same row**: reset `status='menunggu_verifikasi'` on resubmit, `revisi_count++`, clear `verif_decision`/`verif_note`/`id_verifikator`/`verified_at`; history captured in the audit log. One delivery = one stable `short_code`.
- **Online** `disetujui → terkirim`: backend materializes outbound `wa_messages` rows for the session phone (file → media row with `note_operator` caption; link → text row); cat-3 appends `verif_note` as `Catatan: …`. The existing connector sends them. **No connector send-path changes.**
- **Offline** (Phase 2) `disetujui → terkirim`: operator picks `delivery_method` + marks delivered.

---

## 4. Online flow wiring

### 4.1 Operator side (`ChatPopup`)
- Remove the paperclip button, Ctrl+V paste-to-send, and drag-drop file sending. Plain **text** chat replies stay free/ungated.
- Add a **"Kirim Data"** button → compact form: **Link** (URL), **File** picker (existing `ALLOWED_MIME`, ≤25 MB), **Note**, and a dropdown to bind `id_konsultasi` (prefilled from the visit's `konsultasi_pengunjung` rows).
- Submit → `POST /api/deliveries` (multipart) → row `menunggu_verifikasi`, verifier notified.
- Deliverable renders as an **operator-only bubble** sourced from `data_deliveries` (NOT `wa_messages` — customer sees nothing yet), with a tiny label: `⏳ Menunggu Verifikasi` → `✏️ Revisi` (shows verifier note, tap to edit & resubmit) → `✓ Terkirim` (real customer message now appears).
- The same status badges the conversation row in the Layanan Online inbox.

### 4.2 Verifier WA notification
New `wa_outbox.msg_type='verif_request'`, sent to the verifier's `admin_users.notel`:

```
🔔 Verifikasi Data  [V37]
Pemohon : <nama> — <instansi>
Antrian : <nomor_antrian>
Diminta : <rincian_data> (<wilayah_data>)
Disiapkan operator:
  🔗 <link_url>          (tappable when a link exists)
  📎 <media_name>        (review file di panel: <deep-link to /admin/verifikasi>)
  Catatan: "<note_operator>"
Balas:  1 Setuju  ·  2 Revisi (mis. "2 tahun 2023 belum ada")  ·  3 Setuju+catatan
```

Also a **web-push** to `role=verifikator` (via `rules_for_role`).

### 4.3 Verifier WA reply parsing (backend, not connector)
- The connector posts the verifier's inbound to `/api/wa/ingest` as for any number — **no new connector code**.
- The backend `ingest` checks **first** whether the sender's normalized phone matches a `verifikator`'s `notel`. If so, it branches **out of the customer intake state machine** (verifier never sees the wizard) into the verify handler.
- Parse `1` / `2 <note>` / `3 <note>`, with an optional leading `short_code` (`V37 2 …`). Map to the **oldest pending** verification for that verifier (FIFO) unless a code is supplied.
- Apply via the **same code path** as `PUT /api/deliveries/:id/verify`.
- Bot confirms to the verifier: `✅ V37 disetujui & dikirim ke pemohon` / `✏️ V37 dikembalikan ke operator`.
- No pending / unparseable → friendly bail: `Balas 1, 2, atau 3 — atau buka panel: <link>`.

### 4.4 Materialize on approval (online)
- `setuju` (1): materialize customer `wa_messages` → `terkirim`. File present → media row (caption = `note_operator`, with `link_url` appended to the caption when a link also exists). Link only → text row (`note_operator` + `link_url`).
- `setuju_catatan` (3): same as `setuju`, with `verif_note` appended as `Catatan: …` shown to the customer → `terkirim`.
- `revisi` (2): nothing sent; `status='revisi'`; push to operator (`petugas_pst`); chat bubble shows the note.

---

## 5. Verifikator role & permissions

Touch FE + BE in the same session (project parity rule). The role ENUM gotcha applies — `ALTER TABLE` first, then whitelist.

- DB: `ALTER TABLE admin_users MODIFY role ENUM('superadmin','admin','operator','resepsionis','petugas_pst','pimpinan','verifikator');` (verify-after-insert guard already exists in `Users.php`).
- DB: `ALTER TABLE admin_users ADD COLUMN notel VARCHAR(20) NULL;` — surfaced in the user create/edit form so halima's number is set there.
- Backend whitelist: add `'verifikator'` in `Users.php` (both create §42 and update §83 lists).
- `Api_base.php` hierarchy: add `'verifikator' => 1`. **Real gating** is per-endpoint allow-lists (not the numeric level): create/edit/cancel → `['petugas_pst','operator','admin','superadmin']`; verify → `['verifikator','admin','superadmin']`; read (list/detail/file) → either set.
- FE: extend `UserRole` (`api/auth.ts`), `UserManagementPage` role options, and `TopNav` nav gates.
- Verifikator menu shows **only Verifikasi** (not PST/DTSEN mutation menus).

---

## 6. Web UI — `/admin/verifikasi` (`VerifikasiPage`)

Two sections: **Menunggu** (queue, `status='menunggu_verifikasi'`) and **Riwayat** (decided). Each card:
- **Pemohon:** nama, instansi, nomor antrian, kontak.
- **Data diminta:** `rincian_data`, `wilayah_data`, `tahun_awal`–`tahun_akhir`, `status_data` (from `konsultasi_pengunjung`).
- **Deliverable:** link (clickable) + file (preview/download via `GET /api/deliveries/:id/file`), operator note, `short_code`, channel badge.
- **Actions:** `[Setuju]` · `[Revisi…]` · `[Setuju + Catatan…]` (the two `…` open a textarea) → `PUT /api/deliveries/:id/verify`.
- Live refresh via react-query polling (matches existing inbox pattern).

---

## 7. Notifications

- **Verifier:** add `rules_for_role('verifikator')` in `Notifications.php` returning the `menunggu_verifikasi` count + items; the existing `notifier` service auto-pushes to `role=verifikator` subscriptions. Also the per-delivery `wa_outbox` `verif_request` message (§4.2).
- **Operator:** on `revisi`, push to the operator (`petugas_pst`) so they know to fix and resubmit.

---

## 8. API surface

New `api/deliveries` resource (routes in `backend/application/config/routes.php`; wrapper `frontend/src/api/deliveries.ts`). Envelope follows project conventions (`success`/`data`/`message`; HTTP status reflects result; never 200 + `success:false`).

| Verb | Route | CI3 route map | Who | Purpose |
|---|---|---|---|---|
| POST | `/api/deliveries` (multipart) | `deliveries/index` | operator | create deliverable → `menunggu_verifikasi`, fire notif |
| GET | `/api/deliveries` (`?status=&id_kunjungan=`) | `deliveries/index` | verifier/operator | queue / per-visit list (paginated) |
| GET | `/api/deliveries/(:num)` | `deliveries/detail/$1` | verifier/operator | detail |
| GET | `/api/deliveries/(:num)/file` | `deliveries/file/$1` | verifier/operator | serve uploaded file (path-traversal guarded) |
| PUT | `/api/deliveries/(:num)/verify` | `deliveries/verify/$1` | verifikator/admin | decision `{decision, note?}` |
| PUT | `/api/deliveries/(:num)` | `deliveries/detail/$1` | operator | edit & resubmit on revisi |
| DELETE | `/api/deliveries/(:num)` | `deliveries/detail/$1` | operator | cancel pending → `dibatalkan` |

Each method: explicit `require_auth()` + role allow-list, `$this->input->method()` check (405 on mismatch), cast `(:num)` ids to `int`, validate at the boundary.

The verifier's WA reply is handled inside the existing `/api/wa/ingest` branch (no new public route), calling the same verify code path.

---

## 9. Migrations, ordering & invariants

PHP is **live-on-edit** (no deploy gate) and `db_tamdes` is **production with no staging**. Therefore:

1. **Back up `db_tamdes` first** (fresh dump; confirm row-count scope).
2. Apply migrations **before** the PHP that reads them goes live (or guard the queries):
   - ① role ENUM `+verifikator`
   - ② `admin_users.notel`
   - ③ `wa_outbox.msg_type` `+verif_request`
   - ④ `CREATE TABLE data_deliveries`
3. Store migration SQL in `docs/migrations/2026-06-30-verifikator-data-delivery.sql`.

**DELETE-visit cascade invariant:** `data_deliveries` references `kunjungan`, so the admin DELETE-visit cascade **must** add `data_deliveries` (and unlink the deliverable files in `wa_media/`) + audit. This is a project invariant, not an afterthought.

**Finalization-gate invariant:** the 3-layer SKD `menunggu_evaluasi` gate is unaffected — this feature adds a parallel data-delivery state machine and must not touch the visit `status` finalization path.

---

## 10. Offline — Phase 2 sketch (detailed later)

- New PST menu **"Pengiriman Data"** listing offline/walk-in visits needing data.
- Operator creates a `channel='offline'` delivery (link/file + note) → **same verification pipeline**.
- On `disetujui`, operator picks `delivery_method` (`flashdisk` / `printed` / `wa`) and marks delivered → `terkirim`.
- Customer note: printed (print server) or WA'd if the guest has a `notel`.

---

## 11. Testing / verification plan (manual — no automated suite)

- **Frontend:** `npm run lint` clean; `npm run build` (tsc + bundle) passes; smoke `/admin/verifikasi` and `ChatPopup` "Kirim Data" at `localhost:5173`.
- **Backend:** read changed files end-to-end; `curl` each `api/deliveries` endpoint, asserting the `success`/`data`/`message` envelope and HTTP status; confirm role allow-list rejects unauthorized roles.
- **WA flow (test number):** operator creates delivery → verifier gets `verif_request` → reply `1`/`2 <note>`/`3 <note>` → confirm send/bounce/send+note behavior and that the verifier is excluded from the intake wizard.
- **Invariants:** SKD `menunggu_evaluasi` gate intact; DELETE-visit cascade now removes `data_deliveries` + files.
- Deploy: backend = Apache graceful + migrations applied first; frontend = build + PM2 restart + **bump SW `CACHE_NAME`**; connector = no restart needed (no `wa/server.js` change) — but confirm.

---

## 12. File-touch map (to guide the implementation plan)

**Backend**
- `docs/migrations/2026-06-30-verifikator-data-delivery.sql` (new)
- `modules/api/controllers/Deliveries.php` (new resource)
- `modules/api/models/` delivery model (new)
- `modules/api/controllers/Wa.php` — verifier-sender branch in `ingest`; materialize-on-approval helper; `verif_request` enqueue
- `modules/api/controllers/Users.php` — role whitelist (2 spots) + `notel`
- `modules/api/controllers/Api_base.php` — `verifikator` hierarchy entry
- `modules/api/controllers/Notifications.php` — `rules_for_role('verifikator')` + operator-revisi rule
- `config/routes.php` — `api/deliveries/*` routes
- DELETE-visit cascade (wherever the visit cascade lives) — add `data_deliveries`

**Frontend**
- `src/api/deliveries.ts` (new wrapper)
- `src/api/auth.ts` — `UserRole` += `verifikator`
- `src/pages/admin/VerifikasiPage.tsx` (new)
- `src/pages/admin/UserManagementPage.tsx` — role option + `notel` field
- `src/components/admin/TopNav.tsx` — Verifikasi nav item + verifikator gating
- `src/components/wa/ChatPopup.tsx` — replace attachment with "Kirim Data" form + deliverable bubbles/labels
- `src/pages/admin/LayananOnlineInboxPage.tsx` — delivery status badge on conversation rows
- `src/types/` — delivery types
- `frontend/public/sw.js` — bump `CACHE_NAME` on deploy

---

## 13. Open questions / future

- Multi-attachment data packages (deferred).
- Whether to forward review files to the verifier's WA (deferred; web panel for now).
- SLA / escalation if a verification sits in `menunggu_verifikasi` too long (future).
- Multiple verifiers / load-balancing (the model supports it via `id_verifikator`; routing rule is future).
