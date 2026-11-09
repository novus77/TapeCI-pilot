import Link from "next/link";

export interface PagerProps {
  readonly page: number;
  readonly totalPages: number;
  readonly total: number;
  readonly pageSize: number;
  /** Builds the href for a target page, preserving every other parameter. */
  readonly href: (page: number) => string;
  readonly labels: {
    readonly region: string;
    readonly previous: string;
    readonly next: string;
    readonly first: string;
    readonly last: string;
    readonly summary: string;
    readonly emptyPage: string;
    readonly position: string;
  };
}

/**
 * Server-rendered pager. Plain links, so it works without JS and the URL stays
 * shareable. Disabled edges render as non-interactive text rather than dead
 * links, so keyboard users do not tab into something that does nothing.
 */
export function Pager({ page, totalPages, total, pageSize, href, labels }: PagerProps) {
  const outOfRange = page > totalPages;
  // One page means the pager is noise — unless the URL asked for a page that does
  // not exist, which must explain itself rather than look like an empty list.
  if (totalPages <= 1 && !outOfRange) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pager" aria-label={labels.region}>
      <p className="pager-summary">
        {outOfRange
          ? labels.emptyPage
              .replace("{page}", String(page))
              .replace("{totalPages}", String(totalPages))
          : labels.summary
              .replace("{first}", String(first))
              .replace("{last}", String(last))
              .replace("{total}", String(total))}
      </p>
      <div className="pager-controls">
        {page > 1 ? (
          <Link className="button button-ghost" href={href(1)} rel="first">
            {labels.first}
          </Link>
        ) : (
          <span className="button button-ghost is-disabled" aria-disabled="true">
            {labels.first}
          </span>
        )}
        {page > 1 ? (
          <Link className="button button-ghost" href={href(page - 1)} rel="prev">
            {labels.previous}
          </Link>
        ) : (
          <span className="button button-ghost is-disabled" aria-disabled="true">
            {labels.previous}
          </span>
        )}
        <span className="pager-position" aria-current="page">
          {labels.position
            .replace("{page}", String(page))
            .replace("{totalPages}", String(totalPages))}
        </span>
        {page < totalPages ? (
          <Link className="button button-ghost" href={href(page + 1)} rel="next">
            {labels.next}
          </Link>
        ) : (
          <span className="button button-ghost is-disabled" aria-disabled="true">
            {labels.next}
          </span>
        )}
        {page < totalPages ? (
          <Link className="button button-ghost" href={href(totalPages)} rel="last">
            {labels.last}
          </Link>
        ) : (
          <span className="button button-ghost is-disabled" aria-disabled="true">
            {labels.last}
          </span>
        )}
      </div>
    </nav>
  );
}
