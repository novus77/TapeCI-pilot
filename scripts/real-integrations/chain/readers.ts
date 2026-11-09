import { promises as dns } from "node:dns";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import { getAddress, type Hex } from "viem";
import type { ReadClient } from "@tapeci/chain";
import { sha256Hex } from "@tapeci/shared";
import type { TransactionObservation } from "./transaction.js";
import {
  errorMessage,
  normalizeAddress,
  normalizeHash,
  safeRpcHost,
  safeUrlEvidence,
} from "./common.js";

export interface TransactionReader {
  readonly operator: string;
  readonly url: string;
  readonly client: ReadClient;
}

export interface TransactionReadExpectation {
  readonly chainId: number;
  readonly hash: Hex;
  readonly from: string;
  readonly to: string;
  readonly valueWei: bigint;
  /** Immediately preceding block; used to prove this block's signer debit. */
  readonly balanceBeforeBlock: bigint;
}

function asNullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export async function collectTransactionObservation(
  reader: TransactionReader,
  expected: TransactionReadExpectation,
): Promise<TransactionObservation> {
  const errors: string[] = [];
  const hash = normalizeHash(expected.hash, "hash");
  const from = normalizeAddress(expected.from, "from");
  normalizeAddress(expected.to, "to");
  const [chainIdResult, headResult, transactionResult, receiptResult] =
    await Promise.allSettled([
      reader.client.getChainId(),
      reader.client.getBlockNumber({ cacheTime: 0 }),
      reader.client.getTransaction({ hash }),
      reader.client.getTransactionReceipt({ hash }),
    ]);

  const chainId = chainIdResult.status === "fulfilled" ? chainIdResult.value : -1;
  if (chainIdResult.status === "rejected") errors.push(errorMessage(chainIdResult.reason));
  const latestBlock =
    headResult.status === "fulfilled" ? headResult.value : expected.balanceBeforeBlock;
  if (headResult.status === "rejected") errors.push(errorMessage(headResult.reason));

  const transaction =
    transactionResult.status === "fulfilled"
      ? {
          hash: normalizeHash(transactionResult.value.hash, "transaction.hash"),
          from: normalizeAddress(transactionResult.value.from, "transaction.from"),
          to: asNullable(
            transactionResult.value.to === null
              ? null
              : normalizeAddress(transactionResult.value.to, "transaction.to"),
          ),
          valueWei: transactionResult.value.value,
        }
      : null;
  if (transactionResult.status === "rejected") errors.push(errorMessage(transactionResult.reason));

  const receipt =
    receiptResult.status === "fulfilled"
      ? {
          transactionHash: normalizeHash(
            receiptResult.value.transactionHash,
            "receipt.transactionHash",
          ),
          blockNumber: receiptResult.value.blockNumber,
          blockHash: normalizeHash(receiptResult.value.blockHash, "receipt.blockHash"),
          status: receiptResult.value.status,
          gasUsed: receiptResult.value.gasUsed,
          effectiveGasPriceWei: receiptResult.value.effectiveGasPrice,
        }
      : null;
  if (receiptResult.status === "rejected") errors.push(errorMessage(receiptResult.reason));

  const balanceBlock =
    receipt !== null && receipt.blockNumber > 0n
      ? receipt.blockNumber - 1n
      : expected.balanceBeforeBlock;
  const [beforeResult, afterResult] = await Promise.allSettled([
    reader.client.getBalance({ address: from, blockNumber: balanceBlock }),
    reader.client.getBalance({ address: from, blockNumber: receipt?.blockNumber ?? balanceBlock }),
  ]);
  const balanceBeforeWei = beforeResult.status === "fulfilled" ? beforeResult.value : null;
  if (beforeResult.status === "rejected") errors.push(errorMessage(beforeResult.reason));
  const balanceAfterWei = afterResult.status === "fulfilled" ? afterResult.value : null;
  if (afterResult.status === "rejected") errors.push(errorMessage(afterResult.reason));
  if (
    receipt !== null &&
    transaction !== null &&
    balanceBeforeWei !== null &&
    balanceAfterWei !== null
  ) {
    const feeWei = receipt.gasUsed * receipt.effectiveGasPriceWei;
    const expectedDebitWei = feeWei + transaction.valueWei;
    const observedDebitWei = balanceBeforeWei - balanceAfterWei;
    if (
      expected.balanceBeforeBlock === receipt.blockNumber - 1n &&
      balanceBlock === receipt.blockNumber - 1n &&
      observedDebitWei !== expectedDebitWei
    ) {
      errors.push(
        `balance debit ${observedDebitWei.toString()} != fee+value ${expectedDebitWei.toString()} between blocks ${balanceBlock.toString()} and ${receipt.blockNumber.toString()}`,
      );
    }
  }

  return {
    operator: reader.operator,
    rpcHost: safeRpcHost(reader.url),
    chainId,
    latestBlock,
    transaction,
    receipt,
    balanceBeforeWei,
    balanceAfterWei,
    error: errors.length === 0 ? null : errors.join("; "),
  };
}

export interface DnsObservation {
  readonly a: readonly string[];
  readonly aaaa: readonly string[];
  readonly cname: readonly string[];
  readonly errors: readonly string[];
}

export interface TlsObservation {
  readonly strictAuthorized: boolean;
  readonly hostMatches: boolean;
  readonly validFrom: string;
  readonly validTo: string;
  readonly subject: string;
  readonly issuer: string;
  readonly error: string | null;
}

export interface HttpObservation {
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  readonly error: string | null;
}

export interface GatewayNetworkObservation {
  readonly dns: DnsObservation;
  readonly tls: TlsObservation;
  readonly http: {
    readonly status: number;
    readonly finalUrl: string;
    readonly contentType: string | null;
    readonly contentSha256: Hex | null;
    readonly error: string | null;
  };
}

export interface GatewayNetworkDependencies {
  readonly resolveDns: (hostname: string) => Promise<DnsObservation>;
  readonly inspectTls: (hostname: string) => Promise<TlsObservation>;
  readonly fetchHttps: (url: string) => Promise<HttpObservation>;
  readonly sha256: (body: Uint8Array) => Promise<Hex>;
}

async function resolveAll(
  method: (hostname: string) => Promise<string[]>,
  hostname: string,
  errors: string[],
): Promise<string[]> {
  try {
    return await method(hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENODATA" && code !== "ENOTFOUND") errors.push(errorMessage(error));
    return [];
  }
}

export const nodeGatewayDependencies: GatewayNetworkDependencies = {
  resolveDns: async (hostname) => {
    const errors: string[] = [];
    const [a, aaaa, cname] = await Promise.all([
      resolveAll((name) => dns.resolve4(name), hostname, errors),
      resolveAll((name) => dns.resolve6(name), hostname, errors),
      resolveAll((name) => dns.resolveCname(name), hostname, errors),
    ]);
    return { a, aaaa, cname, errors };
  },
  inspectTls: async (hostname) =>
    new Promise((resolve) => {
      const socket = connectTls({
        host: hostname,
        servername: hostname,
        port: 443,
        rejectUnauthorized: true,
        timeout: 20_000,
      });
      const fail = (error: unknown): void => {
        socket.destroy();
        resolve({
          strictAuthorized: false,
          hostMatches: false,
          validFrom: "1970-01-01T00:00:00.000Z",
          validTo: "1970-01-01T00:00:00.000Z",
          subject: "",
          issuer: "",
          error: errorMessage(error),
        });
      };
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error("TLS handshake timed out")));
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        if (certificate === null || Object.keys(certificate).length === 0) {
          fail(new Error("TLS peer returned no certificate"));
          return;
        }
        const validFrom = new Date(certificate.valid_from);
        const validTo = new Date(certificate.valid_to);
        const identityError = checkServerIdentity(hostname, certificate);
        resolve({
          strictAuthorized: socket.authorized,
          hostMatches: identityError === undefined,
          validFrom: Number.isNaN(validFrom.getTime())
            ? "1970-01-01T00:00:00.000Z"
            : validFrom.toISOString(),
          validTo: Number.isNaN(validTo.getTime())
            ? "1970-01-01T00:00:00.000Z"
            : validTo.toISOString(),
          subject: Object.entries(certificate.subject)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", "),
          issuer: Object.entries(certificate.issuer)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", "),
          error:
            socket.authorized || socket.authorizationError === null
              ? null
              : String(socket.authorizationError),
        });
        socket.end();
      });
    }),
  fetchHttps: async (rawUrl) => {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "TapeCI-real-integration-readonly/1" },
      });
      const body = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        finalUrl: safeUrlEvidence(response.url),
        contentType: response.headers.get("content-type"),
        body,
        error: null,
      };
    } catch (error) {
      return {
        status: 0,
        finalUrl: safeUrlEvidence(rawUrl),
        contentType: null,
        body: new Uint8Array(),
        error: errorMessage(error),
      };
    }
  },
  sha256: async (body) => sha256Hex(body),
};

export async function collectGatewayNetworkObservation(
  rawUrl: string,
  dependencies: GatewayNetworkDependencies = nodeGatewayDependencies,
): Promise<GatewayNetworkObservation> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("gateway URL must use HTTPS");
  }
  const safeUrl = safeUrlEvidence(rawUrl);
  const safe = new URL(safeUrl);
  const [dnsObservation, tls, http] = await Promise.all([
    dependencies.resolveDns(safe.hostname),
    dependencies.inspectTls(safe.hostname),
    dependencies.fetchHttps(safeUrl),
  ]);
  return {
    dns: dnsObservation,
    tls,
    http: {
      status: http.status,
      finalUrl: http.finalUrl,
      contentType: http.contentType,
      contentSha256:
        http.error === null && http.body.length > 0
          ? await dependencies.sha256(http.body)
          : null,
      error: http.error,
    },
  };
}

export function addressesEqual(left: string | null, right: string): boolean {
  return left !== null && getAddress(left) === getAddress(right);
}
