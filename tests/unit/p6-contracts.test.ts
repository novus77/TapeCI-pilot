/**
 * P6 pure contracts: the derived publication URL (SPEC §12.4) and the recovery
 * capability table (§12.2, §12.3).
 *
 * Both are pure functions precisely so these rules can be pinned without a database or
 * a network: the URL must never be attacker-chosen, and a capability must never be
 * granted that the server does not support.
 */
import { describe, expect, it } from "vitest";

import { derivePublicUrl, TAPEKIT_GATEWAY_HOST_SUFFIX } from "../../apps/api/src/publication.js";
import { recoveryCapability, type RecoveryFacts } from "../../apps/api/src/recovery.js";

describe("§12.4 public URL derivation", () => {
  it("derives the gateway URL from the bound protocol name", () => {
    // Evidence-backed mapping: the observed on-chain name 10.2.4.tape resolves on the
    // gateway as dashed labels.
    const derived = derivePublicUrl("10.2.4.tape", TAPEKIT_GATEWAY_HOST_SUFFIX);
    expect(derived).toEqual({ status: "derived", url: "https://10-2-4.tapekit.org/" });
  });

  it("refuses to invent a URL when no name is bound", () => {
    expect(derivePublicUrl(null, TAPEKIT_GATEWAY_HOST_SUFFIX)).toEqual({ status: "no-name" });
  });

  it("refuses when no gateway is configured, instead of guessing one", () => {
    expect(derivePublicUrl("10.2.4.tape", null)).toEqual({ status: "unconfigured" });
  });

  it("refuses a name that is not a protocol name", () => {
    // A name without the protocol suffix cannot be mapped; returning a URL for it would
    // be fabricating a site address.
    expect(derivePublicUrl("evil.example.com", TAPEKIT_GATEWAY_HOST_SUFFIX).status).not.toBe(
      "derived",
    );
    expect(derivePublicUrl("10.2.4.eth", TAPEKIT_GATEWAY_HOST_SUFFIX).status).not.toBe("derived");
  });

  it("refuses a bad gateway configuration rather than emitting a malformed host", () => {
    expect(derivePublicUrl("10.2.4.tape", "not a host").status).toBe("invalid-configuration");
  });

  it("cannot be steered by anything that looks like a URL in the name", () => {
    // The name is on-chain data, but treat it as hostile anyway: it must never become a
    // different origin.
    const derived = derivePublicUrl("https://evil.example/10.2.4.tape", TAPEKIT_GATEWAY_HOST_SUFFIX);
    expect(derived.status).not.toBe("derived");
  });
});

describe("§12.2/§12.3 recovery capability", () => {
  /** Facts for a deployment that genuinely can be resumed. */
  const RESUMABLE: RecoveryFacts = {
    state: "UPLOAD_INTERRUPTED",
    triggerKind: "webhook",
    plan: "present",
    context: "stored",
    approval: "active",
    journal: "verified",
    files: "partial",
    unresolvedWrites: 0,
  };

  it("allows resume only with a verified journal, a live approval and a stored plan", () => {
    expect(recoveryCapability(RESUMABLE).action).toBe("resume");
  });

  it("does not resume when the approval expired — the signature gate comes first", () => {
    const capability = recoveryCapability({ ...RESUMABLE, approval: "expired" });
    expect(capability.action).not.toBe("resume");
    // Reapproval is the honest action there, not a resume that skips the gate.
    expect(capability.action).toBe("reapproval");
  });

  it("resumes with outstanding writes only by reconciling them first", () => {
    // §12.3: resume 核对原 pending/receipt … 然后继续未完成写入. A pending write does not
    // block recovery, but it must be reconciled before anything new is written — so the
    // capability stays `resume` and the reason has to say so.
    const capability = recoveryCapability({ ...RESUMABLE, unresolvedWrites: 2 });
    expect(capability.action).toBe("resume");
    expect(capability.reason).toContain("2");
    expect(capability.reason.toLowerCase()).toContain("reconcil");
  });

  it("never offers a blanket resume for the fail-closed states §12.3 names", () => {
    // §12.3: VERIFY_FAILED / SWITCH_FAILED / RPC_DISAGREEMENT must not get a retry
    // button; the state machine decides, not the user's optimism.
    for (const state of ["VERIFY_FAILED", "SWITCH_FAILED", "RPC_DISAGREEMENT"]) {
      const capability = recoveryCapability({ ...RESUMABLE, state });
      expect(capability.action, state).toBe("none");
    }
  });

  it("grants nothing for a state it does not know", () => {
    // Deny by default: a new state must never inherit a working button.
    for (const state of ["SOMETHING_NEW", "", "upload_interrupted"]) {
      const capability = recoveryCapability({ ...RESUMABLE, state });
      expect(capability.action, state).toBe("none");
    }
  });

  it("explains every refusal", () => {
    for (const state of ["VERIFY_FAILED", "LIVE", "CANCELED", "UNKNOWN_STATE"]) {
      const capability = recoveryCapability({ ...RESUMABLE, state });
      expect(capability.reason.trim().length, state).toBeGreaterThan(0);
    }
  });
});
