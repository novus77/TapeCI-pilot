-- On-chain events TapeCI itself initiated for a container (today: DomainBinding.bind).
-- One row per mined transaction, so the console can show the activation tx hash,
-- the block it landed in and the resulting paid-until timestamp.
CREATE TABLE container_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  chain_id BIGINT NOT NULL DEFAULT 196,
  container_address VARCHAR(42) NOT NULL,
  binding_address VARCHAR(42) NOT NULL,
  event_type TEXT NOT NULL,
  name TEXT NOT NULL,
  name_hash VARCHAR(66) NOT NULL,
  months INTEGER NOT NULL,
  value_wei NUMERIC(78, 0) NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  gas_used NUMERIC(78, 0),
  paid_until TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT container_events_event_type_check CHECK (event_type IN ('bind')),
  CONSTRAINT container_events_chain_id_check CHECK (chain_id = 196),
  CONSTRAINT container_events_container_address_check CHECK (container_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT container_events_binding_address_check CHECK (binding_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT container_events_name_hash_check CHECK (name_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT container_events_tx_hash_check CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT container_events_months_check CHECK (months BETWEEN 1 AND 120),
  CONSTRAINT container_events_value_check CHECK (value_wei >= 0),
  CONSTRAINT container_events_block_check CHECK (block_number >= 0)
);
CREATE UNIQUE INDEX container_events_tx_hash_key ON container_events (tx_hash);
CREATE INDEX container_events_container_idx ON container_events (container_id, created_at DESC);
CREATE INDEX container_events_name_idx ON container_events (container_address, name);
