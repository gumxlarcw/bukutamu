-- Phase 3 — WhatsApp blue ticks (delivered/read) + auto-seen
-- Apply on db_tamdes. Additive & reversible. No data backfill needed.
--
-- `ack` mirrors whatsapp-web.js MessageAck levels for OUTBOUND messages:
--   0 = none/pending, 1 = sent-to-server (✓), 2 = delivered to device (✓✓ grey),
--   3 = read (✓✓ blue), 4 = played (voice). FE renders the tick colour from this.
ALTER TABLE wa_messages
  ADD COLUMN ack TINYINT NOT NULL DEFAULT 0 AFTER status;

-- Queue of chats the operator opened/looked at → connector calls chat.sendSeen()
-- so the VISITOR sees our blue ticks. Read-once: poll() returns rows then deletes them.
-- UNIQUE(wa_chat_id) keeps re-opening the same chat from piling up rows.
CREATE TABLE IF NOT EXISTS wa_seen_queue (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  wa_chat_id  VARCHAR(64)  NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_chat (wa_chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback:
--   ALTER TABLE wa_messages DROP COLUMN ack;
--   DROP TABLE wa_seen_queue;
