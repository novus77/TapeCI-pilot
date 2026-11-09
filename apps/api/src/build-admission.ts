/**
 * Build admission — SPEC §11.2.
 *
 * §11.2 (draft/not-enabled): record that the webhook arrived and why it was
 * skipped, create no platform deployment and issue no build token.
 * §11.2 (later pushes): a push becomes a new business attempt only while
 * `build_enabled` holds; a duplicate delivery stays idempotent.
 *
 * This module is the *decision* only. It is a pure function over facts the
 * caller has already read: no DB, no network, no clock, no environment. A
 * skipped decision therefore cannot create a deployment or issue a token — that
 * is the caller's job, and the caller must not do it. Concretely, on
 * `admit: false` the webhook records the delivery with `accepted = false` and
 * `ADMISSION_SKIP_CODES[reason]`, and stops: zero deployments, zero build
 * attempts, zero tokens, zero GitHub dispatches.
 *
 * §11.2 also requires the copy to be honest about scope: an admission gate is
 * not a firewall. The repository's own `on: push` workflow still starts on
 * GitHub; TapeCI refuses admission and withholds the token, and the UI and docs
 * must say exactly that.
 *
 * The five reasons are deliberately distinct, because each one names a
 * different action for the user:
 *
 * - `draft`                  — finish and finalise the draft, then enable builds.
 * - `build_disabled`         — the project exists; turn builds on.
 * - `no_project`             — connect the repository first (nothing exists yet).
 * - `repository_unauthorized`— something exists, but not for this delivery.
 * - `installation_inactive`  — repair the GitHub App installation first.
 *
 * §11.2's "skip reason" is why `no_project` must not collapse into the generic
 * `REPOSITORY_NOT_AUTHORIZED` the webhook returned for every refusal before
 * this gate existed: "nothing is connected" and "the build switch is off" send
 * the user to two different places.
 */

/**
 * §11.2's skip reasons. Each is a user-facing explanation, not an internal
 * short-circuit, so the union is closed on purpose: a new reason needs a new
 * recovery instruction.
 */
export type AdmissionSkipReason =
  | "draft"
  | "build_disabled"
  | "no_project"
  | "repository_unauthorized"
  | "installation_inactive";

/**
 * §11.2: admitted, or skipped with a reason and a human-readable detail.
 * `detail` is never empty — a skip that cannot be explained is a bug.
 */
export type AdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: AdmissionSkipReason; readonly detail: string };

/**
 * The facts admission is decided from. Every one is a plain value the caller
 * has already resolved; none of them is re-read here.
 *
 * `repoId` matching and installation ownership are one fact (`repositoryMatches`)
 * on purpose: both mean "this delivery is not for this target through this
 * installation", both are refusals the user fixes by re-verifying the
 * connection, and §11.2's table has a single skip row for them.
 */
export interface AdmissionFacts {
  /**
   * The GitHub App installation that delivered this push exists and is neither
   * suspended nor deleted (`github_installations.suspended_at/deleted_at` null).
   * This is the *delivering* installation: it is what the platform would have
   * to dispatch and mint a token through.
   */
  readonly installationActive: boolean;
  /**
   * The delivery belongs to the resolved target — its `githubRepositoryId` is the
   * pushed repository id **and** the delivering installation is the target's
   * installation. "Target" is whichever row was resolved: a `projects` row or an
   * unfinalised `project_drafts` row. `false` when no target was resolved; it is
   * only consulted when one was (see the ordering below).
   */
  readonly repositoryMatches: boolean;
  /**
   * A `projects` row is bound to this repository and branch. This is what
   * §11.2's "later pushes" case admits against.
   */
  readonly projectExists: boolean;
  /**
   * The only target bound to this repository and branch is an unfinalised
   * `project_drafts` row (`state = 'draft'`). A draft has no `projects` row yet,
   * so `isDraft` and `projectExists` are mutually exclusive in the schema; when
   * both are passed, `projectExists` wins because the draft gate is about the
   * target not being promoted.
   */
  readonly isDraft: boolean;
  /**
   * `projects.build_enabled` for the resolved project (migration 0016). Ignored
   * unless a project exists, so a caller cannot use a stale `false` to mask a
   * draft or a missing project.
   */
  readonly buildEnabled: boolean;
}

/**
 * The stable code the caller persists in `webhook_deliveries.error_code` and
 * echoes to GitHub (the column is text, and these are the values existing
 * consumers already understand).
 *
 * `no_project` and `repository_unauthorized` share `REPOSITORY_NOT_AUTHORIZED`:
 * the repository has no finer stored code today, and both are the same 403 for
 * the caller. `AdmissionSkipReason` still tells them apart, so a response body
 * or a log can carry the precise reason.
 */
export const ADMISSION_SKIP_CODES = {
  draft: "PROJECT_DRAFT",
  build_disabled: "BUILD_DISABLED",
  no_project: "REPOSITORY_NOT_AUTHORIZED",
  repository_unauthorized: "REPOSITORY_NOT_AUTHORIZED",
  installation_inactive: "AUTH_REVOKED",
} as const satisfies Record<AdmissionSkipReason, string>;

/**
 * Decide whether a push may become a build, per SPEC §11.2.
 *
 * Precedence is explicit and is decided by "which fix comes first for the user",
 * not by the order the facts happen to be read in:
 *
 * 1. `installation_inactive` — a suspended or deleted installation invalidates
 *    every other fact below it (the platform could not dispatch or mint a token
 *    even if the project were ready), and §11.2's skip reason would otherwise
 *    send the user to enable builds they cannot build. This deliberately
 *    outranks `draft`.
 * 2. `no_project` — nothing is connected to this repository and branch. This is
 *    *not* `repository_unauthorized`: no project is not an unauthorised project.
 * 3. `repository_unauthorized` — a target was resolved but it is not this
 *    delivery's. Reported before `draft` so a mismatched delivery is never
 *    described as "your draft" or "your disabled build": that would name the
 *    wrong repository and hide the real fix.
 * 4. `draft` — the target exists but is not promoted; §11.2's draft row.
 * 5. `build_disabled` — promoted and connected, but `build_enabled` is false:
 *    §11.2's "not enabled" row. Distinct from `draft` because the user has to do
 *    something else.
 *
 * Only then is the push admitted. The function never throws: every input is a
 * total boolean, so there is no unread-fact case here (§11.2's gate is about
 * facts the caller can always read from its own database, unlike §11.1's chain
 * and GitHub checks, where a failed read stays `unknown`).
 */
export function decideAdmission(facts: AdmissionFacts): AdmissionDecision {
  // 1. §11.2: the installation must be live before anything else it implies is
  //    worth explaining. Rule: an inactive installation outranks a draft.
  if (!facts.installationActive) {
    return skip(
      "installation_inactive",
      "the GitHub App installation for this repository is suspended or deleted; restore the installation first",
    );
  }

  // 2. Nothing was resolved at all. §11.2 keeps this distinct from the generic
  //    refusal: there is no target to describe and no installation to blame, so
  //    the only useful instruction is "connect the repository".
  if (!facts.projectExists && !facts.isDraft) {
    return skip(
      "no_project",
      "no TapeCI project or draft is connected to this repository branch",
    );
  }

  // 3. A target was resolved but it is not this delivery's repository through
  //    its installation. Naming it a draft or a disabled build would point the
  //    user at the wrong repository, so the mismatch is reported as itself.
  if (!facts.repositoryMatches) {
    return skip(
      "repository_unauthorized",
      "this delivery is not for the project's repository through its GitHub App installation",
    );
  }

  // 4. §11.2's draft row: nothing is deployed, no token, and the user finalises.
  if (!facts.projectExists) {
    return skip(
      "draft",
      "the repository is still a project draft; finalise the draft and enable builds first",
    );
  }

  // 5. §11.2's not-enabled row: finalised, but the switch is off.
  if (!facts.buildEnabled) {
    return skip(
      "build_disabled",
      "builds are not enabled for this project; enable builds in the project console first",
    );
  }

  return { admit: true };
}

function skip(reason: AdmissionSkipReason, detail: string): AdmissionDecision {
  return { admit: false, reason, detail };
}
