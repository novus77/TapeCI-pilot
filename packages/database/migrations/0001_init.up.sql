-- TapeCI: PostgreSQL 16+ proposed initial schema
-- Date: 2026-10-19 | DRAFT: validated against the PRD, not run on a live database.
-- Addresses stored lowercase. Monetary values in wei stored NUMERIC(78,0).
-- Migration tooling may wrap statements in a transaction.

CREATE TYPE deployment_state AS ENUM (
  'RECEIVED','BUILDING','BUILT','VALIDATING','PLAN_READY',
  'AWAITING_APPROVAL','APPROVED','UPLOADING_ASSETS','VERIFYING_ASSETS',
  'SWITCHING_ENTRY','VERIFYING_RELEASE','LIVE',
  'BUILD_FAILED','PLAN_REJECTED','APPROVAL_EXPIRED','AUTH_REVOKED',
  'OWNERSHIP_CHANGED','INSUFFICIENT_BALANCE','FEE_OVER_BUDGET',
  'RPC_DISAGREEMENT','CHAIN_REORG_PENDING','IMPLEMENTATION_CHANGED',
  'UPLOAD_CONFLICT','UPLOAD_INTERRUPTED','VERIFY_FAILED',
  'SWITCH_FAILED','ROLLBACK_REQUIRED','CANCELED'
);

CREATE TYPE file_state AS ENUM (
  'PENDING','UNCHANGED','WRITING','WRITTEN','VERIFIED','CONFLICT','FAILED'
);
CREATE TYPE transaction_state AS ENUM (
  'PREPARED','SIGNED','BROADCAST','INCLUDED','SAFE','REPLACED','REVERTED','FAILED'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id BIGINT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  chain_id BIGINT NOT NULL,
  address VARCHAR(42) NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain_id, address)
);

CREATE TABLE github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL UNIQUE,
  github_account_id BIGINT NOT NULL,
  account_login TEXT NOT NULL,
  suspended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE containers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id BIGINT NOT NULL CHECK (chain_id = 196),
  factory_address VARCHAR(42) NOT NULL CHECK (factory_address ~ '^0x[0-9a-f]{40}$'),
  processor_index BIGINT NOT NULL CHECK (processor_index >= 0),
  processor_address VARCHAR(42) NOT NULL CHECK (processor_address ~ '^0x[0-9a-f]{40}$'),
  token_id NUMERIC(78,0) NOT NULL CHECK (token_id >= 1),
  container_address VARCHAR(42) NOT NULL CHECK (container_address ~ '^0x[0-9a-f]{40}$'),
  registry_address VARCHAR(42) NOT NULL CHECK (registry_address ~ '^0x[0-9a-f]{40}$'),
  binding_address VARCHAR(42) NOT NULL CHECK (binding_address ~ '^0x[0-9a-f]{40}$'),
  last_checked_block NUMERIC(78,0),
  last_observed_owner VARCHAR(42), -- cache/evidence only, NEVER authorization source
  last_registry_impl VARCHAR(42),
  last_binding_impl VARCHAR(42),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, container_address),
  UNIQUE (chain_id, processor_address, token_id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  github_installation_id UUID NOT NULL REFERENCES github_installations(id),
  github_repository_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  build_command TEXT NOT NULL DEFAULT 'npm run build',
  install_command TEXT NOT NULL DEFAULT 'npm ci',
  output_directory TEXT NOT NULL DEFAULT 'dist',
  container_id UUID NOT NULL REFERENCES containers(id),
  strict_deweb_mode BOOLEAN NOT NULL DEFAULT true,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (github_repository_id, default_branch, container_id)
);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_delivery_id TEXT NOT NULL UNIQUE,
  github_installation_numeric_id BIGINT,
  github_repository_id BIGINT,
  event_type TEXT NOT NULL,
  ref TEXT,
  commit_sha VARCHAR(40),
  accepted BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error_code TEXT,
  CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$')
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  container_id UUID NOT NULL REFERENCES containers(id),
  created_by_user_id UUID REFERENCES users(id),
  webhook_delivery_id UUID UNIQUE REFERENCES webhook_deliveries(id),
  idempotency_key TEXT,
  source_event_key TEXT,             -- dedup exact source trigger (not commit SHA)
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('webhook','manual','rollback')),
  commit_sha VARCHAR(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  state deployment_state NOT NULL DEFAULT 'RECEIVED',
  state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  target_chain_id BIGINT NOT NULL DEFAULT 196 CHECK (target_chain_id = 196),
  registry_address VARCHAR(42) NOT NULL CHECK (registry_address ~ '^0x[0-9a-f]{40}$'),
  artifact_sha256 VARCHAR(66),
  artifact_storage_key TEXT,
  manifest_sha256 VARCHAR(66),
  plan_json JSONB,
  error_code TEXT,
  error_message TEXT,
  approved_cost_cap_wei NUMERIC(78,0),
  estimated_cost_wei NUMERIC(78,0),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key),
  UNIQUE (source_event_key),
  CHECK (approved_cost_cap_wei IS NULL OR approved_cost_cap_wei >= 0),
  CHECK (estimated_cost_wei IS NULL OR estimated_cost_wei >= 0)
);

-- Lock against two concurrent chain-mutating operations for one container.
-- Planning can occur concurrently, but the following states cannot.
CREATE UNIQUE INDEX one_chain_writer_per_container ON deployments(container_id)
  WHERE state IN ('APPROVED','UPLOADING_ASSETS','VERIFYING_ASSETS',
                  'SWITCHING_ENTRY','VERIFYING_RELEASE');
CREATE INDEX deployments_project_created_idx ON deployments(project_id, requested_at DESC);
CREATE INDEX deployments_state_idx ON deployments(state, requested_at);

CREATE TABLE release_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  target_path TEXT NOT NULL,
  source_relative_path TEXT NOT NULL,
  sha256 VARCHAR(66) NOT NULL CHECK (sha256 ~ '^0x[0-9a-f]{64}$'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 8400000),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 350),
  content_type TEXT NOT NULL,
  state file_state NOT NULL DEFAULT 'PENDING',
  last_confirmed_chunk_index INTEGER NOT NULL DEFAULT -1,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, target_path),
  CHECK (length(target_path) > 0),
  CHECK (last_confirmed_chunk_index < chunk_count)
);

CREATE TABLE chain_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  release_file_id UUID REFERENCES release_files(id),
  chain_id BIGINT NOT NULL DEFAULT 196 CHECK (chain_id = 196),
  signer_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  operation TEXT NOT NULL,
  operation_fingerprint VARCHAR(66) NOT NULL,
  nonce NUMERIC(78,0),
  gas_limit NUMERIC(78,0),
  gas_used NUMERIC(78,0),
  effective_gas_price_wei NUMERIC(78,0),
  tx_hash VARCHAR(66),
  state transaction_state NOT NULL DEFAULT 'PREPARED',
  receipt_block_number NUMERIC(78,0),
  receipt_block_hash VARCHAR(66),
  replacement_for UUID REFERENCES chain_transactions(id),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash),
  UNIQUE (deployment_id, operation_fingerprint, nonce)
);
CREATE INDEX tx_deployment_idx ON chain_transactions(deployment_id, created_at);
CREATE INDEX tx_signer_nonce_idx ON chain_transactions(chain_id, signer_address, nonce);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  signer_address VARCHAR(42) NOT NULL,
  chain_id BIGINT NOT NULL DEFAULT 196,
  manifest_sha256 VARCHAR(66) NOT NULL,
  approval_digest VARCHAR(66) NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  approved_cost_cap_wei NUMERIC(78,0) NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK (approved_cost_cap_wei >= 0)
);

CREATE TABLE releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  deployment_id UUID NOT NULL UNIQUE REFERENCES deployments(id),
  release_id TEXT NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  manifest_sha256 VARCHAR(66) NOT NULL,
  entry_sha256 VARCHAR(66) NOT NULL,
  entry_path TEXT NOT NULL DEFAULT 'index.html',
  verify_report JSONB NOT NULL,
  verified_block_number NUMERIC(78,0) NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (project_id, release_id)
);
CREATE UNIQUE INDEX releases_one_current_idx ON releases(project_id) WHERE is_current = true;

CREATE TABLE deployment_events (
  id BIGSERIAL PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  old_state deployment_state,
  new_state deployment_state,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','worker','webhook','system')),
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deployment_events_by_job_idx ON deployment_events(deployment_id, id);

-- NOTE: Add RLS or authorization checks at API service boundary, including project memberships.
-- NOTE: The partial unique index intentionally prevents concurrent chain-mutating deployments.
-- NOTE: Release files are physically retained on-chain for rollback; a DB entry is NOT proof of current on-chain existence.
-- NOTE: Do not automatically DROP audit tables in an ordinary rollback migration.
