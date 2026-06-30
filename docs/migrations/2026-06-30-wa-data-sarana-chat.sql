-- 2026-06-30  Backfill: WA #1 (online data) visits → sarana "Aplikasi Chat" (16)
-- The #1 online flow used to hardcode sarana [2] (PST Online). It now records the
-- visitor-picked jenis + an ONLINE sarana (default Aplikasi Chat = 16). Bring legacy
-- #1 online rows onto the new default. notel/jenis untouched. Idempotent.
-- Scope verified at write time: 0 matching rows (no #1 online data visits yet).
UPDATE tamdes_kunjungan k
JOIN wa_sessions s ON s.id_kunjungan = k.id_kunjungan AND s.category = 'data'
SET k.sarana = '[16]'
WHERE k.created_by = 'whatsapp' AND k.sarana = '[2]';
