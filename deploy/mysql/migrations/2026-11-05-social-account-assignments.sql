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
SELECT integration_id, owner_user_id, updated_at
  FROM social_accounts
 WHERE owner_user_id IS NOT NULL;

-- Fail closed on a code rollback: old code treats every account as unassigned (admins only).
UPDATE social_accounts SET owner_user_id=NULL WHERE owner_user_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON polaris_content_studio.social_account_assignments TO 'polaris_app'@'%';
