-- 2026-06-11 — WA Layanan Online: manual completion + operator take-over.
-- Apply with: mysql db_tamdes < docs/migrations/2026-06-11-wa-takeover-manual-close.sql
-- (root creds in /root/.my.cnf; DB name db_tamdes — do NOT rename.)

-- 1. New intermediate status: evaluation filled by the WA visitor, awaiting
--    operator close. ENUM change → ALTER required (project rule).
ALTER TABLE tamdes_kunjungan MODIFY status
  ENUM('antri','dipanggil','proses','diproses','selesai','menunggu_evaluasi','evaluasi_selesai')
  NOT NULL DEFAULT 'antri';

-- 2. Operator claim on the session (single source of truth for pending + visit).
ALTER TABLE wa_sessions
  ADD COLUMN assigned_to INT NULL AFTER id_kunjungan,
  ADD COLUMN assigned_at DATETIME NULL AFTER assigned_to;

-- 3. Backfill ALL existing sessions (running AND selesai) to Irma (admin_users.id=3).
--    SILENT: pure DB assignment, enqueues NOTHING — no requester is notified.
UPDATE wa_sessions SET assigned_to = 3, assigned_at = NOW()
WHERE assigned_to IS NULL;
