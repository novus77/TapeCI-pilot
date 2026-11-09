-- Rollback P2-only tables. Audit tables from the baseline are deliberately kept.
DROP TABLE IF EXISTS operator_sessions CASCADE;
DROP TABLE IF EXISTS project_members CASCADE;
DROP TABLE IF EXISTS artifact_uploads CASCADE;
DROP TABLE IF EXISTS build_tokens CASCADE;
DROP TABLE IF EXISTS wallet_challenges CASCADE;
