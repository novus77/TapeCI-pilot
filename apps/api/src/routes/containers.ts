import type { FastifyInstance } from "fastify";
import type { WalletClient } from "viem";
import { and, desc, eq } from "drizzle-orm";
import {
  auditEvents,
  containerEvents,
  containers,
  operatorSessions,
  projectMembers,
  projects,
} from "@tapeci/database";
import { XLAYER_MAINNET } from "@tapeci/config";
import { bindDecision, validateMonths, validateOnChainName } from "@tapeci/deployer";
import type { ReadClient } from "@tapeci/chain";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { recordBody } from "../validation.js";
import { resolveContainerOnChain } from "../container-resolver.js";
import { createOperatorClients } from "@tapeci/verifier";
import {
  bindCost,
  confirmBindSubmission,
  createChainBindingPort,
  findBindSubmission,
  listBindSubmissions,
  parseContainerAddress,
  projectBudgetCheck,
  recordBindSubmission,
  requireContainerBindingAccess,
  suggestedNameFor,
  type BindSubmission,
  type BindingChainPort,
  type BindingChainReads,
} from "../binding.js";
import { createWorkerRuntime } from "../worker/runtime.js";

/** Exact error body shapes are part of the contract (see report-2.md). */
function invalidName(reason: string): ApiError {
  return new ApiError(400, "INVALID_NAME", reason, { reason });
}

/**
 * Next action for a (name, container) pair. `bindDecision` reasons about one
 * paid-until timestamp, but `DomainBinding` keeps two windows: the name-level
 * `paidUntil(nameHash, container)` and the container-level `containerPaidUntil`.
 * The later of the two is what the gateway actually enforces, so it is the one
 * the decision must use — otherwise a container-wide activation would be
 * reported as "not live" and the operator would pay again.
 */
function bindDecisionFor(live: BindingChainReads, nowSeconds: number) {
  return bindDecision({
    isLive: live.isLive,
    isContainerLive: live.isContainerLive,
    paidUntil: Math.max(live.paidUntil, live.containerPaidUntil),
    nowSeconds,
  });
}

/** `uint40` unix seconds -> ISO string, or null when nothing was ever paid. */
function formatTimestamp(unixSeconds: number): string | null {
  return unixSeconds === 0 ? null : new Date(unixSeconds * 1000).toISOString();
}

function invalidMonths(reason: string): ApiError {
  return new ApiError(400, "INVALID_MONTHS", reason, { reason });
}

function defaultReadClient(): ReadClient {
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) throw new ApiError(500, "INTERNAL", "no RPC operator configured");
  return primary.client;
}

function readClientOf(deps: ApiDeps): ReadClient {
  return (deps.readClient ?? defaultReadClient)();
}

/**
 * Operator sender. The default is the same env-driven runtime the deploy worker
 * uses (operator key + write RPC); tests inject a local wallet or stub.
 */
function walletOf(deps: ApiDeps): () => WalletClient {
  const injected = deps.operatorWallet;
  if (injected !== undefined) {
    return () => {
      const wallet = injected();
      if (wallet === null) {
        throw new ApiError(503, "OPERATOR_UNAVAILABLE", "no operator wallet configured for the API");
      }
      // The worker runtime types its client structurally; viem's branded Client
      // type differs by declaration only, so this is the one unavoidable cast.
      return wallet as WalletClient;
    };
  }
  return () => {
    const runtime = createWorkerRuntime({ db: deps.db, env: deps.env });
    if (runtime.wallet === null) {
      throw new ApiError(503, "OPERATOR_UNAVAILABLE", "no operator private key configured for the API");
    }
    return runtime.wallet as WalletClient;
  };
}

function chainPort(deps: ApiDeps): BindingChainPort {
  return createChainBindingPort({ client: readClientOf(deps), wallet: walletOf(deps) });
}

export function registerContainerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/containers/:address", async (request) => {
    const user = requireUser(request);
    const params = request.params as { address?: string };
    const address = params.address?.toLowerCase();
    if (address === undefined || !/^0x[0-9a-f]{40}$/.test(address)) {
      throw new ApiError(400, "INVALID_PATH", "container address must be 0x + 40 hex");
    }
    const [row] = await deps.db
      .select({ container: containers })
      .from(containers)
      .innerJoin(projects, eq(projects.containerId, containers.id))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(and(eq(containers.containerAddress, address), eq(projectMembers.userId, user.id)))
      .limit(1);
    if (row === undefined) throw new ApiError(404, "CONTAINER_NOT_FOUND", "container not found");
    const resolveContainer =
      deps.resolveContainer ??
      ((input: `0x${string}`) => resolveContainerOnChain(input));
    const live = await resolveContainer(address as `0x${string}`);
    const sessions = await deps.db
      .select()
      .from(operatorSessions)
      .where(eq(operatorSessions.containerId, row.container.id))
      .orderBy(desc(operatorSessions.createdAt))
      .limit(20);
    return {
      container: {
        id: row.container.id,
        address: row.container.containerAddress,
        chainId: row.container.chainId,
        factory: live.factory,
        opener: live.opener,
        registry: live.registry,
        binding: live.binding,
        processorIndex: live.processorIndex,
        processor: live.processor,
        tokenId: live.tokenId,
        owner: live.owner,
        opened: live.opened,
        lastCheckedBlock: row.container.lastCheckedBlock,
        operatorSessions: sessions.map((session) => ({
          id: session.id,
          signerAddress: session.signerAddress,
          expiresAt: session.expiresAt.toISOString(),
          revokedAt: session.revokedAt?.toISOString() ?? null,
        })),
        riskNotice:
          "Sites are controlled by the current circuit holder. Transferring the NFT or revoking the operator stops further writes.",
        chain: XLAYER_MAINNET.name,
      },
    };
  });

  /** `name` is optional: without it the canonical suggested name is described. */
  app.get("/v1/containers/:address/binding", async (request) => {
    const user = requireUser(request);
    const params = request.params as { address?: string };
    const address = parseContainerAddress(params.address);
    const query = request.query as { name?: string };

    const access = await requireContainerBindingAccess(deps.db, address, user.id);
    const container = access.container;
    const suggestedName = suggestedNameFor(container);

    let name = suggestedName;
    if (query.name !== undefined && query.name !== "") {
      const requested = query.name.trim();
      const check = validateOnChainName(requested);
      if (!check.ok) throw invalidName(check.reason);
      name = requested;
    }

    const port = chainPort(deps);
    const live = await port.read(address, name);
    const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const decision = bindDecisionFor(live, nowSeconds);
    const state =
      decision === "ALREADY_LIVE" ? "ACTIVE" : decision === "RENEW" ? "EXPIRED" : "NOT_ACTIVATED";
    // `canWrite` echoes the authorization already enforced above; `writeBlockedReason`
    // explains a 403 to the console without calling the bind route.
    const writable = access.via === "project" || access.via === "wallet-owner";
    const paidUntil = formatTimestamp(live.paidUntil);
    const containerPaidUntil = formatTimestamp(live.containerPaidUntil);

    // `state: "pending"` marks a broadcast hash whose receipt is not known yet, so
    // a refresh keeps showing the attempt instead of losing it (§3.3).
    const submissions: readonly BindSubmission[] = await listBindSubmissions(deps.db, container.id, 10);
    const recentEvents = submissions.map((submission, index) => ({
      id: `${submission.txHash}:${String(index)}`,
      eventType: "bind",
      name: submission.name,
      months: submission.months,
      valueWei: submission.valueWei,
      txHash: submission.txHash,
      blockNumber: submission.blockNumber,
      gasUsed: submission.gasUsed,
      paidUntil: submission.paidUntil,
      state: submission.state,
      createdAt: submission.createdAt,
    }));
    // The newest attempt that has not confirmed yet: the console shows "pending"
    // for it and offers a re-check rather than a second send.
    const pendingSubmission =
      submissions.find((submission) => submission.state === "pending") ?? null;

    const binding = {
      containerAddress: address,
      bindingAddress: container.bindingAddress,
      name,
      suggestedName,
      state,
      isLive: live.isLive,
      isContainerLive: live.isContainerLive,
      paidUntil,
      containerPaidUntil,
      monthlyFeeWei: live.monthlyFeeWei.toString(),
      canWrite: writable,
      writeBlockedReason: writable
        ? null
        : "binding requires the maintainer or owner role on one of the container's projects",
      decision,
      nameRecorded: false,
      pendingSubmission,
      recentEvents,
    };
    // Both shapes: the contract fields at the top level, and the same object under
    // `binding` (what the console reads).
    return {
      name,
      isLive: live.isLive,
      isContainerLive: live.isContainerLive,
      paidUntil,
      containerPaidUntil,
      monthlyFeeWei: live.monthlyFeeWei.toString(),
      suggestedName,
      paidUntilUnix: live.paidUntil,
      containerPaidUntilUnix: live.containerPaidUntil,
      decision,
      binding,
      pendingSubmission,
      recentEvents,
    };
  });

  app.post("/v1/containers/:address/bind", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { address?: string };
    const address = parseContainerAddress(params.address);
    const body = recordBody(request.body);

    // Read the raw value (not `stringField`) so an empty/missing name is reported
    // as INVALID_NAME rather than the generic INVALID_BODY.
    const rawName = body.name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw invalidName("name is required (e.g. 10.2.4.tape)");
    }
    const name = rawName.trim();
    const nameCheck = validateOnChainName(name);
    if (!nameCheck.ok) throw invalidName(nameCheck.reason);

    const rawMonths = body.months;
    const months =
      typeof rawMonths === "number"
        ? rawMonths
        : typeof rawMonths === "string" && /^[0-9]+$/.test(rawMonths.trim())
          ? Number(rawMonths.trim())
          : Number.NaN;
    const monthsCheck = validateMonths(months);
    if (!monthsCheck.ok) throw invalidMonths(monthsCheck.reason);

    const access = await requireContainerBindingAccess(deps.db, address, user.id);
    const container = access.container;

    const port = chainPort(deps);
    // Re-read activation from the chain: the container row is never trusted here.
    const live: BindingChainReads = await port.read(address, name);
    const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const decision = bindDecisionFor(live, nowSeconds);
    if (decision === "ALREADY_LIVE") {
      throw new ApiError(409, "ALREADY_LIVE", `name ${name} is already live for this container`, {
        name,
        paidUntil: new Date(live.paidUntil * 1000).toISOString(),
        containerPaidUntil: new Date(live.containerPaidUntil * 1000).toISOString(),
      });
    }

    const valueWei = BigInt(months) * live.monthlyFeeWei;
    let estimatedGas: bigint;
    try {
      estimatedGas = await port.simulate({ name, container: address, months, valueWei });
    } catch (error) {
      const decoded = port.decodeRevert?.(error) ?? null;
      throw new ApiError(
        409,
        "BIND_REVERTED",
        decoded === null
          ? "the bind call reverted in simulation"
          : `the bind call reverted in simulation: ${decoded.reason}`,
        {
          name,
          months,
          valueWei: valueWei.toString(),
          ...(decoded === null ? {} : { revertsWith: decoded.reason }),
        },
      );
    }

    const client = (deps.readClient ?? defaultReadClient)();
    const gasPriceWei = await client.getGasPrice();
    const cost = bindCost({
      name,
      months,
      monthlyFeeWei: live.monthlyFeeWei,
      gasPriceWei,
      estimatedGas,
    });

    if (access.projectId !== null) {
      const budget = await projectBudgetCheck(deps, access.projectId, cost.estimatedCostWei);
      if (budget !== null && budget.exceeded) {
        throw new ApiError(409, "FEE_OVER_BUDGET", "the bind cost would exceed the project's monthly budget", {
          projectId: budget.projectId,
          spentThisMonthWei: budget.spentWei.toString(),
          requestedWei: budget.requestedWei.toString(),
          monthlyCapWei: budget.capWei.toString(),
        });
      }
    }

    // Order matters (§9.4): broadcast, persist the hash, and only then wait.
    // `port.broadcast` returns as soon as the node accepts the transaction, so a
    // crash or a receipt timeout after this line leaves a stored pending row
    // instead of losing the attempt entirely.
    const broadcast = await port.broadcast({
      name,
      container: address,
      months,
      valueWei,
      gas: estimatedGas,
    });

    await recordBindSubmission(deps.db, {
      container,
      name,
      months,
      valueWei,
      txHash: broadcast.txHash,
      createdByUserId: user.id,
      projectId: access.projectId,
    });

    // From here the wait only *updates* state. A timeout is "still pending", not
    // a failure: the caller gets 202 with the stored hash and may re-check.
    const receipt = await port.confirm(broadcast.txHash);
    if (receipt === null) {
      await writeBindAudit(deps, {
        request,
        user,
        access,
        address,
        container,
        name,
        months,
        valueWei,
        txHash: broadcast.txHash,
        decision,
        status: 202,
        paidUntil: null,
        blockNumber: null,
        gasUsed: null,
        outcome: "pending",
      });
      // 202: the hash is stored and the outcome is unknown, so this is not a
      // completed request and not a failure either.
      void reply.code(202);
      return {
        ok: true,
        state: "pending" as const,
        txHash: broadcast.txHash,
        blockNumber: null,
        paidUntil: null,
        gasUsed: null,
        name,
        months,
        valueWei: valueWei.toString(),
        message: "the bind transaction was broadcast; its receipt is not known yet",
      };
    }

    if (receipt.status !== "success") {
      // A mined revert proves the attempt failed, so the pending row is removed
      // rather than left claiming a live hash. `container_events` only allows
      // `event_type = 'bind'`, so there is no truthful row to keep for a revert.
      await deps.db.delete(containerEvents).where(eq(containerEvents.txHash, broadcast.txHash));
      throw new ApiError(409, "BIND_FAILED", "the bind transaction was mined but reverted", {
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber.toString(),
      });
    }

    // The receipt is success; the activation itself is read back, never assumed.
    let paidUntilUnix = live.paidUntil;
    try {
      const after = await port.read(address, name);
      paidUntilUnix = after.paidUntil;
    } catch {
      // An unreadable post-state must not hide the mined evidence: keep the pre-state.
    }
    const paidUntil = paidUntilUnix === 0 ? null : new Date(paidUntilUnix * 1000);

    await confirmBindSubmission(deps.db, {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      paidUntil,
    });
    await writeBindAudit(deps, {
      request,
      user,
      access,
      address,
      container,
      name,
      months,
      valueWei,
      txHash: receipt.txHash,
      decision,
      status: 200,
      paidUntil,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      outcome: "confirmed",
    });

    return {
      ok: true,
      state: "confirmed" as const,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber.toString(),
      paidUntil: paidUntil?.toISOString() ?? null,
      gasUsed: receipt.gasUsed.toString(),
      name,
      months,
      valueWei: valueWei.toString(),
    };
  });

  /**
   * Record a bind hash the *user's own wallet* broadcast (§3.3 / §9.4).
   *
   * The direct-wallet path in `bind-name-form.tsx` signs in the browser, so the
   * server never sees the hash. Without this route the bind leaves no
   * `container_events` row: the console cannot show pending/confirmed and a
   * refresh loses the state. Registration is deliberately not confirmation —
   * the receipt is read here, but a hash the caller supplies never by itself
   * marks the name live.
   */
  app.post("/v1/containers/:address/bind/submissions", async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { address?: string };
    const address = parseContainerAddress(params.address);
    const body = recordBody(request.body);

    const rawHash = body.txHash;
    const txHash = typeof rawHash === "string" ? rawHash.trim().toLowerCase() : "";
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      throw new ApiError(400, "INVALID_BODY", "txHash must be 0x + 64 hex characters");
    }

    const rawName = body.name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw invalidName("name is required (e.g. 10.2.4.tape)");
    }
    const name = rawName.trim();
    const nameCheck = validateOnChainName(name);
    if (!nameCheck.ok) throw invalidName(nameCheck.reason);

    const rawMonths = body.months;
    const months =
      typeof rawMonths === "number"
        ? rawMonths
        : typeof rawMonths === "string" && /^[0-9]+$/.test(rawMonths.trim())
          ? Number(rawMonths.trim())
          : Number.NaN;
    const monthsCheck = validateMonths(months);
    if (!monthsCheck.ok) throw invalidMonths(monthsCheck.reason);

    const access = await requireContainerBindingAccess(deps.db, address, user.id);
    const container = access.container;

    // A hash already attributed to a different name/container is never
    // re-attributed: that would let a historical transaction be claimed as this
    // attempt's payment.
    const existing = await findBindSubmission(deps.db, txHash as `0x${string}`);
    if (existing !== null) {
      if (existing.name !== name) {
        throw new ApiError(
          409,
          "TRANSACTION_MISMATCH",
          "this transaction hash is already recorded for a different name",
          { txHash, recordedName: existing.name, requestedName: name },
        );
      }
      // A recorded hash is idempotent for the *record*, but its state may have
      // advanced since (a pending hash can be mined later). Re-confirm instead of
      // replaying a stale "pending", otherwise a refresh can never see it land.
      if (existing.state === "pending") {
        const retryReceipt = await chainPort(deps).confirm(txHash as `0x${string}`);
        if (retryReceipt !== null && retryReceipt.status === "success") {
          // Read the post-state rather than assuming the stored value.
          let paidUntilUnix = 0;
          try {
            paidUntilUnix = (await chainPort(deps).read(address, name)).paidUntil;
          } catch {
            // An unreadable post-state must not hide the mined evidence.
          }
          await confirmBindSubmission(deps.db, {
            txHash: txHash as `0x${string}`,
            blockNumber: retryReceipt.blockNumber,
            gasUsed: retryReceipt.gasUsed,
            paidUntil: paidUntilUnix === 0 ? null : new Date(paidUntilUnix * 1000),
          });
          const refreshed = await findBindSubmission(deps.db, txHash as `0x${string}`);
          return { ok: true, state: "confirmed", submission: refreshed, duplicate: true };
        }
      }
      return { ok: true, state: existing.state, submission: existing, duplicate: true };
    }

    const port = chainPort(deps);
    // The value is derived from the live fee, exactly like the operator path, so
    // the stored intent matches what the wallet should have sent.
    const live = await port.read(address, name);
    const valueWei = BigInt(months) * live.monthlyFeeWei;

    const recorded = await recordBindSubmission(deps.db, {
      container,
      name,
      months,
      valueWei,
      txHash: txHash as `0x${string}`,
      createdByUserId: user.id,
      projectId: access.projectId,
    });

    // The receipt is read immediately so the common case (the wallet already
    // mined it) reports `confirmed`; a timeout leaves the row pending, which is
    // the recoverable state §3.3 requires.
    const receipt = await port.confirm(txHash as `0x${string}`);
    if (receipt === null) {
      // 202: the hash is stored but the outcome is unknown — accepted, not complete.
      void reply.code(202);
      return {
        ok: true,
        state: "pending" as const,
        submission: recorded.submission,
        duplicate: !recorded.inserted,
        message: "the hash is recorded; its receipt is not known yet",
      };
    }
    if (receipt.status !== "success") {
      await deps.db.delete(containerEvents).where(eq(containerEvents.txHash, txHash));
      throw new ApiError(409, "BIND_FAILED", "the bind transaction was mined but reverted", {
        txHash,
        blockNumber: receipt.blockNumber.toString(),
      });
    }
    let paidUntilUnix = live.paidUntil;
    try {
      const after = await port.read(address, name);
      paidUntilUnix = after.paidUntil;
    } catch {
      // Unreadable post-state: keep the pre-state rather than inventing one.
    }
    const paidUntil = paidUntilUnix === 0 ? null : new Date(paidUntilUnix * 1000);
    await confirmBindSubmission(deps.db, {
      txHash: txHash as `0x${string}`,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      paidUntil,
    });
    return {
      ok: true,
      state: "confirmed" as const,
      submission: {
        ...recorded.submission,
        state: "confirmed" as const,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        paidUntil: paidUntil?.toISOString() ?? null,
      },
      duplicate: !recorded.inserted,
    };
  });
}

/**
 * One audit row per bind outcome. The operator path and the direct-wallet path
 * share it so both leave the same evidence, and a pending attempt is recorded
 * with the `submitted` outcome instead of disappearing.
 */
async function writeBindAudit(
  deps: ApiDeps,
  input: {
    readonly request: { readonly id: string; readonly ip: string; readonly headers: Record<string, unknown> };
    readonly user: { readonly id: string; readonly githubLogin: string };
    readonly access: { readonly projectId: string | null; readonly via: "project" | "wallet-owner" };
    readonly address: string;
    readonly container: { readonly bindingAddress: string };
    readonly name: string;
    readonly months: number;
    readonly valueWei: bigint;
    readonly txHash: string;
    readonly decision: string;
    readonly status: number;
    readonly paidUntil: Date | null;
    readonly blockNumber: string | null;
    readonly gasUsed: string | null;
    readonly outcome: "pending" | "confirmed";
  },
): Promise<void> {
  const userAgent = input.request.headers["user-agent"];
  await deps.db.insert(auditEvents).values({
    event: "container.bind",
    actorUserId: input.user.id,
    githubLogin: input.user.githubLogin,
    method: "POST",
    route: "/v1/containers/:address/bind",
    path: `/v1/containers/${input.address}/bind`,
    status: input.status,
    ip: input.request.ip,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 200) : null,
    requestId: input.request.id,
    projectId: input.access.projectId,
    organizationId: null,
    metadata: {
      containerAddress: input.address,
      bindingAddress: input.container.bindingAddress,
      name: input.name,
      months: input.months,
      valueWei: input.valueWei.toString(),
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      gasUsed: input.gasUsed,
      paidUntil: input.paidUntil?.toISOString() ?? null,
      via: input.access.via,
      decision: input.decision,
      outcome: input.outcome,
    },
  });
}
