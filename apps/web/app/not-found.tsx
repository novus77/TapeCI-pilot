import Link from "next/link";

import { getServerT } from "@/lib/i18n-server";

export default async function NotFound() {
  const { t } = await getServerT();
  return (
    <div className="console-page page--exception page-header">
      <p className="exception-code" aria-hidden="true">404</p>
      <h1 className="page-title">{t("notFound.title")}</h1>
      <p className="lede">{t("notFound.body")}</p>
      <p>
        <Link className="button" href="/">
          {t("notFound.back")}
        </Link>
      </p>
    </div>
  );
}
