-- Single-row store for the connector's live QR / link state, so the admin
-- "Layanan Online" page can show the QR (connector pushes; admin page polls).
CREATE TABLE IF NOT EXISTS wa_qr_state (
  id         TINYINT NOT NULL DEFAULT 1,
  qr         LONGTEXT NULL,          -- data-URL PNG of the current QR (null once linked)
  ready      TINYINT(1) NOT NULL DEFAULT 0,
  number     VARCHAR(20) NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO wa_qr_state (id, ready) VALUES (1, 0);
