CREATE TABLE deployment_notification_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, deployment_id)
);
