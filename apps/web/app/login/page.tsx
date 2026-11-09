import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import { PageHeader } from "@/components/page-header";
import { RiskNotice } from "@/components/risk-notice";
import { apiBaseUrl, isMockMode } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const { t } = await getServerT();
  const demo = isMockMode();
  const loginUrl = `${apiBaseUrl()}/v1/auth/github/login?returnTo=/`;
  return (
    <div className="console-page page--login">
      <PageHeader
        eyebrow={
          <>
            <Link href="/">{t("login.overview")}</Link> / {t("login.title")}
          </>
        }
        title={t("login.title")}
        lede={t("login.lede")}
      />
      <section className="panel login-card" aria-labelledby="login-heading">
        <Image className="login-emblem" src="/tapeci-logo-96.png" alt="TapeCI" width={48} height={48} />
        <div className="panel-head">
          <h2 id="login-heading">{t("login.githubAccount")}</h2>
        </div>
        <div className="button-row">
          <a className="button button-primary" href={loginUrl}>
            {t("login.signIn")}
          </a>
          <Link className="button" href="/">
            {t("console.loginBack")}
          </Link>
        </div>
        {demo ? (
          <RiskNotice tone="info" title={t("login.demoMode")}>
            <p>{t("login.demoBody")}</p>
          </RiskNotice>
        ) : (
          <RiskNotice tone="warning" title={t("login.appRequired")}>
            <p>
              {t("console.loginInstall")}
            </p>
          </RiskNotice>
        )}
      </section>
    </div>
  );
}
