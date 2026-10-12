-- Migration for an existing polaris-mysql volume; run manually as admin (fresh volumes already get
-- this from deploy/mysql/init.sql):
--   docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' \
--     < deploy/mysql/migrations/2026-10-12-connect-return-view.sql
USE polaris_content_studio;

-- Add return_view to social_connect_attempts so the authorization callback can return users
-- to the view they started from (workspace, accounts, etc.) instead of forcing ?view=accounts.
-- Check if column exists before adding it
SET @exist := (SELECT COUNT(*) FROM information_schema.COLUMNS 
               WHERE TABLE_SCHEMA = 'polaris_content_studio' 
               AND TABLE_NAME = 'social_connect_attempts' 
               AND COLUMN_NAME = 'return_view');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE social_connect_attempts ADD COLUMN return_view VARCHAR(20) DEFAULT ''accounts'' COMMENT ''View to return to after authorization completes''', 
  'SELECT ''Column return_view already exists'' AS message');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
