-- §15.1 requires CAS on a draft update. Without a version token a stale PATCH silently
-- overwrites whatever another tab saved, which is exactly the lost-update the spec's
-- "CAS" clause names.
ALTER TABLE project_drafts
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

COMMENT ON COLUMN project_drafts.version IS
  'Optimistic-concurrency token for draft updates (SPEC 15.1 CAS); the client sends expectedVersion and a mismatch is 409 DRAFT_CHANGED.';
