import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";

export const xLayerChain = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech"] },
  },
  blockExplorers: {
    default: { name: "OKX Explorer", url: "https://www.okx.com/web3/explorer/xlayer" },
  },
});

export type ReadClient = ReturnType<typeof createReadClient>;

export function createReadClient(url: string): ReturnType<typeof createPublicClient> {
  return createPublicClient({
    chain: xLayerChain,
    transport: http(url, { batch: { wait: 0, batchSize: 10 }, retryCount: 2, timeout: 20_000 }),
  });
}

/** Local Anvil fork clients: `testClient` exposes impersonation/balance/storage cheat codes. */
export function createForkClients(url: string): {
  publicClient: ReadClient;
  testClient: ReturnType<typeof createTestClient>;
} {
  const publicClient = createReadClient(url);
  const testClient = createTestClient({
    chain: xLayerChain,
    mode: "anvil",
    transport: http(url, { retryCount: 0, timeout: 30_000 }),
  });
  return { publicClient, testClient };
}

/**
 * Wallet client that broadcasts through the node with `eth_sendTransaction`.
 * Used only against a local fork with impersonated accounts; TapeCI never holds
 * a production key (PRD §7.2).
 */
export function createImpersonatedWalletClient(
  url: string,
  address: Hex,
): ReturnType<typeof createWalletClient> {
  return createWalletClient({
    chain: xLayerChain,
    transport: http(url, { retryCount: 0, timeout: 60_000 }),
    account: { address, type: "json-rpc" },
  });
}
