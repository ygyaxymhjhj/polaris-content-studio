USE polaris_content_studio;

-- MySQL 8: independently guard every added column so partial migrations can be rerun.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='workspace_feishu_config' AND column_name='notify_rejected'), 'SELECT 1', 'ALTER TABLE workspace_feishu_config ADD COLUMN notify_rejected TINYINT(1) NOT NULL DEFAULT 0');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_post_tracking' AND column_name='review_status'), 'SELECT 1', 'ALTER TABLE social_post_tracking ADD COLUMN review_status ENUM(''unknown'',''pending'',''rejected'') NOT NULL DEFAULT ''unknown''');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_post_tracking' AND column_name='save_action'), 'SELECT 1', 'ALTER TABLE social_post_tracking ADD COLUMN save_action ENUM(''pass'',''update'',''draft'',''schedule'',''now'') NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_post_tracking' AND column_name='rejected_detected_at'), 'SELECT 1', 'ALTER TABLE social_post_tracking ADD COLUMN rejected_detected_at DATETIME(3) NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_post_tracking' AND column_name='notify_rejected'), 'SELECT 1', 'ALTER TABLE social_post_tracking ADD COLUMN notify_rejected TINYINT(1) NOT NULL DEFAULT 0');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

-- Extending the enum preserves the existing audit/event unique key and all audit rows.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_notification_outbox' AND column_name='event_type' AND LOCATE('''draft_rejected''', column_type)>0), 'SELECT 1', 'ALTER TABLE social_notification_outbox MODIFY COLUMN event_type ENUM(''draft_submitted'',''published'',''draft_rejected'') NOT NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
