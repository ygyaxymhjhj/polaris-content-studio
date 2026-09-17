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
-- The app only reads/writes its own database; schema changes run separately as admin.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.projects TO 'polaris_app'@'%';
