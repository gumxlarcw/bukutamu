-- WA Layanan Online category gate (2026-06-29)
ALTER TABLE wa_sessions
  ADD COLUMN category VARCHAR(16) NULL DEFAULT NULL COMMENT 'data|offline|lainnya — chosen in chat menu' AFTER state;

ALTER TABLE wa_outbox
  MODIFY COLUMN msg_type ENUM('intake_link','confirmation','eval_link','thankyou','group_notify','menu') NOT NULL;
