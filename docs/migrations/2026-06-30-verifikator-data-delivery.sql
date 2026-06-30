-- Verifikator & Data Delivery — Phase 1
-- Apply order matters (role ENUM before any code writes 'verifikator').
-- ENUM lists built from ACTUAL live COLUMN_TYPE captured 2026-06-30:
--   admin_users.role   = enum('superadmin','admin','operator','resepsionis','petugas_pst','pimpinan')
--   wa_outbox.msg_type = enum('intake_link','confirmation','eval_link','thankyou','group_notify','menu')

-- 1) Add the verifikator role (preserves all existing values).
ALTER TABLE admin_users
  MODIFY COLUMN role
  ENUM('superadmin','admin','operator','resepsionis','petugas_pst','pimpinan','verifikator')
  NOT NULL;

-- 2) Verifier WhatsApp number (also used for any future per-user contact).
ALTER TABLE admin_users
  ADD COLUMN notel VARCHAR(20) NULL AFTER nama;

-- 3) New outbox message type for the verification ping + bot confirmations.
ALTER TABLE wa_outbox
  MODIFY COLUMN msg_type
  ENUM('intake_link','confirmation','eval_link','thankyou','group_notify','menu','verif_request')
  NOT NULL;

-- 4) The unified delivery + verification record.
CREATE TABLE IF NOT EXISTS data_deliveries (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_kunjungan    INT NOT NULL,
  id_konsultasi   INT NULL,
  channel         ENUM('online','offline') NOT NULL DEFAULT 'online',
  link_url        TEXT NULL,
  media_path      VARCHAR(255) NULL,
  media_mime      VARCHAR(100) NULL,
  media_name      VARCHAR(200) NULL,
  note_operator   TEXT NULL,
  status          ENUM('menunggu_verifikasi','revisi','disetujui','terkirim','dibatalkan')
                    NOT NULL DEFAULT 'menunggu_verifikasi',
  verif_decision  ENUM('setuju','revisi','setuju_catatan') NULL,
  verif_note      TEXT NULL,
  id_verifikator  INT NULL,
  verified_at     DATETIME NULL,
  revisi_count    INT NOT NULL DEFAULT 0,
  short_code      VARCHAR(12) NULL,
  delivery_method ENUM('wa','flashdisk','printed') NULL,
  delivered_at    DATETIME NULL,
  delivered_by    INT NULL,
  created_by      INT NOT NULL,
  verif_outbox_id BIGINT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status (status),
  KEY idx_kunjungan (id_kunjungan),
  KEY idx_verif_pending (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
