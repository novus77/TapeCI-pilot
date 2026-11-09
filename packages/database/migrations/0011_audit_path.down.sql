DROP INDEX IF EXISTS audit_events_scope_backfill_idx;
ALTER TABLE audit_events DROP COLUMN IF EXISTS path;
