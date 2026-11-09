import type { Hex } from "@tapeci/shared";

/**
 * TapeKit source pin (P0-01). The commit below is the only source of truth used
 * for X Layer network constants. Record it in docs/evidence/sources.md together
 * with the clone date and the checks performed by scripts/probe/probe.ts.
 */
export const TAPEKIT_SOURCE = {
  repository: "https://github.com/TapeOutProtocol/TapeKit",
  commit: "40994bd65baedbda4df72cb0985031a5f082f606",
  commitDate: "2026-10-11T11:08:10+04:00",
  specVersion: "SPEC.md v0.2 draft (BNB-first normative text)",
  configFile: "kernel/src/config.js",
  // X Layer constants below were read from kernel/src/config.js at the pinned commit
  // and independently re-read from chain by scripts/probe/probe.ts.
} as const;

/** ERC-1967 implementation slot (same slot TapeKit's kernel pins). */
export const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export type OperatorName = "okx" | "drpc" | "thirdweb" | "other";

export interface RpcEndpoint {
  readonly url: string;
  readonly operator: Exclude<OperatorName, "thirdweb" | "other">;
  readonly maxBatch: number;
  readonly callerKeys?: boolean;
}

export interface ImplementationAllowlist {
  readonly role: "factory" | "siteRegistry" | "domainBinding";
  readonly proxy: Hex;
  readonly implementations: readonly Hex[];
  readonly note?: string;
}

export interface ChainConfig {
  readonly chainId: number;
  readonly key: "xlayer";
  readonly name: string;
  readonly nativeCurrency: string;
  /** TapeKit area code for names on this chain (X Layer = 2). BNB has no area code. */
  readonly area: number;
  readonly factory: Hex;
  readonly opener: Hex;
  readonly registries: readonly Hex[];
  readonly binding: Hex;
  readonly allowlist: readonly ImplementationAllowlist[];
  readonly rpcs: readonly RpcEndpoint[];
  readonly pin: {
    /** Pin to (second-highest observed head) - offset. */
    readonly offset: number;
    readonly maxLagBlocks: number;
    readonly maxBlockAgeSeconds: number;
  };
  readonly openFeeNote: string;
}

/**
 * X Layer mainnet config, cross-checked against TapeKit `kernel/src/config.js`
 * at commit 40994bd6… and re-read on chain (P0-02).
 */
export const XLAYER_MAINNET: ChainConfig = {
  chainId: 196,
  key: "xlayer",
  name: "X Layer",
  nativeCurrency: "OKB",
  area: 2,
  factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
  opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
  registries: ["0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6"],
  binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
  allowlist: [
    {
      role: "factory",
      proxy: "0x1f09daefa827f02cbb40967cc91b259763760761",
      implementations: [
        // 2026-10-22 freeze: TapeKit deployed a new factory implementation for
        // X Layer (factorySeal.implementation). The 2026-09-19 implementation is
        // kept so an owner rollback does not trip fail-closed reads.
        "0xb41c1e7602eb5734be2430b72178ccb814a5293d",
        "0x74956236ab64ed143933040b4137e8a352e4d17b",
      ],
      note: "TapeKit config.js factorySeal.implementation (2026-10-22 freeze; previous 2026-09-19 kept)",
    },
    {
      role: "siteRegistry",
      proxy: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
      implementations: ["0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f"],
      note: "TapeKit config.js expectedImpl; verified on chain 2026-10-19",
    },
    {
      role: "domainBinding",
      proxy: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
      implementations: ["0x5ebf29b80789e548907c707530c3c7607c4347df"],
      note: "TapeKit config.js expectedImpl; verified on chain 2026-10-19",
    },
  ],
  rpcs: [
    { url: "https://rpc.xlayer.tech", operator: "okx", maxBatch: 10 },
    { url: "https://xlayerrpc.okx.com", operator: "okx", maxBatch: 10 },
    { url: "https://xlayer.drpc.org", operator: "drpc", maxBatch: 3, callerKeys: true },
    // thirdweb's X Layer node answers exactly like OKX on errors and out-of-range blocks,
    // so TapeKit counts it as the OKX operator (kernel/src/config.js comment).
    { url: "https://196.rpc.thirdweb.com", operator: "okx", maxBatch: 10, callerKeys: true },
  ],
  pin: {
    offset: 2,
    maxLagBlocks: 300,
    maxBlockAgeSeconds: 300,
  },
  openFeeNote: "Read live from Opener.FEE(); not a constant in TapeCI.",
};

/**
 * `DomainBinding` proxy address for the active chain (X Layer 196).
 *
 * `bind` / `isLive` / `isContainerLive` / `paidUntil` / `containerPaidUntil` all
 * live here. Kept as a named export so the binding tooling does not have to
 * re-derive it from `XLAYER_MAINNET.binding` (one source of truth, same value).
 */
export const DOMAIN_BINDING: Hex = XLAYER_MAINNET.binding;

/** Mutable observation captured while researching the ecosystem; re-read before use. */
export const OBSERVED_XLAYER_SITE = {
  name: "2.2.0.tape" as const,
  processorIndex: 0,
  tokenId: 2,
  container: "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3" as Hex,
  path: "index.html" as const,
  size: 26993,
  sha256: "0xe0f21c08c2ad09d3818d39c802153d33b6931311300d7419228d98da0a8300f0" as Hex,
  chunkCount: 2,
  fallbackPath: "index.html",
  capturedAt: "2026-10-19T14:41:00+08:00",
  note: "Live site observed while onboarding. Contents are mutable; verify at a pinned block.",
} as const;

/** Opened containers observed on X Layer. Ownership is mutable: always re-check at the pin. */
export const OBSERVED_XLAYER_CONTAINERS = [
  {
    processorIndex: 0,
    tokenId: 1,
    container: "0xE2E5FfD861C8a0b50Ce21A7bcbDD6Bb5aaC250aB" as Hex,
    note: "opened, empty file set (pathCount = 0) — good fork write target",
  },
  {
    processorIndex: 0,
    tokenId: 2,
    container: "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3" as Hex,
    note: "opened, live index.html (2 chunks) — good P0-06 verification target",
  },
] as const;

/** Resolve RPC endpoints with optional env overrides (`TAPECI_RPC_OKX`, `TAPECI_RPC_DRPC`). */
export function resolveRpcEndpoints(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RpcEndpoint[] {
  const okxOverride = env.TAPECI_RPC_OKX?.trim();
  const drpcOverride = env.TAPECI_RPC_DRPC?.trim();
  return XLAYER_MAINNET.rpcs.flatMap((endpoint) => {
    if (endpoint.operator === "okx" && okxOverride && endpoint === XLAYER_MAINNET.rpcs[0]) {
      return [{ ...endpoint, url: okxOverride }];
    }
    if (endpoint.operator === "drpc" && drpcOverride) {
      return [{ ...endpoint, url: drpcOverride }];
    }
    return [endpoint];
  });
}

/** Distinct RPC operators (a single operator counts once no matter how many endpoints it has). */
export function independentOperators(
  endpoints: readonly RpcEndpoint[] = XLAYER_MAINNET.rpcs,
): OperatorName[] {
  return [...new Set(endpoints.map((endpoint) => endpoint.operator))];
}

/** First endpoint per operator, for one-vote-per-operator reads. */
export function oneEndpointPerOperator(
  endpoints: readonly RpcEndpoint[] = XLAYER_MAINNET.rpcs,
): RpcEndpoint[] {
  const seen = new Set<string>();
  const out: RpcEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.operator)) continue;
    seen.add(endpoint.operator);
    out.push(endpoint);
  }
  return out;
}

export function implementationFor(
  chain: ChainConfig,
  role: ImplementationAllowlist["role"],
): ImplementationAllowlist {
  const found = chain.allowlist.find((entry) => entry.role === role);
  if (!found) throw new Error(`no implementation allowlist for role ${role}`);
  return found;
}

export * from "./project-config.js";
