-- Concrete request path (no query string) so a failed scope lookup can be
-- retried later without storing query strings, cookies or bodies.
ALTER TABLE audit_events ADD COLUMN path TEXT;
CREATE INDEX audit_events_scope_backfill_idx
  ON audit_events(created_at)
  WHERE project_id IS NULL OR organization_id IS NULL;
