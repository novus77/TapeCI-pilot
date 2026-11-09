"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useConnect, useSignTypedData } from "wagmi";
import { recoverTypedDataAddress } from "viem";

import { useT } from "./locale-provider";
import { describeError } from "@/lib/errors";
import { xLayer } from "@/lib/wagmi";
import {
  APPROVAL_CHAIN_ID,
  APPROVAL_DOMAIN_NAME,
  APPROVAL_DOMAIN_VERSION,
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
} from "@/lib/approval-signature";

interface Record_ {
  readonly connector: string;
  readonly address: string;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly signature: string;
  readonly recovered: string;
  readonly matches: boolean;
  readonly deviceNote: string;
  readonly signedAt: string;
  /** The exact typed data that was signed, so the record re-verifies offline. */
  readonly payload: {
    readonly domain: typeof APPROVAL_TYPES extends never ? never : Record<string, unknown>;
    readonly message: Record<string, unknown>;
  };
}

/**
 * Manual acceptance loop for wallet paths that cannot be automated: injected
 * extension, WalletConnect (phone) and hardware devices. It signs the real
 * Approval struct with a test deployment id, recovers the signer in the browser,
 * and re-verifies on the server in a later step via the exported JSON.
 */
export function WalletAcceptance() {
  const { t } = useT();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const [result, setResult] = useState<Record_ | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceNote, setDeviceNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);

  const injected = connectors.find((candidate) => candidate.id === "injected");
  const walletConnect = connectors.find((candidate) => candidate.id === "walletConnect");
  const wrongChain = isConnected && chainId !== xLayer.id;

  // Prefill the note with what we can infer, so a rushed run cannot leave it
  // empty. The user may overwrite it; hardware runs must.
  const suggestedNote = useMemo(() => {
    if (typeof navigator === "undefined") return "";
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
    const version = (/Chrome\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /Version\/(\d+)/.exec(ua))?.[1];
    const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "unknown OS";
    const wallet = connector === undefined ? "wallet" : connector.name;
    const label = `${wallet} / ${browser}${version === undefined ? "" : ` ${version}`} / ${os}`;
    return connector?.type === "walletConnect" ? `${label} (phone)` : label;
  }, [connector]);

  useEffect(() => {
    if (!noteTouched && suggestedNote.length > 0) setDeviceNote(suggestedNote);
  }, [noteTouched, suggestedNote]);

  const domain = useMemo(
    () => ({
      name: APPROVAL_DOMAIN_NAME,
      version: APPROVAL_DOMAIN_VERSION,
      chainId: APPROVAL_CHAIN_ID,
      verifyingContract: "0x0000000000000000000000000000000000000000" as const,
    }),
    [],
  );
  const message = useMemo(
    () =>
      ({
        deploymentId: `acceptance-${Date.now()}`,
        manifestHash: `0x${"11".repeat(32)}` as const,
        container: "0x0000000000000000000000000000000000000000" as const,
        costCapWei: 0n,
        nonce: `acceptance-${crypto.randomUUID()}`,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      }) as const,
    [],
  );

  const noteOk = deviceNote.trim().length >= 4;

  async function sign(): Promise<void> {
    if (address === undefined) return;
    if (!noteOk) {
      setError(t("accept.noteRequired"));
      return;
    }
    setError(null);
    try {
      const signature = await signTypedDataAsync({
        domain,
        types: APPROVAL_TYPES,
        primaryType: APPROVAL_PRIMARY_TYPE,
        message,
        account: address,
      });
      const recovered = await recoverTypedDataAddress({
        domain,
        types: APPROVAL_TYPES,
        primaryType: APPROVAL_PRIMARY_TYPE,
        message,
        signature,
      });
      setResult({
        connector: `${connector?.name ?? "unknown"} (${connector?.type ?? "?"})`,
        address,
        chainId,
        deploymentId: message.deploymentId,
        signature,
        recovered,
        matches: recovered.toLowerCase() === address.toLowerCase(),
        deviceNote,
        signedAt: new Date().toISOString(),
        payload: {
          domain,
          message: {
            deploymentId: message.deploymentId,
            manifestHash: message.manifestHash,
            container: message.container,
            costCapWei: message.costCapWei.toString(),
            nonce: message.nonce,
            expiresAt: message.expiresAt.toString(),
          },
        },
      });
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  function download(): void {
    if (result === null) return;
    const blob = new Blob([JSON.stringify({ kind: "tapeci.wallet.acceptance.v1", ...result }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wallet-acceptance-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel" aria-labelledby="accept-heading">
      <div className="panel-head">
        <h2 id="accept-heading">{t("accept.title")}</h2>
        <span className="panel-meta mono">{APPROVAL_CHAIN_ID}</span>
      </div>
      <p className="page-lede">{t("accept.lede")}</p>
      <p className="field-hint">{t("accept.fakeNote")}</p>

      <dl className="meta-grid">
        <div className="meta-item">
          <dt>{t("accept.connector")}</dt>
          <dd>{isConnected ? `${connector?.name ?? "?"} (${connector?.type ?? "?"})` : "—"}</dd>
        </div>
        <div className="meta-item">
          <dt>{t("accept.address")}</dt>
          <dd className="mono">{address ?? "—"}</dd>
        </div>
        <div className="meta-item">
          <dt>{t("accept.chain")}</dt>
          <dd>{isConnected ? (wrongChain ? t("accept.chainWrong", { chainId }) : t("accept.chainOk")) : "—"}</dd>
        </div>
      </dl>

      <div className="button-row">
        {isConnected ? null : (
          <>
            <button
              type="button"
              className="button"
              disabled={connecting || injected === undefined}
              onClick={() => injected !== undefined && connect({ connector: injected })}
            >
              {injected === undefined ? t("accept.walletMissing") : t("wallet.connect")}
            </button>
            <button
              type="button"
              className="button"
              disabled={connecting || walletConnect === undefined}
              onClick={() => walletConnect !== undefined && connect({ connector: walletConnect })}
            >
              WalletConnect
            </button>
          </>
        )}
        <button
          type="button"
          className="button button-primary"
          data-testid="accept-sign"
          disabled={!isConnected || wrongChain || signing || !noteOk}
          onClick={() => void sign()}
        >
          {signing ? t("accept.signing") : t("accept.sign")}
        </button>
      </div>

      <div className="field">
        <label htmlFor="deviceNote">{t("accept.deviceNote")}</label>
        <input
          id="deviceNote"
          value={deviceNote}
          onChange={(event) => {
            setNoteTouched(true);
            setDeviceNote(event.target.value);
          }}
          placeholder="Ledger Nano X / MetaMask 12.x / Chrome 141"
        />
        <p className="field-hint">{t("accept.deviceHint")}</p>
      </div>

      {error === null ? null : (
        <div className="notice notice-critical">
          <div className="notice-content">
            <p className="notice-title">{error}</p>
          </div>
        </div>
      )}

      {result === null ? null : (
        <div className="notice notice-success" data-testid="accept-result">
          <div className="notice-content">
            <p className="notice-title">{t("accept.resultTitle")}</p>
            <div className="notice-body">
              <p>
                {t("accept.recovered")}: <code className="mono">{result.recovered}</code>
              </p>
              <p>{result.matches ? t("accept.matches") : t("accept.mismatch")}</p>
              <p>
                {result.connector} · chain {result.chainId}
              </p>
              <div className="button-row">
                <button type="button" className="button" onClick={download}>
                  {t("accept.download")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <h3>{t("accept.stepsTitle")}</h3>
      <ul className="plain-list">
        <li>{t("accept.stepInjected")}</li>
        <li>{t("accept.stepWalletConnect")}</li>
        <li>{t("accept.stepHardware")}</li>
      </ul>
    </section>
  );
}
