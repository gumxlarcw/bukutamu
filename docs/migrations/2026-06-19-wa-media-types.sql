-- Phase 5 — full WhatsApp media types
-- Apply on db_tamdes. Widens the msg_type ENUM. Existing rows ('text'/'image'/'document') unaffected.
ALTER TABLE wa_messages
  MODIFY COLUMN msg_type
    ENUM('text','image','document','audio','video','sticker','location','contact')
    NOT NULL DEFAULT 'text';

-- Rollback (only if no row uses a new value, else those rows would be coerced to ''):
--   ALTER TABLE wa_messages MODIFY COLUMN msg_type ENUM('text','image','document') NOT NULL DEFAULT 'text';
