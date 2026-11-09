import { RetryButton } from "./retry-button";
import { RiskNotice } from "./risk-notice";

export function ErrorNotice({
  title = "Could not load this page",
  message,
  hint,
  retryLabel,
}: {
  readonly title?: string;
  readonly message: string;
  readonly hint?: string;
  /** Omitted on pages where a refresh cannot help (for example a 404). */
  readonly retryLabel?: string;
}) {
  return (
    <RiskNotice tone="critical" title={title}>
      <p>{message}</p>
      {hint === undefined ? null : <p>{hint}</p>}
      <div className="notice-actions">
        <RetryButton label={retryLabel} />
      </div>
    </RiskNotice>
  );
}
