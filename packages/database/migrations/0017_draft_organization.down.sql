DROP INDEX IF EXISTS project_drafts_organization_idx;
ALTER TABLE project_drafts DROP COLUMN IF EXISTS organization_id;
