# Audit Remediation Implementation Plan — 2026-08-01

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 52 confirmed findings from [`docs/AUDIT_2026-08-01.md`](../../AUDIT_2026-08-01.md) on the live bukutamu production system, one deploy-unit at a time, without an outage.

**Spec:** `docs/AUDIT_2026-08-01.md` (52 confirmed: 7 high / 25 medium / 20 low, + 3 plausible). Finding numbers below (`#N`) refer to that report.

**Architecture:** Eight batches grouped by **deploy mechanism** (git-only → host scripts → backend PHP → Apache infra → frontend → DB migration + connector → data hygiene → ops). Each finding is one task; each batch ends with a review + cutover checkpoint. Work is written and `diff`ed in the working tree; the only live moments are each batch's explicit cutover — **except backend PHP, which goes live the instant the file is saved** (see Global Constraints).

**Tech Stack:** CodeIgniter 3 (PHP 7.4, HMVC, JSON-API) · React 19 + TypeScript 5.9 + Vite 8 · Node connectors (wwebjs / web-push / escpos) · MariaDB `db_tamdes` · Apache 2.4 + PM2 + Cloudflare Tunnel.

## Status (per 2026-08-01)

Dicatat di sini, BUKAN dengan mencentang tiap kotak — rencana 2026-07-12
punya 145 kotak yang semuanya kosong padahal Batch 0-nya sudah dikerjakan,
dan itu membuat orang menyimpulkan "tidak ada yang jalan". Satu blok status
lebih sulit basi.

| Batch | Status | Commit |
| --- | --- | --- |
| 0 — tangkap state produksi ke git | ✅ selesai | `d433bd7`, `5593210` |
| 1 — skrip backup host | ✅ selesai | `293d74d` |
| 2 — backend PHP | ✅ selesai (10/11) | `500b256`, `c26614c` |
| 3 — Apache `mod_remoteip` + redirect HTTPS | ✅ selesai | vhost di luar repo; `Auth.php` menyusul |
| 4 — migrasi DB + `Wa.php` | ✅ selesai | `aa90a9d` |
| 5 — frontend | ✅ selesai | `32800d7` |
| 6 — konektor WA (butuh jendela restart) | ✅ selesai | `9d3a08d` |
| 7 — hardening endpoint kiosk (#1 biometrik) | ⬜ belum | |
| 8 — hygiene data & ops | ⬜ belum | |

Catatan Batch 2: Task 7 (flag `Secure`) sempat DITUNDA karena prasyaratnya
belum ada, lalu dikerjakan bersama Batch 3 setelah redirect http→https
terpasang.

Temuan baru saat mengerjakan Batch 2 (belum diperbaiki, menunggu keputusan
pemilik karena mengubah kontrak prefix yang tertulis di AboutPage):
`Keperluan Pimpinan` → `K` bentrok `Konsultasi Statistik`, dan
`Lainnya Online` → `L` bentrok `Lainnya`. Audit hanya menangkap bentrok `D`.

## Global Constraints

- **No automated tests exist.** Verification = `npm run lint` + `npx tsc --noEmit` (FE), `curl` the endpoint (BE), read-end-to-end + `diff` (both), read-only SQL (DB). Never claim "tested" without pasting the command output. (`.claude/rules/testing.md`)
- **Prod-safety protocol, every file:** read the whole section → `cp {file} {file}.backup` → minimal edit → `diff {file}.backup {file}` → verify the affected flow → user review. (`*.backup` is git-ignored.)
- **⚠ Backend PHP is LIVE ON EDIT.** There is no deploy gate — CI3 loads the file per request. Saving a controller *is* the deploy. Consequences: (a) never save PHP that references an unapplied migration — **run the `ALTER` first**; (b) never leave a file half-edited; (c) `apachectl -k graceful` is only needed for vhost/PHP-ini changes, not controller edits. (auto-memory `infra_php_live_on_edit`)
- **⚠ `npm run build` is NOT read-only.** Vite empties `dist/`, which PM2 is actively serving → real 404s in production. Build to `dist-staging`, then copy **additively**: assets first, `index.html` last. Never delete old asset hashes (open tabs strand on a 404 that `serve.json` marks immutable for a year). (auto-memory `deploy_frontend_atomic_build`, `frontend_404_cached_immutable`)
- **Every FE deploy MUST bump `CACHE_NAME` in `frontend/public/sw.js`** (currently `admin-bukutamu-8200-v81`) or admins keep running pre-deploy code. (auto-memory `deploy_frontend_sw_cache_bump`)
- **Never put a `.backup` file under `frontend/public/`** — Vite copies it into `dist/` and PM2 publishes it. Back those up outside the tree. (auto-memory `frontend_public_backup_leak`)
- **Never restart a warm `bukutamu-wa`.** A restart costs an 8–15 min cold-sync outage. Connector changes are batched into ONE scheduled window (Batch 6). (auto-memory `wa_connector_resilience`)
- **Commit discipline:** NO `Co-Authored-By` trailer. Commit only at a batch checkpoint after user review. Each batch = its own branch off `main`.
- **FE↔BE parity:** a domain-rule change touches both sides in the same session. (auto-memory `feedback_backend_parity`)
- **Before ANY bulk/destructive SQL:** fresh dump + confirm row-count scope + known recovery path. `db_tamdes` is live with no staging. (auto-memory `feedback_prod_write_safety`)
- **Never** rename `db_tamdes` · return HTTP 200 with `success:false` · use port 5000 · add an `admin_users.role` value without an `ALTER`.
- **Known traps to respect while editing:** CI3 mysqli returns numerics as **strings** (`"0"` is truthy); `count_all_results()` **resets** the query builder; `konsultasi_pengunjung` is saved delete-all-then-reinsert so any field not rendered by the form is silently wiped.
- **Verify helpers:** `scripts/smoke/mintjwt.php` (admin JWT), `scripts/smoke/mintkiosk.php` (kiosk token). Backend base `http://127.0.0.1:60/api/` with `-H 'Host: bukutamu.bpsmalut.com'`. **Do not run the write-heavy scripts in `scripts/smoke/` against prod.**

---

## Batch 0 — Capture production state into git · git only, no service restart · ships first

> Rationale: `wa/server.js` has been running in production **uncommitted since 2026-07-23**, and `origin/main` does not have it. `wa/server.js.backup` is the *pre-fix* version, so a naive restore makes it worse. Every later batch is safer once this is committed.

### Task 1: Commit the live connector fix, the ops scripts, and the audit report (#8)

**Files:** `wa/server.js` (modified, uncommitted) · `scripts/ops/{wa_session_snapshot.sh,wa_session_restore.sh}` (untracked) · `docs/AUDIT_2026-08-01.md` (untracked).

- [ ] **Step 1 — Confirm what is at risk:** `git status --short` shows exactly `M wa/server.js`, `?? scripts/ops/`, `?? docs/AUDIT_2026-08-01.md`. Confirm the running process predates nothing: `stat -c %y wa/server.js` (2026-07-15) vs `ps -o lstart= -p $(pgrep -f 'wa/server.js')` (2026-07-23) — the process started **after** the edit, so production is running this file.
- [ ] **Step 2 — Prove the backup is the wrong version** (so nobody "restores" it later): `grep -c QR_DEADLINE_MS wa/server.js.backup` → `0`; `grep -c QR_DEADLINE_MS wa/server.js` → non-zero. Delete the stale backup: `rm wa/server.js.backup`.
- [ ] **Step 3 — Review the diff as a PR:** `git diff wa/server.js`. Expect exactly two changes — the QR-phase watchdog relaxation (`READY_DEADLINE_MS` 180 s vs `QR_DEADLINE_MS` 30 min, re-armed per `qr`/`code` event, tightened again on `authenticated`) and `killBrowserSync()` added to the `initialize` retry loop.
- [ ] **Step 4 — Record the cron dependency** so the schedule survives a rebuild. Create `scripts/ops/README.md`:

```markdown
# ops scripts

`wa_session_snapshot.sh` — 6-hourly snapshot of the WhatsApp LocalAuth session.
Installed in root crontab:

    20 */6 * * * /var/www/html/bukutamu/scripts/ops/wa_session_snapshot.sh

Writes to /var/backups/bukutamu-wa (keeps 12). Gated on wa_qr_state.ready=1 and
a heartbeat <120 s, uses flock, writes .tmp then atomically mv's into place, and
reads the DB read-only. Safe to run by hand.

`wa_session_restore.sh` — interactive restore of a snapshot. Stops bukutamu-wa,
moves the current session aside (path printed on stdout), extracts, restarts.
Run only during a planned relink window.
```

- [ ] **Step 5 — Verify nothing secret is being added:** `git add -n scripts/ops/ docs/AUDIT_2026-08-01.md wa/server.js` lists only those paths — no `config.json`, no `.wwebjs_auth`, no `*.backup`. Confirm with `git check-ignore wa/config.json` (prints the path).
- [ ] **Step 6 — Commit and push:**

```bash
git add wa/server.js scripts/ops/ docs/AUDIT_2026-08-01.md
git commit -m "fix(wa): commit live QR-watchdog + killBrowserSync fix, add ops scripts and 2026-08-01 audit"
git push origin main
```

- [ ] **Step 7 — Verify:** `git status --short` clean; `git log --oneline origin/main..HEAD` empty. **No PM2 restart** — the running process already has this code.

### Task 2: Stop the deploy skill from prompting a destructive "make git clean" (#8)

**Files:** Modify `.claude/skills/deploy/SKILL.md` pre-flight step 1.

- [ ] **Step 1 — Read** the "Pre-flight (always)" section; note step 1 currently reads "Confirm `git status` is clean".
- [ ] **Step 2 — Backup:** `cp .claude/skills/deploy/SKILL.md .claude/skills/deploy/SKILL.md.backup`
- [ ] **Step 3 — Edit** step 1 to: *"Confirm `git status` is clean. If it is NOT, **investigate before discarding** — production may be running an uncommitted file (this happened with `wa/server.js`, 2026-07-15 → 2026-08-01). Never `git checkout --` or `git clean -fd` to make it clean."*
- [ ] **Step 4 — Verify:** `diff .claude/skills/deploy/SKILL.md.backup .claude/skills/deploy/SKILL.md`.

### Batch 0 checkpoint
- [ ] Committed on `main` directly (no code paths touched). User review of the `wa/server.js` diff. **No service restart.**

---

## Batch 1 — Host backup scripts · cron only, no service restart

> Rationale: the weekly Google Drive upload currently carries WhatsApp session credentials. Next run is **Sunday** — this must land before then. These files are outside the repo.

### Task 3: Exclude WhatsApp session credentials from the weekly gdrive backup (#3)

**Files:** Modify `/usr/local/bin/full_backup_to_gdrive.sh` (the `tar` invocation, ~line 34).

- [ ] **Step 1 — Confirm the exposure:** `grep -c -iE 'wwebjs|bukutamu-wa' /usr/local/bin/full_backup_to_gdrive.sh` → `0` (no exclude exists). Confirm the payload: `du -sh /var/backups/bukutamu-wa /var/www/html/bukutamu/wa/.wwebjs_auth` → ~448 MB and ~698 MB.
- [ ] **Step 2 — Confirm the credentials really are inside** (not just cache): `tar -tzf /var/backups/bukutamu-wa/$(ls -t /var/backups/bukutamu-wa | head -1) | grep -c 'IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb'` → non-zero.
- [ ] **Step 3 — Backup:** `cp /usr/local/bin/full_backup_to_gdrive.sh /usr/local/bin/full_backup_to_gdrive.sh.backup`
- [ ] **Step 4 — Edit:** add **both** excludes to the `tar` list. One is not enough — the first covers the snapshots, the second covers the live profile:

```bash
  --exclude=/var/backups/bukutamu-wa \
  --exclude=/var/www/html/bukutamu/wa/.wwebjs_auth \
```

- [ ] **Step 5 — Verify without running the backup:** `diff /usr/local/bin/full_backup_to_gdrive.sh.backup /usr/local/bin/full_backup_to_gdrive.sh` shows only the two added lines. Then dry-run just the tar predicate:

```bash
tar -cf /dev/null --exclude=/var/backups/bukutamu-wa \
  --exclude=/var/www/html/bukutamu/wa/.wwebjs_auth \
  -v /var/www/html/bukutamu/wa 2>/dev/null | grep -c wwebjs_auth
```

Expected: `0`.
- [ ] **Step 6 — Decide on the existing remote copies.** `KEEP_REMOTE=2`, so two archives already on Drive contain the session. Confirm with the user whether to purge them; if yes, delete via `rclone delete` and note it here. **Also review who can read `gdrive:ServerBackups/`** — the same archive carries an `--all-databases` dump (guest PII + `wa_messages`).

### Task 4: Trim the WA session snapshot (#24p)

**Files:** Modify `scripts/ops/wa_session_snapshot.sh:10` (exclude list) and the misleading size comment at `:55`.

- [ ] **Step 1 — Measure** what dominates the 70.6 MB uncompressed archive: `du -sh /var/www/html/bukutamu/wa/.wwebjs_auth/session/Default/* | sort -rh | head -8`. Expect `CertificateRevocation` ≈ 29.59 MB (42%), `IndexedDB` 20.01 MB, `ScriptCache` 14.25 MB, `DIPS` 3.97 MB.
- [ ] **Step 2 — Backup:** `cp scripts/ops/wa_session_snapshot.sh scripts/ops/wa_session_snapshot.sh.backup`
- [ ] **Step 3 — Edit:** add three excludes — `CertificateRevocation`, `ScriptCache`, `DIPS-wal`. **Keep the `DIPS` DB file itself and all of `IndexedDB`** (IndexedDB *is* the credential store). Correct the `<1 MB` comment at `:55` to the real figure.
- [ ] **Step 4 — Verify by restore, not by size:** run the snapshot manually, extract to a scratch dir, and confirm `session/Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/` is present and non-empty. `diff` the script.
- [ ] **Step 5 — Sanity-check the new size:** expect ~22.8 MB uncompressed.

### Task 5: Add a rollback trap to the restore script (#24o)

**Files:** Modify `scripts/ops/wa_session_restore.sh:36`.

- [ ] **Step 1 — Read** the script end to end; note line 34 already prints where the old session was moved.
- [ ] **Step 2 — Backup:** `cp scripts/ops/wa_session_restore.sh scripts/ops/wa_session_restore.sh.backup`
- [ ] **Step 3 — Edit:** add a trap so a failed extract restores the previous session instead of leaving the connector with no `session/` dir:

```bash
trap 'rc=$?; if [ $rc -ne 0 ] && [ -d "$OLD_SESSION" ]; then
  echo "[!] restore failed (rc=$rc) — putting the previous session back"
  rm -rf "$SESSION_DIR"; mv "$OLD_SESSION" "$SESSION_DIR"
  pm2 start bukutamu-wa >/dev/null 2>&1 || true
fi' EXIT
```

Place it immediately after `$OLD_SESSION` is assigned. Match the script's existing variable names when you read it — the names above are illustrative.
- [ ] **Step 4 — Verify:** `bash -n scripts/ops/wa_session_restore.sh` (syntax only). Then rehearse with a deliberately corrupt archive **against a scratch copy of the script pointed at a temp dir** — never against the live session. `diff` the script.

### Batch 1 checkpoint
- [ ] `git checkout -b fix/audit-batch1-backup-hygiene`; commit `scripts/ops/` changes (`/usr/local/bin/` is outside the repo — note its change in the commit body); user review; merge. **No service restart.** Confirm the next weekly gdrive run is clean.

---

## Batch 2 — Backend PHP · ⚠ LIVE ON EDIT — each save is a deploy

> **Read this before touching anything in this batch.** Saving a controller deploys it instantly. Work one task at a time, verify with `curl` immediately after each save, and keep the `.backup` beside it so a revert is one `cp` away. Order matters: Task 6 removes an internet-triggerable outage and is the single highest-value change in the plan.

### Task 6: Make the login lockout per-account instead of per-IP (#2)

**Files:** Modify `backend/application/modules/api/controllers/Auth.php:53-62`.

**Why:** every public request arrives as `::1` (Cloudflare Tunnel → `localhost:60`, no `mod_remoteip`), so the lockout counts *all* failures into one bucket. Five bad logins from anywhere lock all 8 admins for 15 minutes. Worse, `:62` writes another `success=0` row on the already-rejected path, so honest staff retries slide the window forward indefinitely. This fix stands alone — it does not depend on Batch 3.

- [ ] **Step 1 — Read** `Auth.php:39-80` fully. Confirm the count at `:53-61` filters on `ip_address` + `success=0` + `created_at >` and has **no** `username` predicate, and that `:61` returns 429 *before* `password_verify`.
- [ ] **Step 2 — Confirm the blast radius:** `mysql db_tamdes -e "SELECT ip_address, COUNT(*) FROM tamdes_login_attempts GROUP BY 1;"` → `::1`=410, `127.0.0.1`=3. `mysql db_tamdes -e "SELECT COUNT(*) FROM admin_users WHERE active=1;"` → 8 accounts share the bucket.
- [ ] **Step 3 — Backup:** `cp backend/application/modules/api/controllers/Auth.php backend/application/modules/api/controllers/Auth.php.backup`
- [ ] **Step 4 — Edit:** add the username predicate to the count, so one account's failures cannot lock another:

```php
$recent_fails = $this->db
    ->where('ip_address', $ip)
    ->where('username', $username)   // ← lockout is per-account, not per-IP
    ->where('success', 0)
    ->where('created_at >', $cutoff)
    ->count_all_results('tamdes_login_attempts');
```

- [ ] **Step 5 — Stop the self-renewing window:** at `:62`, do **not** call `_log_attempt()` on the already-locked path — return the 429 without writing another failure row. Otherwise every staff retry extends their own lockout.
- [ ] **Step 6 — Verify FAIL path is now scoped:** with a throwaway username, 5 bad POSTs to `/api/auth/login` → 6th returns 429 for *that* username:

```bash
for i in $(seq 1 6); do curl -s -o /dev/null -w "%{http_code} " -X POST \
  -H 'Host: bukutamu.bpsmalut.com' -H 'Content-Type: application/json' \
  -d '{"username":"zz_lockout_probe","password":"wrong"}' \
  http://127.0.0.1:60/api/auth/login; done; echo
```

Expected: `401 401 401 401 401 429`.
- [ ] **Step 7 — Verify a REAL account is unaffected** while the probe is locked: POST a deliberately wrong password for a real username once → must be **401, not 429**. (Do not lock a real account: one attempt only, then stop.)
- [ ] **Step 8 — Clean up the probe rows** (they would otherwise sit in the table): `DELETE FROM tamdes_login_attempts WHERE username='zz_lockout_probe';` — confirm the count first, and take a dump if you are at all unsure.
- [ ] **Step 9 — Verify:** `diff Auth.php.backup Auth.php` shows only the two intended changes. Log in through the real UI once to confirm nothing regressed.

### Task 7: Set the session cookie `Secure` flag from config, not from `$_SERVER['HTTPS']` (#7)

**Files:** Modify `backend/application/modules/api/controllers/Auth.php:120-126` and `:163-169`.

**Why:** TLS terminates at Cloudflare; Apache sees plain HTTP and nothing sets `HTTPS=on`, so the 4-hour admin `jwt_token` is issued **without** `Secure`. CI3's own `ci_session` cookie *is* `Secure` (derived from `base_url` at `config.php:406`) — this is an internal inconsistency, not an ambiguity.

- [ ] **Step 1 — Confirm the precondition:** `curl -sI -H 'Host: bukutamu.bpsmalut.com' http://127.0.0.1:60/api/auth/check | head -1` returns a live API response (not a 301) — plain HTTP is genuinely served. And `grep -n cookie_secure backend/application/config/config.php` shows the CI3 setting already resolves correctly.
- [ ] **Step 2 — Backup:** `cp .../Auth.php .../Auth.php.backup` (skip if Task 6's backup is still current and unmodified since).
- [ ] **Step 3 — Edit** both cookie-setting sites:

```php
'secure' => (bool) $this->config->item('cookie_secure'),
```

Do **not** derive this from `X-Forwarded-Proto` — a client-influenced header must not decide a cookie flag.
- [ ] **Step 4 — Verify:** log in via `curl -i` and confirm `Set-Cookie: jwt_token=...` now carries `Secure` **and** still carries `HttpOnly`:

```bash
curl -si -X POST -H 'Host: bukutamu.bpsmalut.com' -H 'Content-Type: application/json' \
  -d '{"username":"<real>","password":"<real>"}' http://127.0.0.1:60/api/auth/login \
  | grep -i '^set-cookie'
```

- [ ] **Step 5 — Verify the UI still logs in** over the public HTTPS URL (a `Secure` cookie is dropped on plain HTTP — confirm no one relies on `http://` access before you finish this task). `diff` the file.
- [ ] **Step 6 — Enable Cloudflare "Always Use HTTPS" + HSTS** in the CF dashboard for `bukutamu.bpsmalut.com`, so plain HTTP is redirected rather than served. Record here that it was done — this is a console change, not a repo change.

### Task 8: Cap `durasi_detik` on the read side — repairs the published KPI immediately (#4)

**Files:** Modify `backend/application/modules/api/controllers/Queue_stats.php:17-21`, `:59`, `:69` and `Dashboard.php:57`.

**Why:** 2026 `AVG(durasi_detik)` is **46,877 s (13.0 h)** vs **13,644 s** with rows over one day excluded — a **3.44×** inflation on a KPI a statistics office reports. 20 of 219 durationed rows exceed a day; the worst is 342 h. The read-side cap fixes history with no migration and no data loss.

- [ ] **Step 1 — Reproduce the number** so you can prove the fix:

```sql
SELECT ROUND(AVG(durasi_detik)) all_sec,
       ROUND(AVG(CASE WHEN durasi_detik < 43200 THEN durasi_detik END)) capped_sec,
       SUM(durasi_detik >= 43200) over_12h, COUNT(durasi_detik) n
FROM tamdes_kunjungan WHERE YEAR(date_visit) = 2026;
```

- [ ] **Step 2 — Backup both files:** `cp Queue_stats.php Queue_stats.php.backup; cp Dashboard.php Dashboard.php.backup`
- [ ] **Step 3 — Edit:** add `AND durasi_detik < 43200` (12 h — longer than any real PST visit, shorter than any overnight artefact) to the `AVG()` predicate at all four sites. Keep the existing `IS NOT NULL` handling; a NULL must stay excluded, not become 0.
- [ ] **Step 4 — Verify via the API, not just SQL:**

```bash
curl -s -H 'Host: bukutamu.bpsmalut.com' -b "jwt_token=$(php scripts/smoke/mintjwt.php)" \
  http://127.0.0.1:60/api/queue-stats | python3 -m json.tool | grep -i durasi
```

Expected: the average drops from ~781 min to ~227 min.
- [ ] **Step 5 — Check the dashboard tile** at `/admin` renders the new figure and does not show `NaN` or `null` for a period with zero qualifying rows.
- [ ] **Step 6 — Verify:** `diff` both files.

### Task 9: Stop writing poisoned `durasi_detik` values (#4)

**Files:** Modify `Visits.php:291-292`, `Consultations.php:224-225` and `:405`, `Dtsen.php:210` and `:286`, `Evaluations.php:243-244`.

**Why:** every finalization path stamps `durasi_detik = max(0, now − date_visit)` unbounded. Closing the 11 currently-parked Rekomendasi visits through the normal UI would add eleven ~18-day rows. This matches the ops rule already in auto-memory: a visit closed on a later day must leave `durasi_detik` NULL.

- [ ] **Step 1 — Locate all six writers:** `grep -rn "durasi_detik" backend/application/modules/api/controllers/` — confirm exactly the six sites above (plus the read sites fixed in Task 8).
- [ ] **Step 2 — Backup** each of the four controllers before editing it.
- [ ] **Step 3 — Edit:** at each writer, skip the stamp (leave NULL) when the visit did not start today:

```php
// A visit closed on a later day has no meaningful service duration — leaving it
// NULL keeps it out of AVG() instead of poisoning the KPI (see AUDIT_2026-08-01 #4).
$same_day = date('Y-m-d', strtotime($visit->date_visit)) === date('Y-m-d');
$update['durasi_detik'] = $same_day ? max(0, time() - strtotime($visit->date_visit)) : null;
```

- [ ] **Step 4 — Fix the re-stamp trigger:** `Evaluations.php:202` derives `$is_first_submit` from `status === 'menunggu_evaluasi'`, so any downgrade back into that state re-stamps a stale duration on the next submit. Change it to key off `selesai_timestamp === null` instead.
- [ ] **Step 5 — Verify same-day path still stamps:** close one test visit created today and confirm `durasi_detik` is a plausible small number.
- [ ] **Step 6 — Verify cross-day path leaves NULL:** on a visit whose `date_visit` is before today, confirm the close writes `NULL`, not a large integer. **Use one of the 11 already-parked Rekomendasi visits only with the user's go-ahead** — they were parked deliberately (audit ids 1526-1536).
- [ ] **Step 7 — Verify:** `diff` all four controllers.

### Task 10: Enforce account deactivation and role changes on every request (#5b)

**Files:** Modify `backend/application/modules/api/controllers/Api_base.php:39-55` (`require_auth`).

**Why:** `require_auth()` decodes the JWT and never re-reads `admin_users`, and `require_role()` authorises off the **JWT's** role claim (`:119`). A deactivated, deleted or demoted account keeps every protected endpoint for up to 4 hours. `/api/auth/check` returns the fresh role, so the UI shows a revocation that did not happen.

- [ ] **Step 1 — Confirm:** `grep -n "admin_users" Api_base.php` shows no lookup inside `require_auth`; `grep -n "active" Api_base.php` shows `active` is consulted only at login (`Auth.php:68-71`).
- [ ] **Step 2 — Identify the exemption.** `Auth.php:86-99` issues a fallback token from `.env` credentials with `id=0` and **no `admin_users` row**. If you 401 that identity, the fallback login path breaks. Confirm the claim shape: `grep -n "'id'" Auth.php`.
- [ ] **Step 3 — Backup:** `cp Api_base.php Api_base.php.backup`
- [ ] **Step 4 — Edit `require_auth()`** — after a successful decode, re-read the row and overwrite the role from the DB:

```php
// Revocation check: the JWT is valid for 4h, so without this a deactivated or
// demoted account keeps access until expiry (see AUDIT_2026-08-01 #5).
// The .env fallback identity (id=0) has no admin_users row — exempt it.
if ((int) ($this->current_user->id ?? 0) !== 0) {
    $row = $this->db->get_where('admin_users',
        ['username' => $this->current_user->username])->row();
    if (!$row || (int) $row->active !== 1) {
        $this->json_response(['success' => false, 'message' => 'Akun tidak aktif'], 401);
    }
    $this->current_user->role = $row->role;   // authorise off the DB, not the claim
}
```

- [ ] **Step 5 — Verify the happy path first:** log in as a normal admin and hit 3-4 protected endpoints — all still 200. **Do this before Step 6**; a mistake here locks everyone out of the admin panel.
- [ ] **Step 6 — Verify revocation:** with a valid cookie in hand, `UPDATE admin_users SET active=0 WHERE username='<test>';` → the next protected call returns **401**. Then set it back to `1` and confirm access returns. Use a test account, not a real operator.
- [ ] **Step 7 — Verify the `.env` fallback still works:** log in with the fallback credentials and hit a protected endpoint — must be 200, not 401.
- [ ] **Step 8 — Verify:** `diff Api_base.php.backup Api_base.php`.

### Task 11: Add rate limiting and an int cast to the ticket endpoint (#6)

**Files:** Modify `backend/application/modules/api/controllers/Kiosk.php:401-418`.

**Why:** `ticket()` is the one public `Kiosk` method with neither a rate limit nor a token — verified live from the internet, two back-to-back 200s with no 429, returning visitor name + queue number + service. IDs sit in two contiguous blocks (52–678, 990003–990696), so ~1,400 unthrottled GETs dump the office's entire visit history including which visits were `Konsultasi DTSEN` or `Keperluan Pimpinan`. It also lacks `(int)` casting, and CI3 auto-routing lets `/api/kiosk/ticket/990696abc` through despite the `(:num)` route.

- [ ] **Step 1 — Confirm the gap:** `grep -n "require_rate_limit\|require_kiosk_token" Kiosk.php` — every other public method appears (`:17,:41,:61,:327,:428,:493,:537,:606`); `ticket` at `:401` does not.
- [ ] **Step 2 — Backup:** `cp Kiosk.php Kiosk.php.backup`
- [ ] **Step 3 — Edit:** add the throttle and the cast at the top of the method:

```php
$this->require_rate_limit('kiosk/ticket', 30);
$id = (int) $id;
if ($id <= 0) $this->json_response(['success' => false, 'message' => 'ID tidak valid'], 400);
```

- [ ] **Step 4 — Verify the cast:** `/api/kiosk/ticket/990696abc` now returns 400, not a full ticket.
- [ ] **Step 5 — Verify the throttle** (31 requests → last one 429). **Note:** until Batch 3 lands, this bucket is shared across all clients, so a real kiosk could be caught. Prefer to ship this task *after* Task 13, or accept the window knowingly.
- [ ] **Step 6 — Verify:** `diff Kiosk.php.backup Kiosk.php`.
- [ ] **Step 7 — Plan the token (do not implement yet):** the durable fix is `require_kiosk_token('ticket', $id)`, but **no `'ticket'` purpose is minted anywhere today** (existing mints: `Evaluations.php:23,58`; `Kiosk.php:473,573`; `Wa.php:1148,1249,1432,1449,1520`). It must be minted in `register()` / `visit()` / `wa_promote()` and threaded through the `navigate()` to `/kiosk/ticket/:id`. That is a coordinated FE+BE change — carry it in Batch 5 with Task 22.

### Task 12: Gate the report endpoints on the admin role (#14)

**Files:** Modify `Responden.php:20`, `Evaluations.php:295`, `Queue_stats.php:9`.

**Why:** all three call only `require_auth()`, while `Responden::export` (`:73-75`) and `Responden::visit_detail` (`:136-138`) *do* call `require_role('admin')` — the asymmetry proves oversight. Note the verifier **downgraded** this: no new personal data leaks (`/admin/guests` is already `operator`-tier by design); what leaks is the report view and aggregation.

- [ ] **Step 1 — Confirm each has exactly one FE consumer, all admin-tier:** `queueStats.ts:82`, `responden.ts:123`, `evaluations.ts:67`. Confirm `DashboardPage` calls none of them: `grep -rn "queueStatsApi\|respondenApi\|evaluationsApi" frontend/src/pages/admin/DashboardPage.tsx` → no output. **If this grep returns anything, stop** — gating would break the dashboard for non-admins.
- [ ] **Step 2 — Backup** all three controllers.
- [ ] **Step 3 — Edit:** add `$this->require_role('admin');` immediately after `require_auth()` at each site. Level ≥2 keeps `pimpinan`.
- [ ] **Step 4 — Verify FAIL path:** call each endpoint with a `petugas_pst` JWT → 403.
- [ ] **Step 5 — Verify PASS path:** call each with an `admin` JWT → 200 with the same payload as before.
- [ ] **Step 6 — Verify:** `diff` all three. The matching FE route guards land in Batch 5 Task 24 — until then the pages will render and then error, which is acceptable for admin-only screens but should not sit for long.

### Task 13: Close the Deliveries ownership gap (#13)

**Files:** Modify `Deliveries.php:98` (`resubmit`) and `:76-87` (DELETE/cancel branch); `Delivery_model::list_filtered` (`:70-83`).

**Why:** `require_delivery_access` appears at exactly two sites (`:71` detail, `:214` file). `resubmit()` has only `require_auth` + `require_role_in`, loads the row at `:108`, then overwrites `link_url`/`note_operator`/`media_*` and **resets** the verification fields at `:126-141`. `list_filtered` has no `created_by` predicate, so any of the 5 `petugas_pst` accounts can enumerate ids and hijack another operator's deliverable — audit-logged under the attacker's name. `data_deliveries` has 0 rows, so this bites the first time the feature is used in anger.

- [ ] **Step 1 — Confirm:** `grep -n "require_delivery_access" Deliveries.php` → only `:71` and `:214`.
- [ ] **Step 2 — Backup:** `cp Deliveries.php Deliveries.php.backup` and the model file.
- [ ] **Step 3 — Edit:** call `$this->require_delivery_access($row);` immediately after the row load in **both** `resubmit()` and the DELETE branch — **before** the status check, so the 409-vs-404 difference stops leaking existence.
- [ ] **Step 4 — Edit the model:** scope `list_filtered` by `created_by` when the caller's role is `petugas_pst` or `operator`; leave admin/verifikator unscoped.
- [ ] **Step 5 — Verify** with two `petugas_pst` JWTs: operator A creates a delivery; operator B's `resubmit` and `DELETE` on that id → 403; B's list does not contain it; A's own still works; admin still sees both.
- [ ] **Step 6 — Verify:** `diff` both files.

### Task 14: Add the missing guards to `Consultations::data` (#23)

**Files:** Modify `Consultations.php:398` (two independent omissions on one line) and mirror at `Dtsen.php:279`.

**Why:** (a) no Gate-3 DTSEN form check, so a `petugas_pst` posting directly can close a pure-DTSEN visit to `selesai` with 0 rows in `dtsen_konsultasi` — the three sibling endpoints all enforce it. **This does not breach the SKD invariant** (SKD and mixed visits still return `menunggu_evaluasi`). (b) `evaluasi_selesai` is missing from the skip list, so re-saving the form on a WA visit downgrades it to `menunggu_evaluasi`, where the inbox close button vanishes. Both are API-only — no UI reaches them, and there are 0 occurrences in production.

- [ ] **Step 1 — Read** `Consultations.php:310-410` and compare to the Gate-3 block at `:206-214` / `Visits.php:273-282` / `Dtsen.php:168-200`.
- [ ] **Step 2 — Backup:** `cp Consultations.php Consultations.php.backup`
- [ ] **Step 3 — Edit (a):** guard early, using the `$visit_check` already fetched at `:318`, **before** the transaction opens at `:358`:

```php
if ($this->layanan_requires_dtsen_form($visit_check->jenis_layanan)) {
    $this->json_response(['success' => false,
        'message' => 'Kunjungan DTSEN disimpan lewat endpoint DTSEN'], 400);
}
```

- [ ] **Step 4 — Edit (b):** add `&& $visit->status !== 'evaluasi_selesai'` to the transition condition at `:398`. Mirror the same skip at `Dtsen.php:279` for symmetry.
- [ ] **Step 5 — Verify FAIL:** POST `/api/consultations/<pure_dtsen_visit>/data` with a `petugas_pst` JWT → 400, and the visit's status unchanged on a follow-up GET.
- [ ] **Step 6 — Verify PASS:** the same POST against a normal SKD visit still saves and still returns `menunggu_evaluasi`.
- [ ] **Step 7 — Verify:** `diff` both files.

### Task 15: Give `Daftar Antrian Offline` its own queue prefix (#22)

**Files:** Modify `Api_base.php:668-676` (`$prefix_map`).

**Why:** `Daftar Antrian Offline` and `Konsultasi DTSEN` both resolve to `D`, and counting is per-service via `JSON_CONTAINS`, so **both series start at D001**. It also slips past `validate_no_cross_layanan` and `validate_sarana_for_layanan` because the name matches no group. Zero occurrences in 492 visits — but `ManualEntryForm.tsx:152` renders all 9 services unfiltered, so it is one tap away.

- [ ] **Step 1 — Reproduce:** `php -r` against the live map, or `grep -n -A10 'prefix_map' Api_base.php` and confirm both names fall through to `D`.
- [ ] **Step 2 — Backup:** `cp Api_base.php Api_base.php.backup` (skip if Task 10's backup is current).
- [ ] **Step 3 — Edit:** add `'daftar antrian offline' => 'A',` to `$prefix_map`. Match the map's existing key casing/normalisation exactly.
- [ ] **Step 4 — Verify:** create one manual-entry visit with that service → number is `A001`, and an existing DTSEN visit still mints `D00N`.
- [ ] **Step 5 — Verify:** `diff Api_base.php.backup Api_base.php`.
- [ ] **Step 6 — Raise with the user:** should `Daftar Antrian Offline` and `Lainnya Online` appear in the Manual Entry picker at all? Neither has a physical queue. If not, filter them at `ManualEntryForm.tsx:152` in Batch 5.

### Task 16: Low-severity backend hygiene (#24a, #24c, #24d)

**Files:** `Dtsen.php:234` · `Guests.php:170-181` · `Consultations.php:283` and `:295`.

- [ ] **Step 1 — `Dtsen::data()` GET (#24a):** add the `require_layanan_role()` its `Consultations` twin explicitly has. It currently exposes `nik_dirujuk` to 2 accounts (`nayla`, `halima`). Table has 0 rows. Backup → edit → verify a non-DTSEN role gets 403.
- [ ] **Step 2 — `Guests::photo` (#24c):** the only method in the API with **no verb guard**. Add the `GET` check. Change `Cache-Control: public, max-age=3600` on an authenticated face photo to `private, max-age=300` (matching its siblings) — `public` with no `Vary: Cookie` risks a shared-cache cross-user leak. Give the 404 branch a body and a `Content-Type`.
- [ ] **Step 3 — Envelope (#24d):** `Consultations::call` and `::test_sound` return `{success, message, nomor}` with no `data` key. Fix at the **two call sites**, not inside `proxy_antrian` (its failure return carries `http_code`). Inert today (`consultations.ts:12-13` types them `ApiResponse<null>` and both callers discard the response), so this is purely convention.
- [ ] **Step 4 — Verify** each with a `curl` and `diff` each file.

### Batch 2 checkpoint
- [ ] `git checkout -b fix/audit-batch2-backend`; commit; user review; merge. **No Apache reload needed** for controller edits (live on edit) — but run `curl -s -o /dev/null -w "%{http_code}" .../api/auth/check` → 401 as a final smoke test, and tail `/var/log/apache2/bukutamu60_error.log` for new PHP warnings.

---

## Batch 3 — Apache infrastructure · `apachectl -k graceful` · highest care

> **This batch is the only one that can take the whole site down.** It changes request handling for every request. Do it in a quiet window, and keep `apachectl configtest` green before every reload.

### Task 17: Restore real client IPs behind the Cloudflare Tunnel (#2)

**Files:** Enable `mod_remoteip`; modify `/etc/apache2/sites-enabled/bukutamu-60.conf` and `bukutamu-ssl.conf`. **Leave `backend/application/config/config.php:531` (`proxy_ips`) empty.**

**Why:** all 312,001 logged requests are `127.0.0.1`/`::1` — not one real client IP has ever been recorded. This blinds the audit log (1109 rows, zero attribution), makes `require_rate_limit` a single global bucket, and defeats the loopback half of `require_internal_secret()` (`Api_base.php:705`), whose own comment at `Notifications.php:40` claims "X-Internal-Secret + loopback only".

- [ ] **Step 1 — Confirm the current state:** `apachectl -M | grep -i remoteip` → empty. `grep -rn RemoteIP /etc/apache2/` → empty. `awk '{print $1}' /var/log/apache2/bukutamu60_access.log | sort -u` → only loopback.
- [ ] **Step 2 — ⚠ Do NOT fix this via `proxy_ips`.** Cloudflare *appends* to a client-supplied `X-Forwarded-For` and CI3 takes the **first** element, so `$config['proxy_ips'] = '127.0.0.1,::1'` would let any attacker forge `ip_address()` — including forging entries into the audit log and evading the per-account lockout. That is strictly worse than today. `mod_remoteip` with `CF-Connecting-IP` is not forgeable the same way because cloudflared overwrites it.
- [ ] **Step 3 — Enable the module:** `a2enmod remoteip` (does **not** reload by itself).
- [ ] **Step 4 — Backup both vhosts:** `cp /etc/apache2/sites-enabled/bukutamu-60.conf{,.backup}` and the same for `bukutamu-ssl.conf`. **Note:** `sites-enabled/` already holds `*.conf.bak-20260516-1909` files; those are inert (Apache only loads `*.conf`), but do not add more `.conf`-suffixed backups there.
- [ ] **Step 5 — Edit both vhosts,** inside each `<VirtualHost>`:

```apache
# Real client IP behind the Cloudflare Tunnel. cloudflared overwrites
# CF-Connecting-IP, so it is not client-forgeable; X-Forwarded-For is.
# Keep CI3's $config['proxy_ips'] EMPTY — it trusts XFF's first element.
RemoteIPHeader CF-Connecting-IP
RemoteIPTrustedProxy 127.0.0.1
RemoteIPTrustedProxy ::1
```

- [ ] **Step 6 — Config-test before reloading:** `apachectl configtest` → `Syntax OK`. **Do not reload on anything else.**
- [ ] **Step 7 — Reload:** `sudo apachectl -k graceful`.
- [ ] **Step 8 — Verify from the real edge:** `curl -s -o /dev/null https://bukutamu.bpsmalut.com/api/auth/check`, then `tail -2 /var/log/apache2/bukutamu60_access.log` — the first field must now be a **public IP**, not `::1`.
- [ ] **Step 9 — Verify loopback is still loopback:** `curl -s -H 'Host: bukutamu.bpsmalut.com' http://127.0.0.1:60/api/auth/check` still logs `127.0.0.1`. **This matters** — the WA connector and notifier authenticate partly on it. Confirm both are still healthy: `mysql db_tamdes -e "SELECT ready, updated_at FROM wa_qr_state;"` (heartbeat fresh) and `tail /root/.pm2/logs/bukutamu-notifier-error.log` (empty).
- [ ] **Step 10 — Verify the downstream effects:** a fresh admin action writes a real IP into `tamdes_audit_log`; a failed login writes a real IP into `tamdes_login_attempts`. Check with `SELECT ip_address, created_at FROM tamdes_audit_log ORDER BY id DESC LIMIT 3;`.
- [ ] **Step 11 — Rollback path if anything breaks:** `cp /etc/apache2/sites-enabled/bukutamu-60.conf.backup /etc/apache2/sites-enabled/bukutamu-60.conf` (same for ssl), `a2dismod remoteip`, `apachectl configtest`, `apachectl -k graceful`.

### Batch 3 checkpoint
- [ ] Vhosts are outside the repo — record the change in the commit body of a small doc update. User review. Watch `/var/log/apache2/bukutamu60_error.log` for 10 minutes after the reload. Re-run Task 11 Step 5 (the ticket throttle) now that buckets are per-client.

---

## Batch 4 — Database migrations · `ALTER` BEFORE any PHP that references it

> **Ordering is a hard requirement.** Backend PHP is live on edit, so PHP referencing an unapplied migration breaks production instantly — this exact mistake caused a 40-minute WA outage on 2026-06-19. Take a dump first.

### Task 18: Pre-flight backup

- [ ] **Step 1:** `mysqldump db_tamdes | gzip > /var/backups/db_tamdes_pre_batch4_$(date +%Y%m%d_%H%M).sql.gz` and confirm a non-trivial size.
- [ ] **Step 2:** confirm binlog is on for point-in-time recovery: `mysql -e "SHOW VARIABLES LIKE 'log_bin';"` → `ON`.

### Task 19: Add the missing `wa_outbox.msg_type` values (#12)

**Files:** New `docs/migrations/2026-08-01-wa-outbox-msgtype.sql`; then `Wa.php:1547` (guard), `:754`, `:1563` (writers).

**Why:** the ENUM lacks `closing` and `ditangani`. With `stricton => FALSE` both writers store `''` — 10 such rows exist. The advertised closing dedup at `Wa.php:1544` can therefore **never** fire (`WHERE msg_type='closing'` → 0, `WHERE msg_type=''` → 10), and the outbox taxonomy is corrupted so no type-keyed sweep can target these rows.

- [ ] **Step 1 — Confirm:** `SHOW COLUMNS FROM wa_outbox LIKE 'msg_type';` and `SELECT msg_type, COUNT(*) FROM wa_outbox GROUP BY 1;`.
- [ ] **Step 2 — Write the migration** `docs/migrations/2026-08-01-wa-outbox-msgtype.sql`:

```sql
ALTER TABLE wa_outbox MODIFY msg_type
  enum('intake_link','confirmation','eval_link','thankyou','group_notify',
       'menu','verif_request','ditangani','closing') NOT NULL;
```

- [ ] **Step 3 — Apply it** and confirm with `SHOW COLUMNS`.
- [ ] **Step 4 — Backfill the 10 blank rows by body match** (5 each). Inspect first (`SELECT id, LEFT(body,60) FROM wa_outbox WHERE msg_type='';`), confirm the split is exactly 5/5, then `UPDATE` with **explicit ids in an `IN()`** — never a broad predicate. (auto-memory `ops_backfill_close_durasi_null` pattern.)
- [ ] **Step 5 — Only now edit the PHP:** backup `Wa.php`, then make the writers at `:754` and `:1563` set the correct `msg_type`.
- [ ] **Step 6 — Make the guard atomic:** gate on the status transition rather than read-then-write — `->where('status','evaluasi_selesai')->update(...)` plus `affected_rows() === 1` at `Wa.php:708` and `:1305`.
- [ ] **Step 7 — Verify:** `SELECT msg_type, COUNT(*) FROM wa_outbox GROUP BY 1;` shows no `''`. `diff Wa.php`.

### Task 20: Give `wa_backfill` a failure state and fix the root cause (#10)

**Files:** New `docs/migrations/2026-08-01-wa-backfill-failed.sql`; then `Wa.php:299-300`; then `wa/server.js` (connector half → Batch 6).

**Why:** `status` is `enum('pending','done')` with no failure state, so after 4 attempts a row is marked `done` with no audit row and no `log_message('error')`. **Every row created after 2026-07-14 has `attempts=4`** — the designed outage-recovery path has been 100% dead for ~2.5 weeks, invisibly. Root cause is chat-id staleness after the 2026-07-15 session re-link, not `@lid`.

- [ ] **Step 1 — Confirm:** `SELECT attempts, COUNT(*) FROM wa_backfill GROUP BY 1;` → `0|92`, `4|26`.
- [ ] **Step 2 — Migration:**

```sql
ALTER TABLE wa_backfill MODIFY status enum('pending','done','failed') NOT NULL DEFAULT 'pending';
```

- [ ] **Step 3 — Apply**, confirm, **then** edit `Wa.php:300` to write `failed` instead of `done` on give-up, and emit `audit_system` + `log_message('error')` so the next failure is visible.
- [ ] **Step 4 — Backfill the historical rows:** set the 26 `attempts=4` rows to `failed` (explicit ids in `IN()`).
- [ ] **Step 5 — Verify:** `SELECT status, COUNT(*) FROM wa_backfill GROUP BY 1;`. The connector-side chat-id fallback is Batch 6 Task 26 — until then rows will correctly report `failed` rather than lying.

### Task 21: Clear the stale pairing state (#11)

**Files:** Modify `Wa.php:246` and the `qr_state` POST branch.

**Why:** `pair()` at `Wa.php:1207` is the only writer of `pair_phone`; nothing clears it on unlink or on successful link. The live row right now is `ready=1, number=6285176764422, pair_phone=6285176764422, pairing_code=W25H8HJK` — a stale pairing code armed on an already-linked connector. On "Putuskan & Ganti Nomor" to a *different* number, the connector unconditionally calls `requestPairingCode` on the first QR after restart, switching WhatsApp Web into `ALT_DEVICE_LINKING` for the **previous** number. The admin then scans a QR that can never authenticate, during an outage.

- [ ] **Step 1 — Confirm the live row:** `SELECT * FROM wa_qr_state\G`.
- [ ] **Step 2 — Backup** `Wa.php`, then null `pair_phone` and `pairing_code` in the update at `:246` and in the `qr_state` POST branch when `!empty($in['ready'])`.
- [ ] **Step 3 — Clear the current stale row** by hand: `UPDATE wa_qr_state SET pair_phone=NULL, pairing_code=NULL WHERE id=1;` (single row, id explicit).
- [ ] **Step 4 — Verify:** the row shows NULLs and `ready=1`; the admin "Layanan Online" page still shows the connector as linked. The `cancelPairingCode()` connector half is Batch 6 Task 26.

### Batch 4 checkpoint
- [ ] `git checkout -b fix/audit-batch4-wa-migrations`; commit the three migration files + `Wa.php`; user review; merge. **No connector restart** — these are backend + schema only. Confirm the WA heartbeat is still fresh afterwards.

---

## Batch 5 — Frontend · build to `dist-staging` → additive copy → PM2

> **Read the build constraint in Global Constraints before starting.** `npm run build` into `dist/` causes real production 404s. And bump `sw.js` `CACHE_NAME` or none of this reaches anyone.

### Task 22: Fix account deactivation in the UI (#5a)

**Files:** Modify `frontend/src/api/users.ts:11`; `frontend/src/pages/admin/UserManagementPage.tsx:116,121`.

**Why:** CI3 returns `active` as the string `"0"`. `:116` is `{!u.active && <span>Nonaktif</span>}` — `!"0"` is `false`, so the badge never renders and the superadmin thinks deactivation failed. `:121` is `active: !!u.active` — `!!"0"` is `true`, so the **next edit of that user** (rename, phone, role, password reset) silently PUTs `active: true` and `Users.php:99` writes 1 back, restoring login. `users.ts:11` declares `active: number`, so `tsc` cannot catch it. All 8 rows are currently `active=1`, so this is latent until deactivation is first used.

- [ ] **Step 1 — Confirm the type lie:** `grep -n active frontend/src/api/users.ts` → `active: number`. Confirm the runtime value is a string via the API response.
- [ ] **Step 2 — Backup** both files.
- [ ] **Step 3 — Edit `users.ts:11`** to `active: number | string` (honest about the CI3 boundary).
- [ ] **Step 4 — Edit the page** to coerce once per row, mirroring the existing precedent at `GuestListPage.tsx:73`:

```tsx
const isActive = Number(u.active) === 1
// :116
{!isActive && <span className="...">Nonaktif</span>}
// :121
active: isActive
```

- [ ] **Step 5 — Verify:** `npm run lint` (0 errors) and `npx tsc --noEmit -p tsconfig.app.json` (exit 0).
- [ ] **Step 6 — Verify behaviour** after deploy: deactivate a test account → badge appears; then edit that user's phone → it stays deactivated. Pair this with Batch 2 Task 10 so the backend actually enforces it.

### Task 23: Stop the kiosk showing raw JSON to every visitor (#15)

**Files:** Modify `frontend/src/components/kiosk/QueueTicket.tsx:107`.

**Why:** `{ticket.jenis_layanan}` renders unparsed and the field is typed `string`, so **every kiosk visitor's confirmation screen shows `["Perpustakaan"]`**. The thermal ticket is unaffected (`print/server.js` has its own `parseLayanan`).

- [ ] **Step 1 — Confirm:** `curl .../api/kiosk/ticket/990696` returns `"jenis_layanan": "[\"Perpustakaan\"]"`.
- [ ] **Step 2 — Backup**, then edit to `{parseLayanan(ticket.jenis_layanan).join(', ')}`, importing from `@/types/visit` as 13 other files already do.
- [ ] **Step 3 — Verify:** lint + tsc; then load the ticket screen and confirm it reads `Perpustakaan`. Check a multi-service visit (`990694` → `Konsultasi Statistik, Perpustakaan`).

### Task 24: Add an inactivity timeout to the ticket screen (#16)

**Files:** Modify `frontend/src/pages/kiosk/TicketPage.tsx`.

**Why:** all seven sibling kiosk pages arm `useInactivityTimeout(…, 120000)`; `TicketPage` does not. Its only exit is a manual button at `:74`, while its own copy ("Silakan tunggu panggilan") invites the visitor to walk away — so the kiosk parks on the previous visitor's full name, queue number, service and timestamp indefinitely.

- [ ] **Step 1 — Confirm** the seven siblings: `grep -rn useInactivityTimeout frontend/src/pages/kiosk/`.
- [ ] **Step 2 — Backup**, then add `useInactivityTimeout(() => navigate('/kiosk'), 45000)` — deliberately shorter than the 120 s used elsewhere, because this screen holds PII and the visitor only needs to read a number.
- [ ] **Step 3 — Verify:** lint + tsc; then leave the ticket screen idle and confirm it returns to `/kiosk` after ~45 s.

### Task 25: Replace the misleading "Selesai" action in Visit Log (#17)

**Files:** Modify `frontend/src/pages/admin/VisitLogPage.tsx:378-382` (and `:315`, `:481`).

**Why:** for an SKD visit in `menunggu_evaluasi`, the backend soft-corrects `selesai` → `menunggu_evaluasi`, then answers `success:true, "Status berhasil diupdate"`. Audit ids 470-473 show user `irma` hitting this four times in 8 seconds. **This is not a dead end** — `ConsultationQueuePage.tsx:196-211` renders "Buka Evaluasi" for exactly this status, which is the intended action since the 2026-07-31 dual-screen change. The defect is only the misleading feedback.

- [ ] **Step 1 — Confirm** `VisitLogPage.tsx:381` is the only caller that ever sends `'selesai'` for an SKD visit: `grep -rn "'selesai'" frontend/src/pages/admin/`.
- [ ] **Step 2 — Backup**, then replace that arm with the same "Buka Evaluasi" link used on the queue page, keeping a `'selesai'` arm only for `BYPASS_ROLES`.
- [ ] **Step 3 — Backend parity (Batch 2 follow-up):** at `Visits.php:237-244`, `Consultations.php:172-177`, `Dtsen.php:158-164`, replace the silent rewrite with a **409 naming the reason** so any other caller learns the truth. Verify with a `curl` that a `petugas_pst` sending `selesai` on an SKD visit now gets 409, not a green 200.
- [ ] **Step 4 — Verify:** lint + tsc; then confirm the Visit Log row for a `menunggu_evaluasi` SKD visit offers "Buka Evaluasi" and no longer shows a success toast for a no-op.
- [ ] **Step 5 — While in this file, fix the status-control gap (#24q):** Visit Log offers no control for `dipanggil`/`diproses`, and writes the legacy `'proses'` where the queue pages write `'diproses'`. Add the missing controls so a visit parked in either state is actionable from this page too. **⚠ Do NOT rename `proses` → `diproses` as a drive-by** — 186 historical rows use `proses` and both values are in the ENUM, so a rename is a data migration, not a cleanup. Write `'diproses'` for *new* transitions only and leave history alone.
- [ ] **Step 6 — Verify (#24q):** confirm the two previously "stuck" rows (1 `dipanggil` from 2026-05-13, 1 `diproses` from 2026-07-24) are now actionable from Visit Log, and that `SELECT status, COUNT(*) FROM tamdes_kunjungan WHERE status IN ('proses','diproses') GROUP BY 1;` still shows the historical `proses` rows untouched.

### Task 26: Bound the WA check-in face retry (#18)

**Files:** Modify `frontend/src/pages/kiosk/WaCheckInPage.tsx:139`.

**Why:** the `isPending` ternary swaps a `<div>` for a Fragment at the same child position, so React unmounts and remounts `FaceCapture` when the mutation settles; `submitted` (`FaceCapture.tsx:33`) cannot survive, and `:64-71` auto-fires again on `stableDescriptor`. Cycle ≈2.1 s, and `wa_promote` has a kiosk token but **no rate limit**. The verifier bounded the impact: `useInactivityTimeout(120000)` caps it at ~40 POSTs and the "Ganti Nomor" button renders outside the ternary, so it *is* escapable — and the auto-retry is beneficial in the common case.

- [ ] **Step 1 — Backup**, then keep the retry but bound it: an attempt counter in `WaCheckInPage`; after 2 failures stop rendering `FaceCapture` and show "Coba lagi" / "Hubungi petugas Resepsionis".
- [ ] **Step 2 — Verify:** lint + tsc; then force two failures and confirm the fallback UI appears and no further POSTs are sent (watch the network tab / access log).

### Task 27: Invalidate destination lists after create (#19)

**Files:** Modify `GuestAddPage.tsx:45-49`, `ManualEntryPage.tsx:27-40`, `GuestImportPage.tsx:150`; rename the query key in `ManualEntryPage.tsx:20-22`.

**Why:** none imports `useQueryClient`; each just toasts and navigates. `QueryProvider.tsx:4-11` sets `staleTime: 30_000` and `refetchOnWindowFocus: false`, and neither destination overrides it — so once the list renders the pre-create snapshot, **nothing ever schedules a refetch**. It persists until the operator changes a filter/page or reloads. Realistic consequence: a duplicate manual entry.

- [ ] **Step 1 — Backup** all four files.
- [ ] **Step 2 — Edit:** add `qc.invalidateQueries({ queryKey: [...] })` in each `onSuccess`.
- [ ] **Step 3 — Edit:** rename `['guests-all']` → `['guests','all']` so prefix invalidation reaches it and this class stops recurring. Update every reader of that key (`grep -rn "guests-all" frontend/src`).
- [ ] **Step 4 — Verify:** lint + tsc; then create a guest and confirm the list shows it immediately without a reload.

### Task 28: Fix the consultation form's "Batal" (#20)

**Files:** Modify `frontend/src/pages/admin/ConsultationFormPage.tsx:252`.

**Why:** `:45-46` define `isModal`/`goClose`; `:147` (save) and `:171` (back arrow) use `goClose`, but `:252` is hardcoded `navigate('/admin/consultations')` — the only close path that bypasses it. In modal mode this unmounts the inbox: `chats` is plain component state with no persistence, and each `ChatPopup` holds unsent `text` plus the staged "Kirim Data" `kdLink`/`kdNote`/`kdFile`. All lost, and `closeProses` (with its `['wa-inbox']` invalidation) never runs.

- [ ] **Step 1 — Backup**, then change `:252` to `onClick={goClose}`. The correct behaviour already exists on every other path.
- [ ] **Step 2 — Verify:** lint + tsc; then open the form from the WA inbox in modal mode with a chat popup holding unsent text, hit "Batal", and confirm the inbox and the draft survive.

### Task 29: Low-severity frontend hygiene (#24b, #24e, #24f, #24g)

- [ ] **Step 1 — `VerifikasiPage.tsx:350` (#24b):** it hardcodes `showActions={true}`, so `petugas_pst`/`operator` get live-looking Setuju/Revisi buttons that 403. `RequireRole` cannot express this (verifikator is level 1) — use an explicit `allowedRoles` guard.
- [ ] **Step 2 — Kiosk error copy (#24e):** `FaceCapturePage.tsx:45` and `FaceRecognizePage.tsx:68` show axios's English `err.message` ("Request failed with status code 500") at the exact moment a visitor needs guidance. The helper already exists (`lib/apiError.ts:9`) and `WaCheckInPage` already uses it — do the same.
- [ ] **Step 3 — `wa_kiosk` bucket (#24f):** `Queue_stats.php:93` and `VisitLogPage.tsx:412` have no `wa_kiosk` source bucket, so promoted WA check-ins report as "Lainnya" with a raw grey chip. 0 rows today. **FE and BE together.**
- [ ] **Step 4 — `avg_kepentingan` (#24g):** the column is 100% NULL (208/208) and written as literal `null` at `Evaluations.php:215`, yet `EvaluationSummaryPage.tsx:361` exports a **fabricated "0.00"** per indicator in the IKM CSV. Fix `Evaluations.php:304`/`:345` **and** the FE in the same change — fixing only the backend turns the cell into `NaN`. Decide with the user whether the metric is collected at all or dropped from the export.
- [ ] **Step 5 — Verify:** lint + tsc after each.

### Task 30: Frontend route guards for the report pages (#14 FE half)

**Files:** Modify `frontend/src/App.tsx:99,100,103`.

- [ ] **Step 1 — Backup**, then wrap `/admin/responden`, `/admin/evaluations`, `/admin/queue-stats` in `<RequireRole min="admin">`, matching `:101` (`/admin/audit`) and `:102` (`/admin/users`).
- [ ] **Step 2 — Verify:** lint + tsc; then confirm a `petugas_pst` session is redirected rather than shown a page that errors, and an `admin` session still reaches all three.

### Task 31: Batch 5 build and cutover

- [ ] **Step 1 — Bump the service worker:** edit `frontend/public/sw.js` `CACHE_NAME` from `admin-bukutamu-8200-v81` to `-v82`. **Back it up outside `public/`** (e.g. `/root/sw.js.backup`) — a `.backup` inside `public/` is copied into `dist/` and published.
- [ ] **Step 2 — Lint and typecheck:** `cd frontend && npm run lint` (expect ≤3 warnings, 0 errors) and `npx tsc --noEmit -p tsconfig.app.json` (exit 0).
- [ ] **Step 3 — Build to staging, never into the live dist:**

```bash
cd /var/www/html/bukutamu/frontend
npx vite build --outDir dist-staging --emptyOutDir
```

- [ ] **Step 4 — Confirm the build is complete before touching `dist/`:** `ls dist-staging/index.html dist-staging/assets | head` and check every hashed asset referenced by `dist-staging/index.html` exists in `dist-staging/assets/`.
- [ ] **Step 5 — Copy additively — assets first, `index.html` LAST:**

```bash
cp -r dist-staging/assets/. dist/assets/      # add new hashes, keep old ones
cp dist-staging/sw.js dist/sw.js
cp dist-staging/index.html dist/index.html    # last — this is the atomic switch
```

Never `rm` old hashes: open tabs would strand on a 404 that `serve.json` marks immutable for a year.
- [ ] **Step 6 — Verify serving:** `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:3060/` → `200 text/html`. Then fetch each asset hash in the new `index.html` → all 200. Then `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3060/assets/DOES-NOT-EXIST.js` → 404 with `no-store` (the 2026-07-31 protection still in place).
- [ ] **Step 7 — PM2 serves from disk, so no restart is required.** If you restart anyway, `pm2 logs bukutamu-frontend --lines 30` must be clean.
- [ ] **Step 8 — Verify in a real browser:** hard-reload `/admin`, confirm the new `CACHE_NAME` is active (DevTools → Application → Cache Storage) and walk one kiosk ticket screen + one Visit Log row.

### Batch 5 checkpoint
- [ ] `git checkout -b fix/audit-batch5-frontend`; commit; user review; merge. Announce to admins that a reload is needed (in-app reopen is not enough — a full reload is).

---

## Batch 6 — WhatsApp connector · ⚠ requires a restart window (8–15 min cold-sync outage)

> **Do not start this during business hours.** A restart of a warm connector costs an 8–15 min unlinked window. Batch **all** connector changes into this one window. Have `scripts/ops/wa_session_restore.sh` and a fresh snapshot ready before you begin.

### Task 32: Pre-window preparation

- [ ] **Step 1 — Agree the window with the user.** Confirm no pending WA conversations: `SELECT COUNT(*) FROM wa_sessions WHERE assigned_to IS NOT NULL;` and check the inbox is empty.
- [ ] **Step 2 — Fresh snapshot:** run `scripts/ops/wa_session_snapshot.sh` manually and confirm a new archive in `/var/backups/bukutamu-wa`.
- [ ] **Step 3 — Confirm current health so you can compare after:** `SELECT ready, updated_at FROM wa_qr_state;` (fresh heartbeat), `pm2 jlist | grep bukutamu-wa` (`restart_time`).

### Task 33: Connector-side fixes (#10, #11)

**Files:** Modify `wa/server.js` — chat-id fallback (for Task 20) and `cancelPairingCode` (for Task 21).

- [ ] **Step 1 — Backup:** `cp wa/server.js wa/server.js.backup` (this time the backup will be the *current* version — Batch 0 already committed it).
- [ ] **Step 2 — Chat-id fallback (#10 root cause):** when `getChatById` throws during backfill, fall back to `client.getNumberId(phone)` and POST the resolved id back so `wa_sessions.wa_chat_id` is refreshed. This is what actually makes backfill work again; Task 20 only made the failure visible.
- [ ] **Step 3 — `cancelPairingCode` (#11):** add `await client.cancelPairingCode()` at `wa/server.js:159` so "Batal / kembali ke QR" is no longer cosmetic. Today recovery requires a restart.
- [ ] **Step 4 — Syntax check without running:** `node --check wa/server.js`.
- [ ] **Step 5 — `diff wa/server.js.backup wa/server.js`** and have the user review before the restart.

### Task 34: The restart

- [ ] **Step 1:** `pm2 restart bukutamu-wa`
- [ ] **Step 2 — Watch it come up:** `pm2 logs bukutamu-wa --lines 50`. Expect the session to be **reused** — no QR. If a QR appears, the session was lost: use `scripts/ops/wa_session_restore.sh` with the Task 32 snapshot.
- [ ] **Step 3 — Verify liveness:** `SELECT ready, updated_at FROM wa_qr_state;` → `ready=1` with a heartbeat under 60 s old.
- [ ] **Step 4 — Verify inbound:** send one message from a test phone and confirm it lands in `wa_messages` and in `/admin/layanan-online`.
- [ ] **Step 5 — Verify backfill recovered:** `SELECT status, attempts, COUNT(*) FROM wa_backfill GROUP BY 1,2;` — new rows should reach `done`, not `failed` at `attempts=4`.
- [ ] **Step 6 — Verify pairing state stays clean:** `SELECT pair_phone, pairing_code FROM wa_qr_state;` → NULLs while linked.

### Batch 6 checkpoint
- [ ] `git checkout -b fix/audit-batch6-connector`; commit `wa/server.js`; user review; merge. **If anything is wrong, do not iterate live** — restore the snapshot and reschedule.

---

## Batch 7 — Kiosk endpoint hardening · coordinated FE+BE, ships after Batch 3

> This is the biometric exposure (#1). It is deliberately last among the security items because it needs a kiosk-side token and Batch 3's per-client rate limiting to be safe. **Interim mitigation is in Step 1 — do that early even if the rest waits.**

### Task 35: Stop the public biometric dump (#1)

**Files:** Modify `Kiosk.php:8-33` (`face_data`) and `:35-50` (`guest_list`); mint a `kiosk-device` token; thread it through the kiosk frontend.

**Why:** one anonymous GET returns **635,646 bytes** — `id_user`, `nama` and the 128-float face template for all 235 enrolled visitors. A second returns name + `nama_instansi` for all 243. The only guard is a rate limit that is irrelevant because one request *is* the whole table. The in-code comment at `:13-16` claims an Apache IP allowlist is the perimeter; **it does not exist**. Crawlers are already walking this vhost (`Googlebot/2.1`, `OAI-SearchBot/1.0` in the access log).

- [ ] **Step 1 — Interim mitigation, do this first:** add a `LIMIT` and pagination to both endpoints so no single request is ever a full dump. This is a small, low-risk backend edit that materially reduces exposure while the token work is designed.
- [ ] **Step 2 — ⚠ Do NOT "fix" this with an Apache IP allowlist.** Until Batch 3 lands, every client presents as `::1`, so `Require ip 10.x` would block the kiosks and admit the internet. Even after Batch 3, confirm the kiosks' real egress IP first.
- [ ] **Step 3 — Design the device token** with the user. Use the existing `Api_base::mint_kiosk_token` (`:523`) with a new `kiosk-device` purpose and a long TTL; decide how a kiosk obtains and stores it, and what happens when it expires (the kiosk must not silently stop recognising faces).
- [ ] **Step 4 — Backup, then add `require_kiosk_token('kiosk-device', 0)`** at the top of both methods.
- [ ] **Step 5 — Frontend:** thread the token through the kiosk face-recognition fetches.
- [ ] **Step 6 — Verify the FAIL path from the public internet:** `curl https://bukutamu.bpsmalut.com/api/kiosk/face-data` → 403, not 200 with 635 KB.
- [ ] **Step 7 — Verify the PASS path on a real kiosk:** face recognition still matches (warmup 600 ms, 5 samples, threshold 0.55, margin 0.08). **This needs physical hardware — the audit could not verify it.**
- [ ] **Step 8 — Longer term, raise with the user:** move matching server-side so descriptors never leave the box. Also ask whether the already-disclosed dataset warrants any notification, given these are irrevocable biometrics of 235 named people held by a government office.

### Batch 7 checkpoint
- [ ] `git checkout -b fix/audit-batch7-kiosk-token`; commit BE + FE together (parity rule); user review; merge; FE build per Batch 5 Task 31; smoke-test on a physical kiosk before calling it done.

---

## Batch 8 — Data hygiene and ops · no user-facing impact · lowest urgency

### Task 36: Decide the fate of the two dead BPS export columns (#21)

**Why:** `tamdes_kunjungan.hasil_konsultasi` — 492 rows, **0 non-empty**; every writer targets `konsultasi_pengunjung` instead, where 374/374 are filled. The export is scoped to 13 evaluated visits and the column is blank on 100% of them. `konsultasi_pengunjung.kode_bidang_statistik` — `varchar(5)`, 374 rows, 0 filled, **no write path anywhere**.

- [ ] **Step 1 — `hasil_konsultasi`:** add it to **both** `konsultasi_pengunjung` selects (`Responden.php:115` and `:145`), hoist the first non-empty row onto `$v->hasil_konsultasi` in `export()`, and drop `k.hasil_konsultasi` from `:85`.
- [ ] **Step 2 — `kode_bidang_statistik`: decide with the user.** Either render it in `ConsultationDataForm.tsx` **and** add it to the reinsert array at `Consultations.php:370`, or delete it from `Responden.php:115/146`, `responden.ts:87/113` and the four FE render sites.
- [ ] **Step 3 — ⚠ Do not SQL-backfill `kode_bidang_statistik` without Step 2.** `Consultations.php:363-387` saves via `delete()` + explicit-key reinsert that omits this key, so any backfill is **silently destroyed** on the next operator save. (auto-memory `hidden_field_read_modify_write`)
- [ ] **Step 4 — Deadline:** settle this *before* the next annual export.

### Task 37: Remaining low-severity hygiene (#24h–#24n)

- [ ] **`tamdes_responden_tahunan` (#24h):** WRITE-LOCKED on the kiosk and WA check-in paths but never read or written (154 stale rows). Drop it from both `LOCK TABLES` lists (`Kiosk.php:117`, `Wa.php:968`) and correct `docs/DOKUMENTASI_BUKUTAMU.md:677` and `docs/FLOW_PENGUNJUNG.md:179`, which assert a live UPSERT.
- [ ] **Config file modes (#24i):** `database.php` and `push.php` are 0644 while `.env` holding the same class of secrets is 0640. `chmod 640` both. Marginal (2 interactive accounts, all PM2 services run as root). The four `config/*.backup` files are **not** web-served — verified SPA fallback — so leave them.
- [ ] **Logout audit rows (#24j):** 65 of 120 are `admin_user='unknown'`. The proposed fix is already implemented (`Auth.php:149-154` decodes before clearing); the real gaps are that `logout()` has no `require_auth()` so anonymous POSTs write rows, and an expired session is indistinguishable from anonymous. Decide whether to require auth or to stop logging anonymous logouts.
- [ ] **Smoke-script orphans (#24k):** 3 `wa_outbox` rows (87, 2062, 2063), all `sent`/`failed` so undeliverable. **The pattern is the risk, not the rows** — `scripts/smoke/smoke_verifikasi.sh:45` hand-maintains its own cascade list, which will drift. Fix the script; delete the 3 rows only with explicit ids.
- [ ] **Collation drift (#24l):** three collations in one schema (`utf8mb4_general_ci` / `unicode_ci` / `uca1400_ai_ci`). No cross-collation join exists today, but any future phone join throws **ERROR 1267** on a live-on-edit backend. Normalise `tamdes_buku` to match `wa_sessions`/`admin_users` in a planned migration with a fresh dump first.
- [ ] **2026-06-30 backup tables (#24m):** unreferenced but **49% of the database** (`tamdes_buku_bak_20260630` = 16.52 MB of 33.61 MB) and re-dumped nightly. They are also the **only** remaining copy of 3 merged-away guest identities. Confirm a dated gdrive archive contains all three, then drop in one documented migration. Until then add `--ignore-table` to the **daily** script only, never the weekly.
- [ ] **Binlog purge (#24n):** 378 files / **36.58 GB** / 31 days against a 14-day policy that *is* applied (`binlog_expire_logs_seconds=1209600`), no replica pinning. **Diagnose the cause; do not lead with `PURGE BINARY LOGS`** — drift is in the safe direction and there is ~200 days of runway (252 G free). Discarding recovery history to fix a symptom would be the wrong trade.

### Task 38: PM2 memory sampling and the upstream memory hog (#9, P2)

**Why:** `pm2 jlist` shows **0 apps with nonzero `monit.memory`** across all 46 — `ActionMethods.js:60` substitutes `{memory: 0}` on pidusage error and `Worker.js:80` gates on that value, so **no `max_memory_restart` on this host can fire**. Smoking gun: `portal-browser-gateway` has a 900 MB cap and is at **3.94 GB** with `restart_time=1`. For `bukutamu-wa` the guard was always decorative anyway — PM2 samples one pid per app, so it would only ever see `node` (63 MB), never the chromium tree.

- [ ] **Step 1 — Diagnose pidusage in isolation:** `node -e "require('/usr/lib/node_modules/pm2/node_modules/pidusage')(3755, console.log)"` (substitute the current pid).
- [ ] **Step 2 — ⚠ Do NOT run `pm2 update`** to chase it — that respawns every app on the host, including `bukutamu-wa`.
- [ ] **Step 3 — Move the chromium ceiling into `wa/server.js`,** which already has `killBrowserSync()` and an `exit(1)`→PM2 path. Fix the misleading comment in `ecosystem.config.cjs` claiming the 350M cap reaps a chromium leak.
- [ ] **Step 4 — Address the actual pressure (P2):** `portal-browser-gateway` at 3.94 GB is the upstream cause of the exhausted swap, and it was already OOM-killed at 6.5 GB on Jul 29. That is not a bukutamu component — raise it with the user as a separate issue.
- [ ] **Step 5 — Cheap and correct:** set `OOMScoreAdjust=-500` on the mariadb unit. MariaDB currently sits at oom_score 754 with 2.25 GB swapped; killing it takes down every app on the box.
- [ ] **Step 6 — ⚠ Do NOT `swapoff -a && swapon -a`** and do **not** restart `bukutamu-wa` as part of this task.

### Task 39: `dist/assets` retention policy

**Why:** 753 files / 23 MB accumulated, and this is **intentional** — old hashes are retained so pre-deploy tabs do not strand on a 404 that `serve.json` marks immutable for a year. But there is no pruning in either direction.

- [ ] **Step 1 — Add age-based pruning only** (>30 days). **Never** prune by "not in the current build" — that reintroduces the 2026-07-31 incident.
- [ ] **Step 2 — Verify** after a prune that every asset referenced by the current `dist/index.html` still resolves.

### Task 40: Note the plausible-but-unproven items — no action now

- [ ] **P1 — queue numbering is `COUNT(*)+1` with no uniqueness guard.** Mechanism is real (no unique index; `Visits.php:179` hard-deletes same-day rows inside a transaction so the count drops; `Kiosk::visit` generates at `:363` and inserts at `:380` with no `LOCK TABLES`). **But the DB evidence was misattributed** — all 8 duplicates predate the 2026-05-16 consolidation and were caused by an already-fixed bug (`ce9edc6`). Scoped to `date_visit >= '2026-05-16'`: **zero duplicates in 29 numbered visits.** If ever addressed: derive from `MAX(CAST(SUBSTRING(nomor_antrian,2) AS UNSIGNED))` scoped to today **and the same service** (not prefix — see #22), and add `LOCK TABLES` to `Kiosk::visit`. **Do not add a UNIQUE index** — the 8 legacy rows would make the `ALTER` fail.
- [ ] **P3 — outbox age cap covers only `group_notify`.** The single-type scope is a documented deliberate call (`Wa.php:1222-1225`), current state is 126 sent / 2 failed / **zero pending**, and the cited 146 h incident is what *produced* the cap. If pursued, the `wa_messages` half is the more valuable one (those carry approved data deliveries), and it cannot reach `'ditangani'` rows until Task 19's `ALTER` lands.

### Batch 8 checkpoint
- [ ] `git checkout -b fix/audit-batch8-hygiene`; commit; user review; merge.

---

## Standing recommendation — first automated test

This repo has **no automated tests**, and findings #4 (`durasi_detik`), #5 (`Number(active)`) and #17 (silent no-op) are exactly the class a single regression test would have caught.

- [ ] Propose scaffolding **Vitest** (matches Vite) with two first cases: the CI3 numeric-string boundary (`Number(active)`, `Number(status)`) and a duration-cap assertion.
- [ ] **Get user sign-off before adding it** — it would be the first test in the repo and the choice locks in tooling. (`.claude/rules/testing.md`)

---

## Coverage check

Every confirmed finding in `AUDIT_2026-08-01.md` maps to a task:

| Finding | Task | Finding | Task |
|---|---|---|---|
| #1 biometric dump | 35 | #14 report role gates | 12, 30 |
| #2 IP collapse | 6, 17 | #15 raw JSON ticket | 23 |
| #3 gdrive WA creds | 3 | #16 ticket timeout | 24 |
| #4 durasi_detik KPI | 8, 9 | #17 silent no-op | 25 |
| #5a FE deactivation | 22 | #18 face retry loop | 26 |
| #5b JWT revocation | 10 | #19 query invalidation | 27 |
| #6 ticket enumeration | 11 | #20 Batal / modal | 28 |
| #7 cookie Secure | 7 | #21 dead export columns | 36 |
| #8 uncommitted code | 1, 2 | #22 duplicate `D` prefix | 15 |
| #9 PM2 sampler | 38 | #23 Consultations guards | 14 |
| #10 wa_backfill | 20, 33 | #24a–d backend low | 16 |
| #11 pair_phone | 21, 33 | #24e–g frontend low | 29 |
| #12 msg_type ENUM | 19 | #24h–n data/ops low | 37 |
| #13 Deliveries owner | 13 | #24o–q scripts/UI low | 5, 4, 25 |
| P1, P3 | 40 (no action) | P2 memory | 38 |
