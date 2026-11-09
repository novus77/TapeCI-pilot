-- Durable audit trail for mutating API requests (stdout remains the shipping path).
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  github_login TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
  ip TEXT NOT NULL,
  user_agent TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at DESC);
