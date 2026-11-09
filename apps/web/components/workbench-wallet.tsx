"use client";

import Link from "next/link";
import { useT } from "./locale-provider";
import { useWalletConnection } from "./wallet-connection";

/** Connection state comes from the shared wallet provider; resource counts are never invented. */
export function WorkbenchWallet() {
  const { t } = useT();
  const wallet = useWalletConnection();
  return <section className="panel rail-card" data-testid="workbench-wallet">
    <div className="rail-head"><h2>{t("workbench.walletTitle")}</h2>
      {!wallet.isConnected ? <span className="tag">{t("workbench.walletDisconnected")}</span> : null}
    </div>
    {wallet.isConnected && wallet.address !== null ? <>
      <p className="rail-note mono">{t("wallet.connectedAs", { address: `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` })}</p>
      {wallet.wrongChain ? <p className="rail-note">{t("wallet.wrongChain", { chainId: "196" })}</p> : null}
    </> : <p className="rail-note">{t("workbench.walletBody")}</p>}
    <Link className="button button-block" href={wallet.isConnected && !wallet.wrongChain && wallet.address !== null ? `/resources?address=${wallet.address}` : "/resources"}>{t("workbench.walletConnect")}</Link>
  </section>;
}
