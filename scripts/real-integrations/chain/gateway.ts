import type { Hex } from "viem";
import { TapeCiError } from "@tapeci/shared";
import {
  REAL_INTEGRATION_SCHEMA_VERSION,
  errorMessage,
  normalizeAddress,
  normalizeHash,
  safeRpcHost,
  safeUrlEvidence,
  uniqueStrings,
  unixSecondsToIso,
} from "./common.js";

export interface GatewayExpectation {
  readonly chainId: number;
  readonly domain: string;
  readonly container: string;
  readonly url: string;
  readonly expectedContentSha256: Hex;
  readonly now: Date;
}

export interface GatewayObservation {
  readonly chain: readonly {
    readonly operator: string;
    readonly rpcHost: string;
    readonly chainId: number;
    readonly pinnedBlock: bigint;
    readonly blockHash: Hex;
    readonly isLive: boolean;
    readonly isContainerLive: boolean;
    readonly paidUntilUnix: bigint;
    readonly error: string | null;
  }[];
  readonly dns: {
    readonly a: readonly string[];
    readonly aaaa: readonly string[];
    readonly cname: readonly string[];
    readonly errors: readonly string[];
  };
  readonly tls: {
    readonly strictAuthorized: boolean;
    readonly hostMatches: boolean;
    readonly validFrom: string;
    readonly validTo: string;
    readonly subject: string;
    readonly issuer: string;
    readonly error: string | null;
  };
  readonly http: {
    readonly status: number;
    readonly finalUrl: string;
    readonly contentType: string | null;
    readonly contentSha256: Hex | null;
    readonly error: string | null;
  };
}

export interface GatewayEvidence {
  readonly schema: "tapeci.real-integration.gateway.v1";
  readonly schemaVersion: typeof REAL_INTEGRATION_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly readOnly: true;
  readonly writeActionsPerformed: false;
  readonly status: "VERIFIED" | "BLOCKED";
  readonly expected: {
    readonly chainId: number;
    readonly domain: string;
    readonly container: Hex;
    readonly url: string;
    readonly expectedContentSha256: Hex;
  };
  readonly chain: readonly {
    readonly operator: string;
    readonly rpcHost: string;
    readonly chainId: number;
    readonly pinnedBlock: string;
    readonly blockHash: Hex;
    readonly isLive: boolean;
    readonly isContainerLive: boolean;
    readonly paidUntil: string | null;
    readonly error: string | null;
  }[];
  readonly dns: GatewayObservation["dns"];
  readonly tls: GatewayObservation["tls"];
  readonly http: {
    readonly status: number;
    readonly finalUrl: string;
    readonly contentType: string | null;
    readonly contentSha256: Hex | null;
    readonly error: string | null;
  } | null;
  readonly blockers: readonly string[];
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)) {
    throw new TapeCiError("INVALID_CONFIG", "domain must be a DNS name", {
      details: { field: "domain" },
    });
  }
  return domain;
}

function normalizeHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TapeCiError("INVALID_CONFIG", "url must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new TapeCiError("INVALID_CONFIG", "url must use HTTPS");
  }
  return safeUrlEvidence(raw);
}

function normalizeIso(raw: string, field: string): string {
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be an ISO timestamp`);
  }
  return new Date(millis).toISOString();
}

export function evaluateGatewayEvidence(
  observation: GatewayObservation,
  expectation: GatewayExpectation,
  observedAt = new Date().toISOString(),
): GatewayEvidence {
  const expected = {
    chainId: expectation.chainId,
    domain: normalizeDomain(expectation.domain),
    container: normalizeAddress(expectation.container, "container"),
    url: normalizeHttpUrl(expectation.url),
    expectedContentSha256: normalizeHash(
      expectation.expectedContentSha256,
      "expectedContentSha256",
    ),
  };
  const blockers = new Set<string>();
  const operators = observation.chain.map((entry) => entry.operator.trim());
  if (
    observation.chain.length < 2 ||
    operators.some((operator) => operator.length === 0) ||
    uniqueStrings(operators).length !== operators.length
  ) {
    blockers.add("operators.independent");
  }

  for (const entry of observation.chain) {
    if (entry.error !== null) blockers.add(`rpc:${entry.operator}`);
    if (entry.chainId !== expected.chainId) blockers.add(`chainId:${entry.operator}`);
    if (!entry.isLive) blockers.add("chain.domainLive");
    if (!entry.isContainerLive) blockers.add("chain.containerLive");
    if (entry.paidUntilUnix * 1000n <= BigInt(expectation.now.getTime())) {
      blockers.add("chain.paidUntil");
    }
  }
  if (observation.chain.length > 1) {
    const first = observation.chain[0];
    if (
      first !== undefined &&
      !observation.chain.every(
        (entry) =>
          entry.pinnedBlock === first.pinnedBlock &&
          entry.blockHash.toLowerCase() === first.blockHash.toLowerCase() &&
          entry.isLive === first.isLive &&
          entry.isContainerLive === first.isContainerLive &&
          entry.paidUntilUnix === first.paidUntilUnix,
      )
    ) {
      blockers.add("rpc.pinAgreement");
    }
  }

  if (
    observation.dns.a.length === 0 &&
    observation.dns.aaaa.length === 0 &&
    observation.dns.cname.length === 0
  ) {
    blockers.add("dns.records");
  }
  if (observation.dns.errors.length > 0) blockers.add("dns.errors");

  const tlsValidFrom = normalizeIso(observation.tls.validFrom, "tls.validFrom");
  const tlsValidTo = normalizeIso(observation.tls.validTo, "tls.validTo");
  if (!observation.tls.strictAuthorized || observation.tls.error !== null) {
    blockers.add("tls.trusted");
  }
  if (!observation.tls.hostMatches) blockers.add("tls.host");
  if (
    Date.parse(tlsValidFrom) > expectation.now.getTime() ||
    Date.parse(tlsValidTo) <= expectation.now.getTime()
  ) {
    blockers.add("tls.validity");
  }

  if (
    observation.http.status < 200 ||
    observation.http.status >= 300 ||
    observation.http.error !== null
  ) {
    blockers.add("http.status");
  }
  const finalUrl = safeUrlEvidence(observation.http.finalUrl);
  const expectedHost = new URL(expected.url).hostname;
  if (new URL(finalUrl).hostname !== expectedHost) blockers.add("http.origin");
  if (
    observation.http.contentSha256 === null ||
    observation.http.contentSha256.toLowerCase() !== expected.expectedContentSha256
  ) {
    blockers.add("http.contentHash");
  }

  return {
    schema: "tapeci.real-integration.gateway.v1",
    schemaVersion: REAL_INTEGRATION_SCHEMA_VERSION,
    observedAt,
    readOnly: true,
    writeActionsPerformed: false,
    status: blockers.size === 0 ? "VERIFIED" : "BLOCKED",
    expected,
    chain: observation.chain.map((entry) => ({
      operator: entry.operator,
      rpcHost: safeRpcHost(entry.rpcHost),
      chainId: entry.chainId,
      pinnedBlock: entry.pinnedBlock.toString(),
      blockHash: normalizeHash(entry.blockHash, "chain.blockHash"),
      isLive: entry.isLive,
      isContainerLive: entry.isContainerLive,
      paidUntil: unixSecondsToIso(entry.paidUntilUnix),
      error: entry.error === null ? null : errorMessage(entry.error),
    })),
    dns: {
      a: [...observation.dns.a].sort(),
      aaaa: [...observation.dns.aaaa].sort(),
      cname: [...observation.dns.cname].sort(),
      errors: observation.dns.errors.map(errorMessage),
    },
    tls: {
      strictAuthorized: observation.tls.strictAuthorized,
      hostMatches: observation.tls.hostMatches,
      validFrom: tlsValidFrom,
      validTo: tlsValidTo,
      subject: observation.tls.subject,
      issuer: observation.tls.issuer,
      error: observation.tls.error === null ? null : errorMessage(observation.tls.error),
    },
    http: {
      status: observation.http.status,
      finalUrl,
      contentType: observation.http.contentType,
      contentSha256:
        observation.http.contentSha256 === null
          ? null
          : normalizeHash(observation.http.contentSha256, "http.contentSha256"),
      error: observation.http.error === null ? null : errorMessage(observation.http.error),
    },
    blockers: [...blockers].sort(),
  };
}
