DROP INDEX IF EXISTS audit_events_organization_idx;
DROP INDEX IF EXISTS audit_events_project_idx;
ALTER TABLE audit_events DROP COLUMN IF EXISTS organization_id;
ALTER TABLE audit_events DROP COLUMN IF EXISTS project_id;
