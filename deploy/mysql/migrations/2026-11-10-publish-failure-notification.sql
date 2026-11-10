USE polaris_content_studio;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='workspace_feishu_config' AND column_name='notify_publish_failed'), 'SELECT 1', 'ALTER TABLE workspace_feishu_config ADD COLUMN notify_publish_failed TINYINT(1) NOT NULL DEFAULT 0');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_post_tracking' AND column_name='notify_publish_failed'), 'SELECT 1', 'ALTER TABLE social_post_tracking ADD COLUMN notify_publish_failed TINYINT(1) NOT NULL DEFAULT 0');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_notification_outbox' AND column_name='event_type' AND LOCATE('''publish_failed''', column_type)>0), 'SELECT 1', 'ALTER TABLE social_notification_outbox MODIFY COLUMN event_type ENUM(''draft_submitted'',''published'',''draft_rejected'',''publish_failed'') NOT NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

-- NULL leaves non-failure events governed by the existing audit/event key.
SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='social_notification_outbox' AND column_name='failure_postiz_post_id'), 'SELECT 1', 'ALTER TABLE social_notification_outbox ADD COLUMN failure_postiz_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='social_notification_outbox' AND index_name='social_notification_failure_post' AND non_unique=0 AND column_name='failure_postiz_post_id'), 'SELECT 1', 'ALTER TABLE social_notification_outbox ADD UNIQUE KEY social_notification_failure_post (failure_postiz_post_id)');
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
