"use client";

/**
 * Connect a wallet to answer the only question this page is asked: "do I have a circuit?"
 * (SPEC §3.1 step 1 — "connect a wallet **or** type an address").
 *
 * Before this the page only offered a text field: a user who already had a wallet had to copy
 * an address out of it and paste it back into the same page. Connecting now navigates straight
 * to the holdings view, because that is what connecting is for.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useT } from "./locale-provider";
import { useWalletConnection } from "./wallet-connection";

export function ResourceWalletPanel({ currentAddress }: { readonly currentAddress: string | null }) {
  const { t } = useT();
  const router = useRouter();
  const wallet = useWalletConnection();

  const viewing = wallet.address?.toLowerCase() ?? null;
  const alreadyViewing = viewing !== null && viewing === currentAddress?.toLowerCase();

  useEffect(() => {
    // Only when the user has actually connected and is on the right chain; a redirect loop here
    // would make the page unusable, so the target is compared before navigating.
    if (!wallet.isConnected || wallet.wrongChain || viewing === null || alreadyViewing) return;
    router.replace(`/resources?address=${viewing}`);
  }, [wallet.isConnected, wallet.wrongChain, viewing, alreadyViewing, router]);

  if (wallet.wrongChain) {
    return (
      <div className="wallet-panel" data-testid="resources-wallet-wrong-chain">
        <p className="field-hint">{t("wallet.wrongChain", { chainId: "196" })}</p>
        <button
          type="button"
          className="button"
          disabled={wallet.switching}
          onClick={() => void wallet.switchChain()}
        >
          {wallet.switching ? t("wallet.switching") : t("wallet.switch")}
        </button>
      </div>
    );
  }

  if (wallet.isConnected && viewing !== null) {
    return (
      <p className="field-hint" data-testid="resources-wallet-connected">
        {t("resources.connectedWallet", {
          address: `${viewing.slice(0, 6)}…${viewing.slice(-4)}`,
        })}
      </p>
    );
  }

  if (!wallet.connectable) {
    return (
      <p className="field-hint" data-testid="resources-wallet-unavailable">
        {wallet.blockedReason === null ? t("wallet.noConnector") : t(wallet.blockedReason as never)}
      </p>
    );
  }

  return (
    <div className="wallet-panel" data-testid="resources-wallet">
      <div>
        <p className="card-sub">{t("resources.walletHint")}</p>
      </div>
      <button
        type="button"
        className="button button-primary"
        data-testid="resources-wallet-connect"
        disabled={wallet.connecting}
        onClick={() => void wallet.connect()}
      >
        {wallet.connecting ? t("wallet.connecting") : t("wallet.connect")}
      </button>
    </div>
  );
}
