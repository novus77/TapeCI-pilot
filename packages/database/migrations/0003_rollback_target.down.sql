DROP INDEX IF EXISTS deployments_rollback_target_idx;
ALTER TABLE deployments DROP COLUMN IF EXISTS rollback_target_release_id;
