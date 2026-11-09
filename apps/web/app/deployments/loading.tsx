import { getServerT } from "@/lib/i18n-server";
import { SkeletonLine, SkeletonTable } from "@/components/skeleton";

/** The deployments page is dominated by its table, so the skeleton mirrors that. */
export default async function Loading() {
  const { t } = await getServerT();
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-busy="true">
      <p className="visually-hidden">{t("common.loading")}</p>
      <div className="page-loading-head">
        <SkeletonLine width="30%" height={22} />
        <SkeletonLine width="55%" height={12} />
      </div>
      <SkeletonLine width="100%" height={64} />
      <SkeletonTable rows={10} columns={5} />
    </div>
  );
}
