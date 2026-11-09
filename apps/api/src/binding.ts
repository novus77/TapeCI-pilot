/**
 * DomainBinding API layer: live activation reads plus the operator-sent `bind`.
 *
 * Everything here is deliberately fail-closed:
 * - name/months rules come from `@tapeci/deployer`'s pure planner, so the API
 *   cannot accept a call the CLI/browser would refuse (or vice versa);
 * - `isLive` / `isContainerLive` / `paidUntil` / `containerPaidUntil` /
 *   `monthlyFee` are re-read from the chain on every request; nothing is trusted
 *   from the container row except the identity used to derive the name;
 * - the call is simulated with `eth_call` + `estimateGas` before anything is
 *   signed, so a revert is reported instead of spending gas;
 * - the project budget guard runs after the cost is known and before the send.
 */
import { keccak256, stringToBytes, type WalletClient } from "viem";
import { and, desc, eq } from "drizzle-orm";
import { bindingAbi, selectorOf, xLayerChain, type ReadClient } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { planBind } from "@tapeci/deployer";
import {
  containerEvents,
  containers,
  projectBudgets,
  projects,
  wallets,
  type Database,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { canWrite, projectAccess } from "./project-access.js";
import { monthlySpendWei } from "./routes/governance.js";

/** `bind(string name, address container, uint256 months)` — verified in P0-03. */
export const BIND_SELECTOR: Hex = selectorOf("bind(string,address,uint256)");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `:address` path parameter -> lowercase `0x…`, or a 400. */
export function parseContainerAddress(raw: string | undefined): Hex {
  const address = raw?.toLowerCase();
  if (address === undefined || !/^0x[0-9a-f]{40}$/.test(address)) {
    throw new ApiError(400, "INVALID_PATH", "container address must be 0x + 40 hex");
  }
  return address as Hex;
}

/** `bytes32` name hash used by `paidUntil(nameHash, container)`. */
export function nameHashOf(name: string): Hex {
  return keccak256(stringToBytes(name));
}

/**
 * Canonical TapeKit name for a container: `<tokenId>.<area>.<processorIndex>.tape`
 * (area 2 on X Layer). Derived only from the container row, never from input.
 */
export function suggestedNameFor(container: {
  readonly tokenId: string;
  readonly processorIndex: number;
}): string {
  return `${container.tokenId}.${XLAYER_MAINNET.area}.${container.processorIndex}.tape`;
}

export interface BindingChainReads {
  readonly isLive: boolean;
  readonly isContainerLive: boolean;
  /** `paidUntil(nameHash, container)` in unix seconds (0 when never paid). */
  readonly paidUntil: number;
  /** `containerPaidUntil(container)` in unix seconds. */
  readonly containerPaidUntil: number;
  readonly monthlyFeeWei: bigint;
}

/** Live state of one container's activation (view calls only). */
export async function readBindingState(
  client: ReadClient,
  container: Hex,
  name: string,
): Promise<BindingChainReads> {
  const binding = XLAYER_MAINNET.binding;
  const [isLive, isContainerLive, paidUntil, containerPaidUntil, monthlyFeeWei] = await Promise.all([
    client.readContract({
      address: binding,
      abi: bindingAbi,
      functionName: "isLive",
      args: [name, container],
    }),
    client.readContract({
      address: binding,
      abi: bindingAbi,
      functionName: "isContainerLive",
      args: [container],
    }),
    client.readContract({
      address: binding,
      abi: bindingAbi,
      functionName: "paidUntil",
      args: [nameHashOf(name), container],
    }),
    client.readContract({
      address: binding,
      abi: bindingAbi,
      functionName: "containerPaidUntil",
      args: [container],
    }),
    client.readContract({ address: binding, abi: bindingAbi, functionName: "monthlyFee" }),
  ]);
  return { isLive, isContainerLive, paidUntil, containerPaidUntil, monthlyFeeWei };
}

export interface SimulateBindInput {
  readonly name: string;
  readonly container: Hex;
  readonly months: number;
  readonly valueWei: bigint;
}

export interface SendBindResult {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly status: "success" | "reverted";
}

/** A broadcast hash, before any receipt exists. */
export interface BroadcastBindResult {
  readonly txHash: Hex;
}

/** The chain seam: reads are injected, the sender is resolved lazily. */
export interface BindingChainPort {
  readonly read: (container: Hex, name: string) => Promise<BindingChainReads>;
  /** `eth_call` + `estimateGas` for the exact call; throws on revert. */
  readonly simulate: (input: SimulateBindInput) => Promise<bigint>;
  /**
   * Broadcast only. Returns as soon as the node accepted the transaction, so the
   * caller can persist the hash *before* waiting for a receipt. Never blocks on
   * the receipt: a crash between here and `confirm` must leave a stored hash.
   */
  readonly broadcast: (input: SimulateBindInput & { readonly gas?: bigint }) => Promise<BroadcastBindResult>;
  /**
   * Wait for the receipt of an already-broadcast hash and classify it. Returns
   * `null` when the receipt did not arrive within the budget (timeout ≠ failure:
   * the transaction may still be mined later, so the caller keeps it pending).
   */
  readonly confirm: (txHash: Hex) => Promise<SendBindResult | null>;
  /** Decode an `eth_call` revert when the ABI can decode it. */
  readonly decodeRevert?: (error: unknown) => { readonly reason: string } | null;
}

function bindCall(args: SimulateBindInput) {
  return {
    address: XLAYER_MAINNET.binding,
    abi: bindingAbi,
    functionName: "bind",
    args: [args.name, args.container, BigInt(args.months)],
    value: args.valueWei,
  } as const;
}

/** How long `confirm` waits before reporting "still pending" instead of failing. */
export const BIND_RECEIPT_TIMEOUT_MS = 120_000;

/**
 * Default port: simulate through `eth_call` + `estimateGas`, broadcast with the
 * operator wallet, then wait for a mined receipt separately.
 *
 * `chain: null` on both simulated writes is required — viem otherwise routes a
 * dry run made with a local (private-key) account to `eth_sendTransaction`,
 * which would bypass the simulation entirely.
 */
export function createChainBindingPort(input: {
  readonly client: ReadClient;
  readonly wallet: () => WalletClient;
}): BindingChainPort {
  return {
    read: (container, name) => readBindingState(input.client, container, name),
    simulate: async (args) => {
      const account = input.wallet().account?.address;
      await input.client.simulateContract({
        ...bindCall(args),
        chain: xLayerChain,
        ...(account === undefined ? {} : { account }),
      });
      return input.client.estimateContractGas({
        ...bindCall(args),
        account: account ?? ZERO_ADDRESS,
      });
    },
    broadcast: async (args) => {
      const account = input.wallet().account;
      if (account === undefined || account === null) {
        throw new ApiError(503, "OPERATOR_UNAVAILABLE", "the operator wallet has no account");
      }
      const txHash = await input.wallet().writeContract({
        ...bindCall(args),
        chain: xLayerChain,
        account,
        ...(args.gas === undefined ? {} : { gas: args.gas }),
      });
      return { txHash };
    },
    confirm: async (txHash) => {
      let receipt;
      try {
        receipt = await input.client.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
          timeout: BIND_RECEIPT_TIMEOUT_MS,
        });
      } catch (error) {
        // A receipt timeout or a not-yet-visible receipt is "unknown", not
        // "failed": the transaction may still be mined, so the caller keeps the
        // stored hash pending instead of reporting a failure.
        if (isPendingReceiptError(error)) return null;
        throw error;
      }
      return {
        txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: receipt.status === "success" ? "success" : "reverted",
      };
    },
    decodeRevert: (error) => {
      const candidate = error as {
        readonly name?: string;
        readonly functionName?: string;
        readonly args?: readonly unknown[];
      };
      if (typeof candidate.functionName !== "string") return null;
      const args = Array.isArray(candidate.args) ? candidate.args : [];
      const rendered = args.map((arg) => String(arg)).join(", ");
      return { reason: rendered === "" ? candidate.functionName : `${candidate.functionName}(${rendered})` };
    },
  };
}

/**
 * `true` when the error only means "no receipt yet" — viem's receipt timeout, or
 * a node that has not indexed the transaction. Anything else (a transport
 * failure, a decoding error) is a real error and must surface.
 */
export function isPendingReceiptError(error: unknown): boolean {
  const candidate = error as { readonly name?: string; readonly code?: string } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  return (
    candidate.name === "WaitForTransactionReceiptTimeoutError" ||
    candidate.name === "TransactionReceiptNotFoundError" ||
    candidate.code === "TIMEOUT"
  );
}

export interface ContainerBindingAccess {
  readonly container: typeof containers.$inferSelect;
  /** The project that authorized the write; null when wallet ownership did. */
  readonly projectId: string | null;
  readonly via: "project" | "wallet-owner";
}

/**
 * Authorization for reading/writing a container's activation.
 *
 * - A session user with write access (maintainer/owner, directly or through the
 *   organization) to at least one project using the container is allowed.
 * - When no project uses the container, only a session user whose verified wallet
 *   is the container's current holder is allowed (403 OWNER_REQUIRED otherwise).
 * - A container that belongs to someone else's project is never writable through
 *   wallet ownership: the project members are the gate, not the chain holder.
 */
export async function requireContainerBindingAccess(
  db: Database,
  address: Hex,
  userId: string,
): Promise<ContainerBindingAccess> {
  const [container] = await db
    .select()
    .from(containers)
    .where(and(eq(containers.chainId, 196), eq(containers.containerAddress, address)))
    .limit(1);
  if (container === undefined) {
    throw new ApiError(404, "CONTAINER_NOT_FOUND", "container not found");
  }

  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.containerId, container.id));

  let writableProjectId: string | null = null;
  let sawReadOnlyRole = false;
  for (const row of projectRows) {
    const access = await projectAccess(db, row.id, userId);
    if (access === null) continue;
    if (canWrite(access.role)) {
      writableProjectId ??= row.id;
      continue;
    }
    sawReadOnlyRole = true;
  }
  if (writableProjectId !== null) {
    return { container, projectId: writableProjectId, via: "project" };
  }
  if (sawReadOnlyRole) {
    throw new ApiError(
      403,
      "PROJECT_ROLE_REQUIRED",
      "binding a container requires the maintainer or owner role on one of its projects",
    );
  }

  const verified = await db
    .select({ address: wallets.address })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.chainId, 196)));
  const owner = container.lastObservedOwner?.toLowerCase() ?? null;
  const holdsByWallet =
    owner !== null &&
    owner !== ZERO_ADDRESS &&
    verified.some((row) => row.address.toLowerCase() === owner);
  if (!holdsByWallet) {
    throw new ApiError(
      403,
      "OWNER_REQUIRED",
      "no project gives you write access; only a session user whose verified wallet is the container owner may bind it",
      { containerOwner: owner },
    );
  }
  return { container, projectId: null, via: "wallet-owner" };
}

export interface BudgetCheck {
  readonly projectId: string;
  readonly spentWei: bigint;
  readonly requestedWei: bigint;
  readonly capWei: bigint;
  readonly exceeded: boolean;
}

/**
 * Project monthly budget guard — the same rule deploy applies for
 * `FEE_OVER_BUDGET` (monthly spend + this call vs the project cap). Returns null
 * when the project has no cap. `monthlySpendWei` is the governance helper deploy
 * already uses, so both paths count the same costs.
 */
export async function projectBudgetCheck(
  deps: Pick<ApiDeps, "db">,
  projectId: string,
  requestedWei: bigint,
): Promise<BudgetCheck | null> {
  const [budget] = await deps.db
    .select({ cap: projectBudgets.monthlyCapWei })
    .from(projectBudgets)
    .where(eq(projectBudgets.projectId, projectId))
    .limit(1);
  if (budget?.cap === null || budget?.cap === undefined) return null;
  const spentWei = await monthlySpendWei(deps as ApiDeps, projectId);
  const capWei = BigInt(budget.cap);
  return {
    projectId,
    spentWei,
    requestedWei,
    capWei,
    exceeded: spentWei + requestedWei > capWei,
  };
}

/** `msg.value` and gas cost for one bind, using the shared pure planner. */
export function bindCost(input: {
  readonly name: string;
  readonly months: number;
  readonly monthlyFeeWei: bigint;
  readonly gasPriceWei: bigint;
  readonly estimatedGas: bigint;
}): { readonly valueWei: bigint; readonly estimatedCostWei: bigint } {
  const plan = planBind(input);
  return { valueWei: plan.valueWei, estimatedCostWei: plan.estimatedCostWei };
}

// ---------------------------------------------------------------------------
// Bind submission tracking (§3.3 / §9.4)
//
// The broadcast and the database are not one transaction. The only safe order is
// intent -> hash -> verify, so every bind that reaches the network leaves a row
// behind even if the process dies before a receipt exists:
//
//   pending    a hash is stored; no receipt is known yet
//   confirmed  the receipt succeeded and the activation was re-read
//
// `container_events` is the table (`event_type = 'bind'`), so the console's
// existing `recentEvents` read already surfaces the row. `gas_used` is null
// exactly while the attempt is pending, which is what makes the two states
// distinguishable without a schema change. A reverted attempt deletes its own
// pending row and is reported as `BIND_FAILED`, which is what the route did
// before tracking existed — recording a third state would need an `event_type`
// extension and that migration belongs to the integrator.
// ---------------------------------------------------------------------------

export type BindSubmissionState = "pending" | "confirmed";

/** A stored bind attempt. `blockNumber`/`gasUsed` are null until the receipt lands. */
export interface BindSubmission {
  readonly txHash: Hex;
  readonly state: BindSubmissionState;
  readonly name: string;
  readonly months: number;
  readonly valueWei: string;
  readonly paidUntil: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly createdAt: string;
}

/**
 * Persist the intent + hash *before* waiting for any receipt.
 *
 * `onConflictDoNothing` on the unique `tx_hash` index makes a retried call
 * idempotent: the same broadcast can be submitted twice (a double click, a
 * network retry) and still leave exactly one row. The returned `inserted` flag
 * lets a caller distinguish "this call recorded the hash" from "it was already
 * recorded", so a retry never re-reports a new send.
 */
export async function recordBindSubmission(
  db: Database,
  input: {
    readonly container: typeof containers.$inferSelect;
    readonly name: string;
    readonly months: number;
    readonly valueWei: bigint;
    readonly txHash: Hex;
    readonly createdByUserId: string | null;
    readonly projectId: string | null;
    readonly paidUntil?: Date | null;
  },
): Promise<{ readonly submission: BindSubmission; readonly inserted: boolean }> {
  const [inserted] = await db
    .insert(containerEvents)
    .values({
      containerId: input.container.id,
      chainId: 196,
      containerAddress: input.container.containerAddress,
      bindingAddress: input.container.bindingAddress,
      eventType: "bind",
      name: input.name,
      nameHash: nameHashOf(input.name),
      months: input.months,
      valueWei: input.valueWei.toString(),
      txHash: input.txHash,
      // A pending attempt has no block yet. `container_events.block_number` is
      // NOT NULL, so a pending row stores 0 and `gas_used` stays null: 0 is not
      // a real block on X Layer and the read below treats null gas as pending.
      blockNumber: "0",
      gasUsed: null,
      paidUntil: input.paidUntil ?? null,
      createdByUserId: input.createdByUserId,
      projectId: input.projectId,
    })
    .onConflictDoNothing({ target: containerEvents.txHash })
    .returning();

  const row = inserted ?? (await findBindSubmissionRow(db, input.txHash));
  if (row === undefined) {
    throw new ApiError(500, "INTERNAL", "the bind submission could not be recorded");
  }
  return { submission: toBindSubmission(row), inserted: inserted !== undefined };
}

/**
 * Update a stored attempt after the receipt (or the absence of one). Only
 * `block_number`/`gas_used`/`paid_until` change: the hash, name, months and
 * value are the recorded intent and are never rewritten by a confirmation.
 */
export async function confirmBindSubmission(
  db: Database,
  input: {
    readonly txHash: Hex;
    readonly blockNumber: bigint;
    readonly gasUsed: bigint;
    readonly paidUntil: Date | null;
  },
): Promise<void> {
  await db
    .update(containerEvents)
    .set({
      blockNumber: input.blockNumber.toString(),
      gasUsed: input.gasUsed.toString(),
      paidUntil: input.paidUntil,
    })
    .where(eq(containerEvents.txHash, input.txHash));
}

/** Every stored bind attempt for one container, newest first. */
export async function listBindSubmissions(
  db: Database,
  containerId: string,
  limit = 10,
): Promise<readonly BindSubmission[]> {
  const rows = await db
    .select()
    .from(containerEvents)
    .where(eq(containerEvents.containerId, containerId))
    .orderBy(desc(containerEvents.createdAt))
    .limit(limit);
  return rows.map(toBindSubmission);
}

/** One stored attempt by hash, or `null`. */
export async function findBindSubmission(
  db: Database,
  txHash: Hex,
): Promise<BindSubmission | null> {
  const row = await findBindSubmissionRow(db, txHash);
  return row === undefined ? null : toBindSubmission(row);
}

async function findBindSubmissionRow(
  db: Database,
  txHash: Hex,
): Promise<typeof containerEvents.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(containerEvents)
    .where(eq(containerEvents.txHash, txHash))
    .limit(1);
  return row;
}

function toBindSubmission(row: typeof containerEvents.$inferSelect): BindSubmission {
  // `gas_used` is written only by `confirmBindSubmission`, so a null value is
  // exactly the "broadcast, no receipt yet" state.
  return {
    txHash: row.txHash as Hex,
    state: row.gasUsed === null ? "pending" : "confirmed",
    name: row.name,
    months: row.months,
    valueWei: row.valueWei,
    paidUntil: row.paidUntil?.toISOString() ?? null,
    blockNumber: row.blockNumber,
    gasUsed: row.gasUsed,
    createdAt: row.createdAt.toISOString(),
  };
}
