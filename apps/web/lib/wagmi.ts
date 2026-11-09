import {
  createConfig,
  createConnector,
  http,
  type Connector,
  type CreateConnectorFn,
} from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { defineChain } from "viem";
import { createLazyOnce, walletConnectorKinds } from "./wallet-connectors";

/** X Layer mainnet (TapeCI chain 196). */
export const xLayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: {
    default: { name: "OKX Explorer", url: "https://www.okx.com/web3/explorer/xlayer" },
  },
});

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const connectorKinds = walletConnectorKinds(walletConnectProjectId);
const walletConnectConnector: CreateConnectorFn = createConnector((config) => {
  let delegate: Connector | null = null;
  // `createLazyOnce` drops a rejected attempt: a failed import or a refused
  // pairing must be retryable, not cached for the rest of the session.
  const loadDelegate = createLazyOnce(async (): Promise<Connector> => {
    if (typeof window === "undefined") {
      throw new Error("WalletConnect is available only in the browser");
    }
    if (walletConnectProjectId === undefined) {
      throw new Error("WalletConnect project id is not configured");
    }
    const { walletConnect } = await import("wagmi/connectors/walletConnect");
    // wagmi types the factory's return more loosely than `Connector`; the
    // runtime value satisfies the connector contract.
    return walletConnect({ projectId: walletConnectProjectId, showQrModal: true })(config) as unknown as Connector;
  });
  const getDelegate = async (): Promise<Connector> => {
    delegate ??= await loadDelegate();
    return delegate;
  };

  return {
    id: "walletConnect",
    name: "WalletConnect",
    type: "walletConnect",
    async setup() {
      if (typeof window === "undefined") return;
      await (await getDelegate()).setup?.();
    },
    async connect(parameters) {
      return (await getDelegate()).connect(parameters);
    },
    async disconnect() {
      // Never load the delegate to disconnect: a failed pairing that left no
      // delegate has nothing to disconnect, and loading here would surface an
      // import error on a control that only ever needs to clear local state.
      await delegate?.disconnect();
      delegate = null;
    },
    async getAccounts() {
      return (await getDelegate()).getAccounts();
    },
    async getChainId() {
      return (await getDelegate()).getChainId();
    },
    async getProvider(parameters) {
      return (await getDelegate()).getProvider(parameters);
    },
    async isAuthorized() {
      if (typeof window === "undefined") return false;
      return (await getDelegate()).isAuthorized();
    },
    async switchChain(parameters) {
      const delegateConnector = await getDelegate();
      const switched = await delegateConnector.switchChain?.(parameters);
      // The lazy delegate can return undefined when the wallet declines; callers
      // only care that the chain did change, so surface the requested chain.
      return switched ?? config.chains[0];
    },
    onAccountsChanged(accounts) {
      delegate?.onAccountsChanged(accounts);
    },
    onChainChanged(chainId) {
      delegate?.onChainChanged(chainId);
    },
    onConnect(connectInfo) {
      delegate?.onConnect?.(connectInfo);
    },
    onDisconnect(error) {
      delegate?.onDisconnect(error);
    },
    onMessage(message) {
      delegate?.onMessage?.(message);
    },
  };
}) as CreateConnectorFn;

export const wagmiConfig = createConfig({
  chains: [xLayer],
  connectors: [
    injected({ shimDisconnect: true }),
    ...(connectorKinds.includes("walletconnect") && walletConnectProjectId !== undefined
      ? [walletConnectConnector]
      : []),
  ],
  transports: { [xLayer.id]: http("https://rpc.xlayer.tech") },
  ssr: true,
});
