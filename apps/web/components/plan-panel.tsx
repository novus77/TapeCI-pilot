import { getServerT } from "@/lib/i18n-server";
import {
  formatBytes,
  formatGwei,
  formatInteger,
  formatUtcDateTime,
  formatWeiAsOkb,
  shortValue,
} from "@/lib/format";
import type { DeploymentPlan } from "@/lib/types";

import { EmptyState, RiskNotice } from "./risk-notice";

export async function PlanPanel({ plan }: { readonly plan: DeploymentPlan | null }) {
  const { t } = await getServerT();
  return (
    <section className="panel" aria-labelledby="plan-heading">
      <div className="panel-head">
        <h2 id="plan-heading">{t("plan.title")}</h2>
        <span className="panel-meta mono">{plan?.schemaVersion ?? "not planned"}</span>
      </div>
      {plan === null ? (
        <EmptyState
          title={t("plan.noPlan")}
          message={t("console.planEmpty")}
        />
      ) : (
        <>
          {plan.blocked ? (
            <RiskNotice tone="critical" title={t("plan.blocked")}>
              <ul className="plain-list">
                {plan.blockedReasons.map((reason) => (
                  <li key={reason}>
                    <code>{reason}</code>
                  </li>
                ))}
              </ul>
              <p>{t("plan.blockedBody")}</p>
            </RiskNotice>
          ) : (
            <p className="panel-copy">
              {t("console.planSummary", { block: formatInteger(plan.pinnedBlockNumber) })}
            </p>
          )}
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("plan.release")}</dt>
              <dd className="mono">{plan.releaseId}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.entryPath")}</dt>
              <dd className="mono">{plan.entryPath}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.pinnedHash")}</dt>
              <dd className="mono" title={plan.pinnedBlockHash}>
                {shortValue(plan.pinnedBlockHash, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.rpcOperators")}</dt>
              <dd>{plan.operators.join(" + ")}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.containerOwner")}</dt>
              <dd className="mono" title={plan.containerOwner ?? undefined}>
                {shortValue(plan.containerOwner, 10, 6)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.containerOpened")}</dt>
              <dd>{t(plan.containerOpened ? "common.yes" : "common.no")}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("plan.observedAt")}</dt>
              <dd>{formatUtcDateTime(plan.observedAt)}</dd>
            </div>
          </dl>
          <div className="two-col">
            <div>
              <h3>{t("plan.totals")}</h3>
              <dl className="meta-grid">
                <div className="meta-item">
                  <dt>{t("plan.files")}</dt>
                  <dd>{plan.totals.files}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.writes")}</dt>
                  <dd>
                    {plan.totals.writes} / {plan.totals.unchanged} / {plan.totals.conflicts}
                  </dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.chunks")}</dt>
                  <dd>{plan.totals.chunks}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.bytes")}</dt>
                  <dd>{formatBytes(plan.totals.bytes)}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3>{t("plan.fees")}</h3>
              <dl className="meta-grid">
                <div className="meta-item">
                  <dt>{t("plan.gasPrice")}</dt>
                  <dd>{formatGwei(plan.fees.gasPriceWei, t("console.unknown"))}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.estimatedGas")}</dt>
                  <dd>{formatInteger(plan.fees.estimatedGas)}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.estimatedCost")}</dt>
                  <dd>{formatWeiAsOkb(plan.fees.estimatedCostWei, t("console.unknown"))}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.recommendedCap")}</dt>
                  <dd>{formatWeiAsOkb(plan.fees.recommendedCapWei, t("console.unknown"))}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.approvedCap")}</dt>
                  <dd>{formatWeiAsOkb(plan.fees.costCapWei, t("console.unknown"))}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("plan.withinBudget")}</dt>
                  <dd>{t(plan.fees.withinBudget ? "common.yes" : "common.no")}</dd>
                </div>
              </dl>
            </div>
          </div>
          {plan.warnings.length === 0 ? null : (
            <RiskNotice tone="warning" title={t("plan.warnings")}>
              <ul className="warning-list">
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </RiskNotice>
          )}
        </>
      )}
    </section>
  );
}
