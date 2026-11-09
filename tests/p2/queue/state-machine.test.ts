import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  DEPLOYMENT_STATES,
  TERMINAL_STATES,
  allowedTransitions,
  canTransition,
  getDeployment,
  isTerminalState,
  listDeploymentEvents,
  transitionDeployment,
  type Database,
} from "@tapeci/queue";
import {
  detectServices,
  seedDeployment,
  seedDeploymentRow,
  setupTestDatabase,
  type TestDatabaseHandle,
} from "./helpers.js";

const services = await detectServices();
const describeDb = services.database ? describe : describe.skip;

describeDb("deployment state machine (PostgreSQL CAS)", () => {
  let handle: TestDatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
  });

  function db(): Database {
    if (handle === undefined) throw new Error("test database is not ready");
    return handle.db;
  }

  it("applies an allowed transition and appends exactly one event", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });

    const updated = await transitionDeployment(db(), {
      deploymentId: seed.deploymentId,
      expectedVersion: 0,
      toState: "BUILDING",
      eventType: "worker.plan.build_started",
      actorKind: "worker",
      actorId: "plan-worker",
      payload: { commitSha: seed.commitSha },
    });

    expect(updated.state).toBe("BUILDING");
    expect(updated.stateVersion).toBe(1);
    expect(updated.startedAt).not.toBeNull();
    expect(updated.finishedAt).toBeNull();
    expect(updated.errorCode).toBeNull();

    const events = await listDeploymentEvents(db(), seed.deploymentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      oldState: "RECEIVED",
      newState: "BUILDING",
      eventType: "worker.plan.build_started",
      actorKind: "worker",
      actorId: "plan-worker",
      payload: { commitSha: seed.commitSha },
    });
  });

  it("rejects an invalid transition with a typed UPLOAD_CONFLICT and no event", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });

    await expect(
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 0,
        toState: "UPLOADING_ASSETS",
        eventType: "worker.deploy.started",
        actorKind: "worker",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" });

    const current = await getDeployment(db(), seed.deploymentId);
    expect(current?.state).toBe("RECEIVED");
    expect(current?.stateVersion).toBe(0);
    expect(await listDeploymentEvents(db(), seed.deploymentId)).toHaveLength(0);
  });

  it("rejects a stale expectedVersion with retryable PLAN_STALE", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });

    await expect(
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 7,
        toState: "BUILDING",
        eventType: "worker.plan.build_started",
        actorKind: "worker",
      }),
    ).rejects.toMatchObject({ code: "PLAN_STALE", retryable: true });

    const current = await getDeployment(db(), seed.deploymentId);
    expect(current?.state).toBe("RECEIVED");
  });

  it("lets exactly one of two concurrent CAS transitions win", async () => {
    const seed = await seedDeployment(db(), { state: "RECEIVED" });

    const results = await Promise.allSettled([
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 0,
        toState: "BUILDING",
        eventType: "worker.plan.build_started",
        actorKind: "worker",
        payload: { racer: 1 },
      }),
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 0,
        toState: "BUILDING",
        eventType: "worker.plan.build_started",
        actorKind: "worker",
        payload: { racer: 2 },
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0];
    if (rejection === undefined || rejection.status !== "rejected") {
      throw new Error("expected one rejected transition");
    }
    expect(rejection.reason).toMatchObject({ code: "PLAN_STALE" });

    const current = await getDeployment(db(), seed.deploymentId);
    expect(current?.state).toBe("BUILDING");
    expect(current?.stateVersion).toBe(1);
    expect(await listDeploymentEvents(db(), seed.deploymentId)).toHaveLength(1);
  });

  it("rejects any transition out of a terminal state", async () => {
    const seed = await seedDeployment(db(), { state: "LIVE" });

    await expect(
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 0,
        toState: "BUILDING",
        eventType: "system.force",
        actorKind: "system",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_CONFLICT",
      details: { reason: "terminal_state" },
    });

    const current = await getDeployment(db(), seed.deploymentId);
    expect(current?.state).toBe("LIVE");
  });

  it("never lets the state machine jump to LIVE before verification", async () => {
    const seed = await seedDeployment(db(), { state: "APPROVED" });
    await expect(
      transitionDeployment(db(), {
        deploymentId: seed.deploymentId,
        expectedVersion: 0,
        toState: "LIVE",
        eventType: "worker.deploy.succeeded",
        actorKind: "worker",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" });

    const sources = DEPLOYMENT_STATES.filter((state) => canTransition(state, "LIVE"));
    expect(sources).toEqual(["VERIFYING_RELEASE"]);
  });

  it("allows VERIFYING_RELEASE -> LIVE and sets finished_at", async () => {
    const seed = await seedDeployment(db(), { state: "VERIFYING_RELEASE" });
    const updated = await transitionDeployment(db(), {
      deploymentId: seed.deploymentId,
      expectedVersion: 0,
      toState: "LIVE",
      eventType: "worker.verify.release_live",
      actorKind: "worker",
    });
    expect(updated.state).toBe("LIVE");
    expect(updated.finishedAt).not.toBeNull();
    expect(isTerminalState(updated.state)).toBe(true);
  });

  it("records error code, error message and finished_at for error endpoints", async () => {
    const seed = await seedDeployment(db(), { state: "UPLOADING_ASSETS" });
    const updated = await transitionDeployment(db(), {
      deploymentId: seed.deploymentId,
      expectedVersion: 0,
      toState: "UPLOAD_INTERRUPTED",
      eventType: "worker.deploy.failed",
      actorKind: "worker",
      errorMessage: "RPC timeout after broadcast",
    });
    expect(updated.state).toBe("UPLOAD_INTERRUPTED");
    expect(updated.errorCode).toBe("UPLOAD_INTERRUPTED");
    expect(updated.errorMessage).toBe("RPC timeout after broadcast");
    expect(updated.finishedAt).not.toBeNull();
  });

  it("maps the one-chain-writer partial unique index to UPLOAD_CONFLICT", async () => {
    const first = await seedDeployment(db(), { state: "AWAITING_APPROVAL" });
    const second = await seedDeploymentRow(db(), {
      projectId: first.projectId,
      containerId: first.containerId,
      registryAddress: first.registryAddress,
      state: "AWAITING_APPROVAL",
    });

    await transitionDeployment(db(), {
      deploymentId: first.deploymentId,
      expectedVersion: 0,
      toState: "APPROVED",
      eventType: "user.approval.accepted",
      actorKind: "user",
    });

    await expect(
      transitionDeployment(db(), {
        deploymentId: second.deploymentId,
        expectedVersion: 0,
        toState: "APPROVED",
        eventType: "user.approval.accepted",
        actorKind: "user",
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_CONFLICT",
      details: { reason: "container_chain_writer_conflict" },
    });
  });

  it("exposes the PRD transition map and terminal-state set", () => {
    expect(allowedTransitions("RECEIVED")).toEqual(["BUILDING", "BUILD_FAILED", "CANCELED"]);
    expect(allowedTransitions("LIVE")).toEqual([]);
    expect(canTransition("APPROVED", "UPLOADING_ASSETS")).toBe(true);
    expect(canTransition("APPROVED", "VERIFYING_RELEASE")).toBe(false);
    expect(TERMINAL_STATES).toContain("UPLOAD_CONFLICT");
    expect(TERMINAL_STATES).toContain("CANCELED");
    for (const terminal of TERMINAL_STATES) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      expect(isTerminalState(terminal)).toBe(true);
    }
  });
});
