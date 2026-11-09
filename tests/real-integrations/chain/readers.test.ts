import { describe, expect, it, vi } from "vitest";
import {
  collectGatewayNetworkObservation,
  collectTransactionObservation,
  type GatewayNetworkDependencies,
  type TransactionReader,
} from "../../../scripts/real-integrations/chain/readers.js";

const HASH = `0x${"ab".repeat(32)}` as const;
const BLOCK_HASH = `0x${"cd".repeat(32)}` as const;
const FROM = "0x25063c2210a0bccce3e15d250573179483275f22";
const TO = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";

describe("transaction reader", () => {
  it("only requests finalized chain state and never sends a transaction", async () => {
    const requests: string[] = [];
    const client = {
      getChainId: vi.fn(async () => 196),
      getBlockNumber: vi.fn(async () => 101n),
      getTransaction: vi.fn(async () => ({
        hash: HASH,
        from: FROM,
        to: TO,
        value: 0n,
      })),
      getTransactionReceipt: vi.fn(async () => ({
        transactionHash: HASH,
        blockNumber: 100n,
        blockHash: BLOCK_HASH,
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
      })),
      getBalance: vi.fn(async (input: { blockNumber?: bigint }) => {
        requests.push(`balance:${input.blockNumber?.toString() ?? "latest"}`);
        return input.blockNumber === 99n
          ? 1_000_000_000_000_000_000n
          : input.blockNumber === 100n
            ? 999_999_979_000_000_000n
            : 999_999_958_000_000_000n;
      }),
      sendTransaction: vi.fn(),
      writeContract: vi.fn(),
    };
    const reader = {
      operator: "okx",
      url: "https://rpc.example.test/v1/secret-key",
      client,
    } as unknown as TransactionReader;

    const observation = await collectTransactionObservation(reader, {
      chainId: 196,
      hash: HASH,
      from: FROM,
      to: TO,
      valueWei: 0n,
      balanceBeforeBlock: 99n,
    });

    expect(observation.chainId).toBe(196);
    expect(observation.rpcHost).toBe("rpc.example.test");
    expect(observation.receipt?.gasUsed).toBe(21_000n);
    expect(requests).toContain("balance:99");
    expect(JSON.stringify(observation, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    )).not.toContain("secret-key");
    expect(client.sendTransaction).not.toHaveBeenCalled();
    expect(client.writeContract).not.toHaveBeenCalled();
  });

  it("records an RPC failure as evidence instead of inventing a receipt", async () => {
    const reader = {
      operator: "drpc",
      url: "https://drpc.example.test",
      client: {
        getChainId: async () => 196,
        getBlockNumber: async () => 101n,
        getTransaction: async () => {
          throw new Error("transaction not found");
        },
        getTransactionReceipt: async () => {
          throw new Error("receipt not found");
        },
        getBalance: async () => 0n,
      },
    } as unknown as TransactionReader;

    const observation = await collectTransactionObservation(reader, {
      chainId: 196,
      hash: HASH,
      from: FROM,
      to: TO,
      valueWei: 0n,
      balanceBeforeBlock: 99n,
    });
    expect(observation.transaction).toBeNull();
    expect(observation.receipt).toBeNull();
    expect(observation.error).toContain("transaction not found");
  });
});

describe("gateway network reader", () => {
  it("collects DNS, strict TLS, and HTTPS body evidence with injectable I/O", async () => {
    const deps: GatewayNetworkDependencies = {
      resolveDns: async () => ({
        a: ["203.0.113.10"],
        aaaa: [],
        cname: [],
        errors: [],
      }),
      inspectTls: async () => ({
        strictAuthorized: true,
        hostMatches: true,
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2027-01-01T00:00:00.000Z",
        subject: "CN=tapekit.org",
        issuer: "CN=Example CA",
        error: null,
      }),
      fetchHttps: async () => ({
        status: 200,
        finalUrl: "https://10-2-4.tapekit.org/",
        contentType: "text/html",
        body: new TextEncoder().encode("hello"),
        error: null,
      }),
      sha256: async () => HASH,
    };

    const observation = await collectGatewayNetworkObservation(
      "https://user:secret@10-2-4.tapekit.org/?token=private",
      deps,
    );
    expect(observation.dns.a).toEqual(["203.0.113.10"]);
    expect(observation.http.contentSha256).toBe(HASH);
    expect(JSON.stringify(observation)).not.toContain("secret");
    expect(JSON.stringify(observation)).not.toContain("private");
  });
});
