USE polaris_content_studio;
CREATE TABLE IF NOT EXISTS projects (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(255) NOT NULL,
  snapshot JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX projects_owner_updated (owner_hash, updated_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  -- scrypt$N$r$p$<salt hex>$<hash hex>; parameters travel with the hash so they can be raised later.
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY users_username (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  -- sha256 of the cookie token, never the token itself: a database dump does not hand over live sessions.
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX sessions_user (user_id),
  INDEX sessions_expires (expires_at),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Publish audit: one row per submission attempt (success or failure) so "who handed what to which
-- account, where, when" is answerable. Polaris only creates Postiz drafts, so a successful row is
-- 'drafted'; 'published' and 'queued' are legacy values kept for rows written before that change.
-- account_name and published_by_name are point-in-time snapshots; Postiz remains the source of
-- truth for channels and posts.
CREATE TABLE IF NOT EXISTS social_publishes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  asset_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform VARCHAR(32) NOT NULL,
  integration_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  published_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_by_name VARCHAR(128) NOT NULL,
  content_preview VARCHAR(200) NOT NULL,
  postiz_post_id VARCHAR(128) NULL,
  published_url VARCHAR(1024) NULL,
  scheduled_at DATETIME(3) NULL,
  status ENUM('published','queued','drafted','failed') NOT NULL,
  error VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX social_publishes_project (project_id, created_at),
  INDEX social_publishes_asset (asset_id, created_at)
) ENGINE=InnoDB;

-- Local ownership registry for Postiz channels. Postiz remains the source of truth for tokens and
-- channel existence; this table only records who may see and publish to each integration.
-- owner_user_id NULL = unassigned (visible to administrators only, until they assign it).
CREATE TABLE IF NOT EXISTS social_accounts (
  integration_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  provider VARCHAR(32) NOT NULL DEFAULT '',
  account_name VARCHAR(255) NOT NULL DEFAULT '',
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  assigned_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  origin ENUM('connect','admin') NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX social_accounts_owner (owner_user_id),
  CONSTRAINT social_accounts_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT social_accounts_assigned_by_fk FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per authorisation attempt: the channel-id snapshot taken when a member started the flow
-- lets the return callback claim only channels that did not exist before, without touching Postiz.
-- state_hash equals the value stored in the connect cookie (sha256 of "userId:state").
CREATE TABLE IF NOT EXISTS social_connect_attempts (
  state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(32) NOT NULL,
  snapshot_ids JSON NULL,
  return_view VARCHAR(20) DEFAULT 'accounts' COMMENT 'View to return to after authorization completes',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  CONSTRAINT social_connect_attempts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Singleton credentials are encrypted by the application. All dates are explicit UTC values.
CREATE TABLE IF NOT EXISTS workspace_feishu_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  notify_drafts TINYINT(1) NOT NULL DEFAULT 1,
  notify_published TINYINT(1) NOT NULL DEFAULT 1,
  notify_rejected TINYINT(1) NOT NULL DEFAULT 0,
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

-- A Postiz id may belong to multiple submission audits, so its index is not unique.
CREATE TABLE IF NOT EXISTS social_post_tracking (
  publish_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  postiz_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('DRAFT','QUEUE','PUBLISHED','ERROR') NOT NULL DEFAULT 'DRAFT',
  review_status ENUM('unknown','pending','rejected') NOT NULL DEFAULT 'unknown',
  save_action ENUM('pass','update','draft','schedule','now') NULL,
  rejected_detected_at DATETIME(3) NULL,
  release_url VARCHAR(2048) NULL,
  postiz_publish_date DATETIME(3) NULL,
  confirmed_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NOT NULL,
  next_check_at DATETIME(3) NOT NULL,
  last_checked_at DATETIME(3) NULL,
  check_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(512) NULL,
  notify_published TINYINT(1) NOT NULL DEFAULT 0,
  notify_rejected TINYINT(1) NOT NULL DEFAULT 0,
  config_version INT UNSIGNED NOT NULL,
  INDEX social_tracking_postiz (postiz_post_id),
  INDEX social_tracking_due (notify_published, confirmed_at, next_check_at),
  CONSTRAINT social_tracking_audit_fk FOREIGN KEY (publish_audit_id) REFERENCES social_publishes(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS social_notification_outbox (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  publish_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type ENUM('draft_submitted','published','draft_rejected') NOT NULL,
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

-- Uploaded videos are immutable, owner-scoped receipts; the media itself stays in Postiz.
CREATE TABLE IF NOT EXISTS video_uploads (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  postiz_media_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  postiz_path VARCHAR(4096) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  width INT UNSIGNED NOT NULL,
  height INT UNSIGNED NOT NULL,
  duration_seconds DOUBLE NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY video_uploads_owner_request (owner_user_id, request_id),
  CONSTRAINT video_uploads_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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

-- Manual posts are written by hand in Polaris and never join an AI project snapshot. There is no
-- media library yet, so the validated image (and its list thumbnail) live inline as data URLs;
-- the thumbnail column keeps list payloads small without returning the full image.
CREATE TABLE IF NOT EXISTS posts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_data MEDIUMTEXT NULL,
  image_thumb MEDIUMTEXT NULL,
  image_name VARCHAR(255) NULL,
  image_width INT UNSIGNED NULL,
  image_height INT UNSIGNED NULL,
  video_media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX posts_owner_updated (owner_user_id, updated_at),
  CONSTRAINT posts_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per account a manual post should reach. 'not_started' and 'failed' targets leave the
-- post editable; 'accepted', 'submitting' and 'pending_unknown' freeze it so every account got the
-- same content. snapshot_version records the post version that was handed to Postiz.
CREATE TABLE IF NOT EXISTS post_targets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  post_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  integration_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform VARCHAR(32) NOT NULL DEFAULT '',
  account_name VARCHAR(255) NOT NULL DEFAULT '',
  status ENUM('not_started','submitting','accepted','failed','pending_unknown') NOT NULL DEFAULT 'not_started',
  snapshot_version INT UNSIGNED NOT NULL DEFAULT 0,
  attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attempt_started_at DATETIME(3) NULL,
  postiz_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  warning VARCHAR(512) NULL,
  error VARCHAR(512) NULL,
  submitted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY post_targets_post_account (post_id, integration_id),
  INDEX post_targets_post_status (post_id, status),
  CONSTRAINT post_targets_post_fk FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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

-- The app only reads/writes its own database; schema changes run separately as admin.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.video_processing_jobs TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.draft_submissions TO 'polaris_app'@'%';
GRANT SELECT, INSERT ON polaris_content_studio.video_uploads TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.projects TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.users TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.sessions TO 'polaris_app'@'%';
-- Audit rows are append-only from the app's perspective: INSERT to record an attempt, SELECT to
-- display history. No UPDATE/DELETE, so an app bug or leaked session cannot rewrite history.
GRANT SELECT, INSERT ON polaris_content_studio.social_publishes TO 'polaris_app'@'%';
-- Ownership registry: the app upserts rows and reads ownership; no DELETE, so rows survive channel
-- removal in Postiz (the live list, not the registry, decides what is visible).
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_accounts TO 'polaris_app'@'%';
-- Connect attempts are consumed once and swept when expired, hence DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.social_connect_attempts TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.workspace_feishu_config TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_post_tracking TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_notification_outbox TO 'polaris_app'@'%';
-- Manual posts belong to their owner and can be removed while nothing reached Postiz, hence DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.posts TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.post_targets TO 'polaris_app'@'%';
