-- Optional expiry for a membership grant. NULL means "no expiry", which is the
-- existing behaviour, so this is additive and safe to apply on a live table.
--
-- The column is enforced at read time (an expired row stops granting access) rather
-- than by a background job: a sweeper can lag, and a grant that still works after
-- its expiry is a security bug, not a cosmetic one.
ALTER TABLE organization_members
  ADD COLUMN expires_at timestamptz;

ALTER TABLE project_members
  ADD COLUMN expires_at timestamptz;

-- Expiry is only meaningful for a future date; a past value would silently grant
-- nothing, which is a confusing way to express "remove".
ALTER TABLE organization_members
  ADD CONSTRAINT organization_members_expires_future
  CHECK (expires_at IS NULL OR expires_at > created_at);

ALTER TABLE project_members
  ADD CONSTRAINT project_members_expires_future
  CHECK (expires_at IS NULL OR expires_at > created_at);

CREATE INDEX organization_members_expires_idx
  ON organization_members (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX project_members_expires_idx
  ON project_members (expires_at)
  WHERE expires_at IS NOT NULL;
