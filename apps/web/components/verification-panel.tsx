import { formatDuration, formatInteger, formatUtcDateTime, shortValue } from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";
import type { VerificationReport } from "@/lib/types";

import { EmptyState } from "./risk-notice";

export async function VerificationPanel({
  report,
}: {
  readonly report: VerificationReport | null;
}) {
  const { t } = await getServerT();
  const flag = (value: boolean | null) => value === null ? t("console.unknown") : t(value ? "common.yes" : "common.no");
  return (
    <section className="panel panel-light" aria-labelledby="verification-heading">
      <div className="panel-head">
        <h2 id="verification-heading">{t("verify.evidence")}</h2>
        <span
          className={
            report === null
              ? "evidence-badge evidence-unknown"
              : report.releaseMatch
                ? "evidence-badge evidence-ok"
                : "evidence-badge evidence-bad"
          }
        >
          {report === null ? t("verify.noReport") : report.releaseStatus}
        </span>
      </div>
      {report === null ? (
        <EmptyState
          title={t("console.verifyEmpty")}
          message={t("console.verifyEmptyBody")}
        />
      ) : (
        <>
          <p className="panel-copy">
            {t("verify.summary", { block: report.pinnedBlockNumber === null ? t("console.unknown") : formatInteger(report.pinnedBlockNumber), operators: report.nodeOperators.join(" + "), duration: formatDuration(report.durationMs) })}{" "}
            {t(report.releaseMatch ? "verify.matchBody" : "verify.mismatchBody")}
          </p>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>releaseMatch</dt>
              <dd>{report.releaseMatch ? "true" : "false"}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("verify.chainStatus")}</dt>
              <dd>{report.status}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("verify.completed")}</dt>
              <dd>{formatUtcDateTime(report.completedAt)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("verify.registryImpl")}</dt>
              <dd className="mono" title={report.registryImplementation ?? undefined}>
                {shortValue(report.registryImplementation, 10, 6)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("verify.bindingImpl")}</dt>
              <dd className="mono" title={report.bindingImplementation ?? undefined}>
                {shortValue(report.bindingImplementation, 10, 6)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("verify.manifestCount")}</dt>
              <dd>{report.manifest.fileCount}</dd>
            </div>
          </dl>

          <h3>{t("verify.fileChecks")}</h3>
          <div className="table-wrap" role="region" aria-label={t("console.files")} tabIndex={0}>
            <table className="table table-light">
              <caption className="visually-hidden">
                {t("verify.caption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("console.path")}</th>
                  <th scope="col">{t("verify.expectedSha")}</th>
                  <th scope="col">{t("verify.actualSha")}</th>
                  <th scope="col">{t("verify.operators")}</th>
                  <th scope="col">{t("verify.result")}</th>
                </tr>
              </thead>
              <tbody>
                {report.files.map((file) => (
                  <tr key={file.path}>
                    <td className="mono">{file.path}</td>
                    <td className="mono" title={file.expectedSha256}>
                      {shortValue(file.expectedSha256, 10, 6)}
                    </td>
                    <td className="mono" title={file.actualSha256 ?? undefined}>
                      {shortValue(file.actualSha256, 10, 6)}
                    </td>
                    <td>{t(file.operatorsAgree ? "verify.agree" : "verify.disagree")}</td>
                    <td>
                      <span className={file.matched ? "light-status is-ok" : "light-status is-bad"}>
                        {file.matched ? `✓ ${t("verify.matched")}` : `✕ ${t("verify.mismatch")}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="two-col">
            <div>
              <h3>{t("verify.journal")}</h3>
              {report.journal === null ? (
                <p className="panel-copy">{t("verify.noJournal")}</p>
              ) : (
                <dl className="meta-grid">
                  <div className="meta-item">
                    <dt>{t("verify.journalComplete")}</dt>
                    <dd>{flag(report.journal.complete)}</dd>
                  </div>
                  <div className="meta-item">
                    <dt>{t("verify.verifiedFilesMatch")}</dt>
                    <dd>{flag(report.journal.verifiedFilesMatch)}</dd>
                  </div>
                  <div className="meta-item">
                    <dt>{t("verify.txOk")}</dt>
                    <dd>{flag(report.journal.transactionsOk)}</dd>
                  </div>
                  <div className="meta-item">
                    <dt>{t("verify.allMined")}</dt>
                    <dd>{flag(report.journal.allMinedBeforePin)}</dd>
                  </div>
                  <div className="meta-item">
                    <dt>{t("verify.entryLast")}</dt>
                    <dd>{flag(report.journal.entryWrittenLast)}</dd>
                  </div>
                  <div className="meta-item">
                    <dt>{t("verify.txGas")}</dt>
                    <dd>
                      {report.journal.transactionCount} / {formatInteger(report.journal.totalGasUsed)}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
            <div>
              <h3>{t("verify.finality")}</h3>
              <dl className="meta-grid">
                <div className="meta-item">
                  <dt>{t("verify.safe")}</dt>
                  <dd>
                    {report.finality.safeBlockNumber === null
                      ? t("console.unknown")
                      : formatInteger(report.finality.safeBlockNumber)}
                  </dd>
                </div>
                <div className="meta-item">
                  <dt>{t("verify.finalized")}</dt>
                  <dd>
                    {report.finality.finalizedBlockNumber === null
                      ? t("console.unknown")
                      : formatInteger(report.finality.finalizedBlockNumber)}
                  </dd>
                </div>
                <div className="meta-item">
                  <dt>{t("verify.pinnedSafe")}</dt>
                  <dd>{flag(report.finality.pinnedBlockIsSafe)}</dd>
                </div>
                <div className="meta-item">
                  <dt>{t("verify.pinnedFinalized")}</dt>
                  <dd>{flag(report.finality.pinnedBlockIsFinalized)}</dd>
                </div>
              </dl>
            </div>
          </div>

          {report.warnings.length === 0 ? null : (
            <div className="light-warning">
              <h3>{t("verify.warnings")}</h3>
              <ul className="warning-list">
                {report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="evidence-note">
            {t("verify.explainer")}
          </p>
        </>
      )}
    </section>
  );
}
