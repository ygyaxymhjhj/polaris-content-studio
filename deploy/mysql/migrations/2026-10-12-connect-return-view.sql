-- Add return_view to social_connect_attempts so the authorization callback can return users
-- to the view they started from (workspace, accounts, etc.) instead of forcing ?view=accounts.

ALTER TABLE social_connect_attempts 
ADD COLUMN return_view VARCHAR(20) DEFAULT 'accounts' 
COMMENT 'View to return to after authorization completes';
