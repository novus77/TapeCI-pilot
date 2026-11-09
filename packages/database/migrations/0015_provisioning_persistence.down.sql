-- Reverse 0015 only: drop what the migration created, children before parents.
-- These tables hold financial/delivery evidence once used, so this down exists for isolated
-- test databases (SPEC §6); production rollback must not run it against live rows.
DROP TABLE IF EXISTS provisioning_transactions CASCADE;
DROP TABLE IF EXISTS provisioning_steps CASCADE;
DROP TABLE IF EXISTS provisioning_quote_acceptances CASCADE;
DROP TABLE IF EXISTS provisioning_tasks CASCADE;
DROP TABLE IF EXISTS resource_quotes CASCADE;
DROP TABLE IF EXISTS wallet_resources CASCADE;
DROP TABLE IF EXISTS resource_index_checkpoints CASCADE;
DROP TABLE IF EXISTS resource_index_state CASCADE;
