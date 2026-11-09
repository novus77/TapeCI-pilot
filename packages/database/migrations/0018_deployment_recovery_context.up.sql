-- §12.2 recovery context: what a reapproved deployment needs in order to CONTINUE the
-- original plan instead of re-planning against half-written resources.
--
-- Without it the worker can only tell "the state is UPLOAD_INTERRUPTED" and reuses
-- plan_json for exactly that state; after a reapproval the state is APPROVED, so the
-- original plan would be recomputed and the upload would fail with UPLOAD_CONFLICT on
-- files that are already on chain.
--
-- Nullable and append-only in practice: a deployment that never entered recovery has
-- none, and the value is written once when recovery starts. No backfill — inventing a
-- context for historical rows would claim a journal identity we do not have.
ALTER TABLE deployments
  ADD COLUMN recovery_context jsonb;

COMMENT ON COLUMN deployments.recovery_context IS
  'Original plan summary, journal identity and recovery stage captured when a deployment first needs recovery; survives AWAITING_APPROVAL -> APPROVED (SPEC 12.2).';
