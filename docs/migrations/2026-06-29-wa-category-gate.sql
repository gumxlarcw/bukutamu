-- WA Layanan Online category gate (2026-06-29). Idempotent (safe to re-run).
-- NOTE: the state-ENUM change below was MISSED in the first apply and added same-day after the
-- E2E smoke caught new sessions silently storing state='' (non-strict ENUM truncation). Keep all
-- three together so a fresh environment provisions the complete schema.

-- 1. New session category (chosen in the chat menu).
ALTER TABLE wa_sessions
  ADD COLUMN IF NOT EXISTS category VARCHAR(16) NULL DEFAULT NULL COMMENT 'data|offline|lainnya — chosen in chat menu' AFTER state;

-- 2. New session state for the pre-form category menu. WITHOUT this, INSERT/UPDATE state='awaiting_category'
--    is truncated to '' on a non-strict server → the whole gate breaks (menu loop).
ALTER TABLE wa_sessions
  MODIFY COLUMN state ENUM('awaiting_category','awaiting_form','submitted','expired') NOT NULL DEFAULT 'awaiting_form';

-- 3. New outbox message type for the category menu.
ALTER TABLE wa_outbox
  MODIFY COLUMN msg_type ENUM('intake_link','confirmation','eval_link','thankyou','group_notify','menu') NOT NULL;
