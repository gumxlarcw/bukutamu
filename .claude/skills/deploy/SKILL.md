---
name: deploy
description: Use when the user says "deploy", "release", "ship to prod", "push to bukutamu.bpsmalut.com", or asks to restart PM2/Apache after merging — guides the safe deploy sequence for backend (Apache), frontend (PM2), and print (manual to kiosks)
---

# Deploy — bukutamu

This skill walks you through deploying the bukutamu monorepo to production
(`bukutamu.bpsmalut.com`). The three components deploy differently — DO NOT
restart everything at once.

## When to trigger

- User mentions: "deploy", "release", "ship", "promote", "restart PM2",
  "graceful reload Apache", "after the merge".
- After a PR is merged to `main` and the user says "now what?".
- When the user mentions kiosk PCs needing a new print server build.

## When NOT to trigger

- Local dev only (`npm run dev`) — no deploy.
- DB-only changes (run the migration script manually; deploy step still
  needs Apache reload if PHP files changed).

## Pre-flight (always)

1. Confirm `git status` is clean and `git branch` shows `main`.
   **If it is NOT clean, investigate before discarding.** Production may be
   running an uncommitted file: `wa/server.js` ran live and untracked from
   2026-07-15 to 2026-08-01, and its `.backup` was the *pre-fix* version, so
   "restoring" it would have reintroduced the bug. Compare the file's mtime
   against the running process (`ps -o lstart= -p $(pgrep -f wa/server.js)`)
   before assuming a modified file is stale. **Never** run `git checkout --`,
   `git restore`, `git stash` or `git clean -fd` to make the tree clean.
2. `git log --oneline origin/main..HEAD` should be empty — you're deploying
   what's already on `main`.
3. Read `deploy-config.md` (sibling file) for the env vars and rollback
   commands relevant to the components you're touching.
4. Ask the user: "Which components are you deploying — backend, frontend,
   print, or all?" Do not guess.
5. Heads-up: there is NO staging environment. Production is the only
   environment. Treat deploys with caution.

## Backend (Apache + PHP, no build step)

```bash
# 1. Make sure repo on disk reflects the commit being deployed
cd /var/www/html/bukutamu
git status                           # must be clean
git log -1 --oneline                 # confirm SHA

# 2. Reload Apache gracefully (no downtime)
sudo apachectl -k graceful

# 3. Smoke test
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://bukutamu.bpsmalut.com:460/api/auth/check
# expect 401 (unauth) — anything 5xx means rollback
```

If you get a 5xx: `sudo apachectl -k graceful` once more; if still bad,
roll back via git (see `deploy-config.md`).

## Frontend (Vite build + PM2 serve)

```bash
cd /var/www/html/bukutamu/frontend
npm install                          # in case package-lock changed
npm run lint                         # cheap insurance
npm run build                        # tsc -b && vite build → dist/

# PM2 serves dist/ on :3060 — restart to pick up new dist
pm2 restart bukutamu-frontend
pm2 logs bukutamu-frontend --lines 30   # confirm no startup errors

# Smoke test
curl -sS http://localhost:3060/ | head -c 200
# expect HTML starting with <!doctype html>
```

**Important**: PM2 serves the *built* `dist/`. If you forget `npm run build`,
PM2 restart will happily serve the OLD dist — no error, no warning.

## Print server (kiosk PCs, NOT this server)

This server does NOT run `print/`. It only holds the canonical source.

1. Bump version in `print/package.json` if behavior changed.
2. Tell the user: "Print server changed — kiosk PCs need to pull the new
   `print/` directory and `npm install && pm2 restart bukutamu-print`
   on each one."
3. List which kiosk hostnames/locations need updating based on the change.

DO NOT attempt to SSH into kiosk PCs from this skill — that's a manual
operator task and credentials are not part of the repo.

## Post-deploy verification

Manually walk one full visit through the kiosk:
1. Check-in (face recognition warmup → match)
2. Pick service (one SKD, one DTSEN — verify both flows)
3. Queue ticket prints (kiosk-only)
4. PST dashboard calls the ticket (strict-mode TV call should NOT fall over)
5. SKD only: evaluation tablet appears → submit → status → `selesai`
6. DTSEN: queue prefix `D`, no evaluation, → `selesai`

If any step regresses: roll back per `deploy-config.md`.

## Reporting

After deploy, output:
- Components touched
- Commit SHA deployed
- Smoke-test results (Apache 401? Frontend HTML? PM2 logs clean?)
- Anything you DID NOT verify (kiosks, real visitor flow, printer hardware)
  so the user knows what's still on them.
