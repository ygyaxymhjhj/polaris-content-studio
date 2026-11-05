-- Multi-user account assignment. Safe to re-run: the backfill only sees legacy owners, and the
-- legacy column is cleared so a later replay cannot resurrect assignments an admin removed.
USE polaris_content_studio;

CREATE TABLE IF NOT EXISTS social_account_assignments (
  integration_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (integration_id, user_id),
  INDEX social_account_assignments_user (user_id),
  CONSTRAINT social_account_assignments_account_fk FOREIGN KEY (integration_id)
    REFERENCES social_accounts(integration_id) ON DELETE CASCADE,
  CONSTRAINT social_account_assignments_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT IGNORE INTO social_account_assignments (integration_id, user_id, created_at)
SELECT s.integration_id, s.owner_user_id, s.updated_at
  FROM social_accounts s
  LEFT JOIN (SELECT DISTINCT integration_id FROM social_account_assignments) a
    ON a.integration_id = s.integration_id
 WHERE s.owner_user_id IS NOT NULL
   -- Only migrate accounts that have no assignment set. After a rollback, old code can write
   -- owner_user_id again; replaying this migration must not merge that stale owner into an
   -- existing set and silently restore access an admin removed.
   AND a.integration_id IS NULL;

-- Fail closed on a code rollback: old code treats every account as unassigned (admins only).
UPDATE social_accounts SET owner_user_id=NULL WHERE owner_user_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON polaris_content_studio.social_account_assignments TO 'polaris_app'@'%';
