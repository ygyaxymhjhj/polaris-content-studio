-- Migration for an existing polaris-mysql volume; run manually as admin (fresh volumes already get
-- this from deploy/mysql/init.sql):
--   docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' \
--     < deploy/mysql/migrations/2026-10-12-social-draft-status.sql
USE polaris_content_studio;

-- Polaris now only creates Postiz drafts and never publishes or schedules. A successful submission
-- is recorded as 'drafted' so the audit distinguishes a draft handed to Postiz from a post that
-- went live. 'published' and 'queued' stay in the enum because earlier rows still use them.
-- Re-applying the same MODIFY is a no-op.
ALTER TABLE social_publishes MODIFY status ENUM('published','queued','drafted','failed') NOT NULL;
