-- Live unread-count badge for the Layanan Online inbox.
-- Per-phone "last read" marker; unread = inbound wa_messages with id > last_read_msg_id.
-- Advanced (forward-only) by seen() when an operator opens a chat. Additive & reversible.
CREATE TABLE IF NOT EXISTS wa_read_state (
  phone_norm       VARCHAR(32)         NOT NULL,
  last_read_msg_id BIGINT(20) UNSIGNED NOT NULL DEFAULT 0,
  updated_at       DATETIME            NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (phone_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback: DROP TABLE wa_read_state;
