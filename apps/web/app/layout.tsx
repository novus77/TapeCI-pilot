import type { Metadata } from "next";
import { Search } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConsoleBreadcrumb } from "@/components/console-breadcrumb";
import { Providers } from "@/app/providers";
import { LocaleProvider } from "@/components/locale-provider";
import { LocaleSwitch } from "@/components/locale-switch";
import { NotificationBell } from "@/components/notification-bell";
import { NavDrawer } from "@/components/shell-nav";
import { SearchShortcut } from "@/components/search-shortcut";
import { SiteNav, type NavCounts } from "@/components/site-nav";
import { UserMenu } from "@/components/user-menu";
import { getCurrentUser } from "@/lib/api";
import { translate } from "@/lib/i18n";
import { getLocale } from "@/lib/locale-server";

import "./globals.css";
import "./precision.css";
import "./precision-pages.css";
import "./release-review.css";

export const metadata: Metadata = {
  title: {
    default: "TapeCI — Release console",
    template: "%s · TapeCI",
  },
  description:
    "GitHub commit to verifiable DeWEB on X Layer 196. Four distinct states: Build Success, Uploaded, Verified, Live.",
  applicationName: "TapeCI",
  // Sized variants: the source asset is 1254² and 413 KB, which is wasteful in a 24px slot.
  icons: {
    icon: [
      { url: "/tapeci-logo-32.png", sizes: "32x32", type: "image/png" },
      { url: "/tapeci-logo-96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: [{ url: "/tapeci-logo-180.png", sizes: "180x180", type: "image/png" }],
  },
};

function mockMode(): boolean {
  return process.env.NEXT_PUBLIC_TAPECI_MOCK === "1" || process.env.TAPECI_MOCK === "1";
}

/**
 * Sidebar counts. A destination whose count could not be loaded is omitted rather
 * than rendered as 0, because "0 deployments" and "we did not ask" are different
 * statements and only one of them is true.
 */
async function loadNavCounts(): Promise<NavCounts> {
  // The API client decides for itself whether it is serving the mock store, so the
  // layout does not have to duplicate that switch.
  const { listDeployments, listProjects, listOrganizations } = await import("@/lib/api");
  const [deployments, projects, organizations] = await Promise.all([
    listDeployments().catch(() => null),
    listProjects().catch(() => null),
    listOrganizations().catch(() => null),
  ]);
  return {
    "/deployments": deployments?.length,
    "/projects": projects?.length,
    "/organizations": organizations?.length,
  };
}

/** Sidebar pinned projects: a short list, omitted entirely when it cannot be loaded. */
async function loadPinnedProjects(): Promise<readonly { id: string; repoFullName: string }[]> {
  const { listProjects } = await import("@/lib/api");
  try {
    const projects = await listProjects();
    return projects.slice(0, 4).map((project) => ({ id: project.id, repoFullName: project.repoFullName }));
  } catch {
    return [];
  }
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const mock = mockMode();
  const locale = await getLocale();
  // Counts and pinned projects are decoration, so they must never delay or break the shell:
  // they fall back to "no entry" on any failure rather than rendering a false zero.
  const [user, counts, pinned] = await Promise.all([
    getCurrentUser(),
    loadNavCounts(),
    loadPinnedProjects(),
  ]);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const account = user === null ? "?" : user.githubLogin.slice(0, 1).toUpperCase();

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"}>
      <body>
        <Providers>
        <LocaleProvider locale={locale}>
        <a className="skip-link" href="#main">
          {t("skip.toMain")}
        </a>

        <div className="shell">
          <aside className="shell-sidebar">
            <Link className="sidebar-brand" href="/">
              <span className="brand-logo" aria-hidden="true">
                <Image src="/tapeci-logo-96.png" alt="" width={28} height={28} priority />
              </span>
              <strong>TapeCI</strong>
              <span className="beta-chip">BETA</span>
            </Link>

            <div className="sidebar-workspace">
              <span className="avatar" aria-hidden="true">{account}</span>
              <div>
                <strong>{user?.githubLogin ?? t("login.signIn")}</strong>
                <small>{t("sidebar.personalWorkspace")}</small>
              </div>
            </div>

            <p className="sidebar-label">{t("sidebar.workspace")}</p>
            <SiteNav counts={counts} />

            {pinned.length === 0 ? null : (
              <>
                <p className="sidebar-label">{t("sidebar.pinnedProjects")}</p>
                <ul className="pinned-list">
                  {pinned.map((project) => (
                    <li key={project.id}>
                      <Link href={`/projects/${project.id}`}>
                        <span className="pin-icon" aria-hidden="true" />
                        {project.repoFullName.split("/")[1] ?? project.repoFullName}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="sidebar-bottom">
              <div className="network-card">
                <strong>
                  <span className="dot" aria-hidden="true" />
                  X Layer / 196
                </strong>
                <p>{t("sidebar.areaCode")} · {t("sidebar.twoOperators")}</p>
              </div>
              <Link className="sidebar-link" href="/wallet-check">
                {t("nav.walletCheck")}
              </Link>
            </div>
          </aside>

          <div className="shell-main">
            <header className="ctxbar">
              <NavDrawer
                labels={{
                  open: t("nav.openMenu"),
                  close: t("nav.closeMenu"),
                  title: t("nav.primary"),
                }}
              >
                <SiteNav counts={counts} />
                <div className="drawer-preferences"><Link href="/wallet-check">{t("nav.walletCheck")}</Link></div>
              </NavDrawer>
              <Link className="ctxbar-brand" href="/" aria-label="TapeCI overview">
                <Image src="/tapeci-logo-96.png" alt="" width={24} height={24} priority />
                <strong>TapeCI</strong>
              </Link>

              <ConsoleBreadcrumb account={user?.githubLogin ?? "TapeCI"} />

              <form data-console-search className="ctxbar-search" action="/deployments" method="get" role="search">
                <span className="visually-hidden">{t("topbar.search")}</span>
                <Search size={14} strokeWidth={1.8} aria-hidden="true" />
                <input
                  type="search"
                  name="q"
                  placeholder={t("topbar.searchPlaceholder")}
                  aria-label={t("topbar.searchPlaceholder")}
                />
                <kbd aria-hidden="true">⌘K</kbd>
              </form>

              <div className="ctxbar-actions">
                <Link className="ctxbar-wallet" href="/resources">
                  {t("nav.resources")}
                </Link>
                <NotificationBell />
                <LocaleSwitch />

                {user === null ? (
                  <Link
                    className="topbar-avatar"
                    href="/login"
                    title={t("login.signIn")}
                    aria-label={t("login.signIn")}
                  >
                    ?
                  </Link>
                ) : (
                  <UserMenu login={user.githubLogin} />
                )}
              </div>
            </header>

            {mock ? <p className="console-demo-strip"><span className="mock-chip">{t("topbar.mock")}</span>{t("home.mockStrip")}</p> : null}
            <SearchShortcut />
            <main id="main" className="shell-content">
              {children}
            </main>
            <footer className="site-footer">
              <div className="footer-inner">
                <p>
                  <strong>{t("footer.warning")}</strong> {t("footer.warningBody")}
                </p>
                <p className="footer-meta">
                  {t("footer.meta")}
                  {mock ? t("footer.metaMock") : ""}
                </p>
              </div>
            </footer>
          </div>
        </div>
        </LocaleProvider>
        </Providers>
      </body>
    </html>
  );
}
