-- A draft may belong to an organization so its finalised project lands in that org
-- instead of always being personal (issue P4-08). Nullable: both are legitimate.
--
-- Deliberately no backfill: existing drafts were created before this column existed
-- and there is no record of the organization their author intended, so guessing one
-- would move a project into an org nobody chose.
ALTER TABLE project_drafts
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;

-- Org-scoped lookups (a draft is listed by owner; an org view filters by this).
CREATE INDEX project_drafts_organization_idx
  ON project_drafts (organization_id)
  WHERE organization_id IS NOT NULL;
