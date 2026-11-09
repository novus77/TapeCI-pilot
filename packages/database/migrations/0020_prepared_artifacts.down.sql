-- Dropping these columns destroys the frozen snapshot pointer and the preparation request.
-- For a compressed deployment that is unrecoverable: `loadDeploymentArtifact` would parse a
-- NULL request as "original" and could never find the bytes that were approved (Stage C review
-- F2). The migration therefore refuses to run while any deployment still references them,
-- instead of silently discarding the data and leaving deployments that can never be resumed or
-- rolled back.
DO $$
DECLARE
  pinned bigint;
BEGIN
  SELECT count(*) INTO pinned
  FROM deployments
  WHERE prepared_artifact_key IS NOT NULL OR preparation_request IS NOT NULL;

  IF pinned > 0 THEN
    RAISE EXCEPTION
      'refusing to drop prepared-artifact columns: % deployment row(s) still carry a pin or a preparation request. Archive or clear them first.',
      pinned;
  END IF;
END $$;

ALTER TABLE deployments
  DROP CONSTRAINT deployments_prepared_artifact_key_check,
  DROP COLUMN prepared_artifact_key,
  DROP COLUMN preparation_request;
