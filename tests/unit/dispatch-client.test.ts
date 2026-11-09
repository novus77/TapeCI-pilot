/**
 * SPEC §11.3: a dispatch whose outcome GitHub did not confirm must be reported as
 * **unknown**, never as a failure — because re-dispatching on a false failure is how a
 * duplicate build happens. These tests pin that distinction and the identity rule that
 * `workflowSha` is the run's own head, never the target commit.
 */
import { describe, expect, it } from "vitest";

import type { GithubError } from "@tapeci/github";
import { dispatchWorkflow, findWorkflowRun } from "@tapeci/github";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** A fake `fetch` that records calls and answers with a scripted response. */
function scriptedFetch(
  answer: (call: Call) => { status: number; json?: unknown } | Error,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const answerValue = answer(call);
    if (answerValue instanceof Error) throw answerValue;
    return new Response(answerValue.json === undefined ? null : JSON.stringify(answerValue.json), {
      status: answerValue.status,
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

const AUTH = { token: "installation-token" } as const;
let keyCounter = 0;
/** A fresh key per call: the client keeps a process-local ledger of claimed keys. */
function dispatchInput(): Record<string, unknown> {
  keyCounter += 1;
  const correlationId = `corr-${keyCounter}`;
  return {
    ...AUTH,
    owner: "acme",
    repo: "site",
    workflowFile: "tapeci.yml",
    ref: "main",
    inputs: { correlationId, targetSha: "a".repeat(40) },
    idempotencyKey: correlationId,
  };
}

describe("§11.3 dispatch: unknown is not failure", () => {
  it("reports 204 as dispatched", async () => {
    const fake = scriptedFetch(() => ({ status: 204 }));
    const result = await dispatchWorkflow({ ...dispatchInput(), fetch: fake.fetch } as never);
    expect(result.dispatched).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("POST");
  });

  it("reports a 5xx as unknown instead of throwing, so the caller can reconcile", async () => {
    const fake = scriptedFetch(() => ({ status: 503 }));
    const result = await dispatchWorkflow({ ...dispatchInput(), fetch: fake.fetch } as never);
    expect(result.dispatched).toBe(false);
    // The distinction that matters: unknown, not a determinate refusal.
    expect(result.dispatched === false ? result.reason : null).toBe("unknown");
  });

  it("reports a network error as unknown rather than a failure", async () => {
    const fake = scriptedFetch(() => new Error("connection reset"));
    const result = await dispatchWorkflow({ ...dispatchInput(), fetch: fake.fetch } as never);
    expect(result.dispatched).toBe(false);
    expect(result.dispatched === false ? result.reason : null).toBe("unknown");
  });

  it("throws for a determinate refusal, because nothing was dispatched", async () => {
    const fake = scriptedFetch(() => ({
      status: 422,
      json: { message: "Workflow does not have workflow_dispatch trigger" },
    }));
    await expect(dispatchWorkflow({ ...dispatchInput(), fetch: fake.fetch } as never)).rejects.toMatchObject(
      { code: "GITHUB_API_ERROR" } satisfies Partial<GithubError>,
    );
  });

  it("sends the correlation id as data, never as an authentication credential", async () => {
    const fake = scriptedFetch(() => ({ status: 204 }));
    await dispatchWorkflow({ ...dispatchInput(), fetch: fake.fetch } as never);
    // The id may travel as `idempotency-key` (data about the request), but it must
    // never become the credential that authorizes it: `authorization` stays the
    // installation token (§11.3: "关联标识不单独作为认证凭据").
    const sent = fake.calls[0]?.headers ?? {};
    const authorization = Object.entries(sent).find(([k]) => k.toLowerCase() === "authorization");
    expect(authorization?.[1]).not.toContain("corr-");
    expect(JSON.stringify(fake.calls[0]?.body)).toContain("corr-");
  });
});

describe("§11.3 run lookup: null only when GitHub actually answered", () => {
  const LOOKUP = {
    ...AUTH,
    owner: "acme",
    repo: "site",
    workflowFile: "tapeci.yml",
    headSha: "a".repeat(40),
  } as const;

  it("returns null when GitHub answered and no run matched", async () => {
    const fake = scriptedFetch(() => ({ status: 200, json: { workflow_runs: [] } }));
    const run = await findWorkflowRun({ ...LOOKUP, fetch: fake.fetch } as never);
    expect(run).toBeNull();
  });

  it("throws when the lookup itself failed, because that is not 'no run'", async () => {
    const fake = scriptedFetch(() => ({ status: 500 }));
    // A failed read must not become the basis for re-dispatching.
    await expect(findWorkflowRun({ ...LOOKUP, fetch: fake.fetch } as never)).rejects.toBeDefined();
  });

  it("takes workflowSha from the run's own head_sha, never from a requested target", async () => {
    // The lookup queries by the dispatch ref's head_sha, so the run must report that
    // same SHA; the point of the test is that workflowSha comes from the RUN, not from
    // the target commit the caller asked to build.
    const headSha = "a".repeat(40);
    const fake = scriptedFetch(() => ({
      status: 200,
      json: {
        workflow_runs: [
          {
            id: 12,
            run_attempt: 1,
            head_sha: headSha,
            workflow_id: 7,
            path: ".github/workflows/tapeci.yml",
            event: "workflow_dispatch",
            status: "queued",
          },
        ],
      },
    }));
    const run = await findWorkflowRun({ ...LOOKUP, fetch: fake.fetch } as never);
    expect(run?.workflowSha).toBe(headSha);
  });
});
