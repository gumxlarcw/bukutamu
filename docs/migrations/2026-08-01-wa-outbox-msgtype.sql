-- 2026-08-01 — wa_outbox.msg_type: tambah 'ditangani' dan 'closing'
--
-- Latar (docs/AUDIT_2026-08-01.md temuan #12):
-- Dua penulis di Wa.php menyimpan msg_type 'ditangani' (notifikasi take-over)
-- dan 'closing' (pesan penutup), tapi keduanya TIDAK ada di ENUM. Karena
-- koneksi CI3 memakai stricton => FALSE, MySQL meng-coerce nilai tak dikenal
-- jadi string kosong TANPA error. Akibatnya:
--   1. Dedup penutup di Wa.php (WHERE msg_type='closing') tidak pernah cocok —
--      'closing' = 0 baris, '' = 10 baris.
--   2. Taksonomi outbox rusak: tidak ada sweep/laporan berbasis tipe yang bisa
--      menargetkan baris-baris ini.
--
-- WAJIB dijalankan SEBELUM Wa.php yang menulis nilai baru disimpan — backend
-- PHP live-on-edit, tidak ada gerbang deploy (lihat auto-memory
-- infra_php_live_on_edit; pernah menyebabkan konektor WA mati ~40 menit).

ALTER TABLE wa_outbox MODIFY msg_type
  enum('intake_link','confirmation','eval_link','thankyou','group_notify',
       'menu','verif_request','ditangani','closing') NOT NULL;

-- Backfill 10 baris yang terlanjur tersimpan kosong.
-- Pembagiannya 7 'ditangani' + 3 'closing' — BUKAN 5/5 seperti tertulis di
-- laporan audit; diverifikasi dengan mencocokkan body sebelum menulis.
-- id ditulis eksplisit (pola auto-memory ops_backfill_close_durasi_null):
-- predikat lebar pada tabel produksi adalah cara insiden mass-update 2026-06-30
-- terjadi.

UPDATE wa_outbox SET msg_type = 'ditangani'
 WHERE id IN (50, 53, 62, 77, 94, 558, 2074);

UPDATE wa_outbox SET msg_type = 'closing'
 WHERE id IN (68, 72, 91);

-- Verifikasi:
--   SELECT msg_type, COUNT(*) FROM wa_outbox GROUP BY 1;   -- tidak ada '' lagi
--   SELECT COUNT(*) FROM wa_outbox WHERE msg_type='';       -- 0
