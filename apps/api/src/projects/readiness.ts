/**
 * Project build readiness — SPEC §11.1.
 *
 * A pure function over facts: the caller performs the database and RPC reads
 * and passes their outcome in. There is no DB, network or clock access here.
 *
 * §11.1 forbids a single `ready` boolean. Readiness is eight items, each with
 * one of three states and one of three stages, and three *separate* aggregates:
 *
 * - `canEnableBuild` — the configuration stage only. It must not require
 *   `build_enabled` to already be true: this aggregate is what turns it on.
 * - `canStartBuild`  — the configuration and build stages: enablement plus a
 *   legal target commit and a dispatchable workflow.
 * - `canPublish`     — the release stage only: owner, opened container and a
 *   verified static artifact. Paid publishing is refused while any of those is
 *   `unknown`; `null` is never counted as a pass.
 *
 * Two rules are easy to get wrong and are encoded below:
 * - `static_output` may legitimately be `unknown` before the first build. It is
 *   a release item only, so it must not block enabling or starting.
 * - a failed read is `unknown`, never `false`. In particular `opened: null`
 *   must not be rendered as "not opened" (the P1 rule).
 */

/** §11.1: pass/fail/unknown — every item AND the absence of an answer is one. */
export type ReadinessState = "pass" | "fail" | "unknown";

/** §11.1: the stage that owns an item; the aggregates are per stage. */
export type ReadinessStage = "configuration" | "build" | "release";

/** The eight items in the order §11.1 lists them. Runtime order for the API. */
export const READINESS_ITEM_IDS = [
  "repository_access",
  "installation_active",
  "build_config",
  "static_output",
  "resource_owner",
  "container_opened",
  "path_policy",
  "build_admission",
] as const;

/** §11.1's eight item ids, in the spec's order. */
export type ReadinessItemId = (typeof READINESS_ITEM_IDS)[number];

/**
 * §11.1: `resource_owner`/`container_opened` are the resource facts and
 * `static_output` is the artifact fact — all three gate paid publishing.
 * `path_policy` is chosen before the first build and belongs to configuration.
 * `build_admission` is the build-stage gate (enabled + legal commit + workflow).
 */
const STAGES = {
  repository_access: "configuration",
  installation_active: "configuration",
  build_config: "configuration",
  static_output: "release",
  resource_owner: "release",
  container_opened: "release",
  path_policy: "configuration",
  build_admission: "build",
} satisfies Record<ReadinessItemId, ReadinessStage>;

/** One §11.1 check. `reason` is `null` exactly when the state is `pass`. */
export interface ReadinessItem {
  readonly id: ReadinessItemId;
  readonly state: ReadinessState;
  readonly stage: ReadinessStage;
  readonly reason: string | null;
}

/** §11.1: three stage aggregates, never collapsed into one boolean. */
export interface Readiness {
  readonly items: readonly ReadinessItem[];
  readonly canEnableBuild: boolean;
  readonly canStartBuild: boolean;
  readonly canPublish: boolean;
}

/**
 * The facts readiness is evaluated from.
 *
 * Every `boolean | null` follows the verified-read convention: `true`/`false`
 * only when the read actually produced an answer, `null` when it could not be
 * read. `null` must never be folded into `false`.
 */
export interface ReadinessInput {
  /** GitHub App can read the selected repository. */
  readonly repositoryAccess: boolean | null;
  /** The GitHub App installation exists and is not suspended. */
  readonly installationActive: boolean | null;
  /** Install/build/output commands are filled in and parse. */
  readonly buildConfigComplete: boolean;
  /** A publishable static artifact was observed; `null` = not observed yet. */
  readonly staticOutputObserved: boolean | null;
  /**
   * Is a BUILT artifact actually bound to a build attempt? §11.1's publish gate
   * needs this: `static_output` observed only says the output directory existed, not
   * that a release artifact is recorded for the attempt being published (issue
   * P4-05). Required, so a caller cannot publish without answering it.
   */
  readonly artifactBound: boolean;
  /** The container's current owner matches the project owner. */
  readonly ownerMatches: boolean | null;
  /** Chain read of the open flag; `null` = read unavailable, never `false`. */
  readonly containerOpened: boolean | null;
  /** §11.1: `versioned` by default; `root` only after acknowledgement. */
  readonly pathMode: "versioned" | "root";
  /** The user explicitly acknowledged root mode's overwrite/rollback difference. */
  readonly rootPathAcknowledged: boolean;
  /** `build_enabled` fact supplied by the caller (the column is added later). */
  readonly buildEnabled: boolean;
  /** The selected target commit is a legal full SHA on the selected branch. */
  readonly targetCommitLegal: boolean;
  /** The build workflow exists and is dispatchable; `null` = not checked yet. */
  readonly workflowAvailable: boolean | null;
}

/**
 * §11.1's eight checks as `pass`/`fail`/`unknown`.
 *
 * `canEnableBuild` reads only `configuration` items, so an unbuilt project (or
 * one whose build is disabled) can still be enabled. `canStartBuild` adds the
 * `build` stage. `canPublish` reads only `release` items, so a `null` static
 * output, an unreadable container or a stale owner blocks publishing without
 * blocking the first build.
 */
export function evaluateReadiness(input: ReadinessInput): Readiness {
  const items: readonly ReadinessItem[] = [
    flagItem(
      "repository_access",
      input.repositoryAccess,
      "the GitHub App cannot read the selected repository",
      "repository access could not be checked",
    ),
    flagItem(
      "installation_active",
      input.installationActive,
      "the GitHub App installation is not active",
      "the GitHub App installation state could not be read",
    ),
    input.buildConfigComplete
      ? item("build_config", "pass", null)
      : item("build_config", "fail", "install, build and output configuration is incomplete"),
    // §11.1: `static_output` may be unknown before the first build. It is a
    // release item only; the configuration/build aggregates below never read it.
    flagItem(
      "static_output",
      input.staticOutputObserved,
      "the observed static output is not publishable",
      "no static output has been observed yet",
    ),
    flagItem(
      "resource_owner",
      input.ownerMatches,
      "the container owner does not match the project owner",
      "the container owner could not be verified",
    ),
    // §11.1 / P1: `opened: null` is an unread fact. `flagItem` maps it to
    // `unknown`; only an actual `false` read means "not opened".
    flagItem(
      "container_opened",
      input.containerOpened,
      "the container is not opened",
      "the container open flag could not be read",
    ),
    pathPolicyItem(input),
    buildAdmissionItem(input),
  ];

  // §11.1: canEnableBuild requires only the configuration stage. Requiring
  // `buildEnabled` here would be circular — this aggregate is what enables it.
  const canEnableBuild = everyStagePasses(items, "configuration");

  // §11.1: starting additionally requires the build stage, i.e. an enabled
  // project with a legal target commit and a dispatchable workflow.
  const canStartBuild = canEnableBuild && everyStagePasses(items, "build");

  // §11.1: paid publishing requires every release-stage item to be `pass`.
  // A `null`/`unknown` never counts as a pass, so a failed container read, an
  // unverified owner or an unbuilt artifact cannot be paid-published.
  //
  // The stage items alone are not enough: `static_output` observed only says the
  // output directory existed. Publishing also demands that a BUILT artifact is
  // bound to the attempt being published (issue P4-05, §11.3 "artifact 绑定同一个
  // attempt"). That is a separate fact this function cannot infer, so the caller
  // must supply it and it is ANDed in here rather than trusted separately.
  const canPublish = everyStagePasses(items, "release") && input.artifactBound;

  return { items, canEnableBuild, canStartBuild, canPublish };
}

function item(
  id: ReadinessItemId,
  state: ReadinessState,
  reason: string | null,
): ReadinessItem {
  return { id, state, stage: STAGES[id], reason };
}

/**
 * The verified-read mapping shared by the five boolean facts: `null` is
 * `unknown` (the read produced no answer), `false` is a real `fail`. §11.1's
 * release rule is why an `unknown` must not be promoted to `pass`.
 */
function flagItem(
  id: ReadinessItemId,
  value: boolean | null,
  failReason: string,
  unknownReason: string,
): ReadinessItem {
  if (value === null) return item(id, "unknown", unknownReason);
  if (!value) return item(id, "fail", failReason);
  return item(id, "pass", null);
}

/**
 * §11.1: `pathMode` defaults to `versioned`; `root` is only allowed after the
 * user has read the overwrite/rollback difference. A missing acknowledgement is
 * a refusal (`fail`), not an unread fact (`unknown`), because the input is
 * known and the answer is "not accepted".
 */
function pathPolicyItem(input: ReadinessInput): ReadinessItem {
  if (input.pathMode === "versioned") return item("path_policy", "pass", null);
  if (input.rootPathAcknowledged) return item("path_policy", "pass", null);
  return item(
    "path_policy",
    "fail",
    "root path mode requires an explicit acknowledgement of the overwrite and rollback differences",
  );
}

/**
 * §11.1/§11.2: a build is admitted only when it is enabled, its target commit
 * is legal, and the workflow that will run it is dispatchable. Before enabling,
 * this item legitimately reads `fail` with the reason "build is not enabled";
 * `canEnableBuild` does not consult it.
 */
function buildAdmissionItem(input: ReadinessInput): ReadinessItem {
  if (!input.buildEnabled) return item("build_admission", "fail", "build is not enabled");
  if (!input.targetCommitLegal) {
    return item(
      "build_admission",
      "fail",
      "the target commit is not a legal full SHA on the selected repository and branch",
    );
  }
  if (input.workflowAvailable === null) {
    return item("build_admission", "unknown", "the build workflow has not been checked yet");
  }
  if (!input.workflowAvailable) {
    return item("build_admission", "fail", "the build workflow is not available for dispatch");
  }
  return item("build_admission", "pass", null);
}

/** A stage passes only when every item in it is `pass`; `unknown` is not a pass. */
function everyStagePasses(items: readonly ReadinessItem[], stage: ReadinessStage): boolean {
  return items.every((entry) => entry.stage !== stage || entry.state === "pass");
}
