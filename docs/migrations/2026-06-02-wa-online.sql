-- WhatsApp online data-request channel: pre-submit sessions + outbound queue.
-- Schema is hand-managed (no migrations CLI). Apply with:
--   mysql db_tamdes < docs/migrations/2026-06-02-wa-online.sql

CREATE TABLE IF NOT EXISTS wa_sessions (
  id              BIGINT NOT NULL AUTO_INCREMENT,
  phone_norm      VARCHAR(20)  NOT NULL,                 -- canonical 0xxx
  phone_raw       VARCHAR(32)  NOT NULL,                 -- as seen on WA (62xxx)
  state           ENUM('awaiting_form','submitted','expired') NOT NULL DEFAULT 'awaiting_form',
  id_kunjungan    INT NULL,                              -- set on submit (not a hard FK)
  link_sent_at    DATETIME NULL,
  submitted_at    DATETIME NULL,
  last_inbound_at DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_phone_state (phone_norm, state),
  KEY idx_kunjungan (id_kunjungan)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wa_outbox (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  phone_raw     VARCHAR(32) NOT NULL,
  msg_type      ENUM('intake_link','confirmation','eval_link','thankyou') NOT NULL,
  body          TEXT NOT NULL,
  id_kunjungan  INT NULL,
  status        ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at       DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_status (status, created_at),
  KEY idx_kunjungan_type (id_kunjungan, msg_type)        -- dedup ledger: <=1 eval_link/thankyou per visit
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
