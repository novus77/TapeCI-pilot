-- Resource index and preparation persistence (SPEC §6, §8, §9).
--
-- Additive only: eight new tables, no existing table or constraint is altered. Addresses are
-- normalized lowercase hex; token ids, wei and block numbers are NUMERIC(78,0) so nothing
-- above 2^53 is ever rounded. `containers_token_id_check` (token_id >= 1, P0-04) is
-- deliberately left alone; `wallet_resources` carries its own token_id >= 0 constraint below
-- because §5/§6 admit token 0 in the public asset key.
--
-- Completeness of the scan is derived from `resource_index_state.origin_block` plus one
-- checkpoint per catalogue processor, not stored as a boolean that could disagree with the
-- coverage rows (the API's readResourceIndexSnapshot is the single derivation). §3.2.1
-- therefore cannot show "no circuits" while the derived state is partial.

-- Index-wide state: the trusted scan origin and whether a sync is running. One row per chain.
CREATE TABLE IF NOT EXISTS resource_index_state (
  chain_id BIGINT PRIMARY KEY,
  -- NULL until ops has committed the trusted origin; while NULL no coverage is complete.
  origin_block NUMERIC(78,0),
  -- Persisted so a page served by another process still reports "syncing".
  syncing BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resource_index_state_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT resource_index_state_origin_block_check
    CHECK (origin_block IS NULL OR origin_block >= 0)
);

-- Contiguous per-processor coverage of the verified Transfer-log scan. A row is written only
-- after a chunk has been folded in, and it always carries that block's hash so a restart can
-- prove the checkpoint is still canonical before resuming (§8.3, §8.8). A failed or
-- rate-limited page never advances through_block: a short range is partial, not "owns nothing".
CREATE TABLE IF NOT EXISTS resource_index_checkpoints (
  chain_id BIGINT NOT NULL,
  processor_address VARCHAR(42) NOT NULL,
  factory_address VARCHAR(42) NOT NULL,
  processor_index BIGINT NOT NULL,
  from_block NUMERIC(78,0) NOT NULL,
  through_block NUMERIC(78,0) NOT NULL,
  through_block_hash VARCHAR(66) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, processor_address),
  CONSTRAINT resource_index_checkpoints_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT resource_index_checkpoints_factory_address_check
    CHECK (factory_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT resource_index_checkpoints_processor_index_check CHECK (processor_index >= 0),
  CONSTRAINT resource_index_checkpoints_processor_address_check
    CHECK (processor_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT resource_index_checkpoints_blocks_check
    CHECK (from_block >= 0 AND through_block >= from_block),
  CONSTRAINT resource_index_checkpoints_through_block_hash_check
    CHECK (through_block_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS resource_index_checkpoints_catalog_idx
  ON resource_index_checkpoints(chain_id, processor_index);

-- Public chain projection keyed by the asset key (chain, processor, token_id). `unverified`
-- is a log-derived candidate whose owner is known at observed_block but whose deployed/opened
-- have not been read; only `verified` may carry boolean facts, so a failed read can never be
-- projected as "not deployed"/"not opened" (§8.6).
CREATE TABLE IF NOT EXISTS wallet_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id BIGINT NOT NULL,
  processor_index BIGINT NOT NULL,
  processor_address VARCHAR(42) NOT NULL,
  -- Token 0 is a legal query/asset key (§5, §6). This table indexes observed chain data only;
  -- it does not widen `containers_token_id_check`, which still requires >= 1.
  token_id NUMERIC(78,0) NOT NULL,
  container_address VARCHAR(42),
  owner_address VARCHAR(42),
  deployed BOOLEAN,
  opened BOOLEAN,
  read_status TEXT NOT NULL DEFAULT 'unverified',
  observed_block NUMERIC(78,0),
  observed_block_hash VARCHAR(66),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_resources_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT wallet_resources_processor_index_check CHECK (processor_index >= 0),
  CONSTRAINT wallet_resources_processor_address_check
    CHECK (processor_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallet_resources_token_id_check CHECK (token_id >= 0),
  CONSTRAINT wallet_resources_container_address_check
    CHECK (container_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallet_resources_owner_address_check CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallet_resources_read_status_check
    CHECK (read_status IN ('verified','unavailable','not_found','unverified')),
  CONSTRAINT wallet_resources_observed_block_check
    CHECK (observed_block IS NULL OR observed_block >= 0),
  CONSTRAINT wallet_resources_observed_block_hash_check
    CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT wallet_resources_fact_status_check
    CHECK (read_status = 'verified' OR (deployed IS NULL AND opened IS NULL)),
  CONSTRAINT wallet_resources_verified_read_check
    CHECK (read_status <> 'verified' OR (observed_block IS NOT NULL AND deployed IS NOT NULL AND opened IS NOT NULL)),
  CONSTRAINT wallet_resources_not_found_read_check
    CHECK (read_status <> 'not_found' OR observed_block IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_resources_chain_processor_token_key
  ON wallet_resources(chain_id, processor_address, token_id);
CREATE INDEX IF NOT EXISTS wallet_resources_owner_idx
  ON wallet_resources(chain_id, owner_address, processor_address, token_id);

-- Immutable final quote. A re-quote inserts a new row; nothing updates one, which is what
-- keeps every already-confirmed step attached to its original price (§6, §9.3).
CREATE TABLE IF NOT EXISTS resource_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  -- Verified delivery wallet; a quote never changes recipient.
  recipient_address VARCHAR(42) NOT NULL,
  chain_id BIGINT NOT NULL,
  -- Verified offer source or the built-in `open` source; never user input.
  source_id TEXT NOT NULL,
  offer_id TEXT,
  resource_snapshot JSONB,
  options JSONB NOT NULL,
  steps_snapshot JSONB NOT NULL,
  prices_snapshot JSONB NOT NULL,
  observed_block NUMERIC(78,0) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  terms_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT resource_quotes_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT resource_quotes_recipient_address_check
    CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT resource_quotes_source_id_check CHECK (length(source_id) > 0),
  CONSTRAINT resource_quotes_terms_version_check CHECK (length(terms_version) > 0),
  -- Acquisition and an existing resource are mutually exclusive: exactly one is priced (§7.2).
  CONSTRAINT resource_quotes_offer_or_resource_check
    CHECK ((offer_id IS NULL) <> (resource_snapshot IS NULL)),
  CONSTRAINT resource_quotes_resource_snapshot_check
    CHECK (resource_snapshot IS NULL OR jsonb_typeof(resource_snapshot) = 'object'),
  CONSTRAINT resource_quotes_options_check CHECK (jsonb_typeof(options) = 'object'),
  CONSTRAINT resource_quotes_steps_snapshot_check
    CHECK (jsonb_typeof(steps_snapshot) = 'array' AND jsonb_array_length(steps_snapshot) > 0),
  CONSTRAINT resource_quotes_prices_snapshot_check
    CHECK (jsonb_typeof(prices_snapshot) = 'array'),
  CONSTRAINT resource_quotes_observed_block_check CHECK (observed_block >= 0),
  CONSTRAINT resource_quotes_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS resource_quotes_user_created_idx
  ON resource_quotes(user_id, created_at DESC);

-- Preparation task. `version` is the CAS token: every mutation is
-- `UPDATE ... WHERE id = $1 AND version = $expected` and increments it, so two concurrent
-- confirmations cannot both create a paid intent. `idempotency_key` is unique per user; a
-- replay compares request_digest and returns the same task, a different digest is a conflict.
CREATE TABLE IF NOT EXISTS provisioning_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  -- Immutable; a requote may not move the delivery wallet (§9.3).
  recipient_address VARCHAR(42) NOT NULL,
  chain_id BIGINT NOT NULL,
  initial_quote_id UUID NOT NULL REFERENCES resource_quotes(id),
  current_quote_id UUID NOT NULL REFERENCES resource_quotes(id),
  idempotency_key TEXT NOT NULL,
  -- SHA-256 over quoteId, recipient, chain and options; never a digest of the raw header.
  request_digest VARCHAR(66) NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting_user',
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_tasks_state_check
    CHECK (state IN ('waiting_user','running','needs_action','completed','canceled')),
  CONSTRAINT provisioning_tasks_version_check CHECK (version >= 0),
  CONSTRAINT provisioning_tasks_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT provisioning_tasks_recipient_address_check
    CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT provisioning_tasks_idempotency_key_check
    CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT provisioning_tasks_request_digest_check
    CHECK (request_digest ~ '^0x[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_tasks_user_idempotency_key
  ON provisioning_tasks(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS provisioning_tasks_user_created_idx
  ON provisioning_tasks(user_id, created_at DESC);
-- Worker recovery: tasks that may still need reconciliation (§3.3).
CREATE INDEX IF NOT EXISTS provisioning_tasks_unfinished_idx
  ON provisioning_tasks(state, updated_at)
  WHERE state NOT IN ('completed','canceled');

-- Append-only record of every accepted quote revision, including the initial one.
CREATE TABLE IF NOT EXISTS provisioning_quote_acceptances (
  task_id UUID NOT NULL REFERENCES provisioning_tasks(id),
  quote_id UUID NOT NULL REFERENCES resource_quotes(id),
  accepted_by UUID NOT NULL REFERENCES users(id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, quote_id)
);

CREATE INDEX IF NOT EXISTS provisioning_quote_acceptances_quote_idx
  ON provisioning_quote_acceptances(quote_id);

-- Ordered steps of a preparation task (§5, §9.1). Each step is priced by one quote; a
-- requote + acceptance moves the task's current quote while confirmed steps keep theirs.
CREATE TABLE IF NOT EXISTS provisioning_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES provisioning_tasks(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting',
  quote_id UUID NOT NULL REFERENCES resource_quotes(id),
  -- NULL until an acquisition resolves its tokenId (§9.3); never a placeholder address.
  expected_resource JSONB,
  -- Verified outcome, not the expectation.
  resolved_resource JSONB,
  external_source_id TEXT,
  external_reference TEXT,
  -- Per-step CAS token, mirroring the task's.
  version BIGINT NOT NULL DEFAULT 0,
  -- Machine code, localized by the page; never provider prose.
  error_code TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_steps_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT provisioning_steps_version_check CHECK (version >= 0),
  CONSTRAINT provisioning_steps_kind_check
    CHECK (kind IN ('acquisition','open','activation')),
  CONSTRAINT provisioning_steps_state_check
    CHECK (state IN ('waiting','awaiting_signature','submitted','external_pending','confirmed','failed','skipped')),
  CONSTRAINT provisioning_steps_expected_resource_check
    CHECK (expected_resource IS NULL OR jsonb_typeof(expected_resource) = 'object'),
  CONSTRAINT provisioning_steps_resolved_resource_check
    CHECK (resolved_resource IS NULL OR jsonb_typeof(resolved_resource) = 'object'),
  -- A source without a reference (or vice versa) can never be verified against a provider.
  CONSTRAINT provisioning_steps_external_pair_check
    CHECK ((external_source_id IS NULL) = (external_reference IS NULL)),
  CONSTRAINT provisioning_steps_external_pending_check
    CHECK (state <> 'external_pending' OR (external_source_id IS NOT NULL AND external_reference IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_steps_task_ordinal_key
  ON provisioning_steps(task_id, ordinal);
-- Redundant with the PK, but PostgreSQL requires a unique constraint/index over the exact
-- referenced columns for provisioning_transactions' composite FK (step_id, task_id).
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_steps_id_task_key
  ON provisioning_steps(id, task_id);
-- One verified external order (source + reference) may not back two steps (§6).
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_steps_external_reference_key
  ON provisioning_steps(external_source_id, external_reference)
  WHERE external_source_id IS NOT NULL AND external_reference IS NOT NULL;
-- Reconciler: steps whose sending/external outcome is still unresolved (§3.3, §9.1).
CREATE INDEX IF NOT EXISTS provisioning_steps_unresolved_idx
  ON provisioning_steps(state, updated_at)
  WHERE state IN ('submitted','external_pending');

-- A saved send intent and its observed outcome (§7.3, §9.1–§9.2). The row is written before
-- the wallet is asked to sign, so tx_hash is NULL until a hash comes back; a lost-hash window
-- stays `unresolved` and can later be matched to a recovered hash. A replacement attempt is a
-- new row with the same intent_id and replacement_for pointing at the attempt it superseded
-- (same sender/nonce), while the superseded row is marked `replaced`.
CREATE TABLE IF NOT EXISTS provisioning_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES provisioning_tasks(id),
  step_id UUID NOT NULL,
  quote_id UUID NOT NULL REFERENCES resource_quotes(id),
  -- Logical intent id returned as PreparedStepTransaction.intentId; stable across replacements.
  intent_id UUID NOT NULL,
  chain_id BIGINT NOT NULL,
  sender VARCHAR(42) NOT NULL,
  target VARCHAR(42) NOT NULL,
  value_wei NUMERIC(78,0) NOT NULL,
  calldata TEXT NOT NULL,
  gas_limit NUMERIC(78,0) NOT NULL,
  gas_price_wei NUMERIC(78,0) NOT NULL,
  max_gas_cost_wei NUMERIC(78,0) NOT NULL,
  -- SHA-256 of the intent's canonical fields, re-checked against the chain tx (§9.2).
  expected_digest VARCHAR(66) NOT NULL,
  nonce NUMERIC(78,0),
  tx_hash VARCHAR(66),
  replacement_for UUID,
  status TEXT NOT NULL DEFAULT 'prepared',
  block_number NUMERIC(78,0),
  block_hash VARCHAR(66),
  gas_used NUMERIC(78,0),
  effective_gas_price_wei NUMERIC(78,0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- step_id + task_id must name a real step of THIS task; the composite FK below makes the
  -- attribution structural, so a transaction cannot be moved to another task's step.
  CONSTRAINT provisioning_transactions_step_task_fk
    FOREIGN KEY (step_id, task_id) REFERENCES provisioning_steps(id, task_id),
  CONSTRAINT provisioning_transactions_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT provisioning_transactions_sender_check CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT provisioning_transactions_target_check CHECK (target ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT provisioning_transactions_value_check CHECK (value_wei >= 0),
  CONSTRAINT provisioning_transactions_calldata_check
    CHECK (calldata ~ '^0x([0-9a-f]{2})*$'),
  CONSTRAINT provisioning_transactions_gas_check
    CHECK (gas_limit > 0 AND gas_price_wei >= 0 AND max_gas_cost_wei >= gas_limit * gas_price_wei),
  CONSTRAINT provisioning_transactions_nonce_check CHECK (nonce IS NULL OR nonce >= 0),
  CONSTRAINT provisioning_transactions_expected_digest_check
    CHECK (expected_digest ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT provisioning_transactions_tx_hash_check
    CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT provisioning_transactions_block_hash_check
    CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT provisioning_transactions_status_check
    CHECK (status IN ('prepared','submitted','confirmed','failed','replaced','unresolved')),
  -- A prepared intent has no hash; every broadcast attempt except a lost-hash one must.
  CONSTRAINT provisioning_transactions_prepared_hash_check
    CHECK (status <> 'prepared' OR tx_hash IS NULL),
  CONSTRAINT provisioning_transactions_broadcast_hash_check
    CHECK (status IN ('prepared','unresolved') OR tx_hash IS NOT NULL),
  -- Confirmation needs the receipt facts a canonical-chain check reads (§9.2).
  CONSTRAINT provisioning_transactions_confirmed_receipt_check
    CHECK (status <> 'confirmed' OR (block_number IS NOT NULL AND block_hash IS NOT NULL AND gas_used IS NOT NULL)),
  CONSTRAINT provisioning_transactions_receipt_values_check
    CHECK ((block_number IS NULL OR block_number >= 0)
       AND (gas_used IS NULL OR gas_used >= 0)
       AND (effective_gas_price_wei IS NULL OR effective_gas_price_wei >= 0)),
  CONSTRAINT provisioning_transactions_replacement_check
    CHECK (replacement_for IS NULL OR replacement_for <> id)
);

-- A hash identifies one attempt on one chain; NULL (not broadcast yet) is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_transactions_chain_tx_hash_key
  ON provisioning_transactions(chain_id, tx_hash);
-- An intent has exactly one root attempt, and that intent id is globally unique, so the same
-- intent cannot become a root in another task. Replacement rows are excluded here; the
-- composite replacement FK above keeps them on the same task + intent.
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_transactions_intent_root_key
  ON provisioning_transactions(intent_id)
  WHERE replacement_for IS NULL;
-- Referenced columns for the replacement self-FK (redundant with the PK, required by PG).
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_transactions_id_task_intent_key
  ON provisioning_transactions(id, task_id, intent_id);
-- A replacement must supersede an attempt of the same task and the same intent. Combined with
-- the single-root index above, this forbids cross-task intent attribution (§6). Added after
-- the unique index exists: PostgreSQL resolves the referenced columns at ADD time.
ALTER TABLE provisioning_transactions
  ADD CONSTRAINT provisioning_transactions_replacement_fk
  FOREIGN KEY (replacement_for, task_id, intent_id)
  REFERENCES provisioning_transactions(id, task_id, intent_id);
-- At most one unresolved sending intent per step (§6). A replacement first marks the
-- superseded row `replaced`, which is outside this predicate, then inserts the new attempt.
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_transactions_live_intent_key
  ON provisioning_transactions(step_id)
  WHERE status IN ('prepared','submitted','unresolved');
CREATE INDEX IF NOT EXISTS provisioning_transactions_step_idx
  ON provisioning_transactions(step_id, created_at);
CREATE INDEX IF NOT EXISTS provisioning_transactions_sender_nonce_idx
  ON provisioning_transactions(chain_id, sender, nonce);
-- Reconciler: attempts whose outcome still has to be verified (§3.3).
CREATE INDEX IF NOT EXISTS provisioning_transactions_unresolved_idx
  ON provisioning_transactions(status, updated_at)
  WHERE status IN ('submitted','unresolved');
