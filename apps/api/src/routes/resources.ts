/**
 * Public resource read routes — SPEC §7.2 (rows 1–4).
 *
 * These handlers deliberately never read `request.user` and never touch
 * `deps.db`: the whole response is built from public chain reads plus the
 * resource index, so `WalletResourcePage`/`WalletResource` cannot carry a
 * repository, member, order or internal user id even when the queried address
 * belongs to a logged-in user (§8.7). The private container API in
 * `routes/containers.ts` is untouched and keeps `requireUser`.
 *
 * Because `app.ts` resolves a session user in `onRequest` before routing, an
 * anonymous caller only reaches these handlers when the lead adds the public
 * path branch listed in the T02-b report. The handlers themselves are already
 * anonymous-safe: they never require identity.
 *
 * Precedence inside this module:
 * - 400 for malformed input (chain/address/limit/cursor/tokenId).
 * - 422 for a processor the trusted Factory catalogue does not list (§8.1).
 * - A chain read that fails is *not* an HTTP failure of the DTO: the frozen
 *   `readStatus`/`syncStatus` fields carry `unavailable` so a client can say
 *   "could not read" instead of "you own nothing" (§8.6). 503 is reserved for
 *   the case where even the DTO cannot be built.
 */
import type { FastifyInstance } from "fastify";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import type { ReadClient } from "@tapeci/chain";
import type { Hex } from "@tapeci/shared";
import { createOperatorClients } from "@tapeci/verifier";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { InMemoryResourceIndex, type ResourceIndexStore } from "../resource-index.js";
import {
  inspectResource,
  listProcessors,
  listWalletResources,
  type ResourceDiscoveryDeps,
} from "../resources.js";
import { listMintableProcessors } from "../provisioning/mintable.js";
import { buildSelfMintQuote } from "../provisioning/self-mint-quote.js";
import { recordBody, stringField } from "../validation.js";

const CHAIN_ID = 196;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ResourceRouteOptions {
  /**
   * Index seam. Dev-2's PostgreSQL tables (`resource_index_checkpoints`,
   * `wallet_resources`) plug in here; until then each registration owns a fresh
   * in-memory index so an app instance never shares mutable state with another.
   */
  readonly index?: ResourceIndexStore;
  readonly config?: ChainConfig;
}

export function registerResourceRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  options: ResourceRouteOptions = {},
): void {
  const config = options.config ?? XLAYER_MAINNET;
  const index = options.index ?? new InMemoryResourceIndex();
  const discovery = (): ResourceDiscoveryDeps => ({
    client: readClientOf(deps, config),
    config,
    index,
  });

  // §7.2: the catalogue carries no ownership data, only processors + coverage.
  app.get("/v1/resources/processors", async (request) => {
    const query = request.query as { chainId?: string };
    requireChainId(query.chainId);
    return listProcessors(discovery());
  });

  /**
   * Processors that can actually mint, cheapest first (SPEC §12 of the self-mint spec).
   *
   * X Layer has hundreds of processors, each with its own transistor supply, and prices vary
   * by more than an order of magnitude between them. Sold-out processors are **omitted**: a
   * zero-stock entry would let a client quote a mint that reverts.
   *
   * `limit` bounds how many indices are examined and `take` how many are returned, so a
   * caller that only needs a workable choice can skip the full scan.
   */
  app.get("/v1/resources/mintable-processors", async (request) => {
    const query = request.query as { chainId?: string; limit?: string; take?: string };
    requireChainId(query.chainId);
    const deps = discovery();
    const limit = parseOptionalCount(query.limit, 400);
    const take = parseOptionalCount(query.take, 20);
    return listMintableProcessors({
      client: deps.client,
      factory: deps.config.factory,
      ...(limit === undefined ? {} : { maxProcessors: limit }),
      ...(take === undefined ? {} : { limit: take }),
    });
  });

  /**
   * What it costs to mint one circuit on a processor the user picked
   * (SPEC §12 of the self-mint spec).
   *
   * Public, and **non-binding**: it reads prices from the chosen processor's contracts and
   * returns the two exact transactions, but persists nothing and authorises nothing. The
   * container is opened in a separate second quote, because its token id does not exist until
   * the tapeout lands (§9.3).
   */
  app.post("/v1/resources/self-mint-quote", async (request) => {
    const body = recordBody(request.body);
    const chainId = body["chainId"];
    if (chainId !== undefined && chainId !== 196 && chainId !== "196") {
      throw new ApiError(400, "UNSUPPORTED_CHAIN", "only chain 196 is supported");
    }
    const cpuIndex = body["cpuIndex"];
    if (typeof cpuIndex !== "number" || !Number.isSafeInteger(cpuIndex) || cpuIndex < 0) {
      throw new ApiError(422, "INVALID_BODY", "cpuIndex must be a non-negative integer");
    }
    const deps = discovery();
    const quote = await buildSelfMintQuote({
      client: deps.client,
      factory: deps.config.factory,
      opener: deps.config.opener,
      cpuIndex,
    });
    if (quote === null) {
      // Not an error about a bad request: this processor simply cannot mint right now, and
      // the useful answer is the list of those that can.
      throw new ApiError(
        409,
        "PROCESSOR_SUPPLY_EXHAUSTED",
        "this processor cannot mint right now; choose one from /v1/resources/mintable-processors",
        { cpuIndex },
      );
    }
    return { quote, binding: false };
  });

  // §7.2: `WalletResourcePage`, page size 1–100, opaque cursor.
  app.get("/v1/resources/wallets/:address", async (request) => {
    const query = request.query as { chainId?: string; cursor?: string; limit?: string };
    requireChainId(query.chainId);
    const params = request.params as { address?: string };
    const address = (params.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new ApiError(400, "INVALID_PATH", "wallet address must be 0x + 40 hex characters");
    }
    const limit = parseLimit(query.limit);
    const cursor = query.cursor === undefined || query.cursor === "" ? null : query.cursor;
    return listWalletResources(discovery(), { address: address as Hex, cursor, limit });
  });

  // §7.2: one `WalletResource` for a manual `(processor, tokenId)` lookup.
  // tokenId 0 is a legal query (§5) and both ids stay strings in the DTO.
  app.post("/v1/resources/inspect", async (request) => {
    const body = recordBody(request.body);
    requireChainId(body["chainId"]);
    const processor = requiredField(body, "processor");
    if (!/^0x[0-9a-fA-F]{40}$/.test(processor)) {
      throw new ApiError(400, "INVALID_BODY", "processor must be a 20-byte hex address");
    }
    const tokenIdText = requiredField(body, "tokenId");
    if (!/^(0|[1-9][0-9]*)$/.test(tokenIdText)) {
      // No floats, exponents, signs or JSON numbers: precision loss at the
      // boundary is exactly what the DTO's decimal strings exist to prevent.
      throw new ApiError(
        400,
        "INVALID_BODY",
        "tokenId must be a base-10 integer string; tokenId \"0\" is allowed",
      );
    }
    return inspectResource(discovery(), {
      processor: processor.toLowerCase() as Hex,
      tokenId: BigInt(tokenIdText),
    });
  });

  // §7.2: no verified supply source is configured, so the catalogue is empty and
  // explicitly unavailable — never a fabricated offer list (§1, §9).
  //
  // The response says *why* it is empty and what the caller can do instead. "Unavailable"
  // on its own reads as "the platform is broken"; the honest answer is that this platform
  // only opens circuits you already hold, and a user who lands here may well already have
  // one. That distinction is the difference between a dead end and a redirect.
  app.get("/v1/resources/offers", async (request) => {
    const query = request.query as { chainId?: string };
    const chainId = requireChainId(query.chainId);
    return {
      chainId,
      offers: [],
      available: false,
      /**
       * There is no *pre-priced* supplier: this platform does not hold inventory and does not
       * resell. That is different from "nothing can be minted".
       *
       * Measured 2026-10-28: X Layer has 398 processors with independent transistor supplies
       * and **357 still have stock**, so a user can buy and mint directly from the protocol
       * with their own wallet. `GET /v1/resources/mintable-processors` lists those, cheapest
       * first. Processor 0 alone is sold out, which is why the choice matters.
       */
      unavailableReason: "NO_PREPRICED_OFFERS",
      unavailableKind: "self_mint_available" as const,
      guidance: {
        kind: "mint_from_protocol" as const,
        hint: "There is no pre-priced catalogue here. You can mint a circuit directly from the protocol with your own wallet; most processors still have transistors available.",
        mintableProcessorsPath: "/v1/resources/mintable-processors",
        /** The protocol's own one-click tool, for users who prefer it to this app. */
        protocolTool: "https://id.tapeout.link/",
      },
    };
  });
}

/** Optional positive integer query value with a ceiling, so a URL cannot ask for unbounded work. */
function parseOptionalCount(raw: unknown, max: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ApiError(400, "INVALID_QUERY", `count must be an integer between 1 and ${String(max)}`);
  }
  return value;
}

function requireChainId(raw: unknown): 196 {
  if (raw === undefined || raw === null) return CHAIN_ID;
  if (raw === CHAIN_ID || raw === String(CHAIN_ID)) return CHAIN_ID;
  throw new ApiError(400, "UNSUPPORTED_CHAIN", `only chain ${CHAIN_ID} is supported`);
}

/** `stringField` already throws on a missing value; this narrows the type for the DTO. */
function requiredField(record: Record<string, unknown>, name: string): string {
  const value = stringField(record, name);
  if (value === undefined) throw new ApiError(400, "INVALID_BODY", `${name} is required`);
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ApiError(400, "INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, "INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function readClientOf(deps: ApiDeps, config: ChainConfig): ReadClient {
  const injected = deps.readClient;
  if (injected !== undefined) return injected();
  const operators = createOperatorClients(config);
  const primary = operators[0];
  if (primary === undefined) {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "no RPC operator configured for resource discovery",
      {},
      true,
    );
  }
  return primary.client;
}
