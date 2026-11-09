import { MotionBadge } from "./motion-feedback";
import type { ReleaseStage } from "@/lib/states";
import { stageInfo } from "@/lib/states";
import { translate, type Locale } from "@/lib/i18n";
import type { DeploymentState } from "@/lib/types";

/** Text + colour + symbol, never colour alone. */
export function StageBadge({
  stage,
  state,
  locale = "en",
  currentState = false,
}: {
  readonly stage: ReleaseStage;
  readonly state?: DeploymentState;
  readonly locale?: Locale;
  readonly currentState?: boolean;
}) {
  const info = stageInfo(stage, state, locale);
  const label = currentState && state !== undefined ? translate(locale, `state.${state}`) : info.label;
  return (
    <MotionBadge
      className={`badge badge-${info.tone}`}
      data-stage={stage}
      data-tone={info.tone}
      title={info.description}
      aria-label={label}
      label={label}
      symbol={info.symbol}
    />
  );
}

export function StateChip({ state }: { readonly state: DeploymentState }) {
  return (
    <span className="state-chip mono" title={`Durable deployment state: ${state}`}>
      {state}
    </span>
  );
}

export function StatusChip({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
}) {
  const symbol = tone === "success" ? "✓" : tone === "warning" ? "▲" : tone === "danger" ? "✕" : "·";
  return (
    <MotionBadge className={`status-chip status-${tone}`} data-tone={tone} label={label} symbol={symbol} />
  );
}
