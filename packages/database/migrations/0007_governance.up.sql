CREATE TABLE project_budgets (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  monthly_cap_wei NUMERIC(78, 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approval_policies (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  required_role TEXT NOT NULL DEFAULT 'owner',
  max_cost_cap_wei NUMERIC(78, 0),
  expires_in_seconds INTEGER NOT NULL DEFAULT 900,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_role_check CHECK (required_role IN ('owner', 'maintainer', 'member')),
  CONSTRAINT approval_policies_expiry_check CHECK (expires_in_seconds BETWEEN 60 AND 86400)
);

CREATE TABLE notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_channels_kind_check CHECK (kind IN ('slack', 'email'))
);
CREATE INDEX notification_channels_project_idx ON notification_channels(project_id);
