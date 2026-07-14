#!/bin/bash
# Shared safety guard for the LIVE smoke scripts (audit 2026-07-12 #13).
# These smokes mutate the live db_tamdes AND temporarily rewrite push.php's wa_notify_group,
# relying on a `trap ... EXIT` to restore it — which a SIGKILL / `pm2 stop` never fires.
# Source this immediately after `set -u`, BEFORE any mutation:
#     source "$(dirname "$0")/_guard.sh"
#
# 1. Self-heal: if a prior run died hard, push.php is still pointing at the fake notify group
#    (silent production outage of operator WA notifications). Restore from the leftover .smokebak
#    BEFORE doing anything else.
# 2. Backup gate: refuse to mutate prod unless a same-day db_tamdes dump exists; make one if not.

_PUSH=/var/www/html/bukutamu/backend/application/config/push.php
if [ -f "$_PUSH.smokebak" ]; then
  echo "smoke-guard: leftover $_PUSH.smokebak (prior crashed run) — restoring real push.php first."
  mv -f "$_PUSH.smokebak" "$_PUSH"
fi

_DUMPDIR=/var/backups/db_tamdes-daily
if ls "$_DUMPDIR"/db_tamdes_"$(date +%F)"_*.sql.gz >/dev/null 2>&1; then
  echo "smoke-guard: same-day db_tamdes backup present in $_DUMPDIR."
else
  echo "smoke-guard: no same-day backup — running db_tamdes_daily_backup.sh before mutating prod…"
  if [ -x /usr/local/bin/db_tamdes_daily_backup.sh ]; then
    /usr/local/bin/db_tamdes_daily_backup.sh || { echo "smoke-guard: backup FAILED — refusing to run."; exit 1; }
  else
    echo "smoke-guard: db_tamdes_daily_backup.sh missing/not-executable — refusing to run smoke on prod."
    exit 1
  fi
fi
