-- Phase 4 — WhatsApp reply-quote + reactions
-- Apply on db_tamdes. Additive & reversible.
--
-- quoted_msg_id  : wa_msg_id of the message this one replies to (in/out)
-- quoted_preview : snapshot of the quoted message's text/type for rendering the reply chip
-- reaction       : latest reaction emoji ON this message (e.g. '👍'); NULL = none
ALTER TABLE wa_messages
  ADD COLUMN quoted_msg_id  VARCHAR(80)  NULL AFTER wa_msg_id,
  ADD COLUMN quoted_preview VARCHAR(255) NULL AFTER quoted_msg_id,
  ADD COLUMN reaction       VARCHAR(32)  NULL AFTER ack;

-- Operator → visitor reactions: enqueue here, connector calls message.react(emoji), read-once in poll().
CREATE TABLE IF NOT EXISTS wa_react_queue (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  wa_msg_id  VARCHAR(80)  NOT NULL,
  emoji      VARCHAR(32)  NOT NULL,   -- '' = remove reaction
  created_at DATETIME     NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback:
--   ALTER TABLE wa_messages DROP COLUMN quoted_msg_id, DROP COLUMN quoted_preview, DROP COLUMN reaction;
--   DROP TABLE wa_react_queue;
