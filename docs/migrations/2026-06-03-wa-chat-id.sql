-- WhatsApp may deliver the sender as a privacy "@lid" address instead of "@c.us".
-- Store the EXACT inbound address so we always reply to it (never reconstruct a jid).
ALTER TABLE wa_sessions ADD COLUMN wa_chat_id VARCHAR(64) NULL AFTER phone_raw;
ALTER TABLE wa_outbox   ADD COLUMN wa_chat_id VARCHAR(64) NULL AFTER phone_raw;
