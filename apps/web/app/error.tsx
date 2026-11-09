"use client";

import { useEffect } from "react";

import { useT } from "@/components/locale-provider";
import { RiskNotice } from "@/components/risk-notice";

export default function ErrorPage({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  const { t } = useT();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="console-page page--exception page-header">
      <p className="eyebrow">{t("error.unexpected")}</p>
      <h1 className="page-title">{t("error.title")}</h1>
      <p className="lede">
        {t("console.renderBody")}
      </p>
      <RiskNotice tone="critical" title={t("error.render")}>
        <p>{error.message}</p>
        {error.digest === undefined ? null : <p>Digest: {error.digest}</p>}
        <p>
          <button type="button" className="button" onClick={reset}>
            {t("error.retry")}
          </button>
        </p>
      </RiskNotice>
    </div>
  );
}
