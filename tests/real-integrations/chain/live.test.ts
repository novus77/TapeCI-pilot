import { describe, expect, it } from "vitest";
import { OBSERVED_XLAYER_SITE, XLAYER_MAINNET, oneEndpointPerOperator } from "@tapeci/config";
import { assertContainerVerified, inspectContainer } from "@tapeci/chain";
import { createPublicClient, http } from "viem";
import { xLayerChain } from "@tapeci/chain";
import {
  evaluatePreflightEvidence,
  type PreflightObservation,
} from "../../../scripts/real-integrations/chain/preflight.js";
import { requireRealIntegrationOptIn } from "../../../scripts/real-integrations/chain/common.js";
import {
  evaluateGatewayEvidence,
  type GatewayObservation,
} from "../../../scripts/real-integrations/chain/gateway.js";
import {
  collectGatewayNetworkObservation,
  collectTransactionObservation,
  type TransactionReader,
} from "../../../scripts/real-integrations/chain/readers.js";
import { evaluateTransactionEvidence } from "../../../scripts/real-integrations/chain/transaction.js";
import { bindingAbi, checkImplementation } from "@tapeci/chain";

const ENABLED = process.env.TAPECI_REAL_INTEGRATION === "1";
const OWNER = process.env.TAPECI_REAL_EXPECTED_OWNER?.trim();
const CONTAINER = process.env.TAPECI_REAL_CONTAINER?.trim() ?? OBSERVED_XLAYER_SITE.container;
const BUDGET_CAP_WEI = BigInt(process.env.TAPECI_REAL_BUDGET_CAP_WEI?.trim() ?? "1000000000000000");

describe.runIf(ENABLED)("live X Layer read-only preflight", () => {
  function unbatchedReader(endpoint: (typeof XLAYER_MAINNET.rpcs)[number]): TransactionReader {
    return {
      operator: endpoint.operator,
      url: endpoint.url,
      client: createPublicClient({
        chain: xLayerChain,
        transport: http(endpoint.url, { retryCount: 2, timeout: 20_000 }),
      }),
    };
  }

  it("collects two-operator owner/container evidence without signing or sending", async () => {
    requireRealIntegrationOptIn(process.env);
    expect(OWNER, "set TAPECI_REAL_EXPECTED_OWNER for a write-capable preflight").toBeDefined();
    if (OWNER === undefined) return;

    const endpoints = oneEndpointPerOperator(XLAYER_MAINNET.rpcs);
    const heads = await Promise.all(
      endpoints.map(async (endpoint) => {
        const client = createPublicClient({
          chain: xLayerChain,
          transport: http(endpoint.url, { retryCount: 2, timeout: 20_000 }),
        });
        return { endpoint, client, head: await client.getBlockNumber({ cacheTime: 0 }) };
      }),
    );
    const secondHighest = heads
      .map((entry) => entry.head)
      .sort((left, right) => (left > right ? -1 : left < right ? 1 : 0))[1];
    expect(secondHighest).toBeDefined();
    if (secondHighest === undefined) return;
    const pinnedBlock = secondHighest - BigInt(XLAYER_MAINNET.pin.offset);

    const observations = await Promise.all(
      heads.map(async ({ endpoint, client, head }): Promise<PreflightObservation> => {
        const [chainId, block, inspection, signerBalanceWei, gasPriceWei] = await Promise.all([
          client.getChainId(),
          client.getBlock({ blockNumber: pinnedBlock }),
          // A live evidence run must fail loudly on a failed read rather than record
          // "not opened"; `assertContainerVerified` throws instead of guessing (§8.6).
          inspectContainer(client, XLAYER_MAINNET, CONTAINER as `0x${string}`, pinnedBlock).then(
            assertContainerVerified,
          ),
          client.getBalance({
            address: OWNER as `0x${string}`,
            blockNumber: pinnedBlock,
          }),
          client.getGasPrice(),
        ]);
        if (block.hash === null) throw new Error(`block ${pinnedBlock} has no hash`);
        return {
          operator: endpoint.operator,
          rpcHost: new URL(endpoint.url).hostname,
          chainId,
          head,
          pinnedBlock,
          blockHash: block.hash,
          gasPriceWei,
          signerBalanceWei,
          container: {
            address: inspection.container,
            tokenChainId: inspection.tokenChainId,
            derivedMatches: inspection.derivedMatches,
            isProcessor: inspection.isProcessor,
            owner: inspection.owner,
            opened: inspection.opened,
            readStatus: inspection.readStatus,
          },
          error: null,
        };
      }),
    );

    const evidence = evaluatePreflightEvidence(observations, {
      chainId: 196,
      container: CONTAINER,
      owner: OWNER,
      signer: OWNER,
      budgetCapWei: BUDGET_CAP_WEI,
    });
    console.log(JSON.stringify(evidence, null, 2));
    expect(evidence.status).toBe("READY");
  });

  it("reconciles an existing transaction receipt, actual fee, and adjacent balance debit", async () => {
    const hash = process.env.TAPECI_REAL_TX_HASH?.trim();
    const from = process.env.TAPECI_REAL_TX_FROM?.trim();
    const to = process.env.TAPECI_REAL_TX_TO?.trim();
    if (hash === undefined || from === undefined || to === undefined) {
      expect("TAPECI_REAL_TX_HASH/FROM/TO").toBe("documented in docs/real-integrations/chain-gateway.md");
      return;
    }
    const readers = oneEndpointPerOperator(XLAYER_MAINNET.rpcs).map(unbatchedReader);
    const observations = await Promise.all(
      readers.map((reader) =>
        collectTransactionObservation(reader, {
          chainId: 196,
          hash: hash as `0x${string}`,
          from,
          to,
          valueWei: 0n,
          balanceBeforeBlock: 74093810n,
        }),
      ),
    );
    const evidence = evaluateTransactionEvidence(observations, {
      chainId: 196,
      hash: hash as `0x${string}`,
      from: from as `0x${string}`,
      to: to as `0x${string}`,
      maxFeeWei: 20_000_000_000_000n,
      minConfirmations: 12,
    });
    expect(evidence.status).toBe("VERIFIED");
  });

  it("proves DomainBinding LIVE and HTTPS/DNS/TLS evidence for the published name", async () => {
    const domain = process.env.TAPECI_REAL_DOMAIN?.trim() ?? "10.2.4.tape";
    const url = process.env.TAPECI_REAL_URL?.trim() ?? "https://10-2-4.tapekit.org/";
    const expectedHash =
      process.env.TAPECI_REAL_CONTENT_SHA256?.trim() ??
      "0x3cae50fd41819c41851cc8fe28d07d2f3c686298571194857033ac1d61da1941";
    const readers = oneEndpointPerOperator(XLAYER_MAINNET.rpcs).map(unbatchedReader);
    const heads = await Promise.all(
      readers.map(async (reader) => ({
        reader,
        head: await reader.client.getBlockNumber({ cacheTime: 0 }),
      })),
    );
    const secondHighest = heads
      .map((entry) => entry.head)
      .sort((left, right) => (left > right ? -1 : left < right ? 1 : 0))[1];
    expect(secondHighest).toBeDefined();
    if (secondHighest === undefined) return;
    const pinnedBlock = secondHighest - 2n;
    const bindingAllowlist = XLAYER_MAINNET.allowlist.find(
      (entry) => entry.role === "domainBinding",
    );
    expect(bindingAllowlist).toBeDefined();
    if (bindingAllowlist === undefined) return;
    const [chain, network] = await Promise.all([
      Promise.all(
        heads.map(async ({ reader }): Promise<GatewayObservation["chain"][number]> => {
          const [chainId, block, implementation, isLive, isContainerLive, paidUntilUnix] =
            await Promise.all([
              reader.client.getChainId(),
              reader.client.getBlock({ blockNumber: pinnedBlock }),
              checkImplementation(reader.client, bindingAllowlist, pinnedBlock),
              reader.client.readContract({
                address: XLAYER_MAINNET.binding,
                abi: bindingAbi,
                functionName: "isLive",
                args: [domain, CONTAINER as `0x${string}`],
                blockNumber: pinnedBlock,
              }),
              reader.client.readContract({
                address: XLAYER_MAINNET.binding,
                abi: bindingAbi,
                functionName: "isContainerLive",
                args: [CONTAINER as `0x${string}`],
                blockNumber: pinnedBlock,
              }),
              reader.client.readContract({
                address: XLAYER_MAINNET.binding,
                abi: bindingAbi,
                functionName: "containerPaidUntil",
                args: [CONTAINER as `0x${string}`],
                blockNumber: pinnedBlock,
              }),
            ]);
          return {
            operator: reader.operator,
            rpcHost: new URL(reader.url).hostname,
            chainId,
            pinnedBlock,
            blockHash: block.hash ?? `0x${"00".repeat(32)}`,
            isLive,
            isContainerLive,
            paidUntilUnix: BigInt(paidUntilUnix),
            error: implementation.allowlisted
              ? null
              : "DomainBinding implementation not allowlisted",
          };
        }),
      ),
      collectGatewayNetworkObservation(url),
    ]);
    const evidence = evaluateGatewayEvidence(
      { chain, dns: network.dns, tls: network.tls, http: network.http },
      {
        chainId: 196,
        domain,
        container: CONTAINER,
        url,
        expectedContentSha256: expectedHash as `0x${string}`,
        now: new Date(),
      },
    );
    expect(evidence.status).toBe("VERIFIED");
  });
});
