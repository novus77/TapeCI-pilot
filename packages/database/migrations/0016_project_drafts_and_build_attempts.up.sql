-- Project drafts, build attempts, and the build admission switch (SPEC §11.1–§11.3).
--
-- Additive only: two columns on `projects` plus two new tables; no existing column,
-- index or constraint is altered. `project_drafts` is what makes P0-06 impossible to
-- reintroduce: it stores the resource key `(chain_id, processor_address, token_id)` and
-- has no container-address column, so a container can only ever be the server-side
-- derivation of that key. `build_attempts` keeps `commit_sha` (the source that was
-- built) and `workflow_commit_sha` (the workflow that actually ran) in separate columns
-- (§11.3): a historical commit is legitimately built by a newer workflow, so neither
-- value may ever alias or overwrite the other.

-- §11.2: the platform admission switch. A finalised draft starts with this false — a
-- push is admitted only after the user enables builds through the readiness gate, never
-- merely because promotion created the project.
ALTER TABLE projects
  ADD COLUMN build_enabled boolean NOT NULL DEFAULT false;

-- Existing projects were admitted on every push before this column existed. Leaving them
-- false would silently stop their builds as soon as the admission gate ships, so preserve
-- their previous behaviour for rows that already exist; only new projects start off.
UPDATE projects SET build_enabled = true;

-- §11.3: the saved console configuration revision a build attempt was dispatched with.
-- Kept as a counter distinct from the console's live edit so an in-flight attempt keeps
-- serving its own snapshot instead of "whatever the form says now" (AC-P4-10).
ALTER TABLE projects
  ADD COLUMN config_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT projects_config_version_check CHECK (config_version >= 1);

-- A project that is not finalised yet. It intentionally does not reference `projects`:
-- while the draft lives there is no project row, so no webhook, token or dispatch can
-- resolve the repository to an admitted project (AC-P4-01).
CREATE TABLE IF NOT EXISTS project_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A draft is owned by its creator; project roles do not exist until it finalises.
  owner_user_id UUID NOT NULL REFERENCES users(id),
  github_installation_id UUID NOT NULL REFERENCES github_installations(id),
  -- GitHub's immutable repository id, not only the display name: a name can be renamed
  -- or transferred, and finalisation re-checks that this id is still covered (§11.1).
  github_repository_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  install_command TEXT NOT NULL DEFAULT 'npm ci',
  build_command TEXT NOT NULL DEFAULT 'npm run build',
  output_directory TEXT NOT NULL DEFAULT 'dist',
  -- `versioned` (default) is what a first-time user gets without reading anything;
  -- `root` is only storable together with the acknowledgement below (§11.1).
  path_mode TEXT NOT NULL DEFAULT 'versioned',
  -- Who read which text version and when. The version is compared, never parsed: a UI
  -- built against an older text cannot satisfy a newer server requirement (AC-P4-08).
  root_path_acknowledged_at TIMESTAMPTZ,
  root_path_acknowledged_by UUID REFERENCES users(id),
  root_path_ack_version TEXT,
  -- The asset key (§2). All three columns are NULL until a circuit is attached, and no
  -- container address exists here: the container is derived from this key, never typed.
  chain_id BIGINT,
  processor_address VARCHAR(42),
  token_id NUMERIC(78,0),
  state TEXT NOT NULL DEFAULT 'draft',
  -- Set only with state = 'finalized'; the promotion evidence itself is the projects row.
  finalized_project_id UUID REFERENCES projects(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_drafts_repo_full_name_check
    CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  CONSTRAINT project_drafts_github_repository_id_check CHECK (github_repository_id > 0),
  CONSTRAINT project_drafts_default_branch_check
    CHECK (length(default_branch) BETWEEN 1 AND 255),
  CONSTRAINT project_drafts_commands_check
    CHECK (length(install_command) BETWEEN 1 AND 1024 AND length(build_command) BETWEEN 1 AND 1024),
  -- Canonical relative directory: no leading/trailing slash, no `..` segment, no empty
  -- segment and no backslash. `packages/shared` rejects the same shapes in TS, so a draft
  -- cannot store an output directory the release path would later reinterpret. (A NUL byte
  -- needs no CHECK: PostgreSQL text cannot contain one.)
  CONSTRAINT project_drafts_output_directory_check
    CHECK (
      length(output_directory) BETWEEN 1 AND 1024
      AND output_directory !~ '(^/)|(^|/)\.\.(/|$)|(//)|(/$)'
      AND strpos(output_directory, E'\\') = 0
    ),
  CONSTRAINT project_drafts_path_mode_check CHECK (path_mode IN ('versioned','root')),
  -- §11.1: root mode is only storable after the user read the overwrite/rollback
  -- difference. The service refuses first with the text version; this is the backstop.
  CONSTRAINT project_drafts_root_ack_check
    CHECK (
      path_mode <> 'root'
      OR (root_path_acknowledged_at IS NOT NULL
          AND root_path_acknowledged_by IS NOT NULL
          AND root_path_ack_version IS NOT NULL)
    ),
  CONSTRAINT project_drafts_root_ack_version_check
    CHECK (root_path_ack_version IS NULL OR length(root_path_ack_version) BETWEEN 1 AND 64),
  -- A partial key is not a key: attach all of (chain, processor, tokenId) or none.
  CONSTRAINT project_drafts_resource_key_check
    CHECK (
      ((chain_id IS NULL) = (processor_address IS NULL))
      AND ((processor_address IS NULL) = (token_id IS NULL))
    ),
  CONSTRAINT project_drafts_chain_id_check CHECK (chain_id IS NULL OR chain_id = 196),
  CONSTRAINT project_drafts_processor_address_check
    CHECK (processor_address ~ '^0x[0-9a-f]{40}$'),
  -- `containers_token_id_check` requires >= 1 (P0-04): token 0 is a queryable asset key
  -- but cannot back a project, so a draft refuses to name one as its circuit.
  CONSTRAINT project_drafts_token_id_check CHECK (token_id IS NULL OR token_id >= 1),
  CONSTRAINT project_drafts_state_check CHECK (state IN ('draft','finalized')),
  CONSTRAINT project_drafts_finalized_check
    CHECK ((state = 'finalized') = (finalized_project_id IS NOT NULL)),
  CONSTRAINT project_drafts_timestamps_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS project_drafts_owner_idx
  ON project_drafts(owner_user_id, updated_at DESC);
-- A project can be the promotion of at most one draft; NULLs (still-draft rows) are not
-- compared by a unique index, so many open drafts remain legal.
CREATE UNIQUE INDEX IF NOT EXISTS project_drafts_finalized_project_key
  ON project_drafts(finalized_project_id);

-- One dispatch of one deployment (§11.3). The row is written *before* GitHub is called,
-- so `state = 'planned'` is the save-before-dispatch record; `dispatch_unknown` is the
-- explicit "GitHub may have accepted it; re-read the run instead of dispatching again".
CREATE TABLE IF NOT EXISTS build_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  attempt INTEGER NOT NULL,
  -- A retry of the same SHA is a new attempt (possibly on a new deployment) pointing at
  -- the attempt it superseded; it never replays the original webhook (§11.3, AC-P4-12).
  retry_of UUID REFERENCES build_attempts(id),
  -- The target source revision the user selected. Never rewritten from an OIDC/run claim.
  commit_sha VARCHAR(40) NOT NULL,
  -- The workflow revision that actually runs. Resolved before dispatch and verified via
  -- the authenticated run API; it is a different identity from `commit_sha` (§11.3).
  workflow_commit_sha VARCHAR(40) NOT NULL,
  -- Correlation id passed to the dispatched workflow and matched on the authenticated
  -- run; on its own it is not an authentication credential.
  dispatch_correlation_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  -- The exact install/build/output snapshot this attempt serves from `/v1/builds/context`
  -- (§11.3). Stored per attempt so a later console edit cannot change an in-flight build.
  config_snapshot JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned',
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_attempts_attempt_check CHECK (attempt >= 1),
  CONSTRAINT build_attempts_retry_check CHECK (retry_of IS NULL OR retry_of <> id),
  CONSTRAINT build_attempts_commit_sha_check CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_attempts_workflow_commit_sha_check
    CHECK (workflow_commit_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_attempts_dispatch_correlation_check
    CHECK (length(dispatch_correlation_id) BETWEEN 1 AND 255),
  CONSTRAINT build_attempts_config_version_check CHECK (config_version >= 1),
  CONSTRAINT build_attempts_config_snapshot_check
    CHECK (jsonb_typeof(config_snapshot) = 'object'),
  CONSTRAINT build_attempts_state_check
    CHECK (state IN ('planned','dispatched','running','dispatch_unknown','succeeded','failed','canceled')),
  -- Terminal attempts carry their finish time; live ones cannot claim one.
  CONSTRAINT build_attempts_terminal_check
    CHECK ((state IN ('succeeded','failed','canceled')) = (finished_at IS NOT NULL)),
  CONSTRAINT build_attempts_finished_check CHECK (finished_at IS NULL OR finished_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS build_attempts_deployment_attempt_key
  ON build_attempts(deployment_id, attempt);
-- One correlation id identifies exactly one attempt; a second row could otherwise mix
-- two dispatch results into one history.
CREATE UNIQUE INDEX IF NOT EXISTS build_attempts_dispatch_correlation_key
  ON build_attempts(dispatch_correlation_id);
CREATE INDEX IF NOT EXISTS build_attempts_retry_idx ON build_attempts(retry_of);
CREATE INDEX IF NOT EXISTS build_attempts_commit_idx ON build_attempts(commit_sha, created_at DESC);
