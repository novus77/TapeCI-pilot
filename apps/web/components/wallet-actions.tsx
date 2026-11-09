"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";

import {
  approveDeploymentWithSignatureAction,
  executeDeploymentAction,
  loadApprovalPayloadAction,
  rollbackDeploymentAction,
} from "@/app/actions";
import { detectInjectedWallet } from "@/lib/approval-signature";
import { describeError } from "@/lib/errors";
import { formatWeiAsOkb } from "@/lib/format";
import type { DeploymentState } from "@/lib/types";
import { connectorRequiresInjectedProvider } from "@/lib/wallet-connectors";
import { xLayer } from "@/lib/wagmi";

import { deploymentActionContext } from "@/lib/console-views";
import { ActionEligibility } from "./action-eligibility";
import { ApprovalReview, type ApprovalReviewData } from "./approval-review";
import { FeedbackButton } from "./motion-feedback";
import { ConfirmButton } from "./confirm-button";
import { useT } from "./locale-provider";
import { ManualSignaturePanel } from "./manual-signature";
import { RiskNotice } from "./risk-notice";

const APPROVAL_TYPES = {
  Approval: [
    { name: "deploymentId", type: "string" },
    { name: "manifestHash", type: "bytes32" },
    { name: "container", type: "address" },
    { name: "costCapWei", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

type Outcome = { readonly ok: boolean; readonly message: string } | null;

/**
 * `null` until the client has mounted: the server render cannot know whether the
 * browser has an injected EIP-1193 provider, so the first paint must not claim
 * either state.
 */
type WalletPresence = "unknown" | "present" | "missing";

export function WalletDeploymentActions({
  deploymentId,
  state,
  costCapWei,
  review,
}: {
  readonly deploymentId: string;
  readonly state: DeploymentState;
  readonly costCapWei: string | null;
  readonly review?: ApprovalReviewData;
}) {
  const router = useRouter();
  const { t } = useT();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const [connectorId, setConnectorId] = useState(
    connectors.find((connector) => connector.id === "injected")?.id ?? connectors[0]?.id ?? "",
  );
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const [pending, setPending] = useState<"approve" | "execute" | "rollback" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [walletPresence, setWalletPresence] = useState<WalletPresence>("unknown");
  const [connectError, setConnectError] = useState<string | null>(null);
  const walletHintId = useId();

  // A missing `window.ethereum` is only knowable after mount, so the probe runs
  // in an effect and re-renders the panel with an actionable notice.
  useEffect(() => {
    setWalletPresence(
      typeof window !== "undefined" && !detectInjectedWallet(window) ? "missing" : "present",
    );
  }, []);

  const walletUnknown = walletPresence === "unknown";
  const injectedConnector = connectors.find((candidate) => candidate.id === connectorId);
  const selectedConnector = injectedConnector ?? connectors[0];
  const noWallet =
    walletPresence === "missing" &&
    connectorRequiresInjectedProvider(connectorId);
  const noConnector = selectedConnector === undefined;
  const wrongChain = isConnected && chainId !== xLayer.id;
  const busy = pending !== null || connecting || switching || signing;
  const { approve: canApprove, execute: canExecute, rollback: canRollback } = deploymentActionContext(state);
  const connectDisabled = connecting || noWallet || noConnector || walletUnknown;
  // The hint element only exists in these two cases; `aria-describedby` must not
  // point at an id that is not in the DOM (axe `aria-valid-attr-value`).
  const showWalletHint = noWallet || noConnector;

  async function ensureWallet(): Promise<boolean> {
    if (!isConnected) {
      if (noWallet) {
        setConnectError(t("wallet.noWalletBody"));
        return false;
      }
      if (selectedConnector === undefined) {
        setConnectError(
          t("wallet.noConnector"),
        );
        return false;
      }
      setConnectError(null);
      try {
        // `connect` (mutate) swallows failures into mutation state; the async
        // variant throws, which is what makes the failure visible here.
        await connectAsync({ connector: selectedConnector });
      } catch (error) {
        setConnectError(describeError(error));
        return false;
      }
      return false;
    }
    if (wrongChain) {
      setConnectError(null);
      try {
        await switchChainAsync({ chainId: xLayer.id });
      } catch (error) {
        setConnectError(describeError(error));
      }
      return false;
    }
    return true;
  }

  async function approve(): Promise<void> {
    if (!(await ensureWallet())) return;
    if (address === undefined) return;
    setPending("approve");
    setOutcome(null);
    try {
      const loaded = await loadApprovalPayloadAction(deploymentId);
      if (!loaded.ok) {
        setOutcome({ ok: false, message: loaded.message });
        return;
      }
      const payload = loaded.payload;
      const signature = await signTypedDataAsync({
        domain: {
          name: payload.domain.name,
          version: payload.domain.version,
          chainId: payload.domain.chainId,
          verifyingContract: payload.domain.verifyingContract as `0x${string}`,
        },
        types: APPROVAL_TYPES,
        primaryType: "Approval",
        message: {
          deploymentId: payload.message.deploymentId,
          manifestHash: payload.message.manifestHash as `0x${string}`,
          container: payload.message.container as `0x${string}`,
          costCapWei: BigInt(payload.message.costCapWei),
          nonce: payload.message.nonce,
          expiresAt: BigInt(payload.message.expiresAt),
        },
      });
      const result = await approveDeploymentWithSignatureAction(
        deploymentId,
        address,
        signature,
        payload.approval,
      );
      setOutcome(result);
      if (result.ok) router.refresh();
    } catch (error) {
      setOutcome({ ok: false, message: describeError(error) });
    } finally {
      setPending(null);
    }
  }

  async function execute(): Promise<void> {
    setPending("execute");
    setOutcome(null);
    try {
      const result = await executeDeploymentAction(deploymentId);
      setOutcome(result);
      if (result.ok) router.refresh();
    } catch (error) {
      setOutcome({ ok: false, message: describeError(error) });
    } finally {
      setPending(null);
    }
  }

  async function rollback(): Promise<void> {
    setPending("rollback");
    setOutcome(null);
    try {
      const result = await rollbackDeploymentAction(deploymentId);
      setOutcome(result);
      if (result.ok) router.refresh();
    } catch (error) {
      setOutcome({ ok: false, message: describeError(error) });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel approval-card" aria-labelledby="wallet-actions-heading">
      <div className="panel-head">
        <h2 id="wallet-actions-heading">{t("approval.heading")}</h2>
        <span className="approval-state">{t(`state.${state}`)}</span>
      </div>

      {review === undefined ? null : <ApprovalReview review={review} />}

      {canApprove ? <>
      <RiskNotice tone="info" title={t("approval.infoTitle")}>
        <p>
          {t("approval.infoBody")}
        </p>
      </RiskNotice>

      {noWallet ? (
        <RiskNotice tone="warning" title={t("wallet.noWalletTitle")}>
          <p>
            {t("wallet.noWalletBody")}
          </p>
        </RiskNotice>
      ) : null}

      {connectError === null ? null : (
        <RiskNotice tone="critical" title={t("wallet.connectFailed")}>
          <p>{connectError}</p>
          <p>
            {t("wallet.connectFailedBody")}
          </p>
        </RiskNotice>
      )}

      <ol className="wallet-steps" aria-label={t("approval.heading")}>
        <li data-state={isConnected ? "done" : noWallet ? "pending" : "active"}>{t("wallet.connect")}</li>
        <li data-state={!isConnected ? "pending" : wrongChain ? "active" : "done"}>{t("wallet.step.chain")}</li>
        <li data-state={isConnected && !wrongChain ? "active" : "pending"}>{t("wallet.step.sign")}</li>
      </ol>

      <div className="wallet-row">
        <span className={`wallet-status ${isConnected ? "is-connected" : ""}`}>
          {isConnected
            ? `${address?.slice(0, 6)}…${address?.slice(-4)}`
            : noWallet
              ? t("wallet.noWalletTitle")
              : t("wallet.notConnected")}
        </span>
        {isConnected ? null : (
          <>
            {connectors.length > 1 ? (
              <label className="wallet-connector">
                <span className="visually-hidden">{t("wallet.connector")}</span>
                <select
                  value={connectorId}
                  onChange={(event) => setConnectorId(event.target.value)}
                >
                  {connectors.map((connector) => (
                    <option key={connector.id} value={connector.id}>
                      {connector.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <FeedbackButton
              type="button"
              className="button"
              busy={connecting}
              disabled={connectDisabled}
              aria-describedby={showWalletHint ? walletHintId : undefined}
              onClick={() => {
                void ensureWallet();
              }}
            >
              {connecting ? t("wallet.connecting") : t("wallet.connect")}
            </FeedbackButton>
            {noWallet ? (
              <span className="field-hint" id={walletHintId}>
                {t("wallet.noWalletBody")}
              </span>
            ) : !noConnector ? null : (
              <span className="field-hint" id={walletHintId}>
                {t("wallet.noConnector")}
              </span>
            )}
          </>
        )}
        {wrongChain ? (
          <FeedbackButton
            type="button"
            className="button button-primary"
            busy={switching}
            disabled={switching}
            onClick={() => {
              void ensureWallet();
            }}
          >
            {switching ? t("wallet.switching") : t("wallet.switchChain")}
          </FeedbackButton>
        ) : null}
        {isConnected ? <span className="field-hint">{t("wallet.chain", { chainId })}</span> : null}
      </div>

      </> : null}

      <div className="action-list">
        {(canApprove) ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("approval.approveTitle")}</h3>
            <p className="action-reason">
              {canApprove
                ? noWallet
                  ? t("wallet.manualReason")
                  : t("wallet.ownerReason")
                : t("console.approveCondition")}
            </p>
          </div>
          <FeedbackButton
            type="button"
            className="button button-primary"
            busy={signing || pending === "approve"}
            data-testid="approve-button"
            disabled={busy || !canApprove || !isConnected || wrongChain}
            onClick={() => {
              void approve();
            }}
          >
            {pending === "approve" || signing ? t("wallet.signing") : t("wallet.approve")}
          </FeedbackButton>
        </div>
        ) : null}

        {(canExecute) ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("approval.executeTitle")}</h3>
            <p className="action-reason">
              {canExecute
                ? t("approval.executeReady")
                : t("approval.executeBlocked")}
            </p>
          </div>
          <ConfirmButton
            label={t("approval.execute")}
            pendingLabel={t("demo.executing")}
            confirmLabel={t("approval.execute")}
            title={t("demo.executeConfirm")}
            className="button"
            testId="execute-button"
            disabled={busy || !canExecute}
            busy={pending === "execute"}
            onConfirm={() => {
              void execute();
            }}
          >
            <p>
              {t("wallet.executeBody", { id: deploymentId })}
            </p>
            <p>
              {t("wallet.capBody", { cap: formatWeiAsOkb(costCapWei, t("console.unknown")) })}
            </p>
          </ConfirmButton>
        </div>
        ) : null}

        {(canRollback) ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("approval.rollbackTitle")}</h3>
            <p className="action-reason">
              {canRollback
                ? t("console.rollbackCondition")
                : t("console.rollbackCondition")}
            </p>
          </div>
          <ConfirmButton
            label={t("approval.rollback")}
            pendingLabel={t("demo.requesting")}
            confirmLabel={t("demo.confirmRollback")}
            title={t("demo.rollbackConfirm")}
            className="button button-danger"
            testId="rollback-button"
            disabled={busy || !canRollback}
            busy={pending === "rollback"}
            onConfirm={() => {
              void rollback();
            }}
          >
            <p>
              {t("console.rollbackCondition")}
            </p>
          </ConfirmButton>
        </div>
        ) : null}
      </div>

      <ActionEligibility state={state} />

      {canApprove ? (
        <ManualSignaturePanel
          deploymentId={deploymentId}
          walletDetected={!noWallet}
          onApproved={() => router.refresh()}
        />
      ) : null}

      <div aria-live="polite">
        {outcome === null ? null : (
          <RiskNotice tone={outcome.ok ? "success" : "critical"} title={outcome.ok ? t("demo.actionRecorded") : t("demo.actionRefused")}>
            <p>{outcome.message}</p>
          </RiskNotice>
        )}
      </div>
    </section>
  );
}
