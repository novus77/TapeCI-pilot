import type { MessageKey } from "@/lib/i18n";
import { getServerT } from "@/lib/i18n-server";
import { ACTIVE_RELEASE_STAGES, stageInfo, type ReleaseStage } from "@/lib/states";

import { StageBadge } from "./stage-badge";

/** The four active stages are exactly the ones the PRD legend describes. */
const LEGEND_BODY_KEYS: Readonly<Partial<Record<ReleaseStage, MessageKey>>> = {
  BUILD_SUCCESS: "legend.buildBody",
  UPLOADED: "legend.uploadedBody",
  VERIFIED: "legend.verifiedBody",
  LIVE: "legend.liveBody",
};

/**
 * The four PRD states rendered side by side. The descriptions make the
 * distinction explicit so a build can never be mistaken for a deployment.
 */
export async function ReleaseLegend() {
  const { locale, t } = await getServerT();
  return (
    <ul className="legend-grid" data-testid="release-legend">
      {ACTIVE_RELEASE_STAGES.map((stage) => {
        const info = stageInfo(stage);
        const bodyKey = LEGEND_BODY_KEYS[stage];
        return (
          <li key={stage} className={`legend-card legend-${info.tone}`} data-stage={stage}>
            <StageBadge stage={stage} locale={locale} />
            <p className="legend-copy">{bodyKey === undefined ? info.description : t(bodyKey)}</p>
          </li>
        );
      })}
    </ul>
  );
}
