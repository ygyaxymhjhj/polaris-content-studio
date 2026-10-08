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

-- Publish audit: one row per publish attempt (success or failure) so "who published what, where,
-- when" is answerable. account_name and published_by_name are point-in-time snapshots; Postiz
-- remains the source of truth for channels and posts.
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
  status ENUM('published','failed') NOT NULL,
  error VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX social_publishes_project (project_id, created_at),
  INDEX social_publishes_asset (asset_id, created_at)
) ENGINE=InnoDB;

-- The app only reads/writes its own database; schema changes run separately as admin.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.projects TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.users TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.sessions TO 'polaris_app'@'%';
-- Audit rows are append-only from the app's perspective: INSERT to record an attempt, SELECT to
-- display history. No UPDATE/DELETE, so an app bug or leaked session cannot rewrite history.
GRANT SELECT, INSERT ON polaris_content_studio.social_publishes TO 'polaris_app'@'%';
