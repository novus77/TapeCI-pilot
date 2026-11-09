"use client";

import { FeedbackButton } from "./motion-feedback";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { requestPreparationPlanAction } from "@/app/actions";
import type { DeploymentPreparation, ReleasePreparationRequest } from "@/lib/types";
import { useT } from "./locale-provider";

export function CompressionPreparationPanel({ deploymentId, preparation, error }: {
  readonly deploymentId: string;
  readonly preparation: DeploymentPreparation | null;
  readonly error: string | null;
}) {
  const { t } = useT();
  const router = useRouter();
  const [mode, setMode] = useState<ReleasePreparationRequest["mode"]>(preparation?.request.mode ?? "original");
  const [gatewayId, setGatewayId] = useState(preparation?.gateways.find(gateway => gateway.id === preparation.request.gatewayId)?.id ?? preparation?.gateways[0]?.id ?? "");
  const [spaFallback, setSpaFallback] = useState(preparation?.request.spaFallback ?? false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const selectedGateway = preparation?.gateways.some(gateway => gateway.id === gatewayId) ? gatewayId : preparation?.gateways[0]?.id ?? "";
  const compressed = mode !== "original";
  const noGateway = (preparation?.gateways.length ?? 0) === 0;
  const reasons = {
    DEMO_MODE: "compression.demo", PREPARATION_ROLE_REQUIRED: "compression.role",
    PROJECT_ARCHIVED: "compression.archived", PREPARATION_STATE_LOCKED: "compression.locked",
    PREPARATION_TARGET_CHANGED: "compression.targetChanged", SOURCE_ARTIFACT_UNAVAILABLE: "compression.sourceMissing",
  } as const;

  async function submit() {
    if (!preparation?.canPrepare || pending || (compressed && noGateway)) return;
    setPending(true);
    setFailure(null);
    requestId.current ??= crypto.randomUUID();
    const result = await requestPreparationPlanAction(deploymentId, requestId.current, {
      schemaVersion: "tapeci.preparation.v1", mode,
      spaFallback: compressed && spaFallback,
      ...(compressed ? { gatewayId: selectedGateway } : {}),
    });
    setPending(false);
    if (!result.ok) { setFailure(result.message); return; }
    router.push(`/deployments/${result.deploymentId}`);
    router.refresh();
  }

  return <section className="panel" aria-labelledby="compression-heading" data-testid="compression-preparation">
    <div className="panel-head"><h2 id="compression-heading">{t("compression.title")}</h2><span className="panel-meta">{t("compression.estimate")}</span></div>
    {preparation === null ? <p role="alert">{t("compression.loadError")} {error}</p> : <>
      <p className="panel-copy">{t("compression.reviewHint")}</p>
      <dl className="meta-grid">
        <div className="meta-item"><dt>{t("compression.current")}</dt><dd>{t(`compression.${preparation.request.mode}`)}</dd></div>
        <div className="meta-item"><dt>{t("compression.snapshot")}</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{preparation.snapshotSha256 ?? t("compression.noSnapshot")}</dd></div>
        <div className="meta-item"><dt>{t("compression.gatewayCurrent")}</dt><dd>{preparation.request.gatewayId ?? "—"}</dd></div>
      </dl>
      {/* §15: the recorded plan's own cost lines, so the strategy choice is made against
          numbers rather than adjectives. */}
      {preparation.cost === null ? (
        <p className="field-hint" data-testid="compression-cost-unknown">{t("compression.costUnknown")}</p>
      ) : (
        <dl className="meta-grid" data-testid="compression-cost">
          <div className="meta-item"><dt>{t("compression.costStrategy")}</dt><dd>{t(`compression.${preparation.cost.strategy}`)}</dd></div>
          <div className="meta-item"><dt>{t("compression.costFiles")}</dt><dd>{preparation.cost.physicalFiles}</dd></div>
          <div className="meta-item"><dt>{t("compression.costReused")}</dt><dd>{preparation.cost.reusedFiles}</dd></div>
          <div className="meta-item"><dt>{t("compression.costBytes")}</dt><dd>{preparation.cost.plannedBytes}</dd></div>
          <div className="meta-item"><dt>{t("compression.costChunks")}</dt><dd>{preparation.cost.plannedChunks}</dd></div>
          <div className="meta-item"><dt>{t("compression.costEstimated")}</dt><dd className="mono" data-testid="compression-cost-estimate">{preparation.cost.estimatedCostWei} wei</dd></div>
          <div className="meta-item"><dt>{t("compression.costCap")}</dt><dd className="mono">{preparation.cost.costCapWei} wei</dd></div>
          <div className="meta-item"><dt>{t("compression.costBudget")}</dt><dd>{t(preparation.cost.withinBudget ? "compression.withinBudget" : "compression.overBudget")}</dd></div>
        </dl>
      )}
      <p className="field-hint" data-testid="compression-selection">
        {t("compression.autoHint", {
          strategy: t(preparation.automaticSelection.strategy === "compressed" ? "compression.gzip-whole" : "compression.original"),
          reason: t(`compression.reason.${preparation.automaticSelection.reason}` as never),
        })}
      </p>
      <p className="field-hint">{t("compression.pinHint")}</p>
      {noGateway ? <p className="field-hint">{t("compression.noGateway")}</p> : <p className="field-hint">{t("compression.gatewayHint")}</p>}
      {!preparation.canPrepare ? <p className="action-reason">{t(reasons[preparation.unavailableReason as keyof typeof reasons] ?? "compression.unavailable")}</p> : null}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={pending || !preparation.canPrepare} className="compression-fields">
          <div className="field"><label htmlFor="compression-mode">{t("compression.strategy")}</label>
            <select id="compression-mode" value={mode} onChange={event => { setMode(event.target.value as ReleasePreparationRequest["mode"]); requestId.current = null; }}>
              <option value="original">{t("compression.original")}</option>
              {(["gzip-individual", "gzip-whole", "gzip-grouped"] as const).map(value => <option key={value} value={value} disabled={noGateway}>{t(`compression.${value}`)}</option>)}
            </select>
          </div>
          {compressed ? <>
            <div className="field"><label htmlFor="compression-gateway">{t("compression.gateway")}</label>
              <select id="compression-gateway" value={selectedGateway} onChange={event => { setGatewayId(event.target.value); requestId.current = null; }}>
                <option value="" disabled>{t("compression.chooseGateway")}</option>
                {preparation.gateways.map(gateway => <option key={gateway.id} value={gateway.id}>{gateway.id} · {gateway.origin}</option>)}
              </select>
            </div>
            <label><input type="checkbox" checked={spaFallback} onChange={event => { setSpaFallback(event.target.checked); requestId.current = null; }} /> {t("compression.spa")}</label>
          </> : null}
          <p className="field-hint">{t("compression.newPlanHint")}</p>
          <FeedbackButton type="submit" className="button" busy={pending} disabled={pending || !preparation.canPrepare || (compressed && (!selectedGateway || noGateway))}>{t(pending ? "compression.pending" : "compression.create")}</FeedbackButton>
        </fieldset>
      </form>
      {failure === null ? null : <p role="alert">{failure}</p>}
    </>}
  </section>;
}
