/**
 * Final `open` quote — SPEC §7.2, §9.1–§9.3, §3.2.5.
 *
 * One job: turn a `(processor, tokenId)` a verified wallet already holds into an
 * immutable, priced, expiring quote for exactly one `Opener.open(circuits, tokenId)`
 * call. No acquisition, no purchase surface, no container input.
 *
 * The invariants this module exists to protect:
 * - The container is **derived** from `opener.accountOf(processor, tokenId)` at a
 *   pinned block (§2, §3.2.5). A caller can never supply one, and an unknown
 *   tokenId never produces a constructed address.
 * - A quote is only issued for a resource that is `verified` on chain, owned by
 *   the recipient, and not already opened (§3.1 step 3, §9.1). An unreadable
 *   chain read is `503 RESOURCE_READ_UNAVAILABLE`, never "not opened" (§8.6).
 * - The price is read live (`opener.FEE()`, `eth_gasPrice`, `estimateContractGas`)
 *   and pinned with `observedBlock`; nothing is hard-coded (§7.2).
 * - Every wei value is a base-10 string end to end; `Number()` is never applied
 *   to wei, gas or tokenId (§2, §13).
 * - The quote row is immutable once written; a re-quote inserts a new row (§6).
 */
import { randomUUID } from "node:crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
} from "viem";
import { and, eq } from "drizzle-orm";
import type { ChainConfig } from "@tapeci/config";
import { inspectContainer, openerAbi, type ReadClient } from "@tapeci/chain";
import { resourceQuotes, wallets, type Database } from "@tapeci/database";
import type {
  Hex,
  PreparationPrice,
  PreparationQuote,
  PreparationQuoteStep,
  ResourceRef,
} from "@tapeci/shared";
import { ApiError } from "../errors.js";
import { readProcessorCatalogue } from "../resource-index.js";

/** v1 is single-network (§1); the DTOs encode the literal. */
const CHAIN_ID = 196;

/** §7.2: `open` has one built-in source; it is not a configured supplier. */
export const OPEN_SOURCE_ID = "builtin:open";

/** Opaque terms revision recorded on every quote (§5); compared, never parsed. */
export const OPEN_TERMS_VERSION = "open.v1";

/**
 * §7.2 platform default for quote lifetime. The lead must wire a configuration
 * value (`TAPECI_QUOTE_TTL_SECONDS`) and pass it as `quoteTtlSeconds`; the
 * default here is the spec's suggested 300 s, not a silent production choice.
 */
export const DEFAULT_QUOTE_TTL_SECONDS = 300;

/** Gas headroom on the estimate: 20 %, the same margin the deployer applies. */
const GAS_MARGIN_BPS = 2_000n;
const BPS_DENOMINATOR = 10_000n;

/** Preparation options frozen for P3 (§7.2 first-phase list); open charges no service fee. */
const OPEN_OPTIONS = {
  prepareContainer: true,
  activateName: false,
  activationMonths: null,
  activationName: null,
} as const;

/**
 * The stored terms of one quoted `open` step. The DTO projection
 * (`PreparationQuoteStep`) is a subset; the rest is what the prepare/verify path
 * needs so a later request can never re-derive a different transaction.
 */
export interface OpenStepTerms {
  /** Stable identity of the quoted step; also used as the task step id. */
  readonly id: string;
  readonly ordinal: number;
  readonly kind: "open";
  readonly resource: ResourceRef;
  /** Derived server-side at quote time; recorded as evidence, never re-typed by a caller. */
  readonly container: Hex;
  /** Holder at `observedBlock`; must equal the recipient (§3.1). */
  readonly owner: Hex;
  readonly observedBlock: string;
  readonly to: Hex;
  readonly valueWei: string;
  readonly data: Hex;
  readonly gasLimit: string;
  readonly gasPriceWei: string;
  readonly maxValueWei: string;
  readonly maxGasCostWei: string;
  readonly expiresAt: string;
  readonly prices: readonly PreparationPrice[];
}

/** A quote as read back from the row, with its JSON snapshots parsed and checked. */
export interface StoredQuote {
  readonly id: string;
  readonly userId: string;
  readonly recipient: Hex;
  readonly sourceId: string;
  readonly offerId: string | null;
  readonly resource: ResourceRef | null;
  readonly options: Readonly<Record<string, unknown>>;
  readonly steps: readonly OpenStepTerms[];
  readonly prices: readonly PreparationPrice[];
  readonly observedBlock: string;
  readonly expiresAt: Date;
  readonly termsVersion: string;
  readonly createdAt: Date;
}

export interface OpenQuoteDeps {
  readonly db: Database;
  readonly client: ReadClient;
  readonly config: ChainConfig;
  /** Injectable clock so expiry is testable. */
  readonly now?: () => Date;
  /** §7.2 quote lifetime; defaults to `DEFAULT_QUOTE_TTL_SECONDS`. */
  readonly quoteTtlSeconds?: number;
}

export interface BuildOpenQuoteInput {
  readonly userId: string;
  /** Delivery wallet; must be a verified wallet of `userId` and the current holder. */
  readonly recipient: Hex;
  readonly resource: ResourceRef;
  /**
   * §7.2 `POST /v1/resource-quotes/preview` is a **non-binding** estimate: it must read the
   * chain and price the step, but it must not create a payable row, so the caller cannot
   * later point at an "accepted" quote nobody reviewed. Default `true` keeps the payable
   * route's behaviour.
   */
  readonly persist?: boolean;
}

/**
 * Build and persist the final `open` quote (§7.2 `POST /v1/resource-quotes`).
 *
 * Refusals are machine codes (§13): `PROCESSOR_NOT_REGISTERED`, `RESOURCE_NOT_FOUND`,
 * `RESOURCE_TOKEN_ZERO_UNSUPPORTED`, `ALREADY_OPENED`, `OWNER_REQUIRED`,
 * `WALLET_VERIFICATION_REQUIRED`, `RESOURCE_READ_UNAVAILABLE`, `OPEN_WOULD_REVERT`.
 */
export async function buildOpenQuote(
  deps: OpenQuoteDeps,
  input: BuildOpenQuoteInput,
): Promise<PreparationQuote> {
  requireXLayer(deps.config);
  const resource = readResourceRef(input.resource);
  const recipient = normalizeAddress(input.recipient);
  const now = deps.now?.() ?? new Date();
  const ttlSeconds = quoteTtl(deps.quoteTtlSeconds);

  // §7.2: the payable route requires session **and** a verified wallet whose address is the
  // recipient. A preview is public, so it has neither — but it still must not price a
  // recipient that is not the current holder, which the owner check below covers. Skipping
  // only the signature proof here keeps the two routes' *pricing* identical while their
  // authorisation differs, which is the distinction the spec draws.
  if (input.persist !== false) {
    await requireVerifiedWallet(deps.db, input.userId, recipient);
  }
  const tokenId = tokenIdOf(resource);

  const pinnedBlock = await readOrUnavailable(
    () => deps.client.getBlockNumber(),
    "the chain head to pin the quote",
  );
  const catalogue = await readOrUnavailable(
    () => readProcessorCatalogue(deps.client, deps.config, pinnedBlock),
    "the factory processor catalogue",
  );
  if (!catalogue.some((entry) => entry.processor === resource.processor)) {
    // §8.1: a caller-supplied processor must not extend the trusted catalogue.
    throw new ApiError(
      422,
      "PROCESSOR_NOT_REGISTERED",
      `processor ${resource.processor} is not in the factory catalogue`,
      { processor: resource.processor, observedBlock: pinnedBlock.toString(10) },
    );
  }

  const container = await deriveContainerAddress(deps, resource.processor, tokenId, pinnedBlock);
  const inspection = await inspectContainer(deps.client, deps.config, container, pinnedBlock);
  if (inspection.readStatus === "unavailable") {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      `could not read container ${container}: ${inspection.failure.message}`,
      { container, stage: inspection.failure.stage, observedBlock: pinnedBlock.toString(10) },
      true,
    );
  }
  if (inspection.readStatus === "not_found") {
    throw new ApiError(
      422,
      "RESOURCE_NOT_FOUND",
      `the chain does not hold a circuit for ${resource.processor} token ${resource.tokenId}`,
      { reason: inspection.reason, container, observedBlock: pinnedBlock.toString(10) },
    );
  }
  if (inspection.tokenId !== tokenId || normalizeAddress(inspection.processor) !== resource.processor) {
    // The derived address describes a different token than the one asked about.
    throw new ApiError(
      422,
      "RESOURCE_NOT_FOUND",
      `container ${container} does not belong to the requested circuit`,
      { container, observedBlock: pinnedBlock.toString(10) },
    );
  }
  if (inspection.opened) {
    // §3.1 step 4 / §9.1: an opened circuit has no paid step, and §9.1 asks for such
    // a step to be `skipped` so the user can see why nothing is charged. A quote is
    // the wrong shape to carry that (it would be a priced step that must never be
    // paid), so the quote endpoint refuses and the *task* path records `skipped`.
    // Measured separately: a second `open` reverts on chain and does not re-charge
    // FEE() (P3-13, docs/evidence/provisioning/p3-13-second-open-fork.json).
    throw new ApiError(
      409,
      "ALREADY_OPENED",
      `circuit ${resource.processor} token ${resource.tokenId} is already opened`,
      { container, observedBlock: pinnedBlock.toString(10) },
    );
  }
  const owner = normalizeAddress(inspection.owner);
  if (owner !== recipient) {
    // §3.1 step 3: the recipient must be the current holder, not merely logged in.
    // `open` is permissionless on chain, so this is a *product* restriction rather
    // than a chain one (fork evidence: the opener need not be the holder). It is a
    // conflict with current state, not an authorization failure of the token, hence
    // 409 `NOT_CURRENT_OWNER` as AC-P3-06 specifies (issue P3-09).
    throw new ApiError(
      409,
      "NOT_CURRENT_OWNER",
      "the delivery wallet does not hold this circuit; only its holder can open it",
      { container, owner, recipient, observedBlock: pinnedBlock.toString(10) },
    );
  }

  const valueWei = await readOrUnavailable(
    () =>
      deps.client.readContract({
        address: deps.config.opener,
        abi: openerAbi,
        functionName: "FEE",
        blockNumber: pinnedBlock,
      }),
    "the opener fee",
  );
  const gasPriceWei = await readOrUnavailable(() => deps.client.getGasPrice(), "the gas price");
  const data = encodeFunctionData({
    abi: openerAbi,
    functionName: "open",
    args: [resource.processor, tokenId],
  });
  const estimatedGas = await estimateOpenGas(deps, {
    resource,
    tokenId,
    recipient,
    valueWei,
  });
  const gasLimit = withGasMargin(estimatedGas);
  const maxGasCostWei = gasLimit * gasPriceWei;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const observedBlock = pinnedBlock.toString(10);

  const prices: PreparationPrice[] = [
    {
      kind: "open",
      currency: "OKB",
      amountWei: valueWei.toString(10),
      estimated: false,
      payer: recipient,
      payee: deps.config.opener,
    },
    {
      kind: "gas",
      currency: "OKB",
      amountWei: maxGasCostWei.toString(10),
      estimated: true,
      payer: recipient,
      payee: null,
    },
  ];

  const step: OpenStepTerms = {
    id: randomUUID(),
    ordinal: 0,
    kind: "open",
    resource,
    container,
    owner,
    observedBlock,
    to: deps.config.opener,
    valueWei: valueWei.toString(10),
    data,
    gasLimit: gasLimit.toString(10),
    gasPriceWei: gasPriceWei.toString(10),
    maxValueWei: valueWei.toString(10),
    maxGasCostWei: maxGasCostWei.toString(10),
    expiresAt: expiresAt.toISOString(),
    prices,
  };

  if (input.persist === false) {
    // A preview is the same computation with no row. Its id is prefixed so it can never be
    // mistaken for a payable quote by `POST /v1/preparations`, which is what makes it
    // non-binding rather than merely "not saved yet".
    return {
      id: `preview-${step.id}`,
      userId: input.userId,
      recipient,
      chainId: CHAIN_ID,
      sourceId: OPEN_SOURCE_ID,
      offerId: null,
      resource,
      steps: [toPreparationQuoteStep(step)],
      prices: [...prices],
      observedBlock,
      expiresAt: expiresAt.toISOString(),
      termsVersion: OPEN_TERMS_VERSION,
    };
  }

  const [row] = await deps.db
    .insert(resourceQuotes)
    .values({
      userId: input.userId,
      recipientAddress: recipient,
      chainId: CHAIN_ID,
      sourceId: OPEN_SOURCE_ID,
      // `open` prices an existing resource, so the acquisition offer slot stays empty (§7.2).
      offerId: null,
      resourceSnapshot: resource,
      options: OPEN_OPTIONS,
      stepsSnapshot: [step],
      pricesSnapshot: prices,
      observedBlock,
      expiresAt,
      termsVersion: OPEN_TERMS_VERSION,
      // `created_at` is written from the same clock that computed `expires_at`.
      // The table's `now()` default would use the database clock instead, and
      // `resource_quotes_expiry_check` requires `expires_at > created_at`, so any
      // skew between the API and the database would turn a valid quote into a
      // constraint violation (a 500) rather than a quote.
      createdAt: now,
    })
    .returning();
  if (row === undefined) {
    throw new ApiError(500, "INTERNAL", "the quote could not be persisted");
  }
  return toPreparationQuote(readStoredQuote(row));
}

/**
 * Read one quote back. A missing quote is 404; a corrupt snapshot is 500 rather
 * than a half-parsed quote that could be priced differently on a retry.
 */
export async function loadQuote(db: Database, quoteId: string): Promise<StoredQuote> {
  const [row] = await db
    .select()
    .from(resourceQuotes)
    .where(and(eq(resourceQuotes.id, quoteId), eq(resourceQuotes.chainId, CHAIN_ID)))
    .limit(1);
  if (row === undefined) {
    throw new ApiError(404, "QUOTE_NOT_FOUND", "quote not found");
  }
  return readStoredQuote(row);
}

/** The quote belongs to the caller (§7.3: tasks and quotes are per-user). */
export function assertQuoteOwner(quote: StoredQuote, userId: string): void {
  if (quote.userId !== userId) {
    throw new ApiError(404, "QUOTE_NOT_FOUND", "quote not found");
  }
}

/** §9.3: a re-quote may never move the delivery wallet. */
export function assertQuoteRecipient(quote: StoredQuote, recipient: Hex): void {
  if (quote.recipient !== normalizeAddress(recipient)) {
    throw new ApiError(
      409,
      "WALLET_MISMATCH",
      "this quote was priced for a different delivery wallet",
      { quoteRecipient: quote.recipient, requested: normalizeAddress(recipient) },
    );
  }
}

/** §7.2/§13: an expired quote is never executed; the user must re-quote and review. */
export function assertQuoteNotExpired(quote: StoredQuote, now: Date): void {
  if (quote.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(
      409,
      "QUOTE_EXPIRED",
      "the quote has expired; request a new quote and review the price again",
      { quoteId: quote.id, expiresAt: quote.expiresAt.toISOString() },
    );
  }
}

/** The `open` step of a stored quote, or a 500 when the snapshot is not an open quote. */
export function openStepOf(quote: StoredQuote, stepId: string): OpenStepTerms {
  const step = quote.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined || step.kind !== "open") {
    throw new ApiError(500, "INTERNAL", "the quote does not contain this open step", { stepId });
  }
  return step;
}

/** `PreparationQuote` projection (§5) — only frozen fields, no snapshot internals. */
export function toPreparationQuote(quote: StoredQuote): PreparationQuote {
  return {
    id: quote.id,
    userId: quote.userId,
    recipient: quote.recipient,
    chainId: CHAIN_ID,
    sourceId: quote.sourceId,
    offerId: quote.offerId,
    resource: quote.resource,
    steps: quote.steps.map(toPreparationQuoteStep),
    prices: [...quote.prices],
    observedBlock: quote.observedBlock,
    expiresAt: quote.expiresAt.toISOString(),
    termsVersion: quote.termsVersion,
  };
}

function toPreparationQuoteStep(step: OpenStepTerms): PreparationQuoteStep {
  return {
    id: step.id,
    ordinal: step.ordinal,
    kind: step.kind,
    resource: step.resource,
    prices: [...step.prices],
  };
}

/**
 * `accountOf(processor, tokenId)` at the pinned block — the only container source
 * (§2, §3.2.5). A revert/empty return means the opener has no account for that
 * token: explicit absence (422), not a failed read. Only a transport error is 503.
 */
async function deriveContainerAddress(
  deps: OpenQuoteDeps,
  processor: Hex,
  tokenId: bigint,
  blockNumber: bigint,
): Promise<Hex> {
  let derived: Hex;
  try {
    derived = await deps.client.readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [processor, tokenId],
      blockNumber,
    });
  } catch (error) {
    if (isExplicitContractAnswer(error)) {
      throw new ApiError(
        422,
        "RESOURCE_NOT_FOUND",
        "the opener has no container for this circuit",
        { processor, tokenId: tokenId.toString(10), observedBlock: blockNumber.toString(10) },
      );
    }
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "could not read the container derivation",
      { stage: "derivation", reason: describeError(error) },
      true,
    );
  }
  const container = normalizeAddress(derived);
  if (container === ZERO_ADDRESS) {
    throw new ApiError(422, "RESOURCE_NOT_FOUND", "the opener derived no container for this circuit", {
      processor,
      tokenId: tokenId.toString(10),
    });
  }
  return container;
}

/**
 * `estimateContractGas` for the exact `open` call. A revert here is reported as
 * `OPEN_WOULD_REVERT` instead of a signed transaction that burns gas (the same
 * fail-closed pre-check `binding.ts` performs for `bind`).
 */
async function estimateOpenGas(
  deps: OpenQuoteDeps,
  input: {
    readonly resource: ResourceRef;
    readonly tokenId: bigint;
    readonly recipient: Hex;
    readonly valueWei: bigint;
  },
): Promise<bigint> {
  try {
    return await deps.client.estimateContractGas({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "open",
      args: [input.resource.processor, input.tokenId],
      value: input.valueWei,
      account: input.recipient,
    });
  } catch (error) {
    const reason = describeRevert(error);
    throw new ApiError(
      409,
      "OPEN_WOULD_REVERT",
      reason === null
        ? "the open call reverted in gas estimation"
        : `the open call reverted in gas estimation: ${reason}`,
      {
        processor: input.resource.processor,
        tokenId: input.resource.tokenId,
        valueWei: input.valueWei.toString(10),
        ...(reason === null ? {} : { revertsWith: reason }),
      },
    );
  }
}

/** 404-style refusal for a quote that names a wallet the user never proved (§10). */
async function requireVerifiedWallet(db: Database, userId: string, recipient: Hex): Promise<void> {
  const [wallet] = await db
    .select({ address: wallets.address })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, userId),
        eq(wallets.chainId, CHAIN_ID),
        eq(wallets.address, recipient),
      ),
    )
    .limit(1);
  if (wallet === undefined) {
    throw new ApiError(
      403,
      "WALLET_VERIFICATION_REQUIRED",
      "the delivery wallet must be verified by this user before a quote can be priced",
      { recipient },
    );
  }
}

/**
 * Parse the row's JSON snapshots back into typed terms. A row that cannot be
 * read exactly is a 500: guessing a price from a corrupt snapshot would mean
 * charging an amount the user never reviewed.
 */
export function readStoredQuote(row: typeof resourceQuotes.$inferSelect): StoredQuote {
  const steps = readOpenSteps(row.stepsSnapshot);
  const prices = readPrices(row.pricesSnapshot);
  return {
    id: row.id,
    userId: row.userId,
    recipient: normalizeAddress(row.recipientAddress as Hex),
    sourceId: row.sourceId,
    offerId: row.offerId,
    resource: row.resourceSnapshot === null ? null : readResourceRef(row.resourceSnapshot),
    options: readRecord(row.options),
    steps,
    prices,
    observedBlock: row.observedBlock,
    expiresAt: row.expiresAt,
    termsVersion: row.termsVersion,
    createdAt: row.createdAt,
  };
}

function readOpenSteps(value: unknown): readonly OpenStepTerms[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(500, "INTERNAL", "the quote has no step snapshot");
  }
  return value.map((entry) => {
    const record = readRecord(entry);
    return {
      id: requireString(record, "id"),
      ordinal: requireInteger(record, "ordinal"),
      kind: "open" as const,
      resource: readResourceRef(record["resource"]),
      container: normalizeAddress(requireString(record, "container") as Hex),
      owner: normalizeAddress(requireString(record, "owner") as Hex),
      observedBlock: requireDecimal(record, "observedBlock"),
      to: normalizeAddress(requireString(record, "to") as Hex),
      valueWei: requireDecimal(record, "valueWei"),
      data: requireString(record, "data") as Hex,
      gasLimit: requireDecimal(record, "gasLimit"),
      gasPriceWei: requireDecimal(record, "gasPriceWei"),
      maxValueWei: requireDecimal(record, "maxValueWei"),
      maxGasCostWei: requireDecimal(record, "maxGasCostWei"),
      expiresAt: requireString(record, "expiresAt"),
      prices: readPrices(record["prices"]),
    };
  });
}

function readPrices(value: unknown): readonly PreparationPrice[] {
  if (!Array.isArray(value)) {
    throw new ApiError(500, "INTERNAL", "the quote price snapshot is not an array");
  }
  return value.map((entry) => {
    const record = readRecord(entry);
    const kind = requireString(record, "kind");
    if (!PRICE_KINDS.has(kind)) {
      throw new ApiError(500, "INTERNAL", `unknown price kind in the quote snapshot: ${kind}`);
    }
    const amountWei = record["amountWei"];
    return {
      kind: kind as PreparationPrice["kind"],
      currency: "OKB" as const,
      amountWei: amountWei === null ? null : requireDecimal(record, "amountWei"),
      estimated: record["estimated"] === true,
      payer: normalizeAddress(requireString(record, "payer") as Hex),
      payee: record["payee"] === null ? null : normalizeAddress(requireString(record, "payee") as Hex),
    };
  });
}

const PRICE_KINDS = new Set(["acquisition", "open", "activation", "service", "gas"]);

/** A `ResourceRef` from untrusted JSON: chain 196, lowercase processor, decimal tokenId. */
export function readResourceRef(value: unknown): ResourceRef {
  const record = readRecord(value);
  const chainId = record["chainId"];
  if (chainId !== CHAIN_ID) {
    throw new ApiError(422, "UNSUPPORTED_CHAIN", `only chain ${CHAIN_ID} is supported`, { chainId });
  }
  return {
    chainId: CHAIN_ID,
    processor: normalizeAddress(requireString(record, "processor") as Hex),
    tokenId: requireDecimal(record, "tokenId"),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(500, "INTERNAL", "a stored provisioning snapshot is not an object");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(500, "INTERNAL", `a stored provisioning snapshot is missing ${name}`);
  }
  return value;
}

function requireDecimal(record: Record<string, unknown>, name: string): string {
  const value = requireString(record, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ApiError(500, "INTERNAL", `a stored provisioning snapshot has a non-decimal ${name}`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(500, "INTERNAL", `a stored provisioning snapshot has an invalid ${name}`);
  }
  return value;
}

/**
 * `tokenId` as a `bigint`. `"0"` parses, then is refused by `tokenIdOf`: the
 * protocol has no confirmed usable token 0 and `containers_token_id_check` still
 * requires `>= 1` (P0-04 open), so quoting it would price an asset nobody proved
 * exists (§6, §13).
 */
function tokenIdOf(resource: ResourceRef): bigint {
  if (resource.tokenId === "0") {
    throw new ApiError(
      422,
      "RESOURCE_TOKEN_ZERO_UNSUPPORTED",
      "tokenId 0 is queryable but cannot be opened until the protocol proves it exists",
      { processor: resource.processor, tokenId: resource.tokenId },
    );
  }
  return BigInt(resource.tokenId);
}

function quoteTtl(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_QUOTE_TTL_SECONDS;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new ApiError(500, "INVALID_CONFIG", "quoteTtlSeconds must be a positive integer");
  }
  return configured;
}

/** Ceiling of `gas × (1 + margin)` so an under-quoted limit never truncates a valid call. */
function withGasMargin(gas: bigint): bigint {
  return (gas * (BPS_DENOMINATOR + GAS_MARGIN_BPS) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

function requireXLayer(config: ChainConfig): void {
  if (config.chainId !== CHAIN_ID) {
    throw new ApiError(
      500,
      "INVALID_CONFIG",
      `provisioning supports chain ${CHAIN_ID} only, got ${config.chainId}`,
    );
  }
}

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

function normalizeAddress(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

/** Wrap a read that must not degrade: a failure is 503, never an empty price. */
async function readOrUnavailable<T>(read: () => Promise<T>, what: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      `could not read ${what}`,
      { stage: what, reason: describeError(error) },
      true,
    );
  }
}

/**
 * `true` only when the chain itself answered: a revert or an empty return. A
 * timeout, 5xx or rate limit is a failed read and must stay `unavailable`
 * (§8.6); this mirrors `packages/chain/src/container.ts`, which does not export it.
 */
function isExplicitContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

function describeRevert(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  return error.shortMessage;
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
