"use client";

/**
 * The one wallet control the console uses (SPEC §4 `wallet-connection.tsx`).
 *
 * Before this, each screen rewired `useAccount`/`useConnect`/`useSwitchChain` itself, so the
 * "no provider", "wrong chain" and "connecting" states could drift apart between activation
 * and approval — and one of them had already shipped a disabled button with no explanation
 * (issue P1-14). This component owns those states once.
 *
 * It deliberately does **not** own a wallet's keys or sign anything: it reports the account
 * and chain, offers to connect or switch, and renders the reason when it cannot.
 */
import { useAccount, useChainId, useConnect, useSwitchChain } from "wagmi";

import { useT } from "./locale-provider";
import { walletAvailabilityNotice, walletConnectAvailability } from "@/lib/wallet-connectors";

/** The chain this console operates on; a mismatch is reported, never silently switched. */
export const CONSOLE_CHAIN_ID = 196;

export interface WalletConnectionState {
  readonly address: `0x${string}` | null;
  readonly isConnected: boolean;
  readonly chainId: number;
  readonly wrongChain: boolean;
  /** `null` when there is nothing to fix, otherwise the i18n key explaining it. */
  readonly blockedReason: string | null;
  readonly connect: () => Promise<void>;
  readonly switchChain: () => Promise<void>;
  readonly connecting: boolean;
  readonly switching: boolean;
  /** True when a connector exists, so a control may be offered. */
  readonly connectable: boolean;
}

/**
 * The hook behind the control. Exported separately so a screen that needs the state without
 * the UI (a form, an action panel) can share exactly the same logic.
 */
export function useWalletConnection(): WalletConnectionState {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const hasInjectedProvider =
    typeof window !== "undefined" &&
    typeof (window as { ethereum?: unknown }).ethereum !== "undefined";
  const availability = walletConnectAvailability({
    connectorIds: connectors.map((connector) => connector.id),
    hasInjectedProvider,
  });
  const target =
    availability.state === "connectable"
      ? connectors.find((connector) => connector.id === availability.connectorId)
      : undefined;

  return {
    address: isConnected && address !== undefined ? (address as `0x${string}`) : null,
    isConnected,
    chainId,
    wrongChain: isConnected && chainId !== CONSOLE_CHAIN_ID,
    // The provider probe's "unknown" window is not a blocked reason: the control stays
    // usable and a click surfaces the real error (§10 forbids a silent disable).
    blockedReason:
      target === undefined ? walletAvailabilityNotice(availability) : null,
    connectable: target !== undefined,
    connecting,
    switching,
    connect: async () => {
      if (target === undefined) return;
      await connectAsync({ connector: target }).catch(() => undefined);
    },
    switchChain: async () => {
      await switchChainAsync({ chainId: CONSOLE_CHAIN_ID }).catch(() => undefined);
    },
  };
}

/**
 * A compact status line plus, when needed, the actions to fix it.
 *
 * `children` renders only when the wallet is connected and on the right chain, so a caller
 * cannot accidentally offer a signing action in a state where signing would fail.
 */
export function WalletConnection({
  children,
  testId = "wallet-connection",
}: {
  readonly children?: React.ReactNode;
  readonly testId?: string;
}) {
  const { t } = useT();
  const wallet = useWalletConnection();

  if (wallet.isConnected && !wallet.wrongChain) {
    return (
      <div className="wallet-connection" data-testid={testId} data-state="connected">
        <p className="field-hint" data-testid={`${testId}-address`}>
          {t("wallet.connectedAs", {
            address:
              wallet.address === null
                ? "—"
                : `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
          })}
        </p>
        {children}
      </div>
    );
  }

  if (wallet.wrongChain) {
    return (
      <div className="wallet-connection" data-testid={testId} data-state="wrong-chain">
        <p className="field-hint" data-testid={`${testId}-reason`}>
          {t("wallet.wrongChain", { chainId: String(CONSOLE_CHAIN_ID) })}
        </p>
        <button
          type="button"
          className="button"
          data-testid={`${testId}-switch`}
          disabled={wallet.switching}
          onClick={() => void wallet.switchChain()}
        >
          {wallet.switching ? t("wallet.switching") : t("wallet.switch")}
        </button>
      </div>
    );
  }

  // Not connected. If there is no connector at all, say so — that is the state that used to
  // render as a dead button.
  if (!wallet.connectable) {
    return (
      <div className="wallet-connection" data-testid={testId} data-state="unavailable">
        <p className="field-hint" data-testid={`${testId}-reason`}>
          {wallet.blockedReason === null ? t("wallet.noConnector") : t(wallet.blockedReason as never)}
        </p>
      </div>
    );
  }

  return (
    <div className="wallet-connection" data-testid={testId} data-state="disconnected">
      <button
        type="button"
        className="button button-primary"
        data-testid={`${testId}-connect`}
        disabled={wallet.connecting}
        onClick={() => void wallet.connect()}
      >
        {wallet.connecting ? t("wallet.connecting") : t("wallet.connect")}
      </button>
    </div>
  );
}
