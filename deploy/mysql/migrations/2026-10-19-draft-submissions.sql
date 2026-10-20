USE polaris_content_studio;

CREATE TABLE IF NOT EXISTS draft_submissions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('asset','manual') NOT NULL,
  source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  integration_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  snapshot JSON NOT NULL,
  state ENUM('queued','running','succeeded','failed','unknown') NOT NULL DEFAULT 'queued',
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  postiz_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  warning VARCHAR(512) NULL,
  error VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  UNIQUE KEY draft_submission_request (request_key),
  UNIQUE KEY draft_submission_active (active_key),
  INDEX draft_submission_due (state, created_at),
  INDEX draft_submission_lease (state, lease_expires_at),
  INDEX draft_submission_source (owner_user_id, kind, project_id, source_id),
  INDEX draft_submission_fingerprint (fingerprint, state),
  INDEX draft_submission_attempt (attempt_id),
  CONSTRAINT draft_submission_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.draft_submissions TO 'polaris_app'@'%';
