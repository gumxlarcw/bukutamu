# Kiosk WA Check-in Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make #2 "Daftar Antrian Offline" a real same-day online queue (pick service + get the queue number in WhatsApp; at the kiosk just identify + scan face → the same number prints), and give #1/#3 walk-ins a graceful Resepsionis fallback instead of rejection.

**Architecture:** #2's WA submit picks a service and assigns a real `nomor_antrian` via the existing `generate_queue_number`, stored with `created_by='whatsapp'` (which the PST call-queue already excludes → not callable until arrival). The kiosk check-in becomes identity-first (phone + face), and `wa_promote` flips `created_by='wa_kiosk'` — branching by `nomor_antrian` present (#2 → keep/print the number, enter the active queue) vs absent (#1/#3 → route to Resepsionis, no number). **No new status, no ENUM/migration, no dashboard change.**

**Tech Stack:** CodeIgniter 3 (`Wa.php`, `Kiosk.php`, `Api_base.php`), MySQL `db_tamdes`, React 19 + TS (`frontend/src/pages/kiosk/*`, `pages/wa/LayananOnlinePage.tsx`), whatsapp-web.js connector (unchanged).

**Spec:** `docs/superpowers/specs/2026-06-29-kiosk-wa-checkin-flow-design.md`

## Global Constraints

- **No automated tests** (`testing.md`): verify via `php -l`, `cd frontend && npm run lint && npm run build`, and `curl`/SQL smoke. Do NOT add a test framework.
- **No DB migration** — uses existing columns (`nomor_antrian`, `status`, `created_by`, `wa_sessions.category`). Do NOT add a status/ENUM. The "awaiting arrival" gate is `created_by='whatsapp'` (excluded by `Consultations.php:41`) → `'wa_kiosk'` at kiosk.
- **Do NOT change** the PST dashboard / `Consultations::index`/`call` / strict-mode TV call.
- **`generate_queue_number`** (`Api_base.php:524-542`) is called with a single service string = first element: `generate_queue_number($jenis[0] ?? '')` (mirror `Kiosk.php:489`). Counts all today's rows for the service (any status) → collision-safe.
- **Kiosk branch key:** `nomor_antrian` present → #2; absent → #1/#3 fallback.
- **#1/#3 fallback label** = `'Lainnya'` (Resepsionis group, null queue). **Same-day** only; **stale-day #2** (visit `date_visit` ≠ today) → regenerate today's number at promote.
- **Service hours (verbatim):** `Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT` — standardized via one BE helper + one FE constant.
- **Backup before edit:** `cp {file} {file}.backup`. **Commits:** conventional, NO `Co-Authored-By`.
- **Live-on-edit:** if implementing in an isolated worktree, defer live `curl`/SQL smoke to the deploy window (verify `php -l`/lint/build during build).
- DB: `db_tamdes`, creds in `/root/.my.cnf`.

---

### Task 1: Standardize + correct service hours (BE helper + FE constant)

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (3 message strings: ~`:914`, `:921`, `:1272`; add helper near other `wa_*` helpers)
- Modify: `frontend/src/pages/wa/LayananOnlinePage.tsx` (~`:69`)

**Interfaces:**
- Produces: BE `private function jam_layanan_text()` → `"Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT"`; FE `export const JAM_LAYANAN = '…'`.

- [ ] **Step 1: Backup** `cp backend/application/modules/api/controllers/Wa.php{,.backup}` and `cp frontend/src/pages/wa/LayananOnlinePage.tsx{,.backup}`.
- [ ] **Step 2: Add the BE helper** (in `Wa.php`, beside `wa_menu_text`):
```php
    private function jam_layanan_text() {
        return 'Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT';
    }
```
- [ ] **Step 3:** Replace the 3 hardcoded hours fragments in `Wa.php` (grep `08.00`) with `. $this->jam_layanan_text() .` woven into each message (read each line; keep surrounding copy intact).
- [ ] **Step 4: FE constant** — add `export const JAM_LAYANAN = 'Senin–Kamis 08.00–15.30 WIT, Jumat 08.00–16.00 WIT'` (e.g. in `frontend/src/types/wa.ts` or a small `lib/constants.ts`), and use it at `LayananOnlinePage.tsx:69` (replace the "Senin–Jumat, 08.00–15.30 WIT" text).
- [ ] **Step 5: Verify** `php -l backend/application/modules/api/controllers/Wa.php`; `cd frontend && npm run lint && npm run build`. Grep confirms no remaining "15.30 WIT" without the Friday 16.00.
- [ ] **Step 6: Commit** `fix(wa): correct service hours (Fri 08.00–16.00) + standardize to one helper/constant`.

---

### Task 2: Extract `<ServiceSaranaSelector>` from ServiceSelectPage (refactor, no behavior change)

**Files:**
- Create: `frontend/src/components/kiosk/ServiceSaranaSelector.tsx`
- Modify: `frontend/src/pages/kiosk/ServiceSelectPage.tsx`

**Interfaces:**
- Produces: `ServiceSaranaSelector` — props `{ value: { jenis_layanan: string[]; layanan_lainnya: string; sarana: number[]; sarana_lainnya: string }, onChange: (v) => void }`. Self-contained: fetches `servicesApi.list()`, enforces `wouldBeCross()` + `getAllowedSaranaCodes()` (from `lib/role-access.ts`), renders the service grid + sarana grid + "Lainnya" text inputs.

- [ ] **Step 1: Backup** `cp frontend/src/pages/kiosk/ServiceSelectPage.tsx{,.backup}`.
- [ ] **Step 2: Read** `ServiceSelectPage.tsx` fully. Move the service/sarana selection UI + toggle logic into the new `ServiceSaranaSelector` component (lift the four fields into the `value`/`onChange` props). Keep `wouldBeCross`/`getAllowedSaranaCodes` usage identical.
- [ ] **Step 3:** Refactor `ServiceSelectPage` to render `<ServiceSaranaSelector value={...} onChange={...} />` and keep its existing `navigate('/kiosk/status', { state: { jenis_layanan, layanan_lainnya, sarana, sarana_lainnya } })` behavior unchanged.
- [ ] **Step 4: Verify** `cd frontend && npm run lint && npm run build`. Smoke `/kiosk/service` at `localhost:5173` — picker behaves exactly as before (cross-group prevention, sarana whitelist, Lainnya inputs).
- [ ] **Step 5: Commit** `refactor(kiosk): extract reusable ServiceSaranaSelector (no behavior change)`.

---

### Task 3: Backend — #2 offline submit picks service + assigns same-day queue number

**Files:**
- Modify: `backend/application/modules/api/controllers/Wa.php` (offline branch of the submit handler ~`:760-875`; GET prefill ~`:720-748`)

**Interfaces:**
- Consumes: `generate_queue_number`, `validate_no_cross_layanan`, `validate_sarana_for_layanan` (Api_base), `jam_layanan_text` (Task 1).
- Produces: a #2 visit with `jenis_layanan=[picked]`, `sarana=[picked]`, `nomor_antrian=<today's number>`, `created_by='whatsapp'`, `status='antri'`; confirmation incl. the number. Prefill returns the picked service.

- [ ] **Step 1: Backup** `cp backend/application/modules/api/controllers/Wa.php{,.backup}`.
- [ ] **Step 2: Service from form for offline** — replace the offline branch service hardcode:
```php
            if ($category === 'offline') {
                $jl_in = (isset($input['jenis_layanan']) && is_array($input['jenis_layanan'])) ? array_values($input['jenis_layanan']) : [];
                if (!$jl_in) $this->json_response(['success' => false, 'message' => 'Silakan pilih layanan.'], 422);
                $jenis_layanan = $jl_in;
                $sarana        = (isset($input['sarana']) && is_array($input['sarana'])) ? array_map('intval', $input['sarana']) : [];
                $this->validate_no_cross_layanan($jenis_layanan);          // reject cross-group / unknown
                $this->validate_sarana_for_layanan($jenis_layanan, $sarana);
            } else { // 'data'
                $jenis_layanan = ['Konsultasi Statistik'];
                $sarana        = [2];
            }
```
- [ ] **Step 3: Assign number for #2 inside the LOCK** — in the visit INSERT, set `nomor_antrian`:
```php
                'nomor_antrian' => ($category === 'offline') ? $this->generate_queue_number($jenis_layanan[0] ?? '') : null,
```
(Keep `created_by='whatsapp'`, `status='antri'`. The INSERT is already inside `LOCK TABLES … tamdes_kunjungan WRITE`, so the count in `generate_queue_number` is safe.)
- [ ] **Step 4: New #2 confirmation message** — in the offline confirmation branch, set:
```php
                $no = $this->db->select('nomor_antrian')->get_where('tamdes_kunjungan', ['id_kunjungan' => $id_kunjungan])->row()->nomor_antrian;
                $svc = $jenis_layanan[0] ?? '';
                $body = "✅ *Pendaftaran antrian diterima.*\n"
                      . ($no ? "Nomor antrian: *{$no}* (berlaku hari ini)\n" : '')
                      . "Layanan: {$svc}\n"
                      . "Silakan datang ke Kantor BPS Provinsi Maluku Utara — bagian *Resepsionis* untuk mencetak tiket Anda.\n"
                      . "Jam layanan: " . $this->jam_layanan_text() . ".";
                $this->wa_enqueue_user($sess->phone_raw, $sess->wa_chat_id, 'confirmation', $body);
                // group ping unchanged (or include the number)
```
- [ ] **Step 5: Prefill returns picked service** — in the GET prefill response, include the session's stored service for offline reload (so the form can re-show it). If the offline service isn't persisted pre-submit, returning `category` is enough for the FE to render the selector empty; document that the selector starts empty on first load.
- [ ] **Step 6: Verify** `php -l`. Smoke (curl, fake group): drive a phone to offline, submit with `{"nama":"X","jenis_layanan":["Konsultasi Statistik"],"sarana":[2],"permintaan":[]}` → assert visit `jenis_layanan=["Konsultasi Statistik"]`, `nomor_antrian` like `K0NN`, `created_by='whatsapp'`, `status='antri'`, 0 konsultasi rows; confirmation contains the number + corrected hours. Submitting with empty `jenis_layanan` → 422. Clean up.
- [ ] **Step 7: Commit** `feat(wa): #2 offline submit picks service + gets same-day queue number`.

---

### Task 4: Frontend — #2 offline form adds the service step

**Files:**
- Modify: `frontend/src/pages/wa/LayananOnlinePage.tsx`
- Modify: `frontend/src/types/wa.ts` (payload type if needed), `frontend/src/api/wa.ts` (submit payload)

**Interfaces:**
- Consumes: `<ServiceSaranaSelector>` (Task 2); BE accepts `jenis_layanan`/`sarana` for offline (Task 3).
- Produces: offline mode = **Data Diri + Pilih Layanan**; submit sends the picked service; success ticket shows the assigned number.

- [ ] **Step 1: Backup** the file.
- [ ] **Step 2:** In offline mode (`isOffline`), add a second step **"Pilih Layanan"** using `<ServiceSaranaSelector>` (state for jenis/sarana). The Data-Diri step's primary button advances to this step (not submit); the selector step's button submits. (Reuse the existing 2-step scaffold; for `data` mode keep the current "Data yang Dibutuhkan" step.)
- [ ] **Step 3:** Submit payload for offline includes `jenis_layanan`, `layanan_lainnya`, `sarana`, `sarana_lainnya` (+ `permintaan: []`). Update `WaIntakePayload`/`submitSession` types accordingly.
- [ ] **Step 4:** Success ticket (offline) shows the returned `nomor_antrian` ("Nomor antrian Anda: K0NN, berlaku hari ini — cetak tiket di Resepsionis") using `JAM_LAYANAN`.
- [ ] **Step 5: Verify** `cd frontend && npm run lint && npm run build`. Browser smoke: open an offline session link → Data Diri → Pilih Layanan → submit → success shows a number.
- [ ] **Step 6: Commit** `feat(wa): offline form adds service selection (LayananOnlinePage)`.

---

### Task 5: Backend — kiosk `wa_lookup` (all categories) + `wa_promote` (branch by number; no service input)

**Files:**
- Modify: `backend/application/modules/api/controllers/Kiosk.php` (`wa_lookup` ~`:380-425`, `wa_promote` ~`:435-511`)

**Interfaces:**
- Consumes: `generate_queue_number` (for stale-day regen).
- Produces: `wa-lookup` returns `{nama, id_kunjungan, nomor_antrian, kiosk_token}` for ANY `created_by='whatsapp'` visit; `wa-promote` flips `created_by='wa_kiosk'`, branch: number present → keep/print (regen if stale-day); absent → Resepsionis (`jenis=['Lainnya']`, null number). No `jenis_layanan`/`sarana` from the kiosk.

- [ ] **Step 1: Backup** the file.
- [ ] **Step 2: `wa_lookup`** — remove the offline-only filter, return the number:
```php
        $visit = $this->db->select('id_kunjungan, status, nomor_antrian, date_visit')
                          ->where('id_user', $guest->id_user)
                          ->where('created_by', 'whatsapp')
                          ->order_by('id_kunjungan', 'DESC')->limit(1)
                          ->get('tamdes_kunjungan')->row();
        if (!$visit) {
            $this->json_response(['success' => false, 'message' => 'Nomor ini belum terdaftar via WhatsApp. Silakan pilih "Belum Pernah Daftar".'], 404);
        }
        if (in_array($visit->status, ['selesai', 'evaluasi_selesai'], true)) {
            $this->json_response(['success' => false, 'message' => 'Permintaan Anda sudah selesai diproses. Silakan daftar baru.'], 409);
        }
        $kiosk_token = $this->mint_kiosk_token('wa-checkin', (int) $visit->id_kunjungan, 300);
        $this->json_response(['success' => true, 'data' => ['nama' => $guest->nama, 'id_kunjungan' => (int) $visit->id_kunjungan, 'nomor_antrian' => $visit->nomor_antrian, 'kiosk_token' => $kiosk_token], 'message' => 'OK']);
```
- [ ] **Step 3: `wa_promote`** — drop the `jenis_layanan`/`sarana` input + the `validate_*` calls + the face-required-for-input wiring; keep face_descriptor required (enroll). After the LOCK + recheck (visit still `created_by='whatsapp'`, not finished), branch:
```php
        $today  = date('Y-m-d');
        $hasNum = !empty($visit->nomor_antrian);
        $stale  = $hasNum && (date('Y-m-d', strtotime($visit->date_visit)) !== $today);
        if ($hasNum) {
            // #2 offline: keep service + number; regenerate only if from a previous day.
            $upd = ['created_by' => 'wa_kiosk', 'status' => 'antri', 'date_visit' => date('Y-m-d H:i:s')];
            if ($stale) {
                $svc = json_decode($visit->jenis_layanan, true);
                $upd['nomor_antrian'] = $this->generate_queue_number(is_array($svc) ? ($svc[0] ?? '') : (string) $svc);
            }
            $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', $upd);
        } else {
            // #1/#3 fallback: route to Resepsionis (no TV number).
            $this->db->where('id_kunjungan', $id_kunjungan)->update('tamdes_kunjungan', [
                'created_by' => 'wa_kiosk', 'status' => 'antri',
                'jenis_layanan' => json_encode(['Lainnya']), 'sarana' => json_encode([1]),
                'nomor_antrian' => null, 'date_visit' => date('Y-m-d H:i:s'),
            ]);
        }
```
(Adjust the `$visit` SELECT inside the lock to also fetch `nomor_antrian, date_visit, jenis_layanan`. Keep face/consent enroll. Return `{id_kunjungan, nomor_antrian, mode: hasNum?'queue':'resepsionis'}`.)
- [ ] **Step 4: Verify** `php -l`. Smoke (curl): a #2 visit (with number, from Task 3) → wa-lookup returns the number → wa-promote keeps it, `created_by='wa_kiosk'`, and it now appears in `Consultations::index`. A #1/#3 visit (no number) → wa-lookup OK → wa-promote → `Lainnya`, null number, `created_by='wa_kiosk'`. Stale-day #2 (backdate `date_visit`) → number regenerated. Clean up.
- [ ] **Step 5: Commit** `feat(kiosk): wa check-in handles all WA categories; #2 keeps number, #1/#3 → Resepsionis`.

---

### Task 6: Frontend — identity-first kiosk WA check-in

**Files:**
- Modify: kiosk welcome/entry page (`frontend/src/pages/kiosk/WelcomePage.tsx` — confirm filename) + `App.tsx` if needed
- Modify: `frontend/src/pages/kiosk/WaCheckInPage.tsx`
- Modify: `frontend/src/pages/kiosk/StatusSelectPage.tsx` (remove obsolete WA button), `frontend/src/api/kiosk.ts` (waPromote payload)

**Interfaces:**
- Consumes: `wa-lookup`/`wa-promote` (Task 5).
- Produces: welcome → "Sudah Daftar via WhatsApp — Check-in" → `/kiosk/wa-checkin` (no service pre-pick); flow = phone → face → result (number ticket for #2; "menuju Resepsionis" for #1/#3).

- [ ] **Step 1: Backups** for each modified file.
- [ ] **Step 2:** Add a prominent **"Sudah Daftar via WhatsApp — Check-in"** button on the kiosk welcome screen → `navigate('/kiosk/wa-checkin')` (no service state).
- [ ] **Step 3:** Remove the "Sudah Daftar via WhatsApp" button from `StatusSelectPage.tsx` (now reached identity-first from welcome).
- [ ] **Step 4:** `WaCheckInPage.tsx` — drop the dependency on a pre-selected service. Flow: phone (`waLookup`) → face (`waPromote`, send only `face_descriptor`/`foto`/consent + `id_kunjungan`, NO `jenis_layanan`/`sarana`). On result: if `nomor_antrian` present → go to ticket with that number; else → a "Silakan menuju Resepsionis" screen (no number). Handle 404 ("Belum Pernah Daftar") + 409 (already done).
- [ ] **Step 5:** Update `kiosk.ts` `waPromote` to omit `jenis_layanan`/`sarana`.
- [ ] **Step 6: Verify** `cd frontend && npm run lint && npm run build`. Browser smoke (with a #2 and a #1/#3 visit): welcome → WA check-in → phone → face → #2 prints number; #1/#3 shows "menuju Resepsionis".
- [ ] **Step 7: Commit** `feat(kiosk): identity-first WA check-in (welcome entry, phone→face, no service pick)`.

---

### Task 7: End-to-end manual verification (extend the smoke harness)

**Files:** none (verification; reuse `scratchpad/smoke*.sh` pattern — fake group, fake phones, cleanup)

- [ ] **Step 1:** #2 WA submit (with service) → real `nomor_antrian`, `created_by='whatsapp'`, **absent** from `Consultations::index`.
- [ ] **Step 2:** Kiosk #2: phone → face → `wa_promote` keeps the **same** number, `created_by='wa_kiosk'`, now **present** in `Consultations::index`. Ticket shows that number.
- [ ] **Step 3:** Kiosk #1 and #3: phone → face → `Lainnya`, null number, `created_by='wa_kiosk'`, "menuju Resepsionis". Not rejected.
- [ ] **Step 4:** `null`-queue #2 service (e.g. picked `Lainnya`) → no number → resepsionis branch.
- [ ] **Step 5:** Stale-day #2 → number regenerated for today at promote.
- [ ] **Step 6:** Service hours corrected in all WA messages. `php -l` (Wa/Kiosk), `cd frontend && npm run lint && npm run build` clean.
- [ ] **Step 7 (deploy):** No connector restart (no `wa/server.js` change). Backend live on save; FE `npm run build` + `pm2 restart bukutamu-frontend`; **bump `frontend/public/sw.js` CACHE_NAME** (kiosk + WA pages changed). No migration.

---

## Self-Review

**Spec coverage:** §4 #2 flow → T3/T4; #1/#3 fallback → T5/T6; smooth/identity-first → T6; §5 created_by mechanism (no status) → T3/T5; §7 backend → T3/T5; §8 frontend → T2/T4/T6; §10 service hours → T1; §11 edge cases (null-queue, stale-day, no-reg, idempotent) → T3/T5/T7; §13 verification → T7. No DB migration (§6) — confirmed none. All covered.

**Placeholder scan:** No "TBD"/"add error handling". FE tasks say "read the current file" for exact edits but give the concrete new behavior + props/payloads; backend tasks carry real code. Smoke token plumbing reuses the proven `X-Kiosk-Token` convention from the prior smoke.

**Type/name consistency:** `ServiceSaranaSelector` props, `wa_promote` branch (`nomor_antrian` present/absent), `created_by` values (`whatsapp`/`wa_kiosk`), `jam_layanan_text()`/`JAM_LAYANAN`, fallback label `'Lainnya'`, queue-gen first-service convention — used consistently across tasks.
