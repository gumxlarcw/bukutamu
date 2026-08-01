-- 2026-08-01 — wa_backfill.status: tambah 'failed'
--
-- Latar (docs/AUDIT_2026-08-01.md temuan #10):
-- ENUM hanya punya 'pending' dan 'done', jadi ketika konektor menyerah setelah
-- 4 percobaan, Wa.php:300 menandai baris itu 'done' — status yang IDENTIK
-- dengan sukses. Tidak ada baris audit, tidak ada log_message('error'). Akibatnya
-- jalur pemulihan pasca-outage yang dirancang untuk mengambil pesan tertinggal
-- sudah 100% mati sejak 2026-07-15 tanpa satu pun sinyal.
--
-- Bukti: 92 baris attempts=0 (sukses, terbaru 2026-07-14 12:18) vs 26 baris
-- attempts=4 (menyerah). TIDAK ADA baris dengan attempts 1-3, jadi attempts=4
-- tidak ambigu artinya "menyerah". Semua baris sejak 2026-07-15 attempts=4.
--
-- Penyebab akarnya wa_chat_id basi setelah sesi di-relink 2026-07-15 (BUKAN
-- @lid — @lid yang sama berhasil di-backfill sampai 07-14). Perbaikan sisi
-- konektor (fallback client.getNumberId) ada di Batch 6 karena butuh restart.
-- Migrasi ini membuat kegagalannya TERLIHAT, belum menyembuhkannya.
--
-- WAJIB dijalankan SEBELUM Wa.php yang menulis 'failed' disimpan — backend PHP
-- live-on-edit (auto-memory infra_php_live_on_edit).

ALTER TABLE wa_backfill MODIFY status
  enum('pending','done','failed') NOT NULL DEFAULT 'pending';

-- Koreksi 26 baris yang terlanjur berbohong 'done'. id ditulis eksplisit
-- (auto-memory ops_backfill_close_durasi_null) — predikat lebar pada tabel
-- produksi adalah cara insiden mass-update 2026-06-30 terjadi.
-- Diharapkan: 26 baris terpengaruh.

UPDATE wa_backfill SET status = 'failed'
 WHERE id IN (87,88,89,90,91,92,
              129,130,131,132,133,134,135,136,137,138,139,140,
              141,142,143,144,145,146,147,148);

-- Verifikasi:
--   SELECT status, attempts, COUNT(*) FROM wa_backfill GROUP BY 1,2;
--   -> done/0 = 92, failed/4 = 26, tidak ada done/4 lagi
