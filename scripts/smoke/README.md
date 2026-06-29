# Smoke tests — WA online channel & kiosk WA check-in

Manual end-to-end smoke scripts for the WhatsApp online channel and the kiosk
WA check-in flow. This repo has **no automated test framework** (see
`.claude/rules/testing.md`); these bash scripts are the closest thing to a
regression suite for these two surfaces. Run them after touching `Wa.php`,
`Kiosk.php`, `Api_base.php` (queue/token/validation helpers), or the service
taxonomy.

## ⚠️ Read before running

These hit the **live backend and database** — there is no separate test
environment. They are written to be safe to run on production, but you must
understand how:

- **Fake WhatsApp group.** Each script temporarily rewrites `wa_notify_group`
  in `backend/application/config/push.php` to a non-existent group
  (`000000000-000000000@g.us`) so the connector cannot deliver any operator
  ping to the real group. The original value is restored on exit via a
  `trap … EXIT` — even if the script crashes. (A `push.php.smokebak` is the
  restore source; if you ever see one left behind, `mv` it back.)
- **Fake phone numbers.** All test traffic uses the `62888399*` /
  `0888399*` range — numbers not registered on WhatsApp. Outbound rows the
  connector attempts simply fail; no real person is messaged.
- **Self-cleaning.** Every script deletes the rows it creates
  (`tamdes_buku`, `tamdes_kunjungan`, `konsultasi_pengunjung`,
  `wa_sessions`, `wa_outbox`) keyed on the `0888399*` namespace + the fake
  group, and asserts `0` residual at the end. The whole test-data namespace is
  `notel`/`phone_norm LIKE '0888399%'`.
- **Backend live-on-edit.** Because PHP goes live on save, the `push.php`
  swap is active for the duration of the run. Keep runs short; don't Ctrl-C
  mid-run unless you then confirm `push.php` shows the real group.

Because they mutate live data, **do not run during a busy service window.**

## Prerequisites

- Run **on the server** (the backend must answer at `http://127.0.0.1:60`).
- Root MySQL access via `/root/.my.cnf` (scripts call `mysql db_tamdes`
  with no credentials).
- `push_internal_secret` readable from `backend/application/config/push.php`
  (used to authenticate `POST /api/wa/ingest`).

## Scripts

| Script | Focus | Cases |
| --- | --- | --- |
| `smoke_kiosk.sh` | Kiosk WA check-in happy paths + the pre-arrival call-queue **exclusion invariant** (`created_by='whatsapp'` not callable until promoted) — #2 keeps number, #1/#3 → Resepsionis, sarana_lainnya parity. | 22 |
| `smoke_prefix.sh` | Queue-number **prefix uniqueness** — `Perpustakaan`→`P` vs `Penjualan Produk Statistik`→`J` (no collision), sequential per-service. | 10 |
| `smoke_flows.sh` | Broad sweep — category-gate routing & mis-category mitigation, daily-reset numbering, all submit token/validation failures (`401/403/422/400`), TOCTOU double-submit, multi-match, and kiosk edge cases incl. **stale-day regeneration** (`409/422`). | 54 |

## Running

```bash
cd /var/www/html/bukutamu
bash scripts/smoke/smoke_kiosk.sh
bash scripts/smoke/smoke_prefix.sh
bash scripts/smoke/smoke_flows.sh
```

Each prints `PASS:` / `FAIL:` per assertion and a final
`===== … : N passed, M failed =====`. Expected: **0 failed** and all
`residual … 0` lines green. A non-zero residual means cleanup didn't
complete — investigate before re-running.
