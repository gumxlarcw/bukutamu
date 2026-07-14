# Audit Remediation — Design Spec

**Date:** 2026-07-12
**Source:** Full read-only audit of the bukutamu prod monorepo (47 findings: 3 High, 7 Medium, 31 Low, 6 Info; 0 refuted).
**Goal:** Fix **all 47** findings on a live production system with no staging, without an outage.

---

## Locked decisions

1. **Scope:** all 47 findings, including Info and doc-only items.
2. **Delivery:** one branch per **deploy-unit**; user reviews + agent verifies each batch before it goes live. Never mix deploy mechanisms in one PR.
3. **WA operator inbox is EXCLUSIVE per-operator** (take-over lock is real, admin override allowed) → findings **#17 and #19 are bugs** to fix with ownership checks, not doc changes.
4. **Ops items implemented in-repo by the agent** (TLS/vhost, connector, smoke guards); the **live-cutover step** for each (Apache reload, cert issue, connector relink, prod-DB touch) happens **only at that batch's review checkpoint**, never silently.

## Approach decisions (agent's call, user approved)

- **#1 kiosk IDOR:** (a) immediate rate-limit on `profile_gaps`; (b) bind the mutation token to a freshly-created `id_kunjungan` (proof of a recent face-match) instead of a bare `id_user`; (c) drop `notel`/`email` from the `profile_update` whitelist unless separately verified.
- **#12 JWT secret:** fail **closed** — `503` from `require_auth`/`require_kiosk_token` on missing/short `JWT_SECRET`; never substitute the path-derived fallback.
- **#23 missing role claim:** default to a **non-bypass sentinel** so soft-correct and `require_layanan_role` fail closed.

---

## Prod-safety protocol (every batch, every file)

1. Read the whole file/section first.
2. `cp {file} {file}.backup` immediately before the first edit (`*.backup` is git-ignored).
3. Minimal, style-matching edits.
4. `diff {file}.backup {file}` to verify.
5. **Verify the affected flow** — curl the endpoint / drive the page / lint+build for FE — not just "it compiles".
6. User review of the diff.
7. Deploy via the batch's mechanism.
8. Smoke-test post-deploy; confirm plainly (state failures with output).
9. FE↔BE parity checked per batch (a domain-rule change touches both sides in the same session).
10. No `Co-Authored-By` trailer. Each batch on its own branch off `main`.

**Rollback per mechanism:** BE = `git checkout` the file(s) + `apachectl -k graceful`; FE = redeploy previous `dist/` + `pm2 restart` (do NOT forget the `sw.js` cache implication); connector = restore file + planned `pm2 restart` in the same window; infra = revert vhost + `apachectl -k graceful`, keep old cert until new one verified.

---

## Batches

### Batch 0 — Secret & git hygiene  ·  git only, no service restart  ·  ships first (today)

| # | File | Change |
|---|---|---|
| 4 | `wa/.gitignore` | Broaden ignore to `.wwebjs_auth*` and `.wwebjs_cache*`; delete the stray `wa/.wwebjs_auth.bak-1780454696/` off-repo (do not stage). |
| 20 | `frontend/.env`, `frontend/.gitignore`, `docs/deploy-config.md` | `git rm --cached frontend/.env`; add `.env` + `.env.*` (keep `!.env.example`) to `frontend/.gitignore`; fix the doc var name to `VITE_API_URL` (matches `client.ts:4`). |

*Risk: none (no runtime code). Verify: `git status` shows the session dir ignored; `git ls-files` no longer lists `frontend/.env`; frontend still builds.*

### Batch 1 — Backend state-machine, gates & data-integrity  ·  Apache graceful

| # | File:line | Change |
|---|---|---|
| 3 | `Dtsen.php:63` | Reject non-DTSEN visits early (`if(!layanan_requires_dtsen_form($visit->jenis_layanan)) 400`); or mirror the SKD soft-correct + form/keterangan gates from `Visits::status`. |
| 7 | `Consultations.php:101` | Add DTSEN form-complete gate (copy Gate 3 from `Visits.php:253-261`) after Gate 2. |
| 8 | `Visits.php:244` (+ sibling gate site) | Count only real rows: `rincian_data IS NOT NULL AND TRIM(rincian_data) <> ''`. |
| 21 | `Visits.php:202` (all 3 status handlers) | Reject `status='menunggu_evaluasi'` (400) when `next_status_after_completion() !== 'menunggu_evaluasi'`. |
| 22 | `Consultations.php:124`, `Dtsen.php` | Write `audit('update_status','visit',$id,[from,to])` after the update (parity with `Visits::status`). |
| 23 | `Visits.php:219` | Default missing role claim to a non-bypass sentinel (fail closed). |
| 24 | `Evaluations.php:217` | Set `selesai_timestamp`/`durasi_detik` only on first submit (transition out of `menunggu_evaluasi`); correction re-submits update only rating/eval rows. |
| 30 | `Visits.php:165` | Wrap the 8-DELETE cascade in `trans_start()`/`trans_complete()`; return 500 on `trans_status()===FALSE`. |
| 31 | `Evaluations.php:186` | Wrap delete+insert(+visit update) in a transaction; reject 422 before deleting when the filtered kepuasan set is empty. |
| 32 | `Kiosk.php:80` | Re-run the recent-visit / faceless-reuse check **inside** the `LOCK TABLES` section (mirror `Wa.php:944-948`). |

*Verify: for each gate, curl the endpoint with a crafted status and confirm the correct 400/422 and that a legit flow still passes; confirm audit rows appear.*

### Batch 2 — Backend authz / role gates  ·  Apache graceful

| # | File:line | Change |
|---|---|---|
| 5 | `Wa.php:1544` | Split read vs write role sets; drop `pimpinan` from the write paths (messages POST, `messages_upload`, `react`, `seen`, `session_assign`, `visit_selesai`). |
| 6 | `Wa.php:655` | `require_role('admin')` → `require_role_in(['admin','superadmin'])` for `session_delete`. |
| 11 | `Wa.php:246` | Restrict `disconnect()` and `pair()` to `require_role_in(['admin','superadmin'])`. |
| 17 | `Wa.php:424` | Enforce `assigned_to` ownership (with admin override) on messages POST / `upload` / `react`. **Inbox is exclusive.** |
| 19 | `Deliveries.php:202` | Scope `file`/`detail` access to `created_by` / assigned verifier, not any staff role. |
| 42 | `Deliveries.php:159` (info) | Document the single-verifier Phase-1 assumption; note the assigned-verifier gate to add when multi-verifier routing lands. |

*Verify: with a pimpinan-role JWT, confirm each write path now 403s; with a non-owning PST JWT, confirm chat write 403s while admin override works.*

### Batch 3 — Backend security hardening & conventions  ·  Apache graceful

| # | File:line | Change |
|---|---|---|
| 1 | `Kiosk.php:434` | Rate-limit `profile_gaps`; bind `profile_update` token to a fresh `id_kunjungan`; drop `notel`/`email` from the update whitelist unless separately verified. |
| 12 | `JWT_Helper.php:25` | Fail closed (`503`) on missing/short `JWT_SECRET`; never use the path-derived fallback. |
| 14 | `Consultations.php:186` | `test_sound`: return `502` when the TV proxy fails (mirror `call()`), so the FE toast reflects reality. |
| 15 | `Users.php:51,95` | Store `normalize_phone($notel)` on create + update. |
| 18 | `Evaluations.php:21` | Rate-limit `pending`/`detail`; trim free-text consultation rincian from the tablet payload to only what the eval form needs. |
| 26 | `Guests.php:12` | Append trailing `405` `json_response`. |
| 27 | `Guests.php:95` | Append trailing `405`. |
| 28 | `Users.php:12` (index + detail) | Append trailing `405` in both. |
| 29 | `Wa.php:1227` (3 fallbacks) | Change `?: $v->notel` fallbacks to `null` so the connector builds a valid jid via `jidFromLocal(phone_raw)`. |
| 41 | `Responden.php:187` | Rebuild the search branch with QB `->like()`/`->or_like()` or bound params; same for `_skd_clause()`/`_tw_clause()`. |
| 43 | `config.php:460` (info) | Document SameSite=Strict as the sole CSRF control; remove the 2 dead legacy `csrf_exclude_uris`; consider an Origin/Referer check in `Api_base` for non-GET. |
| 44 | `Visits.php:189` etc. (info) | Add `$id = (int) $id;` at the top of each `(:num)`-routed handler in Visits/Consultations/Dtsen. |

*Verify: #1 — confirm a token minted for one visit can't mutate another id_user, and notel/email no longer writable via the kiosk path; #12 — with JWT_SECRET blanked in a throwaway check, confirm 503 (not silent fallback); #14 — with :5001 down, confirm 502 + FE shows failure.*

### Batch 4 — Frontend  ·  build + PM2 + **bump `sw.js` CACHE_NAME**

| # | File:line | Change |
|---|---|---|
| 16 | `VisitLogPage.tsx:218` | Coerce `Number(row.jenis_konsultasi_dtsen)` / `Number(row.hasil)` in `DtsenResultDetail`. |
| 25 | `EvaluationSummaryPage.tsx:377` (+356) | `Number(data.overall.total_responden) === 0`; coerce `overall` once at the api-wrapper boundary. |
| 37 | `GuestListPage.tsx:314` | `Number(guest.disabilitas)` (and the other numeric fields) in `openEdit`. |
| 38 | `VisitLogPage.tsx:738` | `.catch(() => toast.error('Gagal mengekspor data'))` + button loading state. |
| 39 | `RespondenTahunanPage.tsx:263` | `.catch` toast on `handleExport` + `handleExportMd`; disable while pending. |
| 40 | new `src/lib/apiError.ts` + ~10 callers | Add `getApiErrorMessage(e: unknown, fallback)` on `axios.isAxiosError`; replace `(e as any).response?.data?.message` casts, remove the eslint-disable lines. |
| 46 | WA components (`ChatPopup.tsx:73` etc.) | Same shared helper as #40. |
| 47 | `.claude/rules/code-style.md:19` (doc, no deploy) | Amend to the real convention: pages = default export, components = named export, `components/ui/` = shadcn kebab-case. Do **not** change code. |

*Verify: `npm run lint` clean, `npm run build` passes; smoke the DTSEN detail dialog, the empty-state eval page, a guest edit, and a forced export failure toast. Bump `frontend/public/sw.js` CACHE_NAME.*

### Batch 5 — Connectors  ·  pm2 restart / **planned relink window**

> ⚠️ wa items (#9,#10) require restarting the WA connector. Per ops policy a **warm** connector is not casually restarted — schedule this batch in a deliberate window and expect the cold-sync gauntlet; do not restart on a "tidak merespons" alert.

| # | File:line | Change |
|---|---|---|
| 9 | `wa/server.js:418` | Clear `sentOutbox`/`chatSent` only inside the ack-success branch; on failure skip backfill this tick. |
| 10 | `wa/server.js:356` | Make the give-up fail report idempotent (re-add id until the POST returns `res.ok`). |
| 33 | `notifier/server.js:85` | Add id to `lastSeen` only after a successful send (or 404/410-only failures). |
| 34 | `notifier/server.js:46` | Wrap fetches in `AbortSignal.timeout(...)`; add a `busy` re-entrancy guard (mirror `wa/server.js`). |
| 35 | `print/server.js:129` | Callback on `.close(err=>...)`; defer `res.send` until flush; 500 on error. |
| 36 | `print/server.js:86` | Add `uncaughtException`/`unhandledRejection` guards; try/catch the open-callback and answer the pending response 500 before rethrow. |
| 45 | `print/server.js:26` (info) | Pin CORS to the kiosk origin (env-configurable) instead of `*`. |

*Verify: wa/notifier can be exercised against a scratch backend; print server contract verified by hand (needs a USB POS-58 on a kiosk for a real print — flag as operator-tested).*

### Batch 6 — Infra / TLS  ·  Apache vhost + certbot  ·  ships last, highest care

| # | Target | Change |
|---|---|---|
| 2 | Apache vhost for :60/:460, `Auth.php` cookie | 301 redirect :60 → https :460 (except any endpoint that must stay HTTP); issue a trusted cert on :460 via certbot; set the `jwt_token` cookie `secure` unconditionally; add HSTS. Coordinate with the Cloudflare/TLS topology (:460 bypasses CF, currently self-signed). |
| 13 | `scripts/smoke/*.sh`, `push.php` handling | Prepend a guard: refuse to run without a same-day dump (or invoke `db_tamdes_daily_backup.sh` first); restore `push.php` on startup by detecting a leftover `.smokebak` rather than relying solely on `trap EXIT`. |

*Verify: after 301 — `curl -I http://…:60/...` returns 301 to :460; `curl https://…:460/api/auth/check` returns 401 with a valid (non-self-signed) cert; login sets a `Secure` cookie; HSTS header present. Keep the old cert until the new one is confirmed.*

---

## Coverage check

All 47 findings mapped: B0 {4,20} · B1 {3,7,8,21,22,23,24,30,31,32} · B2 {5,6,11,17,19,42} · B3 {1,12,14,15,18,26,27,28,29,41,43,44} · B4 {16,25,37,38,39,40,46,47} · B5 {9,10,33,34,35,36,45} · B6 {2,13} = 47.

## Out of scope / explicitly deferred

None deferred (scope = all 47). Multi-verifier routing (referenced by #42) is a future feature, not part of this remediation.
