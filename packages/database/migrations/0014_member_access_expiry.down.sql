DROP INDEX IF EXISTS project_members_expires_idx;
DROP INDEX IF EXISTS organization_members_expires_idx;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_expires_future;
ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_expires_future;
ALTER TABLE project_members DROP COLUMN IF EXISTS expires_at;
ALTER TABLE organization_members DROP COLUMN IF EXISTS expires_at;
