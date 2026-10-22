USE polaris_content_studio;

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

-- Independently guarded so a partial migration can be rerun by the database administrator.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='posts' AND column_name='video_media_id'), 'SELECT 1', 'ALTER TABLE posts ADD COLUMN video_media_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

-- Ready records are append-only; the application has no DDL, UPDATE or DELETE permission here.
GRANT SELECT, INSERT ON polaris_content_studio.video_uploads TO 'polaris_app'@'%';
