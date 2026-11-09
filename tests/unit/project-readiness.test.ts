/**
 * Readiness acceptance tests — SPEC §11.1, product-p4.md §1–§2, AC-P4-03/04/05/06/08.
 *
 * `evaluateReadiness` is a pure function over facts, so this is a pure unit
 * test: no DB, no network, no clock, no environment. The tables below are the
 * acceptance gate — a future edit that widens `canPublish`, lets a build-stage
 * fact leak into `canEnableBuild`, or turns a failed read into a `false` fact
 * has to break one of them.
 *
 * Cells where product-p4.md §1's gate lists and the implementation disagree are
 * labelled "DIVERGES F1…F4" in the test name on purpose: they pin the gate that
 * exists today and are listed with both readings in
 * `.superpowers/sdd/provisioning/test-p4a.md`. They are not silent.
 */
import { describe, expect, it } from "vitest";
import {
  READINESS_ITEM_IDS,
  evaluateReadiness,
  type Readiness,
  type ReadinessInput,
  type ReadinessItem,
  type ReadinessItemId,
  type ReadinessStage,
  type ReadinessState,
} from "../../apps/api/src/projects/readiness.js";

/** Every fact in its passing state; each test overrides only what it is about. */
const PASSING_FACTS: ReadinessInput = {
  repositoryAccess: true,
  installationActive: true,
  buildConfigComplete: true,
  staticOutputObserved: true,
  artifactBound: true,
  ownerMatches: true,
  containerOpened: true,
  pathMode: "versioned",
  rootPathAcknowledged: false,
  buildEnabled: true,
  targetCommitLegal: true,
  workflowAvailable: true,
};

const facts = (overrides: Partial<ReadinessInput> = {}): ReadinessInput => ({
  ...PASSING_FACTS,
  ...overrides,
});

const readiness = (overrides: Partial<ReadinessInput> = {}): Readiness => evaluateReadiness(facts(overrides));

function itemOf(result: Readiness, id: ReadinessItemId): ReadinessItem {
  const found = result.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`readiness item ${id} is missing from the payload`);
  return found;
}

const item = (overrides: Partial<ReadinessInput>, id: ReadinessItemId): ReadinessItem =>
  itemOf(readiness(overrides), id);

const nonPassIds = (result: Readiness): readonly ReadinessItemId[] =>
  result.items.filter((entry) => entry.state !== "pass").map((entry) => entry.id);

/**
 * The stage every item carries. dev-p4a.md §3 documents this map as the
 * implementation's own reading (SPEC §11.1 does not list a stage per item);
 * product-p4.md §1's table differs for `static_output`, `resource_owner` and
 * `build_admission` — that is finding F1, not an oversight here. The stage map
 * is load-bearing because the three aggregates are built from it, so pinning it
 * is what stops a relabelling from silently moving a gate.
 */
const STAGE_OF: Record<ReadinessItemId, ReadinessStage> = {
  repository_access: "configuration",
  installation_active: "configuration",
  build_config: "configuration",
  static_output: "release",
  resource_owner: "release",
  container_opened: "release",
  path_policy: "configuration",
  build_admission: "build",
};

describe("the two named traps", () => {
  it("AC-P4-04: static_output = unknown keeps canEnableBuild and canStartBuild true and blocks publishing", () => {
    const result = readiness({ staticOutputObserved: null });
    expect(result.canEnableBuild).toBe(true);
    expect(result.canStartBuild).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  it("AC-P4-04: static_output itself is the named blocker, unknown at the release stage", () => {
    const result = readiness({ staticOutputObserved: null });
    expect(nonPassIds(result)).toEqual(["static_output"]);
    expect(itemOf(result, "static_output")).toMatchObject({ state: "unknown", stage: "release" });
    expect(itemOf(result, "static_output").reason).toMatch(/observed/u);
  });

  it("AC-P4-03 (P4-02 trap): buildEnabled = false does not block canEnableBuild", () => {
    const result = readiness({ buildEnabled: false });
    expect(result.canEnableBuild).toBe(true);
    expect(result.canStartBuild).toBe(false);
    expect(itemOf(result, "build_admission")).toMatchObject({ state: "fail", stage: "build" });
    expect(itemOf(result, "build_admission").reason).toMatch(/enabled/u);
  });

  it("AC-P4-03: enabling changes canStartBuild only, and touches no configuration item", () => {
    const disabled = readiness({ buildEnabled: false });
    const enabled = readiness({ buildEnabled: true });
    expect(enabled.canEnableBuild).toBe(disabled.canEnableBuild);
    expect(disabled.canStartBuild).toBe(false);
    expect(enabled.canStartBuild).toBe(true);
    expect(enabled.canPublish).toBe(disabled.canPublish);
    const configurationStates = (result: Readiness) =>
      result.items.filter((entry) => entry.stage === "configuration").map((entry) => [entry.id, entry.state]);
    expect(configurationStates(enabled)).toEqual(configurationStates(disabled));
  });

  it("the enable switch and the target commit cannot leak into canEnableBuild", () => {
    const result = readiness({ buildEnabled: false, targetCommitLegal: false });
    expect(result.canEnableBuild).toBe(true);
    expect(result.canStartBuild).toBe(false);
  });
});

describe("canPublish is release-only (R5)", () => {
  it("R5: it does not require buildEnabled", () => {
    const result = readiness({ buildEnabled: false });
    expect(result.canPublish).toBe(true);
    expect(result.canStartBuild).toBe(false);
  });

  it("R5: it requires static_output to be a real pass", () => {
    expect(readiness().canPublish).toBe(true);
    expect(readiness({ staticOutputObserved: null }).canPublish).toBe(false);
    expect(readiness({ staticOutputObserved: false }).canPublish).toBe(false);
    expect(item({ staticOutputObserved: false }, "static_output").state).toBe("fail");
  });

  it("it also requires a verified owner and a readable, open container", () => {
    expect(readiness({ ownerMatches: null }).canPublish).toBe(false);
    expect(readiness({ ownerMatches: false }).canPublish).toBe(false);
    expect(readiness({ containerOpened: null }).canPublish).toBe(false);
    expect(readiness({ containerOpened: false }).canPublish).toBe(false);
    expect(item({ ownerMatches: null }, "resource_owner").state).toBe("unknown");
    expect(item({ containerOpened: null }, "container_opened").state).toBe("unknown");
  });
});

/**
 * The six nullable facts, each with the two verdicts that must never be
 * conflated: `null` is an unread fact (`unknown`), `false` is a real negative
 * (`fail`). `build_admission`'s `unread` case needs the enabled + legal facts
 * that precede it, which PASSING_FACTS supplies.
 */
const NULLABLE_FACTS = [
  { id: "repository_access", unread: { repositoryAccess: null }, denied: { repositoryAccess: false } },
  { id: "installation_active", unread: { installationActive: null }, denied: { installationActive: false } },
  { id: "static_output", unread: { staticOutputObserved: null }, denied: { staticOutputObserved: false } },
  { id: "resource_owner", unread: { ownerMatches: null }, denied: { ownerMatches: false } },
  { id: "container_opened", unread: { containerOpened: null }, denied: { containerOpened: false } },
  { id: "build_admission", unread: { workflowAvailable: null }, denied: { workflowAvailable: false } },
] satisfies readonly {
  id: ReadinessItemId;
  unread: Partial<ReadinessInput>;
  denied: Partial<ReadinessInput>;
}[];

describe("an unread fact is unknown, never false (P1-07, AC-P4-05/06)", () => {
  it.each(NULLABLE_FACTS)("$id: null is unknown, false is fail, and the copy differs", ({ id, unread, denied }) => {
    const unreadItem = item(unread, id);
    const deniedItem = item(denied, id);
    expect(unreadItem.state, `${id} unread`).toBe("unknown");
    expect(deniedItem.state, `${id} denied`).toBe("fail");
    expect(unreadItem.reason, `${id} unread`).not.toBeNull();
    expect(deniedItem.reason, `${id} denied`).not.toBeNull();
    expect(unreadItem.reason, `${id} copy`).not.toBe(deniedItem.reason);
    expect(itemOf(readiness(), id)).toMatchObject({ state: "pass", reason: null });
  });

  it("P1-07: containerOpened = null blocks publishing only", () => {
    const result = readiness({ containerOpened: null });
    expect(itemOf(result, "container_opened")).toMatchObject({ state: "unknown", stage: "release" });
    expect(nonPassIds(result)).toEqual(["container_opened"]);
    expect(result.canEnableBuild).toBe(true);
    expect(result.canStartBuild).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  it("AC-P4-05: an unread configuration fact blocks enable and stays unknown", () => {
    const result = readiness({ repositoryAccess: null });
    expect(itemOf(result, "repository_access").state).toBe("unknown");
    expect(result.canEnableBuild).toBe(false);
    expect(result.canStartBuild).toBe(false);
  });
});

describe("path_policy: root needs an acknowledgement", () => {
  it("root without an acknowledgement is fail, not unknown", () => {
    const result = readiness({ pathMode: "root" });
    expect(itemOf(result, "path_policy")).toMatchObject({ state: "fail", stage: "configuration" });
    expect(itemOf(result, "path_policy").reason).toMatch(/acknowledgement/u);
    expect(result.canEnableBuild).toBe(false);
    expect(result.canStartBuild).toBe(false);
  });

  it("root with an acknowledgement passes, and versioned needs none", () => {
    expect(item({ pathMode: "root", rootPathAcknowledged: true }, "path_policy")).toMatchObject({
      state: "pass",
      reason: null,
    });
    expect(item({ pathMode: "versioned" }, "path_policy").state).toBe("pass");
    expect(item({ pathMode: "versioned", rootPathAcknowledged: true }, "path_policy").state).toBe("pass");
  });

  it("a refused acknowledgement is never reported as an unread fact", () => {
    for (const rootPathAcknowledged of [false, true]) {
      expect(item({ pathMode: "root", rootPathAcknowledged }, "path_policy").state).not.toBe("unknown");
    }
  });
});

describe("the eight items in the spec's order and stages", () => {
  it("returns exactly READINESS_ITEM_IDS, in that order", () => {
    expect(READINESS_ITEM_IDS).toHaveLength(8);
    expect(readiness().items.map((entry) => entry.id)).toEqual([...READINESS_ITEM_IDS]);
  });

  it("assigns every item the documented stage", () => {
    expect(readiness().items.map((entry) => [entry.id, entry.stage])).toEqual(
      READINESS_ITEM_IDS.map((id) => [id, STAGE_OF[id]]),
    );
  });

  it("is pure: the facts are not mutated and the verdict is stable", () => {
    const input = Object.freeze(facts());
    const first = evaluateReadiness(input);
    expect(evaluateReadiness(input)).toEqual(first);
    expect(input).toEqual(facts());
  });
});

/**
 * One representative fact per stage state, so the three aggregates can be
 * enumerated over every combination. `stage` is the gate axis here: an
 * aggregate passes only when every item in its stage passes, and `unknown` is
 * never a pass.
 */
const CONFIGURATION_STATE: Record<ReadinessState, Partial<ReadinessInput>> = {
  pass: {},
  fail: { buildConfigComplete: false },
  unknown: { repositoryAccess: null },
};
const BUILD_STATE: Record<ReadinessState, Partial<ReadinessInput>> = {
  pass: {},
  fail: { buildEnabled: false },
  unknown: { workflowAvailable: null },
};
const RELEASE_STATE: Record<ReadinessState, Partial<ReadinessInput>> = {
  pass: {},
  fail: { containerOpened: false },
  unknown: { staticOutputObserved: null },
};
const ITEM_STATES: readonly ReadinessState[] = ["pass", "fail", "unknown"];

const STAGE_COMBINATIONS = ITEM_STATES.flatMap((configuration) =>
  ITEM_STATES.flatMap((build) =>
    ITEM_STATES.map((release) => ({
      configuration,
      build,
      release,
      enable: configuration === "pass",
      start: configuration === "pass" && build === "pass",
      publish: release === "pass",
    })),
  ),
);

interface BlockerCase {
  readonly label: string;
  readonly override: Partial<ReadinessInput>;
  readonly item: ReadinessItemId | null;
  readonly state: ReadinessState | null;
  readonly enable: boolean;
  readonly start: boolean;
  readonly publish: boolean;
}

/**
 * Every row of the three gate truth tables: one row per fact that can block a
 * gate, plus the all-pass row. "DIVERGES" rows are the cells where
 * product-p4.md §1's item lists and this implementation disagree; the expected
 * values below are the implemented gate (F1–F4 in test-p4a.md carry both
 * readings, so a Product ruling changes these rows deliberately, not silently).
 */
const BLOCKER_CASES: readonly BlockerCase[] = [
  { label: "every fact passes", override: {}, item: null, state: null, enable: true, start: true, publish: true },
  {
    label: "repository_access fail blocks enable and start (DIVERGES F3: Product §1 also blocks publish)",
    override: { repositoryAccess: false },
    item: "repository_access",
    state: "fail",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "repository_access unknown fails closed at configuration (DIVERGES F3: Product §1 also blocks publish)",
    override: { repositoryAccess: null },
    item: "repository_access",
    state: "unknown",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "installation_active fail blocks enable and start (DIVERGES F3: Product §1 also blocks publish)",
    override: { installationActive: false },
    item: "installation_active",
    state: "fail",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "installation_active unknown blocks enable and start (DIVERGES F3: Product §1 also blocks publish)",
    override: { installationActive: null },
    item: "installation_active",
    state: "unknown",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "build_config fail blocks enable and start (DIVERGES F3: Product §1 also blocks publish)",
    override: { buildConfigComplete: false },
    item: "build_config",
    state: "fail",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "path_policy fail (root, no acknowledgement) blocks enable and start (DIVERGES F3)",
    override: { pathMode: "root" },
    item: "path_policy",
    state: "fail",
    enable: false,
    start: false,
    publish: true,
  },
  {
    label: "static_output unknown blocks publishing only",
    override: { staticOutputObserved: null },
    item: "static_output",
    state: "unknown",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "static_output fail blocks publishing only",
    override: { staticOutputObserved: false },
    item: "static_output",
    state: "fail",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "resource_owner unknown blocks publishing (DIVERGES F1/F4: Product §1 also blocks enable and start)",
    override: { ownerMatches: null },
    item: "resource_owner",
    state: "unknown",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "resource_owner fail blocks publishing (DIVERGES F1/F4: Product §1 also blocks enable and start)",
    override: { ownerMatches: false },
    item: "resource_owner",
    state: "fail",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "container_opened unknown blocks publishing only",
    override: { containerOpened: null },
    item: "container_opened",
    state: "unknown",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "container_opened fail blocks publishing only",
    override: { containerOpened: false },
    item: "container_opened",
    state: "fail",
    enable: true,
    start: true,
    publish: false,
  },
  {
    label: "buildEnabled = false blocks start only (the enable switch is not a readiness item)",
    override: { buildEnabled: false },
    item: "build_admission",
    state: "fail",
    enable: true,
    start: false,
    publish: true,
  },
  {
    label: "an illegal target commit blocks start only",
    override: { targetCommitLegal: false },
    item: "build_admission",
    state: "fail",
    enable: true,
    start: false,
    publish: true,
  },
  {
    label: "an unchecked workflow blocks start (DIVERGES F2/F3: Product §1 counts build_admission as configuration)",
    override: { workflowAvailable: null },
    item: "build_admission",
    state: "unknown",
    enable: true,
    start: false,
    publish: true,
  },
  {
    label: "an unavailable workflow blocks start (DIVERGES F2/F3: Product §1 counts build_admission as configuration)",
    override: { workflowAvailable: false },
    item: "build_admission",
    state: "fail",
    enable: true,
    start: false,
    publish: true,
  },
];

describe("the three aggregate truth tables", () => {
  it.each(STAGE_COMBINATIONS)(
    "configuration=$configuration build=$build release=$release",
    ({ configuration, build, release, enable, start, publish }) => {
      const result = readiness({
        ...CONFIGURATION_STATE[configuration],
        ...BUILD_STATE[build],
        ...RELEASE_STATE[release],
      });
      expect({
        enable: result.canEnableBuild,
        start: result.canStartBuild,
        publish: result.canPublish,
      }).toEqual({ enable, start, publish });
    },
  );

  it.each(BLOCKER_CASES)("$label", ({ override, item: id, state, enable, start, publish }) => {
    const result = readiness(override);
    expect({
      enable: result.canEnableBuild,
      start: result.canStartBuild,
      publish: result.canPublish,
    }).toEqual({ enable, start, publish });
    if (id !== null) {
      expect(itemOf(result, id).state, id).toBe(state);
      expect(nonPassIds(result), id).toContain(id);
    }
  });
});

/** The five facts that map one-to-one onto an item (admission composes three). */
const PURE_FLAG_ITEMS = [
  ["repository_access", "repositoryAccess"],
  ["installation_active", "installationActive"],
  ["static_output", "staticOutputObserved"],
  ["resource_owner", "ownerMatches"],
  ["container_opened", "containerOpened"],
] as const satisfies readonly (readonly [ReadinessItemId, keyof ReadinessInput])[];

/**
 * Checks the contract's invariants rather than restating a branch: eight items
 * in spec order, the documented stage, "reason is null exactly when pass", the
 * three aggregates as stage conjunctions (SPEC §11.1's "分开聚合"), and the five
 * verified-read flags (`null` never becomes `fail`, `false` never becomes
 * `unknown`).
 */
function violationsOf(input: ReadinessInput): string[] {
  const result = evaluateReadiness(input);
  const problems: string[] = [];
  if (result.items.map((entry) => entry.id).join(",") !== READINESS_ITEM_IDS.join(",")) {
    problems.push("items are not READINESS_ITEM_IDS in order");
  }
  for (const entry of result.items) {
    if (entry.stage !== STAGE_OF[entry.id]) problems.push(`${entry.id}: stage ${entry.stage}`);
    if (entry.state === "pass" && entry.reason !== null) problems.push(`${entry.id}: pass with a reason`);
    if (entry.state !== "pass" && entry.reason === null) problems.push(`${entry.id}: ${entry.state} without a reason`);
  }
  const stagePasses = (stage: ReadinessStage) =>
    result.items.every((entry) => entry.stage !== stage || entry.state === "pass");
  if (result.canEnableBuild !== stagePasses("configuration")) {
    problems.push("canEnableBuild is not the configuration conjunction");
  }
  if (result.canStartBuild !== (result.canEnableBuild && stagePasses("build"))) {
    problems.push("canStartBuild is not configuration plus build");
  }
  if (result.canPublish !== stagePasses("release")) problems.push("canPublish is not the release conjunction");
  for (const [id, flag] of PURE_FLAG_ITEMS) {
    const expected = input[flag] === null ? "unknown" : input[flag] ? "pass" : "fail";
    const actual = result.items.find((entry) => entry.id === id)?.state;
    if (actual !== expected) problems.push(`${id}: ${String(input[flag])} became ${String(actual)}`);
  }
  return problems;
}

/**
 * One override set per axis state, multiplied out. 3·3·2·3·3·3·3·2·2·3 = 17 496
 * inputs — every combination of the facts the module accepts, including all
 * three states of every nullable flag. (`build_config` has no `unknown` fact:
 * the column is non-null, so only `pass`/`fail` are expressible.)
 */
const OVERRIDE_AXES: readonly (readonly Partial<ReadinessInput>[])[] = [
  [{}, { repositoryAccess: false }, { repositoryAccess: null }],
  [{}, { installationActive: false }, { installationActive: null }],
  [{}, { buildConfigComplete: false }],
  [{}, { staticOutputObserved: false }, { staticOutputObserved: null }],
  [{}, { ownerMatches: false }, { ownerMatches: null }],
  [{}, { containerOpened: false }, { containerOpened: null }],
  [{}, { pathMode: "root" }, { pathMode: "root", rootPathAcknowledged: true }],
  [{}, { buildEnabled: false }],
  [{}, { targetCommitLegal: false }],
  [{}, { workflowAvailable: false }, { workflowAvailable: null }],
];

const EXHAUSTIVE_INPUTS = OVERRIDE_AXES.reduce<Partial<ReadinessInput>[]>(
  (rows, axis) => rows.flatMap((row) => axis.map((override) => ({ ...row, ...override }))),
  [{}],
);

describe("reason is null exactly when the state is pass", () => {
  it("holds for every fact combination the module accepts", () => {
    expect(EXHAUSTIVE_INPUTS).toHaveLength(17_496);
    const violations = EXHAUSTIVE_INPUTS.flatMap((override) => violationsOf(facts(override)));
    expect(violations).toEqual([]);
  });

  it("explains every non-pass item in a payload of unread and refused facts", () => {
    const result = readiness({
      repositoryAccess: null,
      installationActive: null,
      staticOutputObserved: null,
      ownerMatches: null,
      containerOpened: null,
      pathMode: "root",
      buildEnabled: false,
      workflowAvailable: null,
    });
    expect(nonPassIds(result)).toEqual([
      "repository_access",
      "installation_active",
      "static_output",
      "resource_owner",
      "container_opened",
      "path_policy",
      "build_admission",
    ]);
    expect(itemOf(result, "build_config")).toMatchObject({ state: "pass", reason: null });
    // A refused acknowledgement and a disabled build are knowable refusals: fail, not unknown.
    expect(itemOf(result, "path_policy")).toMatchObject({ state: "fail", stage: "configuration" });
    expect(itemOf(result, "build_admission")).toMatchObject({ state: "fail", stage: "build" });
    for (const entry of result.items) {
      if (entry.state === "pass") expect(entry.reason, entry.id).toBeNull();
      else expect(entry.reason, entry.id).toBeTruthy();
    }
  });
});

describe("publishing requires a bound artifact (issue P4-05)", () => {
  it("refuses to publish when no artifact is bound to the attempt", () => {
    // `static_output` observed only says the output directory existed. Publishing is
    // the paid action, so it must also know a BUILT artifact exists for this attempt.
    const readiness = evaluateReadiness({ ...PASSING_FACTS, artifactBound: false });
    expect(readiness.canPublish).toBe(false);
    // Enabling and starting are unaffected: the artifact fact is release-stage only.
    expect(readiness.canEnableBuild).toBe(true);
    expect(readiness.canStartBuild).toBe(true);
  });

  it("publishes only when the artifact is bound and every release fact passes", () => {
    expect(evaluateReadiness({ ...PASSING_FACTS, artifactBound: true }).canPublish).toBe(true);
    // Each release-stage fact still has to hold on its own.
    for (const override of [
      { staticOutputObserved: null },
      { staticOutputObserved: false },
      { ownerMatches: null },
      { ownerMatches: false },
      { containerOpened: null },
      { containerOpened: false },
    ] as const) {
      expect(
        evaluateReadiness({ ...PASSING_FACTS, artifactBound: true, ...override }).canPublish,
        `publish must stay blocked for ${JSON.stringify(override)}`,
      ).toBe(false);
    }
  });
});
