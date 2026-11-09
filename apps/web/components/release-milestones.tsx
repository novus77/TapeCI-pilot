import { Check } from "lucide-react";
import { Disclosure } from "./disclosure";
import { getServerT } from "@/lib/i18n-server";
import type { StageEvidence } from "@/lib/states";
import { ACTIVE_RELEASE_STAGES, deploymentStage, lifecycleRank, stageInfo } from "@/lib/states";
import type { DeploymentState } from "@/lib/types";

/** Only persisted evidence advances a node; a signature or receipt alone never implies Live. */
export async function ReleaseMilestones({ state, evidence = {} }: {
  readonly state: DeploymentState;
  readonly evidence?: StageEvidence;
}) {
  const { locale, t } = await getServerT();
  const rank = lifecycleRank(state, evidence);
  const current = deploymentStage(state, evidence);
  return <div className="release-progress">
    <div className="progress-context">
      <strong>{t("console.milestoneCurrent", { stage: stageInfo(current, state, locale).label })}</strong>
      <span>{t("milestones.count", { count: rank })}</span>
    </div>
    <ol className="milestones" aria-label={t("milestones.title")}>
      {ACTIVE_RELEASE_STAGES.map((stage, index) => {
        const info = stageInfo(stage, undefined, locale);
        const done = rank >= index + 1;
        const isCurrent = rank === index + 1;
        return <li key={stage} className={`milestone ${done ? "is-done" : ""} ${isCurrent ? "is-current" : ""}`} aria-current={isCurrent ? "step" : undefined} data-stage={stage} data-milestone={done ? "done" : "pending"}>
          <div className="milestone-track" aria-hidden="true">
            <span className="milestone-dot">{done ? <Check size={14} strokeWidth={2.5} /> : index + 1}</span>
            <span className="milestone-connector" />
          </div>
          <div className="milestone-text">
            <p className="milestone-label">{info.label}</p>
            <span className="milestone-state">{done ? t("milestones.done") : t("milestones.pending")}</span>
          </div>
        </li>;
      })}
    </ol>
    <Disclosure className="lifecycle-definitions" title={t("milestones.details")}>
      <dl className="milestone-definitions">
        {ACTIVE_RELEASE_STAGES.map(stage => {
          const info = stageInfo(stage, undefined, locale);
          return <div key={stage}><dt>{info.label}</dt><dd>{info.description}</dd></div>;
        })}
      </dl>
      <p className="milestone-evidence">{rank === 0 ? t("console.milestoneNone") : t("console.milestoneEvidence")}</p>
    </Disclosure>
  </div>;
}
