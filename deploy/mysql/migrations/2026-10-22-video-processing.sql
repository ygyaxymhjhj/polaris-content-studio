USE polaris_content_studio;

-- Durable local inputs are derived from id, never from a client-supplied filesystem path.
CREATE TABLE IF NOT EXISTS video_processing_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_bytes INT UNSIGNED NOT NULL,
  filename VARCHAR(255) NOT NULL,
  state ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  phase ENUM('validating','converting','saving') NOT NULL DEFAULT 'validating',
  video_media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error VARCHAR(512) NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  files_cleaned_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY video_processing_owner_request (owner_user_id, request_id),
  INDEX video_processing_due (state, created_at),
  INDEX video_processing_lease (state, lease_expires_at),
  INDEX video_processing_cleanup (files_cleaned_at, state, updated_at),
  CONSTRAINT video_processing_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT video_processing_receipt_fk FOREIGN KEY (video_media_id) REFERENCES video_uploads(id)
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.video_processing_jobs TO 'polaris_app'@'%';
