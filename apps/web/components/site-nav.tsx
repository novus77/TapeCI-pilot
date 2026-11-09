"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, CircuitBoard, FolderGit2, LayoutDashboard, Plus, Rocket, ScrollText, Webhook } from "lucide-react";

import { useT } from "./locale-provider";

const LINKS = [
  { href: "/", key: "nav.overview", Icon: LayoutDashboard },
  { href: "/resources", key: "nav.resources", Icon: CircuitBoard },
  { href: "/projects", key: "nav.projects", Icon: FolderGit2 },
  { href: "/deployments", key: "nav.deployments", Icon: Rocket },
  { href: "/projects/new", key: "nav.newProject", Icon: Plus },
  { href: "/organizations", key: "nav.organizations", Icon: Building2 },
  { href: "/audit", key: "nav.audit", Icon: ScrollText },
  { href: "/webhooks", key: "nav.webhooks", Icon: Webhook },
] as const;

/** Per-destination counts. An absent key renders no number, never 0. */
export type NavCounts = Partial<Record<"/projects" | "/deployments" | "/organizations", number>>;

export function SiteNav({ counts }: { readonly counts?: NavCounts } = {}) {
  const pathname = usePathname();
  const { t } = useT();
  return (
    <nav className="site-nav" aria-label={t("nav.primary")}>
      <ul className="nav-list">
        {LINKS.map((link) => {
          const active =
            link.href === "/" ? pathname === "/" : pathname === link.href || (pathname.startsWith(`${link.href}/`) && !(link.href === "/projects" && pathname === "/projects/new"));
          return (
            <li key={link.href}>
              <Link
                className={active ? "nav-link is-active" : "nav-link"}
                href={link.href}
                aria-current={active ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  <link.Icon size={15} strokeWidth={1.8} />
                </span>
                <span>{t(link.key)}</span>
                {counts?.[link.href as keyof NavCounts] !== undefined ? (
                  // aria-hidden: a count is a hint, not part of the link's name. Screen
                  // readers would otherwise announce "Deployments 12" as the destination.
                  <span className="nav-count" aria-hidden="true">
                    {counts[link.href as keyof NavCounts]}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
