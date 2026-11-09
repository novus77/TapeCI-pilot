CREATE TABLE organization_budgets (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  monthly_cap_wei NUMERIC(78, 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
