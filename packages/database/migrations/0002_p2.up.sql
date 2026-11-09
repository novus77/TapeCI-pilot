-- P2 extension: wallet challenges, one-time build tokens, artifact uploads,
-- operator sessions and project membership.
CREATE TABLE IF NOT EXISTS wallet_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address VARCHAR(42) NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  chain_id BIGINT NOT NULL DEFAULT 196,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_challenges_nonce_key ON wallet_challenges(nonce);
CREATE INDEX IF NOT EXISTS wallet_challenges_address_idx ON wallet_challenges(address, created_at DESC);

CREATE TABLE IF NOT EXISTS build_tokens (
  jti UUID PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  repository_id BIGINT NOT NULL,
  commit_sha VARCHAR(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  ref TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS build_tokens_deployment_idx ON build_tokens(deployment_id);

CREATE TABLE IF NOT EXISTS artifact_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  object_key TEXT NOT NULL,
  sha256 VARCHAR(66) NOT NULL CHECK (sha256 ~ '^0x[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_uploads_object_key_key ON artifact_uploads(object_key);
CREATE INDEX IF NOT EXISTS artifact_uploads_deployment_idx ON artifact_uploads(deployment_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_members_project_user_key ON project_members(project_id, user_id);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id),
  signer_address VARCHAR(42) NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  approval_id UUID REFERENCES approvals(id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_sessions_container_idx ON operator_sessions(container_id, expires_at);
CREATE INDEX IF NOT EXISTS operator_sessions_signer_idx ON operator_sessions(signer_address);
