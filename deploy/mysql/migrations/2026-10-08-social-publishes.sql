-- Migration for an existing polaris-mysql volume; run manually as admin (fresh volumes already get
-- this table from deploy/mysql/init.sql):
--   docker exec -i polaris-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' \
--     < deploy/mysql/migrations/2026-10-08-social-publishes.sql
USE polaris_content_studio;

-- Publish audit: one row per publish attempt (success or failure) so "who published what, where,
-- when" is answerable. account_name and published_by_name are point-in-time snapshots; Postiz
-- remains the source of truth for channels and posts. Mirrors deploy/mysql/init.sql exactly.
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

-- Audit rows are append-only from the app's perspective: INSERT to record an attempt, SELECT to
-- display history. No UPDATE/DELETE, so an app bug or a leaked session cannot rewrite history.
GRANT SELECT, INSERT ON polaris_content_studio.social_publishes TO 'polaris_app'@'%';
