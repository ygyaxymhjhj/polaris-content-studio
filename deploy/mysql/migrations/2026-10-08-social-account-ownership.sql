-- Migration for an existing polaris-mysql volume; run manually as admin (fresh volumes already get
-- these tables from deploy/mysql/init.sql):
--   docker exec -i polaris-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' \
--     < deploy/mysql/migrations/2026-10-08-social-account-ownership.sql
USE polaris_content_studio;

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
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  CONSTRAINT social_connect_attempts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The app upserts ownership rows and consumes attempts. social_accounts has no DELETE: rows survive
-- channel removal in Postiz (the live list, not the registry, decides what is visible).
GRANT SELECT, INSERT, UPDATE ON polaris_content_studio.social_accounts TO 'polaris_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON polaris_content_studio.social_connect_attempts TO 'polaris_app'@'%';
