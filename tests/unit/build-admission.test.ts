/**
 * §11.2 admission: a push is skipped — with a reason a human can act on — instead of
 * becoming a build the project never agreed to. The five reasons are distinct because
 * each names a different fix, and the precedence decides which message the user sees.
 */
import { describe, expect, it } from "vitest";

import {
  ADMISSION_SKIP_CODES,
  decideAdmission,
  type AdmissionFacts,
} from "../../apps/api/src/build-admission.js";

/** A push that should be admitted; each test overrides only the fact it is about. */
const ADMITTED: AdmissionFacts = {
  installationActive: true,
  repositoryMatches: true,
  projectExists: true,
  isDraft: false,
  buildEnabled: true,
};

describe("§11.2 admission gate", () => {
  it("admits a push only when every fact is satisfied", () => {
    expect(decideAdmission(ADMITTED)).toEqual({ admit: true });
  });

  it("skips a draft with its own reason, distinct from a disabled project", () => {
    const decision = decideAdmission({ ...ADMITTED, isDraft: true, projectExists: false });
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.reason).toBe("draft");
    expect(decision.detail.length).toBeGreaterThan(0);
  });

  it("skips a not-enabled project with build_disabled, not as a draft", () => {
    const decision = decideAdmission({ ...ADMITTED, buildEnabled: false });
    expect(decision.admit).toBe(false);
    if (decision.admit) return;
    expect(decision.reason).toBe("build_disabled");
  });

  it("keeps no_project separate from an unauthorized repository", () => {
    const none = decideAdmission({ ...ADMITTED, projectExists: false, isDraft: false });
    expect(none.admit).toBe(false);
    if (!none.admit) expect(none.reason).toBe("no_project");

    const foreign = decideAdmission({ ...ADMITTED, repositoryMatches: false });
    expect(foreign.admit).toBe(false);
    if (!foreign.admit) expect(foreign.reason).toBe("repository_unauthorized");
  });

  it("does not collapse the two 'no build' reasons into one webhook code", () => {
    // The stored code is what the UI shows, so the distinction has to survive.
    expect(ADMISSION_SKIP_CODES.draft).not.toBe(ADMISSION_SKIP_CODES.build_disabled);
    // `no_project` and a foreign repository share the historical code on purpose: from
    // the user's side both mean "this repository is not connected here".
    expect(ADMISSION_SKIP_CODES.no_project).toBe(ADMISSION_SKIP_CODES.repository_unauthorized);
  });

  it("ranks an inactive installation above every other reason", () => {
    // Even a draft or a disabled build cannot run, so pointing the user at the draft
    // first would send them to redo work that still cannot execute.
    for (const facts of [
      { ...ADMITTED, installationActive: false },
      { ...ADMITTED, installationActive: false, isDraft: true },
      { ...ADMITTED, installationActive: false, buildEnabled: false },
      { ...ADMITTED, installationActive: false, projectExists: false },
      { ...ADMITTED, installationActive: false, repositoryMatches: false },
    ]) {
      const decision = decideAdmission(facts);
      expect(decision.admit, JSON.stringify(facts)).toBe(false);
      if (!decision.admit) expect(decision.reason).toBe("installation_inactive");
    }
  });

  it("never reports a foreign delivery as the user's own draft", () => {
    const decision = decideAdmission({
      ...ADMITTED,
      repositoryMatches: false,
      isDraft: true,
      projectExists: false,
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toBe("repository_unauthorized");
  });

  it("always explains a skip", () => {
    for (const facts of [
      { ...ADMITTED, installationActive: false },
      { ...ADMITTED, projectExists: false },
      { ...ADMITTED, repositoryMatches: false },
      { ...ADMITTED, isDraft: true, projectExists: false },
      { ...ADMITTED, buildEnabled: false },
    ]) {
      const decision = decideAdmission(facts);
      if (decision.admit) continue;
      expect(decision.detail.trim().length, JSON.stringify(facts)).toBeGreaterThan(0);
    }
  });
});
