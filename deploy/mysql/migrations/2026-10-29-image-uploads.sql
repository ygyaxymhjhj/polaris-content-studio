USE polaris_content_studio;

CREATE TABLE IF NOT EXISTS image_uploads (
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
  thumbnail_data MEDIUMTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY image_uploads_owner_request (owner_user_id, request_id),
  CONSTRAINT image_uploads_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Existing inline images remain readable; NULL means legacy, [] means explicitly cleared.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='posts' AND column_name='image_media_ids'), 'SELECT 1', 'ALTER TABLE posts ADD COLUMN image_media_ids JSON NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

GRANT SELECT, INSERT ON polaris_content_studio.image_uploads TO 'polaris_app'@'%';
