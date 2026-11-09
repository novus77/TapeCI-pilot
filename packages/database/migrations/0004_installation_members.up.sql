-- Multi-tenant access: a user may only use installations they installed/claimed.
CREATE TABLE github_installation_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX github_installation_users_installation_user_key
  ON github_installation_users(installation_id, user_id);

CREATE INDEX github_installation_users_user_idx
  ON github_installation_users(user_id, created_at DESC);
