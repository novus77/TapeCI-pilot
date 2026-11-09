import { getServerT } from "@/lib/i18n-server";
import { SkeletonCards, SkeletonLine, SkeletonTable } from "@/components/skeleton";

/**
 * Route-level loading shell.
 *
 * Replaces a centred spinner with the shape of the page about to arrive: a title,
 * a summary and a table. One polite live region announces the wait; the
 * placeholders themselves are aria-hidden so a screen reader is not read a dozen
 * empty boxes.
 */
export default async function Loading() {
  const { t } = await getServerT();
  return (
    <div className="console-page page-loading" role="status" aria-live="polite" aria-busy="true">
      <p className="visually-hidden">{t("common.loading")}</p>
      <div className="page-loading-head">
        <SkeletonLine width="38%" height={22} />
        <SkeletonLine width="62%" height={12} />
      </div>
      <SkeletonCards count={2} />
      <SkeletonTable rows={6} columns={5} />
    </div>
  );
}
