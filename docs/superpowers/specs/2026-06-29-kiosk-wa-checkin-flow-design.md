# Design — Kiosk WA Check-in Flow (online queue for #2 + graceful fallback for #1/#3)

Date: 2026-06-29
Status: Approved (design) — pending spec review → implementation plan
Builds on: `2026-06-29-wa-category-gate-design.md` (the WhatsApp category menu, already shipped)

## 1. Problem / Goal

The WA category gate is live. Two kiosk-side gaps remain:

1. **Smooth the #2 "Daftar Antrian Offline" check-in.** Today the offline pre-registrant only fills Data Diri online, then at the kiosk must go service-first (`/kiosk/service` → status → WA button) and pick a service again. The *point* of registering the queue online should be: **pick the service AND get the real queue number online**, then at the office just check in and print the *same* number.
2. **Graceful fallback for #1/#3.** A visitor who registered for online Data (#1) or Lainnya (#3) but shows up in person is currently **rejected** by the kiosk's offline-only filter. They should be recognized and routed, not rejected.

## 2. Decisions (locked during brainstorming)

- **#2 = same-day online queue.** In the WA form the visitor **picks a service** and **receives a real same-day queue number** (e.g. `K012`). At the kiosk: identify → **scan face** → the **same** number is printed and enters the active queue. **No service selection at the kiosk.**
- **#1/#3 fallback → Resepsionis.** Any WA pre-registrant who shows up is recognized (phone + face) and routed to the **Resepsionis** front desk (human triage; e.g. data request → PST). No rejection.
- **Face required for everyone** at the kiosk (verify + enroll).
- **Daily reset.** A #2 number is valid only for the day it was issued; if the visitor doesn't come, it lapses.
- **WA message stays simple** — it does NOT spell out "enter phone / scan face"; it just says go to the BPS office Resepsionis to print the ticket.
- **Service hours corrected:** Senin–Kamis 08.00–15.30 WIT; **Jumat 08.00–16.00 WIT**.

## 3. Current state (baseline, cited)

- **Kiosk order is service-first:** `/kiosk` → `/kiosk/service` (`ServiceSelectPage.tsx`) → `/kiosk/status` (`StatusSelectPage.tsx:18-69`, three buttons incl. "Sudah Daftar via WhatsApp" → `/kiosk/wa-checkin`).
- **WA check-in:** `WaCheckInPage.tsx` → `Kiosk.php::wa_lookup` (`:380`, filters `->like('jenis_layanan','Daftar Antrian Offline')`, `:409`) → `wa_promote` (`:435-511`): takes kiosk-selected `jenis_layanan`/`sarana`, overwrites, `generate_queue_number`, `created_by='wa_kiosk'`.
- **#2 WA submit today:** `Wa.php` offline branch sets `jenis_layanan=['Daftar Antrian Offline']`, `sarana=[2]`, **no number**, Data-Diri-only form.
- **Queue number:** `Api_base.php::generate_queue_number()` (`:524-542`) — counts ALL today's rows for the service (any status), prefix = first letter (DTSEN='D'), `Lainnya`/`Keperluan Pimpinan` → `null`.
- **Call queue / TV:** `Consultations.php::index()` (`:8-45`) lists the 4 SKD services for today and **excludes `created_by='whatsapp'`** (`:41`); `call($id)` (`:130-175`) only needs `nomor_antrian`, auto-transitions `antri→dipanggil`.
- **Status ENUM:** `tamdes_kunjungan.status` = `('antri','dipanggil','proses','diproses','selesai','menunggu_evaluasi','evaluasi_selesai')`. `Api_base::valid_statuses()` (`:379`) lists 6 (missing `evaluasi_selesai` — pre-existing, out of scope).
- **Service hours hardcoded (4 places):** `Wa.php:914`, `Wa.php:921`, `Wa.php:1272`, `LayananOnlinePage.tsx:69`.
- **Service selector:** inline in `ServiceSelectPage.tsx` (NOT a reusable component); uses `servicesApi.list()`, `wouldBeCross()`, `getAllowedSaranaCodes()`.

## 4. New flow

### #2 — Daftar Antrian Offline (online queue, same-day)
**WhatsApp:**
1. Menu → reply `2`.
2. Form link → **Data Diri + service picker** (jenis_layanan + sarana; the reusable selector — see §8).
3. Submit → create `tamdes_kunjungan`: `jenis_layanan=[picked service]`, `sarana=[picked]`, `created_by='whatsapp'`, `status='antri'`, **`nomor_antrian = generate_queue_number(service)`** (today's real number). No `konsultasi_pengunjung` rows.
4. Confirmation (Bahasa, simple):
   > ✅ Pendaftaran antrian diterima.
   > Nomor antrian: **{nomor}** (berlaku hari ini)
   > Layanan: {service}
   > Silakan datang ke Kantor BPS Provinsi Maluku Utara — bagian **Resepsionis** untuk mencetak tiket Anda.
   > Jam layanan: Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT.
   - If the picked service is a `null`-queue one (`Lainnya`/`Keperluan Pimpinan`) → no number; message says "menuju Resepsionis" (front-desk, no number).

**Kiosk:**
5. Welcome-screen **"Sudah Daftar via WhatsApp — Check-in"** → `/kiosk/wa-checkin` (identity-first; skips `/kiosk/service`).
6. Enter **phone** → `wa_lookup` finds the visit → **scan face** (enroll + consent) → `wa_promote`: **keep `jenis_layanan`/`sarana`/`nomor_antrian`**, set `created_by='wa_kiosk'`, enroll face. **No kiosk service input.**
7. Print the **same** `nomor_antrian`. The flip to `created_by='wa_kiosk'` makes it enter the active call queue (it was excluded while `'whatsapp'`).

### #1 / #3 — graceful fallback (came in person)
- Welcome → "Sudah Daftar via WhatsApp" → phone → `wa_lookup` finds a `created_by='whatsapp'` visit with **no `nomor_antrian`** → scan face → `wa_promote` (fallback mode): `created_by='wa_kiosk'`, route to **Resepsionis** (jenis → a resepsionis/`null`-queue service), no TV number → "Silakan menuju Resepsionis". The #1 data-request rows / #3 session stay linked for triage. **No rejection.**

### Walk-in (no WA) — unchanged
`/kiosk/service` → status → face/form → ticket. As today.

## 5. "Menunggu kehadiran" mechanism — via `created_by` (NO new status)

The agreed "has a number but not callable until arrival" behavior is realized by the **existing `created_by` flag**, not a new status:
- `created_by='whatsapp'` → **excluded** from `Consultations::index()` (`:41`) → invisible to the call queue / TV → not callable before arrival. (Visible in the admin "Layanan Online" inbox, which is correct.)
- Kiosk check-in flips `created_by='wa_kiosk'` → enters the active queue, callable as its pre-assigned number.

**Therefore: no `status` ENUM ALTER, no `valid_statuses()` change, no FE `VisitStatus`/`StatusBadge` change, no dashboard/TV-call change.** `generate_queue_number` counts all rows regardless of status, so assigning the number at WA-submit is collision-safe and the number is locked in before kiosk activation.

**Kiosk branch key:** `nomor_antrian` present → #2 (activate + print); absent → #1/#3 (resepsionis fallback).

## 6. Data model

- **No migration.** Uses existing columns: `tamdes_kunjungan.nomor_antrian`, `status`, `created_by`; `wa_sessions.category`. No new status/ENUM/column.
- The `Daftar Antrian Offline` jenis_layanan label becomes **unused** for #2 (now the visit carries the *picked* service). Keep the label in the taxonomy (harmless) — `wa_lookup` no longer keys on it.

## 7. Backend changes (`Wa.php`, `Kiosk.php`, `Api_base.php`)

1. **`Wa.php` #2 submit (offline branch):** set `jenis_layanan`/`sarana` from the **form's picked service** (validate via the kiosk taxonomy validators `validate_no_cross_layanan`/`validate_sarana_for_layanan`), and assign `nomor_antrian = generate_queue_number(service)` (reuse the exact calling convention from `Kiosk::register`/`visit`). New simple confirmation message incl. the number. Still `created_by='whatsapp'`, `status='antri'`, no konsultasi rows.
2. **`Wa.php` GET prefill:** return the picked service back to the form on reload (so the offline form can re-show the selection), plus `category` (already returned).
3. **`Kiosk.php::wa_lookup`:** **remove the `->like('jenis_layanan','Daftar Antrian Offline')` filter.** Match the latest `created_by='whatsapp'` visit (not `selesai`/`evaluasi_selesai`). Return `{nama, id_kunjungan, nomor_antrian, kiosk_token}` so the kiosk knows the branch (number present = #2). No 404 for #1/#3 anymore (only 404 if the phone has no WA registration at all).
4. **`Kiosk.php::wa_promote`:** **no `jenis_layanan`/`sarana` input from the kiosk.** Branch:
   - If the visit has a `nomor_antrian` (#2): keep `jenis_layanan`/`sarana`/`nomor_antrian`, set `created_by='wa_kiosk'`, `status='antri'`, enroll face. Return the existing number.
   - Else (#1/#3): set `created_by='wa_kiosk'`, route to Resepsionis (jenis → a resepsionis/`null`-queue service), `nomor_antrian=null`. Return a "menuju resepsionis" indicator.
   - Keep the in-lock TOCTOU recheck (visit still `whatsapp`, not finished) and face-enroll.
5. **Service-hours helper:** add `Api_base`/`Wa` helper (e.g. `jam_layanan_text()`) returning the corrected string; use it in the 3 `Wa.php` messages.

## 8. Frontend changes (`frontend/src`)

1. **Extract `<ServiceSaranaSelector>`** from `ServiceSelectPage.tsx` into a reusable component (props: value + onChange for `jenis_layanan`/`layanan_lainnya`/`sarana`/`sarana_lainnya`; uses `servicesApi.list`, `wouldBeCross`, `getAllowedSaranaCodes`). Refactor `ServiceSelectPage` to consume it (no behavior change).
2. **`LayananOnlinePage.tsx` (#2 offline mode):** add a step/section using `<ServiceSaranaSelector>` so the offline form is **Data Diri + Pilih Layanan** (not Data-Diri-only). Submit sends the picked service. Success ticket shows the assigned number + "menuju Resepsionis" copy.
3. **Kiosk welcome (`WelcomePage`/entry):** add prominent **"Sudah Daftar via WhatsApp — Check-in"** button → `/kiosk/wa-checkin` directly (identity-first). Remove the WA button from `/kiosk/status` (now obsolete there).
4. **`WaCheckInPage.tsx`:** drop the service inputs. Flow = phone → face → result. If `nomor_antrian` returned (#2) → ticket with that number; if resepsionis (#1/#3) → "menuju Resepsionis" screen (no number). Handle "no WA registration" → suggest "Belum Pernah Daftar".
5. **Service-hours constant:** single FE constant; use in `LayananOnlinePage.tsx` (correct Friday).

## 9. Queue / dashboard

**No changes.** `created_by='whatsapp'` exclusion (`Consultations.php:41`) keeps pre-arrival #2 out of the call queue; post-promotion `created_by='wa_kiosk'` includes it. `generate_queue_number` already status-agnostic. Verify `queue-stats` doesn't prematurely count pre-arrival #2 as waiting (minor; acceptable since it's `created_by='whatsapp'`).

## 10. Service-hours correction (4 locations + standardize)

Replace the hardcoded "Senin–Jumat 08.00–15.30 WIT" (and `Sen–Jum` variants) at `Wa.php:914`, `Wa.php:921`, `Wa.php:1272`, `LayananOnlinePage.tsx:69` with the standardized **"Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT"** via the BE helper (§7.5) and the FE constant (§8.5).

## 11. Edge cases

- **#2 picks a `null`-queue resepsionis service** → no number; confirmation = "menuju Resepsionis"; kiosk = resepsionis branch (consistent).
- **#2 registers but comes a different day** → number is from the issue-day's sequence; same-day only. On a later day, `wa_lookup` should treat a stale-day number as not-callable → re-issue a fresh number at kiosk OR direct to resepsionis. (Spec decision: if the visit's `date_visit` is not today, re-generate the number at promote time.)
- **Already checked in / promoted (`wa_kiosk`) or finished** → `wa_lookup`/`wa_promote` handle idempotently (no double-promote), as today.
- **Phone with no WA registration** → 404 → "use Belum Pernah Daftar".
- **#1 data rows** preserved on the visit after fallback promotion (resepsionis can see the request).

## 12. Out of scope

- Advance/future-day booking (this is same-day only).
- Re-architecting the PST queue ordering or the strict-mode TV call.
- The pre-existing `valid_statuses()`-missing-`evaluasi_selesai` bug.
- Removing the now-unused `Daftar Antrian Offline` taxonomy label.

## 13. Verification (manual — repo has no test suite; reuse the smoke harness)

Extend the WA smoke scripts (fake-group + fake phones + cleanup) to cover:
1. #2 WA submit with a service → visit has the **picked service** + a real `nomor_antrian` + `created_by='whatsapp'`; **not** in `Consultations::index` (excluded).
2. Kiosk #2: phone → face → `wa_promote` keeps the **same** number, `created_by='wa_kiosk'`; now **appears** in `Consultations::index`.
3. Kiosk #1/#3: phone → face → resepsionis (no number), not rejected.
4. `null`-queue #2 service → resepsionis branch.
5. Stale-day #2 → re-issued/redirected per §11.
6. Service-hours string corrected in all messages. `php -l`, `npm run lint && build` clean.

## 14. Open questions

- Stale-day #2 (§11): re-generate number at kiosk vs send to resepsionis — default chosen = re-generate today's number at promote. Confirm if you'd rather reject/redirect.
- #1/#3 fallback jenis label at resepsionis: reuse `Lainnya` (null-queue resepsionis) — confirm vs a dedicated label.
