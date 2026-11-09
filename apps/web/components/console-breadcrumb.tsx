"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { usePathname } from "next/navigation";
import { useT } from "./locale-provider";

export function ConsoleBreadcrumb({ account }: { readonly account: string }) {
  const pathname = usePathname();
  const { t } = useT();
  const key = pathname.startsWith("/projects/new") ? "nav.newProject"
    : pathname.startsWith("/projects/") && pathname.endsWith("/settings") ? "settings.title"
    : pathname.startsWith("/projects/") && pathname.endsWith("/compare") ? "project.compare"
    : pathname.startsWith("/projects") ? "nav.projects"
    : pathname.startsWith("/deployments") ? "nav.deployments"
    : pathname.startsWith("/resources/mint") ? "mint.title"
    : pathname.startsWith("/resources/prepare") ? "prepare.title"
    : pathname.startsWith("/preparations/") ? "preparation.title"
    : pathname.startsWith("/resources") || pathname.startsWith("/containers") || pathname.startsWith("/preparations") ? "nav.resources"
    : pathname.startsWith("/organizations") ? "nav.organizations"
    : pathname.startsWith("/audit") ? "nav.audit"
    : pathname.startsWith("/webhooks") ? "nav.webhooks"
    : pathname.startsWith("/wallet-check") ? "nav.walletCheck"
    : pathname.startsWith("/login") ? "login.signIn" : "nav.overview";
  return <nav className="ctxbar-crumb" aria-label={t("topbar.context")}>
    <Link href="/">{account}</Link>
    <ChevronRight size={12} aria-hidden="true" />
    <span aria-current="page">{t(key)}</span>
  </nav>;
}
