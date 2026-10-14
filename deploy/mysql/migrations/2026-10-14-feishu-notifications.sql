USE polaris_content_studio;

CREATE TABLE IF NOT EXISTS workspace_feishu_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  notify_drafts TINYINT(1) NOT NULL DEFAULT 1,
  notify_published TINYINT(1) NOT NULL DEFAULT 1,
  encrypted_credentials TEXT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at DATETIME(3) NOT NULL,
  last_test_at DATETIME(3) NULL,
  last_test_ok TINYINT(1) NULL,
  last_test_error VARCHAR(512) NULL,
  last_worker_at DATETIME(3) NULL,
  last_delivery_error VARCHAR(512) NULL,
  CONSTRAINT workspace_feishu_singleton CHECK (id = 1)
) ENGINE=InnoDB;

-- All notification dates are explicit UTC values supplied by the application.
-- Postiz ids are deliberately NOT unique: separate submissions retain separate audit rows.
CREATE TABLE IF NOT EXISTS social_post_tracking (
  publish_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  postiz_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('DRAFT','QUEUE','PUBLISHED','ERROR') NOT NULL DEFAULT 'DRAFT',
  release_url VARCHAR(2048) NULL,
  postiz_publish_date DATETIME(3) NULL,
  confirmed_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NOT NULL,
  next_check_at DATETIME(3) NOT NULL,
  last_checked_at DATETIME(3) NULL,
  check_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(512) NULL,
  notify_published TINYINT(1) NOT NULL DEFAULT 0,
  config_version INT UNSIGNED NOT NULL,
  INDEX social_tracking_postiz (postiz_post_id),
  INDEX social_tracking_due (notify_published, confirmed_at, next_check_at),
  CONSTRAINT social_tracking_audit_fk FOREIGN KEY (publish_audit_id) REFERENCES social_publishes(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS social_notification_outbox (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  publish_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type ENUM('draft_submitted','published') NOT NULL,
  event_time DATETIME(3) NOT NULL,
  status ENUM('pending','sending','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  sent_at DATETIME(3) NULL,
  last_error VARCHAR(512) NULL,
  config_version INT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY social_notification_event (publish_audit_id, event_type),
  INDEX social_notification_due (status, next_attempt_at),
  INDEX social_notification_lease (status, lease_expires_at),
  CONSTRAINT social_notification_audit_fk FOREIGN KEY (publish_audit_id) REFERENCES social_publishes(id)
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.workspace_feishu_config TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_post_tracking TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_notification_outbox TO 'polaris_app'@'%';
