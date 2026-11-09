/**
 * P2 / T02 — resource discovery.
 *
 * SPEC §15.1 requires this file to prove: read failures land on
 * `unavailable`/`not_found` instead of a false "not opened", `tokenId=0` and
 * very large token ids survive the whole path as strings, and grouping/paging
 * are stable. The behavioural assertions land with the T02 implementation; the
 * cases are enumerated in `.superpowers/sdd/provisioning/test-p0.md`.
 *
 * This file is also the P0 smoke test for the harness: it proves the runner
 * discovers `tests/unit/**`, that `@tapeci/shared` resolves, and that a skip
 * carries a reason instead of being counted as a pass.
 *
 * `packages/shared/src/resources.ts` is written concurrently by the Development
 * subagent, so its absence is a documented skip — never a silent pass, and
 * never a hard failure that would block them.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHARED_SRC = fileURLToPath(new URL("../../packages/shared/src/", import.meta.url));
const RESOURCES_MODULE = `${SHARED_SRC}resources.ts`;
const resourcesPresent = existsSync(RESOURCES_MODULE);

const ABSENT_REASON =
  "packages/shared/src/resources.ts does not exist yet (T02 contract not landed); " +
  "re-run once the Development subagent writes it";

describe("resource discovery smoke (P0 harness)", () => {
  it("imports the shared package entry", async () => {
    const shared: unknown = await import("@tapeci/shared");
    expect(typeof shared).toBe("object");
    expect(shared).not.toBeNull();
  });

  it("resolves the shared source directory this suite will assert against", () => {
    expect(existsSync(SHARED_SRC), `shared source directory missing: ${SHARED_SRC}`).toBe(true);
  });
});

// The label states the real state so a skipped block can never be read as a pass.
const CONTRACT_LABEL = resourcesPresent
  ? "resource discovery contract"
  : `resource discovery contract [SKIPPED: ${ABSENT_REASON}]`;

describe.skipIf(!resourcesPresent)(CONTRACT_LABEL, () => {
  it("loads the §5 resource DTO module", async () => {
    const resources: Record<string, unknown> = await import(
      /* @vite-ignore */ RESOURCES_MODULE
    );
    expect(typeof resources).toBe("object");
    expect(resources).not.toBeNull();
  });

  it("re-exports the resource DTOs from @tapeci/shared", async () => {
    // Types are erased at runtime, so the package entry must still resolve and
    // the module must parse. A missing/renamed export is caught by typecheck.
    const shared: Record<string, unknown> = await import("@tapeci/shared");
    expect(shared).toBeTypeOf("object");
  });
});

// ---------------------------------------------------------------------------
// P1-B — chain read correctness (`inspectContainer`).
//
// Appended by the Development subagent; nothing above this marker was rewritten.
// SPEC §8.6: "读取失败保持 unavailable，不转换为'未开启'". These cases pin the
// three-outcome split at the chain boundary, which is where the defect lived
// (`container.ts` seeded `opened = false` and swallowed every throw).
// ---------------------------------------------------------------------------

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  type Hex,
} from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  assertContainerVerified,
  ContainerReadUnavailableError,
  inspectContainer,
  type ReadClient,
} from "@tapeci/chain";
import { resolveVerifiedOrThrow } from "../../apps/api/src/container-resolver.js";
import { ApiError } from "../../apps/api/src/errors.js";
import { TapeCiError } from "@tapeci/shared";

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const PROCESSOR = "0x839bdd6fa7a66416a609a735e11de5411b98574e" as Hex;
const OWNER = "0x571d447f4f24688ec35ccf07f1d6993655f6af15" as Hex;
const TOKEN_ID = 2n;
const PIN = 74_152_998n;

/** A revert as viem actually surfaces it: wrapped in `ContractFunctionExecutionError`. */
function revertError(functionName: string): Error {
  const reverted = new ContractFunctionRevertedError({
    abi: [],
    data: "0x4e487b71",
    functionName,
  });
  return new ContractFunctionExecutionError(reverted, {
    abi: [],
    args: [],
    contractAddress: CONTAINER,
    functionName,
  });
}

/** A transport failure: no revert, no data — the chain never answered. */
function transportError(functionName: string): Error {
  const http = new HttpRequestError({
    url: "https://rpc.invalid.example",
    details: "timed out",
  });
  return new ContractFunctionExecutionError(http, {
    abi: [],
    args: [],
    contractAddress: CONTAINER,
    functionName,
  });
}

/** Checksummed vs lowercase is not a behaviour change; compare addresses case-insensitively. */
const sameAddress = (left: string | null, right: string): boolean =>
  left !== null && left.toLowerCase() === right.toLowerCase();

type ReadOverrides = Partial<Record<string, () => unknown>>;

/**
 * Minimal `ReadClient`: only the two members `inspectContainer` touches. Each read is
 * keyed by ABI function name so a test can fail exactly one call and leave the rest real.
 */
function fakeClient(overrides: ReadOverrides = {}): ReadClient {
  const reads: Record<string, () => unknown> = {
    token: () => [196n, PROCESSOR, TOKEN_ID],
    isCPU: () => true,
    accountOf: () => CONTAINER,
    ownerOf: () => OWNER,
    isDeployed: () => true,
    isOpened: () => true,
    ...overrides,
  };
  return {
    getBlockNumber: async () => PIN,
    readContract: async (request: { functionName: string }) => {
      const read = reads[request.functionName];
      if (read === undefined) throw new Error(`unexpected read ${request.functionName}`);
      return read();
    },
  } as unknown as ReadClient;
}

describe("inspectContainer — three outcomes (SPEC §8.6)", () => {
  it("returns verified with real booleans and the block the answer came from", async () => {
    const inspection = await inspectContainer(fakeClient(), XLAYER_MAINNET, CONTAINER);

    expect(inspection.readStatus).toBe("verified");
    expect(inspection.observedBlock).toBe(PIN);
    expect(inspection.deployed).toBe(true);
    expect(inspection.opened).toBe(true);
    expect(sameAddress(inspection.owner, OWNER)).toBe(true);
    expect(inspection.tokenId).toBe(TOKEN_ID);
  });

  it("preserves a real `false` as `false`, not as unknown", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isDeployed: () => false, isOpened: () => false }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("verified");
    expect(inspection.deployed).toBe(false);
    expect(inspection.opened).toBe(false);
  });

  it("keeps a failed isOpened read as unavailable with opened=null, never false", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isOpened: () => { throw transportError("isOpened"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("opened");
    // The critical assertion: an unreadable answer is not a negative answer.
    expect(inspection.opened).toBeNull();
    expect(inspection.opened).not.toBe(false);
    // Facts that did succeed are kept rather than thrown away.
    expect(sameAddress(inspection.owner, OWNER)).toBe(true);
    expect(inspection.deployed).toBe(true);
    expect(inspection.observedBlock).toBe(PIN);
  });

  it("keeps a failed isDeployed read as unavailable with deployed=null", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isDeployed: () => { throw transportError("isDeployed"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("deployed");
    expect(inspection.deployed).toBeNull();
    expect(inspection.opened).toBe(true);
  });

  it("keeps a failed ownerOf read as unavailable with owner=null", async () => {
    const inspection = await inspectContainer(
      fakeClient({ ownerOf: () => { throw transportError("ownerOf"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("unavailable");
    expect(inspection.owner).toBeNull();
    expect(inspection.opened).toBeNull();
  });

  it("reports not_found when token() reverts: the chain answered, nothing failed", async () => {
    const inspection = await inspectContainer(
      fakeClient({ token: () => { throw revertError("token"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("not_tapeout_container");
    expect(inspection.opened).toBeNull();
    expect(inspection.owner).toBeNull();
  });

  it("reports not_found when token() returns no data (address is not a contract)", async () => {
    const inspection = await inspectContainer(
      fakeClient({
        token: () => {
          throw new ContractFunctionZeroDataError({ functionName: "token" });
        },
      }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("not_tapeout_container");
  });

  it("does NOT report not_found when token() fails on transport", async () => {
    const inspection = await inspectContainer(
      fakeClient({ token: () => { throw transportError("token"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    // A timeout is not evidence that the address is not a container.
    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("token");
    expect(inspection.observedBlock).toBe(PIN);
  });

  it("reports not_found when the processor is not in the factory catalogue", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isCPU: () => false }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("processor_not_registered");
  });

  it("reports not_found when the address is not the opener derivation", async () => {
    const inspection = await inspectContainer(
      fakeClient({ accountOf: () => "0x00000000000000000000000000000000000000ff" }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("derivation_mismatch");
  });

  it("stays unavailable when the head itself cannot be read", async () => {
    const client = {
      getBlockNumber: async () => {
        throw new Error("no route to host");
      },
      readContract: async () => {
        throw new Error("must not be called");
      },
    } as unknown as ReadClient;

    const inspection = await inspectContainer(client, XLAYER_MAINNET, CONTAINER);

    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("block");
    expect(inspection.observedBlock).toBeNull();
  });

  it("uses the caller-supplied block as observedBlock without re-reading the head", async () => {
    const inspection = await inspectContainer(fakeClient(), XLAYER_MAINNET, CONTAINER, 74_000_000n);

    expect(inspection.observedBlock).toBe(74_000_000n);
    expect(inspection.readStatus).toBe("verified");
  });
});

describe("assertContainerVerified — the unknown never becomes a fact", () => {
  it("passes a verified inspection through unchanged", async () => {
    const inspection = await inspectContainer(fakeClient(), XLAYER_MAINNET, CONTAINER);
    const verified = assertContainerVerified(inspection);

    expect(verified.readStatus).toBe("verified");
    expect(verified.opened).toBe(true);
  });

  it("throws a retryable read error — not CONTAINER_NOT_OPEN — when the read failed", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isOpened: () => { throw transportError("isOpened"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(() => assertContainerVerified(inspection)).toThrow(ContainerReadUnavailableError);
    try {
      assertContainerVerified(inspection);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerReadUnavailableError);
      expect((error as ContainerReadUnavailableError).code).toBe("CONTAINER_READ_UNAVAILABLE");
      expect((error as ContainerReadUnavailableError).retryable).toBe(true);
      expect((error as ContainerReadUnavailableError).stage).toBe("opened");
      expect((error as ContainerReadUnavailableError).observedBlock).toBe(PIN);
      // The whole defect in one assertion: this is not a "not opened" verdict.
      expect(error).not.toBeInstanceOf(TapeCiError);
    }
  });

  it("throws CONTAINER_NOT_TAPEOUT for an explicit not_found", async () => {
    const inspection = await inspectContainer(
      fakeClient({ token: () => { throw revertError("token"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(() => assertContainerVerified(inspection)).toThrow(TapeCiError);
    try {
      assertContainerVerified(inspection);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(TapeCiError);
      expect((error as TapeCiError).code).toBe("CONTAINER_NOT_TAPEOUT");
    }
  });
});

describe("resolveVerifiedOrThrow — the resolver's three-way mapping", () => {
  it("maps a failed read to a retryable 503 CONTAINER_READ_UNAVAILABLE", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isOpened: () => { throw transportError("isOpened"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(() => resolveVerifiedOrThrow(inspection)).toThrow(ApiError);
    try {
      resolveVerifiedOrThrow(inspection);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const api = error as ApiError;
      expect(api.statusCode).toBe(503);
      expect(api.code).toBe("CONTAINER_READ_UNAVAILABLE");
      expect(api.retryable).toBe(true);
      expect(api.details["stage"]).toBe("opened");
      // Never the 409 that reads as a fact.
      expect(api.code).not.toBe("CONTAINER_NOT_OPEN");
    }
  });

  it("maps a real unopened container to 409 CONTAINER_NOT_OPEN", async () => {
    const inspection = await inspectContainer(
      fakeClient({ isOpened: () => false }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(() => resolveVerifiedOrThrow(inspection)).toThrow(ApiError);
    try {
      resolveVerifiedOrThrow(inspection);
      throw new Error("unreachable");
    } catch (error) {
      const api = error as ApiError;
      expect(api.statusCode).toBe(409);
      expect(api.code).toBe("CONTAINER_NOT_OPEN");
      expect(api.retryable).toBe(false);
    }
  });

  it("maps not_found to the existing 422 CONTAINER_NOT_TAPEOUT", async () => {
    const inspection = await inspectContainer(
      fakeClient({ token: () => { throw revertError("token"); } }),
      XLAYER_MAINNET,
      CONTAINER,
    );

    expect(() => resolveVerifiedOrThrow(inspection)).toThrow(TapeCiError);
    try {
      resolveVerifiedOrThrow(inspection);
      throw new Error("unreachable");
    } catch (error) {
      expect((error as TapeCiError).code).toBe("CONTAINER_NOT_TAPEOUT");
    }
  });

  it("returns the verified facts for an opened container", async () => {
    const inspection = await inspectContainer(fakeClient(), XLAYER_MAINNET, CONTAINER);
    const verified = resolveVerifiedOrThrow(inspection);

    expect(sameAddress(verified.container, CONTAINER)).toBe(true);
    expect(sameAddress(verified.owner, OWNER)).toBe(true);
    expect(verified.opened).toBe(true);
    expect(verified.deployed).toBe(true);
    expect(verified.tokenId).toBe(TOKEN_ID);
  });
});
