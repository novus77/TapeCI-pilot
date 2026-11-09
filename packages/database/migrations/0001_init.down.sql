-- Development-only rollback of the baseline schema. Do NOT run this in production:
-- audit tables (deployment_events, webhook_deliveries, chain_transactions) are evidence.
DROP TABLE IF EXISTS deployment_events CASCADE;
DROP TABLE IF EXISTS releases CASCADE;
DROP TABLE IF EXISTS approvals CASCADE;
DROP TABLE IF EXISTS chain_transactions CASCADE;
DROP TABLE IF EXISTS release_files CASCADE;
DROP TABLE IF EXISTS deployments CASCADE;
DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS containers CASCADE;
DROP TABLE IF EXISTS github_installations CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TYPE IF EXISTS transaction_state;
DROP TYPE IF EXISTS file_state;
DROP TYPE IF EXISTS deployment_state;
