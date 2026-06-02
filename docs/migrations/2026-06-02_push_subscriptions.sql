-- Web Push subscriptions for admin desktop notifications (Tier 2).
-- Manual migration (schema is hand-managed). Applied 2026-06-02.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INT(11) NOT NULL AUTO_INCREMENT,
  endpoint TEXT NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,           -- sha256(endpoint), for UNIQUE (endpoint too long to index)
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL,                  -- target role for push (matches Notifications::rules_for_role)
  id_user INT(11) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT current_timestamp(),
  last_seen_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_endpoint_hash (endpoint_hash),
  KEY idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
