"use client";

import { ApprovalReview, type ApprovalReviewData } from "./approval-review";
import { FeedbackButton } from "./motion-feedback";
import { useT } from "./locale-provider";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  approveDeploymentAction,
  executeDeploymentAction,
  loadDeploymentActionCapabilities,
  rollbackDeploymentAction,
} from "@/app/actions";
import type {
  DeploymentActionCapabilities,
  DeploymentActionKind,
  DeploymentActionResult,
} from "@/lib/action-types";
import { describeError } from "@/lib/errors";
import { resumeDeploymentAction, reapproveDeploymentAction } from "@/app/actions";
import { formatWeiAsOkb } from "@/lib/format";
import type { DeploymentState } from "@/lib/types";

import { ActionEligibility } from "./action-eligibility";
import { ConfirmButton } from "./confirm-button";
import { RiskNotice } from "./risk-notice";
import { WalletDeploymentActions } from "./wallet-actions";

export function DeploymentActions(props: {
  readonly deploymentId: string;
  readonly state: DeploymentState;
  readonly demoMode: boolean;
  readonly costCapWei: string | null;
  readonly review?: ApprovalReviewData;
}) {
  return props.demoMode ? (
    <DemoDeploymentActions {...props} />
  ) : (
    <WalletDeploymentActions
      deploymentId={props.deploymentId}
      state={props.state}
      costCapWei={props.costCapWei}
      review={props.review}
    />
  );
}

function DemoDeploymentActions({
  deploymentId,
  state,
  demoMode,
  costCapWei,
  review,
}: {
  readonly deploymentId: string;
  readonly state: DeploymentState;
  readonly demoMode: boolean;
  readonly costCapWei: string | null;
  readonly review?: ApprovalReviewData;
}) {
  const router = useRouter();
  const { t } = useT();
  const [capabilities, setCapabilities] = useState<DeploymentActionCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DeploymentActionKind | null>(null);
  const [outcome, setOutcome] = useState<DeploymentActionResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCapabilities(null);
    setCapabilityError(null);
    loadDeploymentActionCapabilities(deploymentId)
      .then((next) => {
        if (!cancelled) setCapabilities(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCapabilityError(describeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentId, state]);

  useEffect(() => {
    setOutcome(null);
  }, [deploymentId]);

  async function run(kind: DeploymentActionKind) {
    setPendingAction(kind);
    setOutcome(null);
    try {
      const action =
        kind === "approve"
          ? approveDeploymentAction
          : kind === "execute"
            ? executeDeploymentAction
            : kind === "resume"
              ? resumeDeploymentAction
              : kind === "reapprove"
                ? reapproveDeploymentAction
                : rollbackDeploymentAction;
      const result = await action(deploymentId);
      setOutcome(result);
      if (result.ok) router.refresh();
    } catch (error) {
      setOutcome({ ok: false, message: describeError(error), deploymentId });
    } finally {
      setPendingAction(null);
    }
  }

  // AC-P6-17: the capability is the only source of truth. Deriving an action from the
  // state string here is what let the UI render buttons the API would refuse, so the
  // state-derived context is deliberately not consulted any more.
  const busy = pendingAction !== null;
  const reason = (value: string | null | undefined, fallback: string): string =>
    value === null || value === undefined || value.length === 0 ? fallback : value;

  return (
    <section className="panel approval-card" aria-labelledby="actions-heading">
      <div className="panel-head">
        <h2 id="actions-heading">{t("approval.heading")}</h2>
        <span className="approval-state">{t(`state.${state}`)}</span>
      </div>

      {review === undefined ? null : <ApprovalReview review={review} />}

      {demoMode ? (
        <RiskNotice tone="info" title={t("demo.title")}>
          <p>{t("demo.body")}</p>
        </RiskNotice>
      ) : (
        <RiskNotice tone="warning" title={t("demo.walletUnavailable")}>
          <p>
            Approvals require an EIP-712 signature from the container owner. This console build
            does not hold keys, so approval stays disabled; use the CLI for a real approval.
          </p>
        </RiskNotice>
      )}

      {capabilityError === null ? null : (
        <RiskNotice tone="critical" title={t("demo.policyError")}>
          <p>{capabilityError}</p>
        </RiskNotice>
      )}

      <div className="action-list">
        {capabilities?.canApprove === true ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("demo.approve")}</h3>
            {/* §12.1 / Product R4: the EIP-712 message carries no `commit` field, so the
                commit is bound only through the manifest hash. Saying "you are signing
                this commit" would claim a guarantee the signature does not make. */}
            <p className="action-reason" data-testid="approval-binding-note">
              {t("approval.bindingNote")}
            </p>
            <p id="approve-reason" className="action-reason">
              {capabilities === null
                ? t("demo.checkingPolicy")
                : reason(
                    capabilities.reasons.approve,
                    t("demo.approveBlocked"),
                  )}
            </p>
          </div>
          <FeedbackButton
            type="button"
            className="button button-primary"
            data-testid="approve-button"
            busy={pendingAction === "approve"}
            disabled={capabilities === null || !capabilities.canApprove || busy}
            aria-describedby="approve-reason"
            onClick={() => {
              void run("approve");
            }}
          >
            {pendingAction === "approve" ? t("demo.approving") : t("demo.approveDeployment")}
          </FeedbackButton>
        </div>
        ) : null}

        {capabilities?.canExecute === true ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("demo.confirmExecute")}</h3>
            <p id="execute-reason" className="action-reason">
              {capabilities === null
                ? t("demo.checkingExecution")
                : reason(
                    capabilities.reasons.execute,
                    t("demo.executionBlocked"),
                  )}
            </p>
          </div>
          <ConfirmButton
            label={t("demo.execute")}
            pendingLabel={t("demo.executing")}
            confirmLabel={t("demo.confirmExecute")}
            title={t("demo.executeConfirm")}
            className="button"
            testId="execute-button"
            describedBy="execute-reason"
            disabled={capabilities === null || !capabilities.canExecute || busy}
            busy={pendingAction === "execute"}
            onConfirm={() => {
              void run("execute");
            }}
          >
            <p>
              {t("wallet.executeBody", { id: deploymentId })}
            </p>
            <p>
              {t("wallet.demoCapBody", { cap: formatWeiAsOkb(costCapWei, t("console.unknown")) })}
            </p>
          </ConfirmButton>
        </div>
        ) : null}

        {capabilities?.canResume === true ? (
          <div className="action-item">
            <div className="action-copy">
              <h3>{t("recovery.resumeTitle")}</h3>
              <p id="resume-reason" className="action-reason">
                {reason(capabilities.reasons.resume, t("recovery.resumeBlocked"))}
              </p>
            </div>
            <FeedbackButton
              type="button"
              className="button"
              busy={pendingAction === "resume"}
              data-testid="resume-button"
              disabled={busy}
              aria-describedby="resume-reason"
              onClick={() => {
                void run("resume");
              }}
            >
              {pendingAction === "resume" ? t("recovery.resuming") : t("recovery.resume")}
            </FeedbackButton>
          </div>
        ) : null}

        {capabilities?.canReapprove === true ? (
          <div className="action-item">
            <div className="action-copy">
              <h3>{t("recovery.reapproveTitle")}</h3>
              <p id="reapprove-reason" className="action-reason">
                {reason(capabilities.reasons.reapprove, t("recovery.reapproveBlocked"))}
              </p>
            </div>
            <FeedbackButton
              type="button"
              className="button"
              busy={pendingAction === "reapprove"}
              data-testid="reapprove-button"
              disabled={busy}
              aria-describedby="reapprove-reason"
              onClick={() => {
                void run("reapprove");
              }}
            >
              {pendingAction === "reapprove"
                ? t("recovery.reapproving")
                : t("recovery.reapprove")}
            </FeedbackButton>
          </div>
        ) : null}

        {capabilities?.canRollback === true ? (
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("approval.rollbackTitle")}</h3>
            <p id="rollback-reason" className="action-reason">
              {capabilities === null
                ? t("demo.checkingRollback")
                : reason(
                    capabilities.reasons.rollback,
                    t("demo.rollbackBlocked"),
                  )}
            </p>
          </div>
          <ConfirmButton
            label={t("demo.rollback")}
            pendingLabel={t("demo.requesting")}
            confirmLabel={t("demo.confirmRollback")}
            title={t("demo.rollbackConfirm")}
            className="button button-danger"
            testId="rollback-button"
            describedBy="rollback-reason"
            disabled={capabilities === null || !capabilities.canRollback || busy}
            busy={pendingAction === "rollback"}
            onConfirm={() => {
              void run("rollback");
            }}
          >
            <p>{t("console.rollbackCondition")}</p>
          </ConfirmButton>
        </div>
        ) : null}
      </div>

      {/*
        AC-P6-17: no button the server would refuse. The explanation is still shown —
        hiding the action without saying why is what makes a console feel broken.
      */}
      {capabilities === null
        ? null
        : (
            // Every action the server withheld, with its reason. `ActionEligibility`
            // skips these same sentences when the action is blocked, so the text appears
            // exactly once and is visible without opening a disclosure.
            [
              ["approve", capabilities.canApprove, capabilities.reasons.approve],
              ["execute", capabilities.canExecute, capabilities.reasons.execute],
              ["rollback", capabilities.canRollback, capabilities.reasons.rollback],
              ["resume", capabilities.canResume, capabilities.reasons.resume],
              ["reapprove", capabilities.canReapprove, capabilities.reasons.reapprove],
            ] as const
          )
            .filter(([, granted, why]) => !granted && why !== null)
            .map(([id, , why]) => (
              <p
                key={id}
                className="action-reason"
                role="status"
                data-testid={`action-blocked-${id}`}
              >
                {why}
              </p>
            ))}

      <ActionEligibility capabilities={capabilities} state={state} />

      {outcome === null ? null : (
        <RiskNotice
          tone={outcome.ok ? "success" : "critical"}
          title={outcome.ok ? t("demo.actionRecorded") : t("demo.actionRefused")}
        >
          <p>{outcome.message}</p>
          {outcome.ok && outcome.deploymentId !== null && outcome.deploymentId !== deploymentId ? (
            <p>
              <Link href={`/deployments/${outcome.deploymentId}`}>{t("demo.openNew")}</Link>
            </p>
          ) : null}
        </RiskNotice>
      )}
    </section>
  );
}
