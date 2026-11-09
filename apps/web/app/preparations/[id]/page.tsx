import type { Metadata } from "next";
import Link from "next/link";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { PrepareOpenPanel } from "@/components/prepare-open-panel";
import { getPreparation } from "@/lib/api";
import { ApiError, describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";
import type { PreparationTask } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Preparation" };

/**
 * `/preparations/[id]` — the task the open journey created (SPEC §3.3, §3.4, §9.1).
 *
 * The server component loads the task and reports a failed load as an error; it
 * never renders an empty page that could be mistaken for "nothing to do". Every
 * state, every step's own state, the wallet controls and the "check again" action
 * live in the client panel, because the wallet only exists in the browser.
 *
 * `product-p3.md` §2.9 and §5.3 bind the screen: a `submitted` step is "sent, not
 * yet verified"; there is no invented success terminal while no confirmation policy
 * can verify it; and a `skipped` step says why nothing was charged.
 */
export default async function PreparationPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { t } = await getServerT();

  let task: PreparationTask;
  try {
    task = await getPreparation(id);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : null;
    return (
      <>
        <PageHeader
          eyebrow={
            <>
              <Link href="/resources">{t("resources.title")}</Link> / {t("preparation.title")}
            </>
          }
          title={t("preparation.title")}
          lede={t("preparation.lede")}
        />
        <div data-testid="preparation-load-error">
          <ErrorNotice
            title={t("preparation.loadError")}
            message={
              error instanceof ApiError
                ? `${error.code}: ${error.message}`
                : describeError(error)
            }
            hint={t("preparation.loadErrorBody")}
            retryLabel={t("common.retry")}
          />
          {code === null ? null : (
            <p className="field-hint">
              {t("preparation.errorCode")}: <code className="mono">{code}</code>
            </p>
          )}
        </div>
      </>
    );
  }

  // §2.9: a terminal task will not change on its own; every other state can. The
  // panel renders the per-step sentences, so this is the task-level statement.
  const terminal =
    task.state === "completed" || task.state === "failed" || task.state === "canceled";

  return (
    <div className="console-page page--preparation">
      <PageHeader
        eyebrow={
          <>
            <Link href="/resources">{t("resources.title")}</Link> / {t("preparation.title")}
          </>
        }
        title={t("preparation.title")}
        lede={t("preparation.lede")}
      />
      <p className="field-hint" data-testid="preparation-terminal">
        {terminal ? t("preparation.terminal") : t("preparation.nonTerminal")}
      </p>
      <p className="field-hint" data-testid="preparation-id">
        {t("preparation.taskRef", { id: task.id })}
      </p>
      <PrepareOpenPanel mode="task" task={task} />
    </div>
  );
}
