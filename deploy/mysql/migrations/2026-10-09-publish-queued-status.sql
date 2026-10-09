-- Migration for an existing polaris-mysql volume; run manually as admin (fresh volumes already get
-- this from deploy/mysql/init.sql):
--   docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' \
--     < deploy/mysql/migrations/2026-10-09-publish-queued-status.sql
USE polaris_content_studio;

-- Scheduled posts handed to Postiz are recorded as 'queued' so the audit distinguishes them from
-- posts already published on the platform. Re-applying the same MODIFY is a no-op.
ALTER TABLE social_publishes MODIFY status ENUM('published','queued','failed') NOT NULL;
