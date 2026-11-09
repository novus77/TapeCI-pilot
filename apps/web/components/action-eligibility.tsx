"use client";

import type { DeploymentActionCapabilities } from "@/lib/action-types";
import { deploymentActionContext } from "@/lib/console-views";
import type { DeploymentState } from "@/lib/types";
import { Disclosure } from "./disclosure";
import { useT } from "./locale-provider";

export function ActionEligibility({
  capabilities,
  state,
}: {
  readonly capabilities?: DeploymentActionCapabilities | null;
  readonly state?: DeploymentState;
}) {
  const { t } = useT();
  const active = state === undefined ? ["approve", "execute", "rollback"] : deploymentActionContext(state).active;
  const relevant = (action: (typeof active)[number]) => active.includes(action);
  /**
   * A blocked action's reason is rendered by the action panel itself, where it is visible
   * without opening this disclosure. Repeating it here made the same sentence appear
   * twice (a strict-mode violation in tests, and duplicate copy for a screen reader).
   */
  const granted = (action: "approve" | "execute" | "rollback"): boolean =>
    action === "approve"
      ? capabilities?.canApprove === true
      : action === "execute"
        ? capabilities?.canExecute === true
        : capabilities?.canRollback === true;
  const grantedReason = (
    action: "approve" | "execute" | "rollback",
    reason: string | null | undefined,
  ) => (granted(action) ? reason ?? null : null);
  return (
    <Disclosure className="action-eligibility" title={t("console.eligibility")}>
      <ul className="plain-list">
        {relevant("approve") ? <li>
          {t("console.approveCondition")}
          {grantedReason("approve", capabilities?.reasons.approve) ? <p>{capabilities?.reasons.approve}</p> : null}
        </li> : null}
        {relevant("execute") ? <li>
          {t("console.executeCondition")}
          {grantedReason("execute", capabilities?.reasons.execute) ? <p>{capabilities?.reasons.execute}</p> : null}
        </li> : null}
        {relevant("rollback") ? <li>
          {t("console.rollbackCondition")}
          {grantedReason("rollback", capabilities?.reasons.rollback) ? <p>{capabilities?.reasons.rollback}</p> : null}
        </li> : null}
      </ul>
    </Disclosure>
  );
}
