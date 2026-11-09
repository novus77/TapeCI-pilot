import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly lede?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
      <div className="page-title-row">
        <h1 className="page-title">{title}</h1>
        {actions === undefined ? null : <div className="page-actions">{actions}</div>}
      </div>
      {lede === undefined ? null : <p className="lede">{lede}</p>}
    </header>
  );
}

export function Breadcrumb({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <p className="breadcrumb">
      <Link href={href}>← {label}</Link>
    </p>
  );
}
