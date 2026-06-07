-- WA chat history backfill + outage recovery queue.
-- A row = "fetch recent messages for this chat and ingest them" (dedup by wa_msg_id).
-- Enqueued on popup-open (history) and on connector reconnect (recover messages missed
-- while the server/internet was down).
CREATE TABLE IF NOT EXISTS wa_backfill (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_norm  VARCHAR(32) NOT NULL,
  wa_chat_id  VARCHAR(64) NOT NULL,            -- alamat chat untuk getChatById()
  status      ENUM('pending','done') NOT NULL DEFAULT 'pending',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status (status, id),
  KEY idx_phone (phone_norm, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
