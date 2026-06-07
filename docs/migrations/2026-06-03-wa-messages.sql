-- WA Live Chat: conversation store (in + out), bridges web <-> WhatsApp.
-- Additive — wa_outbox (templated system messages) tetap terpisah & tak disentuh.
CREATE TABLE IF NOT EXISTS wa_messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_norm   VARCHAR(32)  NOT NULL,
  wa_chat_id   VARCHAR(64)  NOT NULL,             -- alamat balas persis (@c.us/@lid)
  id_kunjungan INT NULL,                          -- konteks kalau sesi sudah jadi visit
  direction    ENUM('in','out') NOT NULL,
  msg_type     ENUM('text','image','document') NOT NULL DEFAULT 'text',
  body         TEXT NULL,                         -- teks / caption media
  media_path   VARCHAR(255) NULL,                 -- relatif ke backend/assets/wa_media/
  media_mime   VARCHAR(100) NULL,
  media_name   VARCHAR(200) NULL,
  wa_msg_id    VARCHAR(80)  NULL,                 -- id pesan WhatsApp (dedup inbound)
  status       ENUM('pending','sent','failed','received') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_phone_id (phone_norm, id),
  KEY idx_out_pending (direction, status),
  UNIQUE KEY uniq_wa_msg (wa_msg_id)              -- NULL boleh duplikat di MySQL → dedup inbound
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
