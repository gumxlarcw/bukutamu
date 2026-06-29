# Design — WhatsApp "Layanan Online" Category Gate (pre-form confirmation)

Date: 2026-06-29
Status: Approved (design) — pending spec review → implementation plan
Scope: WhatsApp online-service intake flow (connector + backend + frontend + kiosk filter)

## 1. Problem / Goal

Today a new WhatsApp DM **immediately** receives the data-request form link, and the
submit handler **hardcodes** every WA visit to SKD `Konsultasi Statistik` + `sarana=[2]`
(`Wa.php:765-768`) — which always triggers the SKD evaluation tablet. But people contact
the WA channel for different reasons (data, walk-in queue, misc).

**Goal:** Before sending any form, ask the user — in the WhatsApp chat — which service
category they want, and route each category to the right flow. Only the data category
continues to the detailed data-request form; the others are "just a confirmation, outside
the data context."

## 2. Current flow (baseline, for reference)

- **Inbound → session → link:** connector `wa/server.js` `on('message')` (≈227-320) POSTs
  `{phone, wa_id, text}` to `/api/wa/ingest`. `Wa.php::ingest()` (≈11-76): if no active
  session, INSERT `wa_sessions(state='awaiting_form')`, mint `wa-intake` token (48h), send
  `intake_link` to `wa_outbox`, and `wa_notify_group_enqueue("🆕 …Kontak Baru")`.
- **Web wizard:** `frontend/src/pages/wa/LayananOnlinePage.tsx` — 2 steps: **Data Diri**
  (`VisitorForm`) + **Data yang Dibutuhkan** (`components/wa/PermintaanDataForm.tsx`).
  POSTs to `POST /api/wa/session/:id`.
- **Submit → kunjungan:** `Wa.php` (≈748-881): hardcoded `jenis_layanan=['Konsultasi
  Statistik']`, `sarana=[2]`; INSERT `tamdes_kunjungan(status='antri', created_by='whatsapp')`
  + one `konsultasi_pengunjung` row per request; `wa_notify_group_enqueue("✅ …Permintaan
  Data Online Masuk")`.
- **Session states (`frontend/src/types/wa.ts:31`):** `awaiting_form | submitted | expired`.
  - creation → `awaiting_form`; submit → `submitted` (`Wa.php`≈822); 48h no-submit →
    `expired` (dispatch_scan ≈982-984). `submitted` lives until linked kunjungan `selesai`.
- **Taxonomy:**
  - FE: `frontend/src/types/visit.ts` `SERVICE_OPTIONS`, `SARANA_LABELS`;
    `frontend/src/lib/role-access.ts` `SKD_SERVICES / DTSEN_SERVICES / RESEPSIONIS_SERVICES`.
  - BE: `Api_base.php` — `$skd_services` arrays (≈190, 226, 289, 350), `layanan_requires_skd_form()`
    (≈288), eval-status derivation (≈336-358: SKD → `menunggu_evaluasi`, else direct),
    role→services map (≈148-151), group-mixing + sarana validators (≈190-240) **(kiosk-only path)**.
- **Kiosk WA check-in:** `Kiosk.php::wa_lookup()` (≈380) matches the latest
  `created_by='whatsapp'` visit by phone (no service filter); `wa_promote()` (≈435-500)
  **overwrites** `jenis_layanan`/`sarana` with the kiosk's selection, enrolls face, assigns
  `nomor_antrian`, sets `created_by='wa_kiosk'`. Routes: `routes.php:84-85`. FE:
  `pages/kiosk/WaCheckInPage.tsx`, button in `pages/kiosk/StatusSelectPage.tsx:63`.

## 3. New flow — the category gate

A new contact receives a **numbered menu** in chat instead of the form link:

```
Selamat datang di Layanan Online BPS Maluku Utara 👋
Silakan pilih layanan (balas dengan ANGKA):
1. Permintaan Data / Konsultasi Statistik
2. Daftar Antrian Offline (datang ke kantor)
3. Lainnya
```

Session enters a new state **`awaiting_category`**. The user's numeric reply branches the flow:

| # | Menu label | jenis_layanan (stored) | Group / handler | Eval | sarana | Form | Kunjungan | Fulfillment |
|---|---|---|---|---|---|---|---|---|
| 1 | Permintaan Data / Konsultasi Statistik | `Konsultasi Statistik` *(existing)* | SKD / PST | **yes** | `2` (online) | full 2-step data form | yes + `konsultasi_pengunjung` rows | online — data sent back via WA |
| 2 | Daftar Antrian Offline | `Daftar Antrian Offline` *(NEW)* | Resepsionis (no-eval) | no | placeholder, overwritten at kiosk | **Data Diri only** (no data step) | yes (no rows) | come to office → kiosk check-in (phone + face) → physical queue |
| 3 | Lainnya | `Lainnya Online` *(NEW)* | PST online (no-eval) | no | `2` (online) | **none** | yes, minimal (no rows) | live-chat handoff to PST |

Mechanism is **numbered text reply**, not interactive buttons — whatsapp-web.js button/list
support is unreliable and the connector already drops `interactive` messages
(see memory `wa_system_sender_filter`). All online handling is **petugas PST** (no resepsionis
in the online chat); resepsionis only handle #2 visitors when they physically arrive.

## 4. Behavior per category

### #1 — Permintaan Data / Konsultasi Statistik
- `category='data'`, state → `awaiting_form`, mint `wa-intake` token, send the **existing** full
  data form link. Submit path = today's behavior (Konsultasi Statistik / sarana 2 / konsultasi
  rows / "✅ Permintaan Data Online Masuk" group ping / SKD eval flow). **Unchanged except it is
  now reached only after the user picks "1".**

### #2 — Daftar Antrian Offline
- `category='offline'`, state → `awaiting_form`, send a form link in **offline mode**
  (Data Diri only; the "Data yang Dibutuhkan" step is hidden).
- Submit → INSERT `tamdes_kunjungan(jenis_layanan=['Daftar Antrian Offline'],
  sarana=[2] placeholder, status='antri', created_by='whatsapp')`. **No** `konsultasi_pengunjung`
  rows. (sarana is a placeholder; `wa_promote` overwrites `jenis_layanan`/`sarana` with the
  visitor's real kiosk selection on arrival.)
- Confirmation message tells the visitor: come to the office and use the kiosk **"Sudah Daftar
  via WhatsApp"** button → enter phone + scan face → joins the physical queue. (Reuses the
  existing `wa_lookup`/`wa_promote` flow; no new kiosk mechanism.)
- Group ping: "🗓️ *Daftar Antrian Offline* — {nama} ({notel})".

### #3 — Lainnya
- `category='lainnya'`. **No form.** Immediately create a minimal
  `tamdes_kunjungan(jenis_layanan=['Lainnya Online'], sarana=[2], status='antri',
  created_by='whatsapp')` using the guest resolved from the phone (single DB match; if unknown,
  create/Use a minimal guest — petugas completes the profile via chat). No `konsultasi_pengunjung`
  rows. Session → `submitted` (linked to the visit) so it stays active.
- Bot confirms receipt; `wa_notify_group_enqueue("💬 *Lainnya* — minta ditangani: {nama} ({notel})")`.
- Petugas continue with the visitor in the **existing live-chat inbox** (take-over feature,
  memory `wa_manual_close_takeover`); they finalize/close the visit when done.

## 5. Mitigation — picked #2/#3 but actually wants online data

Three layers so a mis-categorized user (or the petugas) can re-route to #1:

1. **Escape line** appended to every #2 and #3 confirmation:
   *"Kalau ternyata Anda butuh **data secara online** (tak perlu datang), balas **1** untuk
   lanjut ke form Permintaan Data."*
2. **Global keyword:** at any state, replying **`menu`** or **`0`** re-sends the category menu
   and resets the session to `awaiting_category` (re-selectable).
3. **Petugas action** in the live-chat inbox: a **"Kirim Form Permintaan Data"** button that
   mints a `wa-intake` token, sends the #1 form link to the visitor, and sets the session
   `category='data'`. For chats already handed off (#3) or where the petugas realizes the need.

**Anti-duplicate on switch:** when the user switches to #1 and the session already has an
`id_kunjungan` from a #2/#3 visit that is still `created_by='whatsapp'` and not `selesai`, the
**same kunjungan is reused** — on #1 form submit it is **converted** (`jenis_layanan` →
`Konsultasi Statistik`, `sarana` → `[2]`, add `konsultasi_pengunjung` rows) rather than creating
a second visit. If the visit was already kiosk-promoted (`created_by='wa_kiosk'`, i.e. the person
arrived), no online switch is offered — they are already being served in person.

## 6. State machine changes

New state **`awaiting_category`** (initial for a new contact).

| From | To | Trigger |
|---|---|---|
| (new contact) | `awaiting_category` | first inbound DM → send menu |
| `awaiting_category` | `awaiting_form` (`category='data'`/`'offline'`) | reply `1` / `2` → send corresponding form link |
| `awaiting_category` | `submitted` (`category='lainnya'`, +visit) | reply `3` → create `Lainnya Online` visit + confirm |
| `awaiting_category` | `awaiting_category` | unrecognized reply → re-send menu (cap ~3, then ping petugas to take over) |
| any | `awaiting_category` | keyword `menu`/`0` (mitigation) |
| `awaiting_form` | `submitted` | form submit (create/convert visit per `category`) |
| `awaiting_category`/`awaiting_form` | `expired` | 48h no progress (extend existing 48h sweep to also cover `awaiting_category`) |

`wa_notify_group` "Kontak Baru" ping is **deferred** from "new contact" to "after category
chosen" so the petugas ping carries the chosen category (less noise). (Adjust if petugas prefer
the early ping.)

Returning-visitor handling in `ingest()` (active-session branch, ≈29-41):
`awaiting_category` → re-send menu; `awaiting_form` → re-send the appropriate form link;
`submitted` → inbound is treated as live-chat (no menu) — but `menu`/`0` still re-routes.

## 7. Data model changes

- **`wa_sessions`**: add column **`category VARCHAR(16) NULL`** (`'data' | 'offline' | 'lainnya'`,
  NULL until chosen). **Requires an `ALTER TABLE` migration** — apply in the same step as the code
  (backend PHP goes live on save; see memory `infra_php_live_on_edit`). Add a `docs/migrations/`
  entry.
- **New `jenis_layanan` labels:** `Daftar Antrian Offline`, `Lainnya Online`. Stored as JSON in
  `tamdes_kunjungan.jenis_layanan` — **no DB ENUM, no migration there.**

## 8. Taxonomy / eval parity (FE + BE — same session)

The two new labels must be classified consistently as **no-eval**:

- **BE `Api_base.php`:** do **not** add them to any `$skd_services` array (so eval-status
  derivation ≈349-358 returns the non-eval path, not `menunggu_evaluasi`). Add `Lainnya Online`
  to the **petugas_pst role→services** list (≈148-151) so PST staff can see/handle #3 visits in
  service-filtered lists/dashboards; classify `Daftar Antrian Offline` under the front-office
  group. (The WA submit path sets `jenis_layanan`/`sarana` server-side and does **not** call the
  kiosk group/sarana validators, so #2/#3 creation is unaffected by `validate_*`.)
- **FE:** add both to `types/visit.ts SERVICE_OPTIONS`; map in `lib/role-access.ts`
  (`Lainnya Online` → PST/no-eval bucket; `Daftar Antrian Offline` → resepsionis/no-eval) for
  labels, colors, and role routing.

## 9. Kiosk filter (decision #4)

`Kiosk.php::wa_lookup()` (≈404-409) currently matches **any** `created_by='whatsapp'` visit. Add
a filter so only **offline** pre-registrations are eligible for kiosk check-in (e.g.
`jenis_layanan` contains `Daftar Antrian Offline`, or join `wa_sessions.category='offline'`),
returning a clear "not an offline registration" message otherwise. This prevents #1 (online data)
and #3 (Lainnya) visitors from wrongly checking in at the kiosk.

## 10. Backend changes summary (`Wa.php` + `wa/server.js`)

- `ingest()`: new contact → create `wa_sessions(state='awaiting_category')` + send **menu**
  (not the form link). Active-session branch: re-send menu/form per state.
- **Reply parser** (new): when the session is `awaiting_category` (or on `menu`/`0` keyword),
  interpret inbound `text` → set `category` + transition + send the right message. (Connector
  already forwards `text`; no connector change strictly required, but verify ingest receives it.)
- Submit handler: branch on `session.category` — `data` (today's logic), `offline` (Data Diri
  only, label `Daftar Antrian Offline`, no rows), and the **convert-on-switch** path.
- `#3` creation + the three new group-ping bodies.
- dispatch_scan expiry: include `awaiting_category`.

## 11. Frontend changes summary

- `LayananOnlinePage.tsx`: read `category` from the session prefill (`GET /api/wa/session/:id`
  must return it) → render **mode `data`** (full 2-step form, current) or **mode `offline`**
  (Data Diri only; hide `PermintaanDataForm`). #3 has no web form.
- Live-chat inbox (admin): add the **"Kirim Form Permintaan Data"** petugas action (mitigation
  layer 3).
- The category **menu itself is in WhatsApp**, not in the FE.

## 12. Reused, unchanged

- The #1 data form, the kiosk **"Sudah Daftar via WhatsApp"** check-in (`wa_lookup`/`wa_promote`,
  which already overwrites the service on arrival), the live-chat inbox + take-over (used for #3).

## 13. Message copy (Bahasa)

- **Menu** — see §3.
- **#2 confirmation:** "Baik 🙏 untuk dilayani **langsung di kantor**. Saat tiba, di kiosk pilih
  **'Sudah Daftar via WhatsApp'**, masukkan nomor HP ini, lalu pindai wajah — Anda langsung masuk
  antrian. Jam layanan: Sen–Jum 08.00–15.30 WIT.\n\n_Kalau ternyata Anda butuh data secara online
  (tak perlu datang), balas *1*._"
- **#3 confirmation:** "Baik 🙏 permintaan Anda sudah kami terima. Petugas kami akan membalas Anda
  di chat ini pada jam layanan (Sen–Jum 08.00–15.30 WIT).\n\n_Kalau ternyata Anda butuh data
  secara online, balas *1* untuk form Permintaan Data._"
- **Unrecognized reply:** re-send the menu with "Mohon balas dengan angka 1, 2, atau 3."

## 14. Edge cases & error handling

- **Unrecognized menu reply:** re-prompt (cap ~3) then ping petugas to take over via inbox.
- **Switch after kiosk promotion:** disallowed (already served in person).
- **#3 unknown guest:** create minimal guest from phone; petugas complete via chat.
- **Idempotency:** keep the existing submit idempotency (return existing ticket); extend so a
  category switch converts rather than blocks.
- **Expiry:** `awaiting_category`/`awaiting_form` expire at 48h.
- **Group not configured:** `wa_notify_group` empty → pings are silent no-op (existing behavior).
- **Stale outbox:** unchanged — existing age-cap/attempts safeguards still apply
  (memory `wa_outbox_stale_delivery`).

## 15. Out of scope / non-goals

- No change to the kiosk physical-queue mechanics, the SKD evaluation questionnaire, or the
  #1 data form fields.
- No WhatsApp interactive buttons/lists (numbered text only).
- No change to DTSEN, Keperluan Pimpinan, or Perpustakaan/Penjualan/Rekomendasi service handling
  for non-WA channels.
- Not "fixing" the WA connector cold-sync stall (separate concern, memory `wa_connector_resilience`).

## 16. Verification plan (manual — repo has no automated tests)

1. New WA DM → receives the **menu** (not a form link).
2. Reply `1` → data form link → submit → Konsultasi Statistik visit + "Permintaan Data Online
   Masuk" ping + SKD eval flow intact.
3. Reply `2` → Data-Diri-only form → submit → `Daftar Antrian Offline` visit (no rows) +
   confirmation; visit appears for kiosk check-in; **#1/#3 visits do NOT** appear in `wa_lookup`.
   Kiosk check-in (phone + face) promotes it, service re-picked at kiosk, joins physical queue.
4. Reply `3` → no form → `Lainnya Online` visit + "Lainnya" ping; petugas take over in inbox; no
   eval link is ever enqueued for #2/#3.
5. Mitigation: from a #2/#3 chat, reply `1` (or `menu`→`1`) → data form; verify the **same**
   kunjungan is converted (no duplicate). Petugas "Kirim Form Permintaan Data" sends the link.
6. Unrecognized reply re-prompts; 48h expiry works; FE build + lint clean
   (`npm run lint && npm run build`); `php -l` on changed controllers.

## 17. Open questions

- Exact `sarana` placeholder for #2 (overwritten at kiosk anyway) — pick a benign value in
  implementation.
- Whether to keep an early "Kontak Baru" ping in addition to the deferred per-category ping
  (default: deferred only).
