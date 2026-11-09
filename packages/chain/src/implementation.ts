import { getAddress, zeroAddress, type Hex } from "viem";
import { IMPL_SLOT, type ChainConfig, type ImplementationAllowlist } from "@tapeci/config";
import { TapeCiError } from "@tapeci/shared";
import type { ReadClient } from "./clients.js";

export interface ImplementationObservation {
  readonly role: ImplementationAllowlist["role"];
  readonly proxy: Hex;
  readonly slot: Hex;
  readonly implementation: Hex | null;
  readonly allowlisted: boolean;
  readonly expected: readonly Hex[];
  readonly codeSize: number;
}

/**
 * Read the ERC-1967 implementation slot. TapeKit SPEC §4.3: never call the
 * contract's own `implementation()` — after an upgrade the new code answers.
 */
export async function readImplementationSlot(
  client: ReadClient,
  proxy: Hex,
  blockNumber?: bigint,
): Promise<Hex> {
  const raw = await client.getStorageAt({
    address: proxy,
    slot: IMPL_SLOT,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (!raw || raw === "0x") {
    throw new TapeCiError("IMPLEMENTATION_CHANGED", `implementation slot is empty for ${proxy}`, {
      details: { proxy },
    });
  }
  const address = getAddress(`0x${raw.slice(-40)}`);
  if (address === zeroAddress) {
    throw new TapeCiError("IMPLEMENTATION_CHANGED", `implementation slot is zero for ${proxy}`, {
      details: { proxy },
    });
  }
  return address;
}

export async function checkImplementation(
  client: ReadClient,
  entry: ImplementationAllowlist,
  blockNumber?: bigint,
): Promise<ImplementationObservation> {
  const [implementation, code] = await Promise.all([
    readImplementationSlot(client, entry.proxy, blockNumber),
    client.getCode({
      address: entry.proxy,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }),
  ]);
  return {
    role: entry.role,
    proxy: entry.proxy,
    slot: IMPL_SLOT,
    implementation,
    allowlisted: entry.implementations.some(
      (candidate) => candidate.toLowerCase() === implementation.toLowerCase(),
    ),
    expected: entry.implementations,
    codeSize: code ? (code.length - 2) / 2 : 0,
  };
}

/** Read every pinned implementation. Also fails if the proxy has no code. */
export async function checkAllImplementations(
  client: ReadClient,
  config: ChainConfig,
  blockNumber?: bigint,
): Promise<ImplementationObservation[]> {
  const observations = await Promise.all(
    config.allowlist.map((entry) => checkImplementation(client, entry, blockNumber)),
  );
  for (const observation of observations) {
    if (observation.codeSize === 0) {
      throw new TapeCiError(
        "IMPLEMENTATION_CHANGED",
        `no bytecode at ${observation.role} proxy ${observation.proxy}`,
        { details: { role: observation.role, proxy: observation.proxy } },
      );
    }
  }
  return observations;
}

/** Fail closed on any implementation drift (PRD state IMPLEMENTATION_CHANGED). */
export async function assertImplementationsAllowlisted(
  client: ReadClient,
  config: ChainConfig,
  blockNumber?: bigint,
): Promise<ImplementationObservation[]> {
  const observations = await checkAllImplementations(client, config, blockNumber);
  const changed = observations.filter((observation) => !observation.allowlisted);
  if (changed.length > 0) {
    throw new TapeCiError(
      "IMPLEMENTATION_CHANGED",
      `implementation not in TapeCI allowlist: ${changed
        .map((item) => `${item.role}=${item.implementation ?? "?"}`)
        .join(", ")}`,
      {
        retryable: false,
        details: {
          changed: changed.map((item) => ({
            role: item.role,
            proxy: item.proxy,
            implementation: item.implementation,
            expected: item.expected,
          })),
        },
      },
    );
  }
  return observations;
}

export async function assertChainId(client: ReadClient, expectedChainId: number): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) {
    throw new TapeCiError(
      "CHAIN_MISMATCH",
      `RPC reports chainId ${chainId}, expected ${expectedChainId}`,
      { details: { chainId, expected: expectedChainId } },
    );
  }
}
