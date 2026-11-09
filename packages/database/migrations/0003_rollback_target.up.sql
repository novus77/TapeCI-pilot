-- P2 rollback audit: link a rollback deployment to the stored release it restores.
ALTER TABLE deployments
  ADD COLUMN rollback_target_release_id UUID REFERENCES releases(id);

CREATE INDEX deployments_rollback_target_idx
  ON deployments(rollback_target_release_id)
  WHERE rollback_target_release_id IS NOT NULL;
