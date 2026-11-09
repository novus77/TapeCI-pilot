/**
 * Layout-shaped loading placeholders.
 *
 * A spinner tells the user "wait" but not what is coming; a skeleton that matches
 * the final layout keeps the page from jumping when content arrives and shows the
 * shape of the answer. Server-rendered, so it appears in the streamed shell before
 * any data is fetched.
 *
 * `aria-hidden` because the surrounding region already announces `aria-busy`; a
 * screen reader should hear one "loading" message, not a dozen empty boxes.
 */

export function SkeletonLine({ width = "100%", height = 14 }: { readonly width?: string; readonly height?: number }) {
  return <span className="skeleton skeleton-line" style={{ width, height }} aria-hidden="true" />;
}

export function SkeletonTable({
  rows = 6,
  columns = 5,
}: {
  readonly rows?: number;
  readonly columns?: number;
}) {
  return (
    <div className="skeleton-table" data-testid="skeleton-table" aria-hidden="true">
      <div className="skeleton-table-head">
        {Array.from({ length: columns }, (_, index) => (
          <span key={index} className="skeleton" style={{ height: 12, width: "70%" }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="skeleton-table-row">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <span
              key={columnIndex}
              className="skeleton"
              style={{ height: 12, width: columnIndex === 0 ? "85%" : "55%" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { readonly count?: number }) {
  return (
    <div className="skeleton-cards" data-testid="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton-card">
          <span className="skeleton" style={{ height: 11, width: "45%" }} />
          <span className="skeleton" style={{ height: 22, width: "30%" }} />
          <span className="skeleton" style={{ height: 11, width: "70%" }} />
        </div>
      ))}
    </div>
  );
}
