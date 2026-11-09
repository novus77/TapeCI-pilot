-- Bind audit rows to the project/organization they mutated so the console can
-- filter by scope instead of guessing from the actor's memberships.
ALTER TABLE audit_events ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE audit_events ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX audit_events_project_idx ON audit_events(project_id, created_at DESC);
CREATE INDEX audit_events_organization_idx ON audit_events(organization_id, created_at DESC);
