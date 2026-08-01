# scripts/ops — WhatsApp session snapshot & restore

Operational tooling for the `bukutamu-wa` connector's WhatsApp LocalAuth
session. Both scripts live here but are **wired into root cron / run by hand**,
so their scheduling is not visible from the repo alone — that is what this file
records.

## Why these exist

Incident 2026-07-15: the host hard-crashed while chromium was writing the
profile → the IndexedDB LevelDB was corrupted → on next start chromium
**silently deleted** the `web.whatsapp.com` origin database → the multidevice
credentials were destroyed → a manual QR relink was required, during business
hours.

A snapshot lets the session be restored **without a relink**, provided the
snapshot is not too stale (a WhatsApp session stays valid roughly a few days to
two weeks).

---

## `wa_session_snapshot.sh`

Compresses the live session directory while the client is running — the same
approach the official wwebjs `RemoteAuth` strategy uses.

**Installed in root crontab:**

```
20 */6 * * * /var/www/html/bukutamu/scripts/ops/wa_session_snapshot.sh >> /var/log/wa_session_snapshot.log 2>&1
```

**Behaviour:**

| Aspect | Detail |
| --- | --- |
| Destination | `/var/backups/bukutamu-wa/wa_session_<ts>.tar.gz` |
| Retention | `KEEP=12` → 12 × 6 h = 3 days of history |
| Concurrency | `flock` on `/var/run/wa_session_snapshot.lock`, non-blocking (a second run exits 0) |
| Health gate | Skips unless `wa_qr_state.ready = 1` **and** heartbeat age < 120 s — a snapshot of a dead or awaiting-QR session is useless and would rotate a good one out |
| `--force` | Bypasses the health gate. For forensics / testing the mechanism only — **do not** rely on a forced snapshot for a real restore |
| Atomicity | Writes `.tmp_<ts>.tar.gz`, then `mv` into place, so a partial archive is never picked up by restore |
| DB access | Read-only (`SELECT` on `wa_qr_state`) |
| `tar` exit 1 | Tolerated and the snapshot is kept — chromium is writing the profile concurrently, so "file changed as we read it" is expected. `rc > 1` is a real failure and aborts |

**Safe to run by hand** at any time — it is read-only with respect to the
connector and never restarts anything.

### Known issue

The script's own header comment claims the essential payload is
`Default/IndexedDB + Default/Local Storage, <1 MB`. That is **wrong**: archives
are currently ~42 MB compressed (~70.6 MB uncompressed), of which about 42 % is
`CertificateRevocation`, plus `ScriptCache` and `DIPS`. See finding **#24p** in
`docs/AUDIT_2026-08-01.md` and Task 4 in
`docs/superpowers/plans/2026-08-01-audit-remediation.md` for the exclude list
that trims it to ~22.8 MB. **`IndexedDB` must never be excluded** — it *is* the
credential store.

---

## `wa_session_restore.sh`

Interactive restore. Run **only** during a planned relink window.

```bash
scripts/ops/wa_session_restore.sh                # newest snapshot
scripts/ops/wa_session_restore.sh <file.tar.gz>  # a specific one
```

**Symptom that calls for it:** `pm2 logs bukutamu-wa` repeatedly shows
`QR baru` and never reaches `WA client ready`.

**What it does, in order:** `pm2 stop bukutamu-wa` → kills any chromium still
holding `user-data-dir=…/session` (a live process would write back into the old
profile and hold `SingletonLock`, corrupting the restore) → moves the current
session to `…/session.pre-restore.<ts>` **and prints that path** → extracts the
snapshot → `pm2 start bukutamu-wa`.

Expected within ~3 minutes: `WA client ready; nomor=…` with **no** QR. If a QR
still appears, the snapshot is stale — try a newer one, or rescan at
`/admin/layanan-online`.

The pre-restore session is deliberately **not** deleted. Remove it by hand once
you are confident the restore succeeded.

### Known limitation

There is no rollback trap: if the extract fails midway, the connector is left
stopped with no `session/` directory. Recovery is manual — move the
`session.pre-restore.<ts>` directory the script printed back to `session/` and
`pm2 start bukutamu-wa`. See finding **#24o** and Task 5 in the remediation
plan.

---

## Rules that apply to anything in this directory

- **Never restart a warm `bukutamu-wa` casually.** A restart of a healthy
  connector costs an 8–15 minute cold-sync outage. Restarting in response to a
  "tidak merespons" alert usually *creates* the outage it was meant to fix —
  let PM2 self-heal instead.
- **Never commit the session itself.** `wa/.wwebjs_auth*` and
  `wa/.wwebjs_cache*` are git-ignored, and `/var/backups/bukutamu-wa` is outside
  the repo. Both contain live WhatsApp credentials.
- Snapshots are credentials. Anyone who can read `/var/backups/bukutamu-wa` can
  impersonate the BPS PST WhatsApp number. They must stay excluded from any
  offsite backup — see finding **#3**.
