# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 47 findings from the 2026-07-12 read-only audit on the live bukutamu production system, one deploy-unit at a time, without an outage.

**Architecture:** Seven batches grouped by **deploy mechanism** (git-only → BE/Apache → FE/PM2 → connectors/relink → infra/TLS). Each finding is one task; each batch ends with a review + deploy checkpoint. Code is written and `diff`ed in the working tree with zero prod impact; the only live moment is each batch's explicit cutover.

**Tech Stack:** CodeIgniter 3 (PHP, HMVC, JSON-API) · React 19 + TypeScript 5.9 + Vite 8 · Node connectors (wwebjs / web-push / escpos) · MySQL `db_tamdes` · Apache + PM2.

## Global Constraints

- **No automated tests.** Verification = `npm run lint` + `npm run build` (FE), `curl` the endpoint (BE), read-end-to-end + `diff` (both). Never claim "tested" without the command output. (`.claude/rules/testing.md`)
- **Prod-safety protocol, every file:** Read whole section → `cp {file} {file}.backup` → minimal edit → `diff {file}.backup {file}` → verify affected flow → user review → deploy → smoke-test. (`*.backup` is git-ignored.)
- **Commit discipline:** NO `Co-Authored-By` trailer. Commit only at a batch checkpoint after user review. Each batch = its own branch off `main`.
- **FE deploys MUST bump `frontend/public/sw.js` CACHE_NAME** or users keep pre-deploy code.
- **FE↔BE parity:** a domain-rule change touches both sides in the same session.
- **Never rename `db_tamdes`.** Never restart a warm WA connector outside a planned window. Never return HTTP 200 with `success:false`.
- **Deploy mechanisms:** BE = `sudo apachectl -k graceful`; FE = `npm run build` + `pm2 restart bukutamu-frontend`; connectors = `pm2 restart <svc>` (wa needs a relink window); infra = Apache vhost + `apachectl -k graceful`.
- **Token/verify helpers:** `scripts/smoke/mintjwt.php` (admin JWT), `scripts/smoke/mintkiosk.php` (kiosk token). Backend base: `http://bukutamu.bpsmalut.com:60/api/`.

---

## Batch 0 — Secret & git hygiene · git only, no service restart · ships first

### Task 1: Broaden WA session ignore + remove stray backup (#4)

**Files:** Modify `wa/.gitignore`; remove untracked dir `wa/.wwebjs_auth.bak-1780454696/`.

- [ ] **Step 1 — Inspect:** `cat wa/.gitignore` and `git status --porcelain wa/` — confirm `.bak-1780454696/` is untracked and current ignores are only `.wwebjs_auth/` / `.wwebjs_cache/`.
- [ ] **Step 2 — Backup:** `cp wa/.gitignore wa/.gitignore.backup`
- [ ] **Step 3 — Edit:** change the two ignore lines to globs `.wwebjs_auth*` and `.wwebjs_cache*` (covers `.bak-<epoch>` and future copies).
- [ ] **Step 4 — Verify:** `git status --porcelain wa/` shows the `.bak-*` dir no longer listed (now ignored). `diff wa/.gitignore.backup wa/.gitignore`.
- [ ] **Step 5 — Remove the stray backup off-repo:** move it out of the tree (e.g. `mv wa/.wwebjs_auth.bak-1780454696 /root/wa-session-bak-1780454696`). **Do NOT `git add` it.** Confirm `ls wa/` no longer shows it.

### Task 2: Untrack `frontend/.env` + fix doc var name (#20)

**Files:** `frontend/.env` (untrack), `frontend/.gitignore`, `docs/deploy-config.md`.

- [ ] **Step 1 — Confirm tracked:** `git ls-files frontend/.env` prints the path (it is tracked). `grep VITE_ frontend/src/api/client.ts` confirms the real var is `VITE_API_URL`.
- [ ] **Step 2 — Backup:** `cp frontend/.gitignore frontend/.gitignore.backup`
- [ ] **Step 3 — Untrack + ignore:** `git rm --cached frontend/.env`; append `.env` and `.env.*` to `frontend/.gitignore` with `!.env.example` kept.
- [ ] **Step 4 — Doc fix:** in `docs/deploy-config.md`, rename the documented `VITE_API_BASE_URL` → `VITE_API_URL` (backup the doc first).
- [ ] **Step 5 — Verify:** `git ls-files frontend/.env` prints nothing; `git check-ignore frontend/.env` prints the path; `cd frontend && npm run build` still succeeds.

### Batch 0 checkpoint
- [ ] `git checkout -b fix/audit-batch0-git-hygiene`; stage only intended files; `git commit -m "chore(security): ignore WA session dirs, untrack frontend/.env"`; user review; merge. **No service restart.**

---

## Batch 1 — Backend state-machine, gates & data-integrity · Apache graceful

> Every task here: `cp <ctrl>.php <ctrl>.php.backup` first, read the method fully, then apply. Verify with a crafted `curl` + a legit-flow `curl` using a minted JWT.

### Task 3: Close the DTSEN-endpoint SKD finalization bypass (#3)

**Files:** Modify `backend/application/modules/api/controllers/Dtsen.php:63` (`detail`).

- [ ] **Step 1 — Read** `Dtsen::detail` and compare to the gate block in `Visits::status` (`Visits.php:189-261`) and `Api_base::next_status_after_completion`.
- [ ] **Step 2 — Backup + edit:** at the top of the status-mutating branch, reject visits that are not DTSEN: if `!$this->layanan_requires_dtsen_form($visit->jenis_layanan)` → `json_response(['success'=>false,'message'=>'Endpoint DTSEN hanya untuk kunjungan DTSEN'],400)`. (Preferred over re-implementing the SKD soft-correct here — keeps one gate owner.)
- [ ] **Step 3 — Verify FAIL path:** `curl -X PUT .../api/dtsen/<SKD_visit_id> -d '{"status":"selesai"}'` with a `petugas_pst` JWT → expect **400**, and the visit's status unchanged in a follow-up `GET`.
- [ ] **Step 4 — Verify PASS path:** same call against a real DTSEN visit id → still finalizes correctly. `diff` the backup.

### Task 4: Add DTSEN form-complete gate to Consultations::detail (#7)

**Files:** Modify `backend/application/modules/api/controllers/Consultations.php:101` (`detail`).

- [ ] **Step 1 — Read** `Consultations::detail` and copy the exact Gate-3 block from `Visits.php:253-261` (count `dtsen_konsultasi` rows for the visit; reject if 0).
- [ ] **Step 2 — Backup + edit:** insert the gate after Gate 2 (~line 110), only for DTSEN visits, before the status update.
- [ ] **Step 3 — Verify:** `curl -X PUT .../api/consultations/<dtsen_visit_with_no_rows> -d '{"status":"selesai"}'` → expect the same rejection message as `Dtsen::detail`; a DTSEN visit *with* a row still finalizes. `diff`.

### Task 5: SKD form gate must ignore ghost summary rows (#8)

**Files:** Modify `backend/application/modules/api/controllers/Visits.php:244` and its sibling gate site.

- [ ] **Step 1 — Read** both gate sites; note the `Consultations::index` subquery already filters real rows.
- [ ] **Step 2 — Backup + edit:** before each `count_all_results()`, add `->where("rincian_data IS NOT NULL AND TRIM(rincian_data) <> ''", NULL, FALSE)`.
- [ ] **Step 3 — Verify:** create a visit whose only konsultasi row has `rincian_data` NULL (via `/summary` with a ringkasan only), then `curl` the status PUT → expect the "belum lengkap" rejection (previously passed). A visit with a real rincian row still passes. `diff`.

### Task 6: Reject `menunggu_evaluasi` for non-SKD visits (#21)

**Files:** Modify `Visits.php:202`, and the status handlers in `Consultations.php` and `Dtsen.php`.

- [ ] **Step 1 — Read** all three handlers; locate where `status` is validated.
- [ ] **Step 2 — Backup + edit each:** if `status==='menunggu_evaluasi'` && `next_status_after_completion($visit->jenis_layanan) !== 'menunggu_evaluasi'` → `400`.
- [ ] **Step 3 — Verify:** `curl` a DTSEN visit to `menunggu_evaluasi` on all three routes → expect 400 each; an SKD visit still accepts it. `diff` all three.

### Task 7: Audit-log status transitions in Consultations & Dtsen (#22)

**Files:** Modify `Consultations.php:124` and the update site in `Dtsen.php`.

- [ ] **Step 1 — Read** how `Visits::status` calls `$this->audit('update_status','visit',$id,['from'=>...,'to'=>...])`.
- [ ] **Step 2 — Backup + edit:** add the identical `audit(...)` call immediately after the successful update in both.
- [ ] **Step 3 — Verify:** perform a status PUT through each endpoint, then `curl .../api/audit` (admin JWT) → confirm a new `update_status` row with correct from/to. `diff`.

### Task 8: Fail-closed default for missing role claim (#23)

**Files:** Modify `Visits.php:219` (and confirm the same default used by `require_layanan_role` / the soft-correct).

- [ ] **Step 1 — Read** where the role is read from the JWT claims and the `?? 'operator'` default.
- [ ] **Step 2 — Backup + edit:** default a missing claim to a non-bypass sentinel (e.g. `''`) so both the soft-correct and `require_layanan_role` fail closed.
- [ ] **Step 3 — Verify:** mint a JWT WITHOUT a role claim (`mintjwt.php`), `curl` an SKD status→`selesai` → expect the soft-correct to still force `menunggu_evaluasi` (not bypass). A normal admin JWT is unaffected. `diff`.

### Task 9: Eval re-submit must not inflate duration (#24)

**Files:** Modify `backend/application/modules/api/controllers/Evaluations.php:217`.

- [ ] **Step 1 — Read** the submit path; find where `selesai_timestamp`/`durasi_detik` are set.
- [ ] **Step 2 — Backup + edit:** only set them when the visit is transitioning **out of** `menunggu_evaluasi` (first submit); on correction re-submit, update rating/eval rows only.
- [ ] **Step 3 — Verify:** submit an eval, note `durasi_detik`; re-submit after the 30s cooldown → `durasi_detik` and `selesai_timestamp` unchanged. `diff`.

### Task 10: Wrap the visit cascade delete in a transaction (#30)

**Files:** Modify `Visits.php:165` (the 8-DELETE cascade).

- [ ] **Step 1 — Read** the cascade (parent + 7 child tables + audit).
- [ ] **Step 2 — Backup + edit:** wrap the deletes in `$this->db->trans_start(); … $this->db->trans_complete();`; if `$this->db->trans_status()===FALSE` → `500` and do not report success (mirror `Consultations.php:251-302`). Keep the pre-delete audit write inside/ordered per existing logic.
- [ ] **Step 3 — Verify:** delete a disposable test visit (admin JWT) → all child rows + parent gone, audit row present, 200. `diff`. (Use a throwaway visit id; this is a real delete — confirm the id first.)

### Task 11: Transaction + empty-payload guard on Evaluations POST (#31)

**Files:** Modify `Evaluations.php:186`.

- [ ] **Step 1 — Read** the delete-then-reinsert block and the `1..10` range filter (~:190).
- [ ] **Step 2 — Backup + edit:** reject `422` **before** any delete when the filtered kepuasan set is empty; wrap delete+insert(+visit update) in a transaction, `500` on failure.
- [ ] **Step 3 — Verify:** POST an eval with all out-of-range values → `422`, prior rows intact; a valid re-submit still replaces rows atomically. `diff`.

### Task 12: Move kiosk register dedup guard inside LOCK TABLES (#32)

**Files:** Modify `backend/application/modules/api/controllers/Kiosk.php:80` (`register`).

- [ ] **Step 1 — Read** `register` lines 80-102 (recent/faceless-reuse check) and the `LOCK TABLES` section; compare to `Wa.php:944-948`.
- [ ] **Step 2 — Backup + edit:** re-run the recent-visit / existing-guest check **inside** the lock, returning the existing visit before the reuse/new-guest branches. Both tables are already in the lock set.
- [ ] **Step 3 — Verify:** fire two near-simultaneous identical `register` POSTs (background `curl &`) → exactly one guest + one visit created, second returns the same visit. `diff`.

### Batch 1 checkpoint
- [ ] Branch `fix/audit-batch1-be-state-machine`; commit; user review of the full diff; `sudo apachectl -k graceful`; smoke: `curl -sS -o /dev/null -w "%{http_code}\n" https://bukutamu.bpsmalut.com:460/api/auth/check` → 401; walk one SKD + one DTSEN finalize end-to-end.

---

## Batch 2 — Backend authz / role gates · Apache graceful

### Task 13: Drop `pimpinan` from WA write paths (#5)

**Files:** Modify `backend/application/modules/api/controllers/Wa.php:1544` (and the shared role helper it uses).

- [ ] **Step 1 — Read** the current `wa_is_pst_role`/`require_layanan_role` helper and every write handler (messages POST, `messages_upload`, `react`, `seen`, `session_assign`, `visit_selesai`).
- [ ] **Step 2 — Backup + edit:** introduce a write-role set that excludes `pimpinan`; keep `pimpinan` on the read gate (inbox / messages GET). Apply the write set to the six handlers.
- [ ] **Step 3 — Verify:** mint a `pimpinan` JWT; `curl` a messages POST → **403**; a GET inbox → 200. A `petugas_pst` JWT → write still 200. `diff`.

### Task 14: `session_delete` admin/superadmin only (#6)

**Files:** Modify `Wa.php:655`.

- [ ] **Step 1 — Read** the `require_role('admin')` call and confirm `require_role_in` exists in `Api_base`.
- [ ] **Step 2 — Backup + edit:** `require_role('admin')` → `require_role_in(['admin','superadmin'])`.
- [ ] **Step 3 — Verify:** `pimpinan` JWT DELETE `/api/wa/sessions/<id>` → 403; admin → allowed. `diff`.

### Task 15: `disconnect`/`pair` admin/superadmin only (#11)

**Files:** Modify `Wa.php:246` (`disconnect`, `pair`).

- [ ] **Step 1 — Read** both handlers' current role gate.
- [ ] **Step 2 — Backup + edit:** add `require_role_in(['admin','superadmin'])` to both.
- [ ] **Step 3 — Verify:** `petugas_pst` JWT POST `/api/wa/disconnect` → 403; admin → allowed (but **do not actually disconnect prod** — test the 403 only, and verify admin path returns the expected pre-action response without confirming). `diff`.

### Task 16: Enforce per-operator ownership on WA chat writes (#17)

**Files:** Modify `Wa.php:424` (messages POST) + `messages_upload` + `react`.

- [ ] **Step 1 — Read** `wa_sessions.assigned_to`, the atomic-claim in `session_assign`, and how the caller's user id is available.
- [ ] **Step 2 — Backup + edit:** before a write, load the session's `assigned_to`; allow if caller is the assignee OR an admin/superadmin (override); else `403`. Applies to POST/upload/react.
- [ ] **Step 3 — Verify:** claim a test session as operator A; operator-B JWT messages POST → 403; A → 200; admin override → 200. `diff`.

### Task 17: Scope delivery file/detail to owner/verifier (#19)

**Files:** Modify `backend/application/modules/api/controllers/Deliveries.php:202` (`file`) + `detail` (:159 area).

- [ ] **Step 1 — Read** `file`/`detail` and the `data_deliveries` columns (`created_by`, assigned verifier).
- [ ] **Step 2 — Backup + edit:** restrict access to the creating operator or the assigned verifier (admin/superadmin override); else `403`.
- [ ] **Step 3 — Verify:** unrelated operator JWT GET `/api/deliveries/<id>/file` → 403; owner/verifier → 200. `diff`.

### Task 18: Document the single-verifier assumption (#42)

**Files:** Modify `Deliveries.php:159` (comment only) + a note in the spec/CHANGELOG.

- [ ] **Step 1 — Backup + edit:** add a comment above `apply_decision` stating the Phase-1 single-verifier assumption and that a per-assigned-verifier gate must be added when multi-verifier routing lands.
- [ ] **Step 2 — Verify:** `diff` — comment-only, no behavior change.

### Batch 2 checkpoint
- [ ] Branch `fix/audit-batch2-be-authz`; commit; user review; `sudo apachectl -k graceful`; smoke: `pimpinan` write → 403, PST write → 200, admin override → 200.

---

## Batch 3 — Backend security hardening & conventions · Apache graceful

### Task 19: Fix the unauthenticated kiosk PII-overwrite IDOR (#1)

**Files:** Modify `Kiosk.php:434` (`profile_gaps`, `profile_update`) + `Api_base` token mint/verify + rate-limit helper.

- [ ] **Step 1 — Read** `profile_gaps`, `profile_update`, the kiosk-token `purpose`/`bound_id` scheme (`Api_base.php:418-451`), and `register`/`visit` (source of a real `id_kunjungan`).
- [ ] **Step 2 — Backup + edit (three parts):** (a) add `require_rate_limit` to `profile_gaps` (match the other kiosk endpoints); (b) mint the profile-update token bound to a freshly-created `id_kunjungan` (proof of recent face-match) rather than a bare `id_user`, and verify that binding in `profile_update`; (c) remove `notel`/`email` from the `profile_update` field whitelist unless a separate verification path exists.
- [ ] **Step 3 — Verify:** a token minted for visit X cannot mutate a different guest; `notel`/`email` are not writable via the kiosk path; the legit kiosk profile-completion flow still works with a token from a real check-in. `diff`.

### Task 20: JWT secret fails closed (#12)

**Files:** Modify `backend/application/libraries/JWT_Helper.php:25`.

- [ ] **Step 1 — Read** the fallback that derives a secret from the install path.
- [ ] **Step 2 — Backup + edit:** on missing/short (`<32` char) `JWT_SECRET`, throw / signal so `require_auth` + `require_kiosk_token` return `503`; never substitute the deterministic value.
- [ ] **Step 3 — Verify:** temporarily point at an empty secret in a throwaway CLI check (NOT prod `.env`) → confirm 503 path; restore. Normal secret → auth works. `diff`.

### Task 21: `test_sound` returns 502 on proxy failure (#14)

**Files:** Modify `Consultations.php:186` (`test_sound`).

- [ ] **Step 1 — Read** `test_sound` and the pattern in `call()`.
- [ ] **Step 2 — Backup + edit:** if the TV-proxy `$result['success']` is false → `json_response([...],502)` before the final response.
- [ ] **Step 3 — Verify:** with `:5001` unreachable, `curl` test-sound → 502 (FE will then show failure, not success). `diff`.

### Task 22: Normalize `admin_users.notel` (#15)

**Files:** Modify `backend/application/modules/api/controllers/Users.php:51,95`.

- [ ] **Step 1 — Read** create + update; confirm `normalize_phone` helper signature.
- [ ] **Step 2 — Backup + edit:** store `$this->normalize_phone($notel)` (canonical `08…`) on both paths.
- [ ] **Step 3 — Verify:** create/update a test user with `8123…` and `0062…` → DB stores canonical `08…`; the verifier jid built in `Deliveries.php:293` is valid. `diff`. (Use a disposable user row.)

### Task 23: Rate-limit + trim eval tablet payload (#18)

**Files:** Modify `Evaluations.php:21` (`pending`, `detail`).

- [ ] **Step 1 — Read** both and what fields the tablet form actually needs.
- [ ] **Step 2 — Backup + edit:** add `require_rate_limit` (as other kiosk endpoints); drop free-text consultation `rincian` from the payload, returning only eval-form fields.
- [ ] **Step 3 — Verify:** the tablet flow still renders; the response no longer leaks rincian; rapid enumeration is throttled. `diff`.

### Task 24: Add trailing 405 verb-guards (#26, #27, #28)

**Files:** Modify `Guests.php:12` (`index`), `Guests.php:95` (`detail`), `Users.php:12` (`index` + `detail`).

- [ ] **Step 1 — Read** each verb chain; copy the pattern from `Visits.php:100` / `Consultations.php:328`.
- [ ] **Step 2 — Backup + edit:** append `json_response(['success'=>false,'message'=>'Method not allowed'],405)` after each verb chain.
- [ ] **Step 3 — Verify:** `curl -X PATCH .../api/guests` → 405; `curl -X POST .../api/guests/1` → 405; `curl -X GET .../api/users/1` → 405 or a real payload (not empty 200). `diff` all.

### Task 25: `wa_chat_id` fallback → null, not bare number (#29)

**Files:** Modify `Wa.php:1227` (three fallback sites).

- [ ] **Step 1 — Read** the three `?: $v->notel` fallbacks and how the connector's `jidFromLocal(phone_raw)` builds a jid.
- [ ] **Step 2 — Backup + edit:** change each fallback to `null` so the connector formats the jid from `phone_raw`.
- [ ] **Step 3 — Verify:** with a synthetic session-anomaly row (null wa_chat_id), confirm the outbox row stores NULL (not `08…`); connector builds a valid jid. `diff`.

### Task 26: Parameterize Responden search (#41)

**Files:** Modify `backend/application/modules/api/controllers/Responden.php:187` (+ `_skd_clause`/`_tw_clause`).

- [ ] **Step 1 — Read** the hand-quoted LIKE branch and the QB `->like()` branch already present for the non-count path.
- [ ] **Step 2 — Backup + edit:** rebuild the search branch with QB `->like()`/`->or_like()` (or bound params); replace `addslashes()`/`intval()` string-building in the clause helpers.
- [ ] **Step 3 — Verify:** search with a `'`-bearing query returns correct results (no SQL error, no injection); result set matches pre-change for a normal query. `diff`.

### Task 27: CSRF config hygiene (#43)

**Files:** Modify `backend/application/config/config.php:460`.

- [ ] **Step 1 — Read** `csrf_exclude_uris` and the SameSite cookie setting.
- [ ] **Step 2 — Backup + edit:** remove the two dead legacy excludes (`recognize/save`, `selamat_datang/masuk`); add a comment documenting SameSite=Strict as the sole CSRF control. (Origin/Referer check on non-GET is optional — note it, don't add unless approved.)
- [ ] **Step 3 — Verify:** login + a normal PUT still work (SameSite unchanged); `diff`.

### Task 28: `(int)` cast on `(:num)` ids (#44)

**Files:** Modify the `(:num)`-routed handlers in `Visits.php`, `Consultations.php`, `Dtsen.php`.

- [ ] **Step 1 — Read** each handler signature.
- [ ] **Step 2 — Backup + edit:** add `$id = (int) $id;` at the top of each.
- [ ] **Step 3 — Verify:** endpoints behave identically for valid ids; `diff`.

### Batch 3 checkpoint
- [ ] Branch `fix/audit-batch3-be-security`; commit; user review; `sudo apachectl -k graceful`; smoke: kiosk profile-update IDOR blocked, verb-guards 405, auth still 401 on `/auth/check`.

---

## Batch 4 — Frontend · `npm run build` + `pm2 restart` + **bump sw.js**

> Each task: `cp <file> <file>.backup`; end-of-batch runs `npm run lint` + `npm run build`.

### Task 29: Coerce DTSEN detail numerics (#16)

**Files:** Modify `frontend/src/pages/admin/VisitLogPage.tsx:218` (`DtsenResultDetail`).

- [ ] **Step 1 — Read** the `===` comparisons and the `statusNum` pattern at ~line 70.
- [ ] **Step 2 — Backup + edit:** `const jenisNum = Number(row.jenis_konsultasi_dtsen); const hasilNum = Number(row.hasil)`; use these in the `find()`/ternaries.
- [ ] **Step 3 — Verify:** open a DTSEN visit → correct labels (not "Kode 1"), hasil chip colored by real outcome.

### Task 30: Fix eval empty-state coercion (#25)

**Files:** Modify `frontend/src/pages/admin/EvaluationSummaryPage.tsx:377` (+356); ideally coerce in `frontend/src/api/evaluations.ts`.

- [ ] **Step 1 — Read** the `total_responden === 0` check + the gate at :356.
- [ ] **Step 2 — Backup + edit:** `Number(data.overall.total_responden) === 0` at both sites (or coerce `overall` once in the api wrapper, like `queueStats.ts`).
- [ ] **Step 3 — Verify:** a zero-eval period renders the "Belum Ada Evaluasi" hero, not the insufficient-grade card.

### Task 31: Coerce GuestList edit fields (#37)

**Files:** Modify `frontend/src/pages/admin/GuestListPage.tsx:314` (`openEdit`).

- [ ] **Step 1 — Read** `openEdit` and the `Number()` coercion at ~:476.
- [ ] **Step 2 — Backup + edit:** `disabilitas: Number(guest.disabilitas)` (and `jenis_disabilitas`/`umur`/`pendidikan`/`pekerjaan`/`kategori_instansi`/`pemanfaatan`).
- [ ] **Step 3 — Verify:** edit a disabled guest → "Jenis Disabilitas" field visible immediately.

### Task 32: Export error toast — VisitLog (#38)

**Files:** Modify `VisitLogPage.tsx:738`.

- [ ] **Step 1 — Read** the export handler.
- [ ] **Step 2 — Backup + edit:** add `.catch(() => toast.error('Gagal mengekspor data'))` and a button loading state; map empty filter values to `|| undefined` for consistency.
- [ ] **Step 3 — Verify:** force a failing export (offline) → error toast, no silent nothing.

### Task 33: Export error toast — Responden (#39)

**Files:** Modify `frontend/src/pages/admin/RespondenTahunanPage.tsx:263` (`handleExport`, `handleExportMd`).

- [ ] **Step 1 — Read** both handlers; confirm `toast` import.
- [ ] **Step 2 — Backup + edit:** `.catch(() => toast.error('Gagal mengekspor'))` on both; disable buttons while pending.
- [ ] **Step 3 — Verify:** force failure → toast; success unchanged.

### Task 34: Shared API-error helper (#40, #46)

**Files:** Create `frontend/src/lib/apiError.ts`; modify ~10 callers (incl. `DtsenQueuePage.tsx:43`, `components/wa/ChatPopup.tsx:73`).

- [ ] **Step 1 — Read** `UserManagementPage.tsx:59` / `WaCheckInPage.tsx:13` for the sanctioned `axios.isAxiosError` pattern; `grep -rn "as any).response" frontend/src` to enumerate callers.
- [ ] **Step 2 — Create** `getApiErrorMessage(e: unknown, fallback = 'Terjadi kesalahan'): string` on `axios.isAxiosError`.
- [ ] **Step 3 — Backup + edit each caller:** replace `(e as any).response?.data?.message` with the helper; remove the `eslint-disable no-explicit-any` lines.
- [ ] **Step 4 — Verify:** `npm run lint` clean (no disables), `npm run build` passes; error toasts still show the right message.

### Task 35: Fix code-style.md naming rule (#47)

**Files:** Modify `.claude/rules/code-style.md:19` (doc only, no deploy).

- [ ] **Step 1 — Backup + edit:** amend to the real convention — pages = default export matching filename; components = named export matching filename; `components/ui/` = shadcn kebab-case. **Do not change any code.**
- [ ] **Step 2 — Verify:** `diff` — doc only.

### Batch 4 checkpoint
- [ ] Branch `fix/audit-batch4-frontend`; **bump `frontend/public/sw.js` CACHE_NAME**; `npm run lint && npm run build`; user review; `pm2 restart bukutamu-frontend`; `pm2 logs bukutamu-frontend --lines 30`; smoke DTSEN detail / empty-eval / guest edit / export-fail at `localhost:3060`.

---

## Batch 5 — Connectors · pm2 restart / **planned relink window**

> ⚠️ Tasks 36–37 restart the WA connector (cold-sync gauntlet). Do this in a deliberate window; do NOT restart on a "tidak merespons" alert. Tasks 38–42 (notifier/print) restart lighter services.

### Task 36: Clear sent-ids only on ACK success (#9)

**Files:** Modify `wa/server.js:418`.

- [ ] **Step 1 — Read** the pre-backfill ack path and the `.catch` that swallows failures.
- [ ] **Step 2 — Backup + edit:** clear `sentOutbox`/`chatSent` only inside the ack-success (`res.ok`) branch; on failure, skip backfill this tick so sent ids are never dropped while rows are `pending`.
- [ ] **Step 3 — Verify (offline):** simulate an ack POST failure against a scratch endpoint → arrays retained, no duplicate resend next tick.

### Task 37: Idempotent give-up fail report (#10)

**Files:** Modify `wa/server.js:356`.

- [ ] **Step 1 — Read** the `MAX_SEND_ATTEMPTS` give-up path.
- [ ] **Step 2 — Backup + edit:** re-add the id to `failedOutbox`/`failedChat` until the fail POST returns `res.ok` (backend ack is idempotent), instead of a one-shot `continue`.
- [ ] **Step 3 — Verify (offline):** drop the fail POST once → id re-reported next tick; once `res.ok`, stops.

### Task 38: Notifier — mark seen only after successful push (#33)

**Files:** Modify `notifier/server.js:85`.

- [ ] **Step 1 — Read** the `lastSeen` update ordering vs `sendNotification`.
- [ ] **Step 2 — Backup + edit:** add an id to `lastSeen` only after ≥1 successful send (or on 404/410-only). Cap retries with a small per-id counter.
- [ ] **Step 3 — Verify (offline):** transient send error → id retried next tick; 410 → dropped.

### Task 39: Notifier — fetch timeout + overlap guard (#34)

**Files:** Modify `notifier/server.js:46`.

- [ ] **Step 1 — Read** the tick + fetches; mirror `wa/server.js` (`AbortSignal.timeout`, `busy` flag).
- [ ] **Step 2 — Backup + edit:** wrap fetches in `AbortSignal.timeout(...)`; add a `busy` flag set on entry / cleared in `finally`.
- [ ] **Step 3 — Verify (offline):** stall the backend → tick aborts, no overlapping ticks pile up.

### Task 40: Print — flush before success reply (#35)

**Files:** Modify `print/server.js:129`.

- [ ] **Step 1 — Read** the escpos chain + `.close()`.
- [ ] **Step 2 — Backup + edit:** pass `.close(err => …)`; defer `res.send` until flush; `500` on flush error.
- [ ] **Step 3 — Verify:** contract-verify by hand; **flag for operator test on a kiosk with a USB POS-58** (cannot test here).

### Task 41: Print — process-level guards (#36)

**Files:** Modify `print/server.js:86`.

- [ ] **Step 1 — Read** the `device.open` callback and try/catch scope.
- [ ] **Step 2 — Backup + edit:** add `process.on('uncaughtException'|'unhandledRejection')` (log + exit(1), matching wa); wrap the open-callback body in try/catch that answers the pending response `500` before rethrow.
- [ ] **Step 3 — Verify:** node syntax check (`node --check print/server.js`); operator smoke on a kiosk.

### Task 42: Print — pin CORS to kiosk origin (#45)

**Files:** Modify `print/server.js:26`.

- [ ] **Step 1 — Backup + edit:** replace `*` with an env-configurable origin (default `https://bukutamu.bpsmalut.com`).
- [ ] **Step 2 — Verify:** `node --check`; confirm the kiosk origin still reaches `/print`.

### Batch 5 checkpoint
- [ ] Branch `fix/audit-batch5-connectors`; commit; user review. **Notifier/print:** `pm2 restart bukutamu-notifier` / kiosk operators pull print. **WA:** schedule the relink window, then `pm2 restart bukutamu-wa`; watch for readiness; verify inbox/send. Print requires kiosk hardware test — report as operator-pending.

---

## Batch 6 — Infra / TLS · Apache vhost + certbot · ships last, highest care

### Task 43: Enforce HTTPS for backend + secure cookie (#2)

**Files:** Apache vhost for :60/:460; `backend/application/modules/api/controllers/Auth.php` cookie flags.

- [ ] **Step 1 — Read** the current vhost config and the `Auth.php` cookie `secure` conditional; confirm certbot is installed and the CF topology (:460 bypasses CF, self-signed today).
- [ ] **Step 2 — Backup vhost:** copy the vhost file before editing.
- [ ] **Step 3 — Cert:** issue a trusted cert for the :460 host via certbot (staging dry-run first if possible).
- [ ] **Step 4 — Vhost edit:** add a 301 from :60 → `https://…:460` (leave any endpoint that genuinely must stay HTTP explicitly excepted); add HSTS on :460.
- [ ] **Step 5 — Cookie:** set `jwt_token` `secure` unconditionally in `Auth.php` (backup first).
- [ ] **Step 6 — Verify:** `curl -I http://…:60/api/auth/check` → 301 to :460; `curl https://…:460/api/auth/check` → 401 with a valid (non-self-signed) cert; login sets a `Secure` cookie; HSTS header present. **Keep the old cert until the new one is confirmed.** `sudo apachectl -k graceful` only after config test passes (`apachectl configtest`).

### Task 44: Guard prod-DB smoke scripts (#13)

**Files:** Modify `scripts/smoke/smoke_flows.sh` (and siblings that mutate) + `push.php` restore logic.

- [ ] **Step 1 — Read** the trap-based restore and the `wa_notify_group` mutation + `LIKE '0888399%'` cleanup.
- [ ] **Step 2 — Backup + edit:** prepend a guard that refuses to run without a same-day dump (or invokes `db_tamdes_daily_backup.sh` first); restore `push.php` on startup by detecting a leftover `.smokebak` rather than relying solely on `trap EXIT`.
- [ ] **Step 3 — Verify:** run the script with no same-day dump → refuses; with a dump → runs and restores cleanly even if killed with SIGKILL mid-run (leftover `.smokebak` detected on next start).

### Batch 6 checkpoint
- [ ] Branch `fix/audit-batch6-infra`; commit; user review; execute the cert/vhost cutover in a planned window with `apachectl configtest` before `graceful`; verify 301 + trusted cert + Secure cookie + HSTS; rollback = revert vhost + keep old cert.

---

## Self-review — spec coverage

All 47 findings have a task: B0 {4→T1, 20→T2} · B1 {3→T3,7→T4,8→T5,21→T6,22→T7,23→T8,24→T9,30→T10,31→T11,32→T12} · B2 {5→T13,6→T14,11→T15,17→T16,19→T17,42→T18} · B3 {1→T19,12→T20,14→T21,15→T22,18→T23,26/27/28→T24,29→T25,41→T26,43→T27,44→T28} · B4 {16→T29,25→T30,37→T31,38→T32,39→T33,40/46→T34,47→T35} · B5 {9→T36,10→T37,33→T38,34→T39,35→T40,36→T41,45→T42} · B6 {2→T43,13→T44}. **47/47 covered.**
