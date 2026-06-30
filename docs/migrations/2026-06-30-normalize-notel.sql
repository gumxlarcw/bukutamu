-- ============================================================================
-- 2026-06-30  Canonicalize tamdes_buku.notel to match Api_base::normalize_phone()
-- ----------------------------------------------------------------------------
-- Context: phone number is now the cross-channel guest unique key (Kiosk::register
-- reuses an existing guest by normalized notel instead of duplicating). WhatsApp
-- already stored notel canonical ("0XXXXXXXXX"); offline kiosk/admin historically
-- stored raw input. This one-off backfill brings legacy rows onto the canonical
-- form so the reuse lookup matches reliably.
--
-- Canonical expression mirrors normalize_phone() EXACTLY:
--   strip non-digits -> TRIM LEADING all '0' -> drop ONE leading '62' -> prepend '0'.
-- (IF + SUBSTRING removes exactly ONE '62', matching PHP substr($d,2) — not the
--  repeated strip that TRIM(LEADING '62') would do.)
--
-- notel is LOOKUP-ONLY: do NOT add a UNIQUE index. Duplicate numbers are tolerated
-- by design (3 known legitimate same-person/shared-number groups predate this).
-- Idempotent: re-running is a no-op (predicate excludes already-canonical rows).
-- Verified on live db_tamdes (224 rows): exactly 1 row changes
--   (id_user 8200108: '85349702676' -> '085349702676'), ZERO new collisions.
-- Target: MariaDB 11.8.6 (REGEXP_REPLACE supported).
-- ============================================================================

-- 0) Backup (CLAUDE.md backup discipline). Drop after a few days once verified.
CREATE TABLE IF NOT EXISTS tamdes_buku_bak_20260630 AS SELECT * FROM tamdes_buku;

-- 1) APPLY
UPDATE tamdes_buku
SET notel = CONCAT('0', IF(TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]','')) LIKE '62%',
                 SUBSTRING(TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]','')), 3),
                 TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]',''))))
WHERE notel IS NOT NULL
  AND TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]','')) <> ''   -- skip empty/all-zero (PHP returns '')
  AND notel <> CONCAT('0', IF(TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]','')) LIKE '62%',
                 SUBSTRING(TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]','')), 3),
                 TRIM(LEADING '0' FROM REGEXP_REPLACE(notel,'[^0-9]',''))));

-- 2) VERIFY: post-backfill shared-number groups must equal ONLY the pre-existing
--    same-person groups (no NEW collision introduced by canonicalization).
SELECT notel, COUNT(DISTINCT id_user) AS n_users, GROUP_CONCAT(DISTINCT id_user) AS ids
FROM tamdes_buku
WHERE notel <> ''
GROUP BY notel
HAVING COUNT(DISTINCT id_user) > 1
ORDER BY n_users DESC;
