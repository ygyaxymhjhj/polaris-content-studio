-- Run with a schema administrator before starting the role-aware app.
-- Existing accounts retain their IDs, password hashes, sessions and project ownership.
USE polaris_content_studio;

SET @role_ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE users ADD COLUMN role ENUM(''admin'',''member'') NOT NULL DEFAULT ''member'' AFTER display_name',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'
);
PREPARE role_migration FROM @role_ddl;
EXECUTE role_migration;
DEALLOCATE PREPARE role_migration;

-- The operator-designated existing admin account is the only automatic promotion.
UPDATE users SET role = 'admin' WHERE username = 'admin';
