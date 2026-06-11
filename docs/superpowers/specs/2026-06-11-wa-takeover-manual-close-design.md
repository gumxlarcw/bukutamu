# WA Layanan Online — Manual Completion + Take-over (Ambil Alih)

**Date:** 2026-06-11
**Scope:** WhatsApp online data-request channel **only** (`created_by='whatsapp'`).
The kiosk/tablet SKD evaluation flow is explicitly **out of scope** and unchanged.

## Problem

Two things on the WA "Layanan Online" channel:

1. **Duplicate-form bug.** When a WA visitor submits their evaluation, the shared
   `Evaluations::detail` POST flips the visit straight to `selesai`. The
   "active session" test (`Wa::ingest`, `wa_active_session`, `backfill_active`)
   treats a session as active only while `state='submitted' AND visit.status <> 'selesai'`.
   So the next inbound message after eval submit (e.g. "sudah saya isi") fails the
   test, is read as a **new request**, and a fresh intake link is minted and sent.

2. **No operator ownership.** There is no notion of which operator is handling a
   request, and no way to tell the requester who is helping them.

## Root cause (bug #1)

`evaluasi auto-submit → status='selesai'` crosses the active-session boundary.
The fix is to NOT let WA evals auto-`selesai`; park them in an intermediate state
that still counts as active, and require an explicit operator close.

## Decisions (from brainstorming)

- **Take-over scope:** both submitted requests (`visit`) **and** pending
  "Menunggu Form" sessions.
- **Re-claim:** locked to the first operator; only `admin`/`superadmin` may
  reassign (override).
- **Selesai message:** yes — send a formal closing thank-you with a smiley.
- **Safety auto-close:** a request in `evaluasi_selesai` (eval already filled)
  for **>3 hours** auto-closes to `selesai`.
- **Backfill:** assign **all** existing WA sessions — both still-running and
  already-`selesai` — to Irma. The backfill is a silent DB assignment: it must
  **not** send any "sedang ditangani" WA notification to requesters. Only the
  interactive "Ambil alih" button notifies.

---

## A. Data model

Single migration: `docs/migrations/2026-06-11-wa-takeover-manual-close.sql`.

1. **New status `evaluasi_selesai`** — "evaluation filled, awaiting operator
   close". `tamdes_kunjungan.status` is a MySQL ENUM, so it requires an
   `ALTER TABLE` (project rule: ENUM changes need a migration):

   ```sql
   ALTER TABLE tamdes_kunjungan MODIFY status
     ENUM('antri','dipanggil','proses','diproses','selesai','menunggu_evaluasi','evaluasi_selesai')
     NOT NULL DEFAULT 'antri';
   ```

2. **Operator claim on the session** (one source of truth for pending + visit):

   ```sql
   ALTER TABLE wa_sessions
     ADD COLUMN assigned_to INT NULL AFTER id_kunjungan,
     ADD COLUMN assigned_at DATETIME NULL AFTER assigned_to;
   ```
   `assigned_to` = `admin_users.id`. `wa_sessions.id_petugas` is **not** used
   (the existing unused `tamdes_kunjungan.id_petugas` column is left alone to
   avoid a split source of truth — a visit's operator is its session's
   `assigned_to`).

3. **Backfill ALL existing sessions to Irma** (`admin_users.id = 3`) — both
   still-running and already-`selesai` — so nothing existing looks unassigned:

   ```sql
   UPDATE wa_sessions SET assigned_to = 3, assigned_at = NOW()
   WHERE assigned_to IS NULL;
   ```

   This is a **silent DB assignment only** — it does NOT enqueue any `wa_outbox`
   message, so no requester receives a "sedang ditangani" notification from the
   backfill. The "sedang ditangani" WA message is sent *exclusively* by the
   interactive `POST /api/wa/sessions/{id}/assign` (the "Ambil alih" button),
   never by the migration or any bulk path.

> **Implementation verification note:** the plan stamps `selesai_timestamp` +
> `durasi_detik` at eval-submit time (when status becomes `evaluasi_selesai`),
> which makes the 3h auto-close and duration trivial but means a non-`selesai`
> row can carry a `selesai_timestamp`. Before relying on this, grep the admin
> Dashboard/reports for any `selesai_timestamp ⇒ status='selesai'` assumption; if
> one exists, add a dedicated `evaluasi_at DATETIME NULL` column instead and key
> the 3h auto-close off it.

---

## B. Feature 1 — Manual completion

### B1. Eval submit no longer auto-closes (WA only)
`Evaluations::detail` POST — branch on `created_by`:

- `created_by === 'whatsapp'` → `status = 'evaluasi_selesai'`.
- otherwise (kiosk/tablet) → `status = 'selesai'` (**unchanged**).

In both cases still set `rating_pengunjung`, `selesai_timestamp`, `durasi_detik`
(timestamp = "evaluation completed at"). The eval re-submit gate
(`in_array($visit->status, ['menunggu_evaluasi','selesai'])`) must also accept
`evaluasi_selesai` so a correction re-submit within the window still works.

Because `evaluasi_selesai <> 'selesai'`, the active-session test already keeps the
session active — **no change needed** in `ingest` / `wa_active_session` /
`backfill_active`. This is what fixes the duplicate-form bug.

### B2. Manual close endpoint
`POST /api/wa/visits/(:num)/selesai` → `api/wa/visit_selesai/$1` (auth + PST role).

- Load visit; require `created_by='whatsapp'`.
- If already `selesai` → idempotent 200.
- If `evaluasi_selesai` → set `status='selesai'`; enqueue closing message
  (ledger-deduped on `msg_type='closing'`); `audit('wa_close', 'visit', $id)`.
- Else → 409 (not ready to close).

PST role set = `['petugas_pst','operator','admin','superadmin','pimpinan']`
(same `wa_is_pst_role()` used elsewhere).

### B3. Closing WA message
Enqueued to `wa_outbox` (`msg_type='closing'`, `wa_chat_id` from the latest
session for the phone):

> Terima kasih telah menggunakan layanan data BPS Provinsi Maluku Utara.
> Permintaan Anda telah selesai kami proses. Semoga data yang kami sampaikan
> bermanfaat. Salam hangat, semoga hari Anda menyenangkan 🙂

### B4. 3-hour safety auto-close
New step in `wa_dispatch_scan()` (runs every poll): WA visits in
`evaluasi_selesai` whose eval-completion time is `> 3h` ago →
`status='selesai'` + enqueue the same closing message (deduped on
`msg_type='closing'`) + `audit_system('auto_close_wa_done', ...)`. The existing
7-day auto-close for un-evaluated `menunggu_evaluasi` stays untouched.

---

## C. Feature 2 — Take over (Ambil alih)

### C1. Assign endpoint
`POST /api/wa/sessions/(:num)/assign` → `api/wa/session_assign/$1` (auth + PST role).

Atomic claim (anti-TOCTOU, mirrors the existing WA submit lock pattern):

```php
$this->db->where('id', $sid)->where('assigned_to', null)
         ->update('wa_sessions', ['assigned_to' => $uid, 'assigned_at' => now]);
$claimed = $this->db->affected_rows() === 1;
```

- `$claimed` → success.
- not claimed (already assigned):
  - caller is `admin`/`superadmin` and target ≠ current → reassign (override).
  - else → **409** `"Sudah ditangani oleh {nama}"` (locked to first operator).
- On any successful (re)assignment → enqueue WA "sedang ditangani" message.

### C2. Operator display name
`admin_users.nama`, with a trailing parenthetical annotation stripped:
`"Irma (Petugas PST)"` → `"Irma"`, `"Nita (Petugas PST)"` → `"Nita"`. Full
names without parentheses are kept verbatim. New operators added by admin are
picked up automatically — there is no operator list to maintain.

### C3. "Sedang ditangani" WA message

> Permintaan Anda sedang ditangani oleh **{nama}**. Mohon menunggu, kami akan
> segera memproses permintaan Anda.

### C4. Inbox payload
`Wa::inbox()` adds, per row:
- `session_id` — now populated for `visit` rows too (subquery: latest session
  for the `id_kunjungan`).
- `assigned_to` (int|null) and `operator_nama` (string|null) via subquery join
  to `admin_users`.

---

## D. Frontend

- `types/visit.ts` — add `evaluasi_selesai` to `VisitStatus`.
- `StatusBadge.tsx` — add `evaluasi_selesai` → label "Evaluasi Selesai" (teal).
- `types/wa.ts` — `WaInboxRow` gains `assigned_to: number | null`,
  `operator_nama: string | null`; `session_id` now present on visits.
- `api/wa.ts` — `assign(sessionId)` and `markSelesai(idKunjungan)`.
- `LayananOnlineInboxPage.tsx`:
  - Each row: `assigned_to == null` → **"Ambil alih"** button; else a
    *"Ditangani: {operator_nama}"* chip. admin/superadmin also get a small
    "Pindahkan" override on assigned rows.
  - Visit rows with `status === 'evaluasi_selesai'` → **"Selesai"** button
    (confirm → `markSelesai`).
  - Summary card for the `evaluasi_selesai` bucket.

---

## E. Invariants preserved

- Kiosk/tablet SKD eval flow unchanged (still auto-`selesai`).
- SKD 3-layer finalization gate intact — `evaluasi_selesai` is only reachable
  *after* a real eval submit; it never lets a visit skip `menunggu_evaluasi`.
- No new token scheme; reuses `wa_outbox`, HMAC kiosk tokens, and existing role
  gates. FE↔BE parity maintained (both sides changed in the same work).

## F. Manual test plan (repo has no automated suite)

1. WA visit → finish consultation → `menunggu_evaluasi` → visitor submits eval
   → status is **`evaluasi_selesai`** (NOT `selesai`).
2. Visitor sends "sudah saya isi" → **no new intake form** is sent (bug fixed).
3. Operator clicks **Selesai** → status `selesai` + closing WA message arrives.
4. Leave a request in `evaluasi_selesai` >3h (or temporarily lower the threshold)
   → it auto-closes to `selesai` with the closing message.
5. **Ambil alih** on an unassigned row → requester gets "ditangani oleh Irma";
   row shows the chip. Second operator's claim → **409** "Sudah ditangani oleh Irma".
   admin override reassigns.
6. Confirm the migration backfilled all in-flight sessions to Irma; no running
   ticket disrupted.
7. Kiosk regression: a non-WA SKD tablet eval still goes straight to `selesai`.
