USE polaris_content_studio;

-- Manual posts: hand-written content that never joins an AI project snapshot. The image and its
-- list thumbnail are inline data URLs because there is no media library yet. CREATE TABLE IF NOT
-- EXISTS also runs from init.sql, so a fresh volume and an upgraded one end up identical.
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
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX posts_owner_updated (owner_user_id, updated_at),
  CONSTRAINT posts_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 'not_started' and 'failed' targets leave the post editable; 'accepted', 'submitting' and
-- 'pending_unknown' freeze it so every account receives the same content. snapshot_version is the
-- post version that was handed to Postiz.
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

-- Grants are idempotent and are re-issued on every deploy after init.sql revokes all privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.posts TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.post_targets TO 'polaris_app'@'%';
