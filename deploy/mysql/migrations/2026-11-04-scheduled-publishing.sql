USE polaris_content_studio;

-- Existing posts keep the draft-only behaviour.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='posts' AND column_name='publish_mode'), 'SELECT 1', 'ALTER TABLE posts ADD COLUMN publish_mode ENUM(''draft'',''schedule'',''now'') NOT NULL DEFAULT ''draft'' AFTER video_media_id');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='posts' AND column_name='scheduled_at'), 'SELECT 1', 'ALTER TABLE posts ADD COLUMN scheduled_at DATETIME(3) NULL AFTER publish_mode');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
