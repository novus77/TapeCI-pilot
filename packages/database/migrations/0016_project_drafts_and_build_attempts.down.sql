-- Reverse 0016 only: drop what the migration created, children before parents, then the
-- two additive project columns. This is genuinely reversible on a fresh database; a
-- production rollback discards draft rows and build-attempt history, so it must not run
-- against live data (the same warning as 0015).
DROP TABLE IF EXISTS build_attempts CASCADE;
DROP TABLE IF EXISTS project_drafts CASCADE;
-- Dropping a column also drops every constraint and index that references it.
ALTER TABLE projects DROP COLUMN IF EXISTS config_version;
ALTER TABLE projects DROP COLUMN IF EXISTS build_enabled;
