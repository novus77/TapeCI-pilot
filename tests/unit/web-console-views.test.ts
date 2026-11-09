import { describe, expect, it } from "vitest";
import { filterDeploymentSnapshot, deploymentActionContext } from "../../apps/web/lib/console-views.js";
import type { DeploymentState, DeploymentSummary } from "../../apps/web/lib/types.js";

const row = (id: string, state: DeploymentState) => ({ id, state, projectId: "p", commitSha: id, project: null, triggerKind: "manual" }) as DeploymentSummary;

describe("console snapshot views", () => {
  const deployments = [row("latest", "AWAITING_APPROVAL"), row("failed", "VERIFY_FAILED"), row("old-live", "LIVE"), row("older-live", "LIVE"), row("canceled", "CANCELED")];
  it("uses the same attention collection for the counter and linked view", () => {
    expect(filterDeploymentSnapshot(deployments, { scope: "attention" }).map(d => d.id)).toEqual(["failed", "canceled"]);
  });
  it("counts completed deployments without implying unique current projects", () => {
    expect(filterDeploymentSnapshot(deployments, { scope: "completed" }).map(d => d.id)).toEqual(["old-live", "older-live"]);
  });
  it("intersects snapshot scope, raw state and fetched-record search", () => {
    expect(filterDeploymentSnapshot(deployments, { scope: "attention", state: "VERIFY_FAILED", q: "FAIL" }).map(d => d.id)).toEqual(["failed"]);
    expect(filterDeploymentSnapshot(deployments, { scope: "attention", state: "LIVE" })).toEqual([]);
  });
  it("keeps approvals separate from failures", () => {
    expect(filterDeploymentSnapshot(deployments, { scope: "approval" }).map(d => d.id)).toEqual(["latest"]);
  });
});

describe("contextual deployment actions", () => {
  it("does not require a wallet for a completed release or execution", () => {
    expect(deploymentActionContext("LIVE")).toMatchObject({ approve: false, execute: false, rollback: true });
    expect(deploymentActionContext("APPROVED")).toMatchObject({ approve: false, execute: true, rollback: false });
  });
  it("retains wallet and manual approval in both original approval states", () => {
    for (const state of ["PLAN_READY", "AWAITING_APPROVAL"] as const) expect(deploymentActionContext(state).approve).toBe(true);
  });
  it("never offers an unconditional retry for failures", () => {
    expect(deploymentActionContext("RPC_DISAGREEMENT")).toMatchObject({ approve: false, execute: false, rollback: false });
  });
  it("exposes only the action relevant to each deployment state", () => {
    expect(deploymentActionContext("LIVE").active).toEqual(["rollback"]);
    expect(deploymentActionContext("APPROVED").active).toEqual(["execute"]);
    expect(deploymentActionContext("AWAITING_APPROVAL").active).toEqual(["approve"]);
    expect(deploymentActionContext("BUILD_FAILED").active).toEqual(["approve", "execute", "rollback"]);
  });
});
