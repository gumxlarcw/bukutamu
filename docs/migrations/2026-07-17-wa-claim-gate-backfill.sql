-- 2026-07-17 — Gerbang wajib-klaim Layanan Online (WA)
-- Spec: docs/superpowers/specs/2026-07-17-wa-claim-gate-design.md
--
-- Tanpa perubahan skema: assigned_to/assigned_at sudah ada sejak
-- 2026-06-11-wa-takeover-manual-close.sql. Ini murni backfill data.
--
-- Sesi yang penanganannya SUDAH berjalan tapi belum punya pemilik tercatat
-- dialihkan ke Irma (admin_users.id = 3) — penangan dominan (6 dari 7 klaim
-- yang ada per 2026-07-17). Tanpa backfill, sesi-sesi ini akan terkunci dari
-- semua petugas begitu gerbang menyala.
--
-- TANPA pemberitahuan ke responden: pesan "sedang ditangani oleh" hanya
-- disisipkan session_assign() ke wa_outbox, dan tak ada trigger apa pun pada
-- wa_sessions (diverifikasi via SHOW TRIGGERS LIKE 'wa_%', 2026-07-17) — jadi
-- UPDATE langsung ini dijamin senyap.
--
-- Sesi berstatus 'antri'/'dipanggil' sengaja DIBIARKAN NULL: penanganannya
-- belum dimulai, jadi petugas harus mengklaimnya sendiri seperti sesi baru.
--
-- Dampak terukur saat perencanaan (2026-07-17): 1 baris — sesi #636,
-- WA-990645, status 'diproses', a.n. Sariyani Basir.
--
-- assigned_at = NOW() mencatat kapan backfill dijalankan, bukan kapan
-- penanganan sebenarnya dimulai (tak ada sumber data untuk itu). Kolom ini
-- hanya catatan; tak ada logika yang membacanya.

-- Pratinjau — jalankan dulu, harus cocok dengan angka di atas:
-- SELECT s.id, s.id_kunjungan, k.status
--   FROM wa_sessions s JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
--  WHERE s.assigned_to IS NULL AND k.status NOT IN ('antri', 'dipanggil');

UPDATE wa_sessions s
  JOIN tamdes_kunjungan k ON k.id_kunjungan = s.id_kunjungan
   SET s.assigned_to = 3,
       s.assigned_at = NOW()
 WHERE s.assigned_to IS NULL
   AND k.status NOT IN ('antri', 'dipanggil');

-- Rollback (bila perlu): kembalikan HANYA baris yang backfill ini sentuh.
-- Ganti '<waktu_backfill>' dengan assigned_at hasil UPDATE di atas.
-- UPDATE wa_sessions SET assigned_to = NULL, assigned_at = NULL
--  WHERE assigned_to = 3 AND assigned_at = '<waktu_backfill>';
