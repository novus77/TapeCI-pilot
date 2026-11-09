import Link from "next/link";
import { WorkbenchWallet } from "./workbench-wallet";

import { translate, type Locale } from "@/lib/i18n";
import type { DeploymentSummary } from "@/lib/types";

/**
 * The workbench rail (Precision Console): what needs a human, then what the wallet holds.
 *
 * "Awaiting approval" is derived from the state machine (`AWAITING_APPROVAL`), which is a
 * different fact from "needs attention" — the latter also counts failures and conflicts, and
 * conflating them would tell an operator there is an approval to sign when there is only a
 * broken build to look at.
 */
export function WorkbenchPending({ pending, locale }: {
  readonly pending: readonly DeploymentSummary[];
  readonly locale: Locale;
}) {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const first = pending[0];
  return <section className="panel rail-card workbench-pending" data-testid="workbench-pending" aria-labelledby="pending-title">
    <div className="rail-head"><h2 id="pending-title">{t("workbench.pendingTitle")}</h2><span className={pending.length ? "tag pending" : "tag"}>{t("workbench.pendingCount", { count: pending.length })}</span></div>
    {first === undefined ? <p className="rail-note">{t("workbench.pendingEmpty")}</p> : <>
      <p className="rail-project" title={first.project?.repoFullName}>{first.project?.repoFullName.split("/").at(-1) ?? first.projectId}</p>
      <p className="rail-meta mono">{first.commitSha.slice(0, 8)} · {first.project?.defaultBranch ?? "—"}</p>
      <p className="rail-note pending-description">{t("workbench.pendingBody")}</p>
      <dl className="rail-facts"><div><dt>{t("workbench.currentStage")}</dt><dd>{t("workbench.stageApproval")}</dd></div><div><dt>{t("workbench.executionState")}</dt><dd>{t("workbench.notUploaded")}</dd></div></dl>
      <Link className="button button-primary button-block" href={`/deployments/${first.id}`}>{t("workbench.review")} →</Link>
      {pending.length > 1 ? <Link className="rail-more" href="/deployments?scope=approval&limit=10">{t("workbench.morePending", { count: pending.length - 1 })}</Link> : null}
    </>}
  </section>;
}

export function WorkbenchRail({ locale, snapshotSize }: {
  readonly locale: Locale;
  readonly snapshotSize: number;
}) {
  return <aside className="workbench-rail" aria-label={translate(locale, "workbench.railLabel")}>
    <WorkbenchWallet />
    <p className="rail-footnote">{translate(locale, "workbench.railFootnote", { count: snapshotSize })}</p>
  </aside>;
}
