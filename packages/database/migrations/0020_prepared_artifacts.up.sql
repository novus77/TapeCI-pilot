ALTER TABLE deployments
  ADD COLUMN preparation_request JSONB,
  ADD COLUMN prepared_artifact_key TEXT,
  ADD CONSTRAINT deployments_prepared_artifact_key_check
    CHECK (prepared_artifact_key IS NULL OR prepared_artifact_key ~ '^sha256/[0-9a-f]{64}[.]tar$');
