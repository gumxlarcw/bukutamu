-- ============================================================================
-- 2026-06-30  Merge 3 known same-person duplicate guest pairs
-- ----------------------------------------------------------------------------
-- These predate the phone-as-unique-key change (a person was duplicated because
-- offline register didn't link by phone). Each pair is unambiguously ONE person:
-- identical notel + nama + email. The new reuse gate will NOT auto-fix them (both
-- rows already have a face), so merge them once here.
--
-- Strategy: SURVIVOR = the most-recent id_user (freshest face + most complete
-- name/profile). Repoint the loser's child rows (tamdes_kunjungan,
-- tamdes_responden_tahunan) to the survivor, THEN delete the loser from
-- tamdes_buku (repoint-first so any FK cascade has nothing to remove).
-- push_subscriptions is admin-scoped — none of these guests have a row.
-- tamdes_responden_tahunan has UNIQUE(id_user,tahun); survivors have NO responden
-- rows, so repointing the losers' 2025 rows does not collide.
--
-- Pair A — Muhammad Rizik A. Han  081395603645 : survivor 8200230  loser 8200094
-- Pair B — Siti Hawa Kharie       082138077776 : survivor 8200208  loser 8200016
-- Pair C — AISYAH A. MAILAHA      082213451083 : survivor 8200182  loser 8200136
--
-- Reversible via the *_mergebak_20260630 tables + tamdes_buku_bak_20260630.
-- ============================================================================

-- 0) Backups of every row that will change (loser + survivor sides).
CREATE TABLE IF NOT EXISTS tamdes_kunjungan_mergebak_20260630 AS
  SELECT * FROM tamdes_kunjungan
  WHERE id_user IN (8200094,8200016,8200136,8200230,8200208,8200182);
CREATE TABLE IF NOT EXISTS tamdes_responden_mergebak_20260630 AS
  SELECT * FROM tamdes_responden_tahunan
  WHERE id_user IN (8200094,8200016,8200136,8200230,8200208,8200182);
-- tamdes_buku already fully snapshotted earlier today in tamdes_buku_bak_20260630.

-- 1) Repoint children loser -> survivor.
UPDATE tamdes_kunjungan         SET id_user = 8200230 WHERE id_user = 8200094;  -- A
UPDATE tamdes_responden_tahunan SET id_user = 8200230 WHERE id_user = 8200094;
UPDATE tamdes_kunjungan         SET id_user = 8200208 WHERE id_user = 8200016;  -- B
UPDATE tamdes_responden_tahunan SET id_user = 8200208 WHERE id_user = 8200016;
UPDATE tamdes_kunjungan         SET id_user = 8200182 WHERE id_user = 8200136;  -- C
UPDATE tamdes_responden_tahunan SET id_user = 8200182 WHERE id_user = 8200136;

-- 2) Delete the now-childless loser guest rows.
DELETE FROM tamdes_buku WHERE id_user IN (8200094,8200016,8200136);

-- 3) VERIFY (each notel must now map to exactly ONE id_user; survivors hold merged visits).
SELECT notel, COUNT(DISTINCT id_user) AS n_users, GROUP_CONCAT(DISTINCT id_user) AS ids
FROM tamdes_buku
WHERE notel IN ('081395603645','082138077776','082213451083')
GROUP BY notel;                                  -- expect n_users = 1 for all three
SELECT id_user, COUNT(*) AS visits
FROM tamdes_kunjungan WHERE id_user IN (8200230,8200208,8200182) GROUP BY id_user;  -- expect 2, 5, 2
SELECT COUNT(*) AS orphan_visits FROM tamdes_kunjungan WHERE id_user IN (8200094,8200016,8200136);  -- expect 0
