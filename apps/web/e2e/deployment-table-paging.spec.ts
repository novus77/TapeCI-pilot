import { expect, test, type Page } from "@playwright/test";

import { MOCK_DEPLOYMENT_IDS, seedDeployments } from "../lib/mock-data";

/**
 * Deployments table sorting and the real pager — `.superpowers/sdd/table-sort-pager/plan.md`
 * items 2 (sortable columns + URL state), 3 (real pager) and 4 (honest paging).
 *
 * Fixture: `seedDeployments` in `apps/web/lib/mock-data.ts`. It is imported
 * rather than hard-coded because the round added history rows to make the pager
 * meaningful; deriving the counts keeps this file honest as the fixture grows.
 * Newest `requestedAt` first:
 *
 *   d…04 docs     AWAITING_APPROVAL 2026-10-19T08:10Z   <- newest
 *   d…03 docs     VERIFYING_ASSETS  2026-10-19T07:05Z
 *   …
 *   d…05 tapekit  BUILD_FAILED      2026-10-17T12:00Z   <- oldest
 *
 * Selectors and copy pinned from the shipped components
 * (`apps/web/components/deployment-table.tsx`, `apps/web/components/pager.tsx`,
 * `apps/web/app/deployments/page.tsx`):
 *
 *   [data-testid="deployment-table"]      the table
 *   [data-testid="deployment-row"]        one row per rendered deployment
 *   thead th[aria-sort]                   "none" | "ascending" | "descending";
 *                                         the th holds `a.sort-link`
 *   nav.pager                             the pager (absent when totalPages <= 1)
 *   nav.pager .pager-summary              "Showing {first}-{last} of {total}"
 *   nav.pager .pager-position             "{page} / {totalPages}", aria-current
 *   nav.pager a[rel="next"|"prev"|"first"|"last"]
 *   nav.pager span[aria-disabled="true"]  the non-interactive edge controls
 *
 * URL state is `?sort=<key>&dir=<asc|desc>`, and the page component omits the
 * defaults (`sort=requestedAt`, `dir=desc`, `page=1`), so the URL after clicking
 * "Requested" from the default view is `?dir=asc` with no `sort` key. The
 * `sortState()` helper below resolves the omission back to `requestedAt` so the
 * assertions describe the effective sort rather than the spelling.
 */

const ROW = '[data-testid="deployment-row"]';
const TABLE = '[data-testid="deployment-table"]';
const PAGER = "nav.pager";

const PER_PAGE = 2;
const TOTAL_ROWS = seedDeployments.length;
const TOTAL_PAGES = Math.ceil(TOTAL_ROWS / PER_PAGE);
const OUT_OF_RANGE_PAGE = 999;

function pageUrl(page = 1): string {
  return `/deployments?limit=${PER_PAGE}&page=${page}`;
}

/** The `<th>` that owns a column, found by its visible label. */
function header(page: Page, label: string) {
  return page.locator(`${TABLE} thead th`).filter({ hasText: label });
}

/** The sort control inside that header (a link, per the shipped markup). */
function sortControl(page: Page, label: string) {
  return header(page, label).locator("a.sort-link, button, a[href]").first();
}

/** `aria-sort` per labelled header, for every header that declares one. */
async function ariaSorts(page: Page): Promise<Record<string, string>> {
  return page.locator(`${TABLE} thead th`).evaluateAll((headers) =>
    Object.fromEntries(
      headers
        .filter((node) => node.hasAttribute("aria-sort"))
        .map((node) => [
          (node.textContent ?? "").replace(/[▲▼↕\s]+/g, " ").trim(),
          node.getAttribute("aria-sort") ?? "",
        ]),
    ),
  );
}

/** The effective sort the URL asks for, with defaults resolved. */
function sortState(page: Page): { key: string; dir: string } {
  const url = new URL(page.url());
  const raw = url.searchParams.get("sort") ?? "requestedAt";
  const [key = "requestedAt", inline] = raw.split(":");
  const dir = inline ?? url.searchParams.get("dir") ?? "desc";
  return { key, dir };
}

/** Rendered deployment ids, in document order. */
async function renderedIds(page: Page): Promise<readonly (string | null)[]> {
  return page.locator(ROW).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-deployment-id")),
  );
}

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
});

test("a sortable header sets aria-sort on its own th and toggles on a second click", async ({
  page,
}) => {
  await page.goto("/deployments");
  await expect(page.locator(TABLE)).toBeVisible();

  // Default view is requestedAt desc, so Requested starts descending and the
  // other sortable columns say "none" — exactly one column may claim the sort.
  const requested = header(page, "Requested");
  await expect(requested).toHaveCount(1);
  await expect(requested).toHaveAttribute("aria-sort", "descending");
  await expect(header(page, "State")).toHaveAttribute("aria-sort", "none");
  await expect(header(page, "Project")).toHaveAttribute("aria-sort", "none");

  const control = sortControl(page, "Requested");
  await expect(control, "the Requested header needs a focusable sort control").toHaveCount(1);

  // Click 1 — flips to ascending, on this th and no other.
  await control.click();
  await expect(requested).toHaveAttribute("aria-sort", "ascending");
  await expect(header(page, "State")).toHaveAttribute("aria-sort", "none");
  expect(sortState(page)).toEqual({ key: "requestedAt", dir: "asc" });

  const afterFirst = await ariaSorts(page);
  expect(
    Object.values(afterFirst).filter((value) => value === "ascending" || value === "descending"),
  ).toHaveLength(1);

  // Click 2 — same header, opposite direction again.
  await control.click();
  await expect(requested).toHaveAttribute("aria-sort", "descending");
  expect(sortState(page)).toEqual({ key: "requestedAt", dir: "desc" });

  // A different column takes the marker over, and the old one goes back to none.
  await sortControl(page, "State").click();
  await expect(header(page, "State")).toHaveAttribute("aria-sort", "ascending");
  await expect(requested).toHaveAttribute("aria-sort", "none");
  expect(sortState(page).key).toBe("state");
});

test("the sort survives a reload because it lives in the URL", async ({ page }) => {
  await page.goto("/deployments?sort=state&dir=desc");
  await expect(page.locator(TABLE)).toBeVisible();
  await expect(header(page, "State")).toHaveAttribute("aria-sort", "descending");
  const before = await ariaSorts(page);
  const url = page.url();

  await page.reload();
  await expect(page.locator(TABLE)).toBeVisible();

  expect(page.url()).toBe(url);
  await expect(header(page, "State")).toHaveAttribute("aria-sort", "descending");
  expect(await ariaSorts(page)).toEqual(before);

  // The same thing through the UI, which is the path a user actually takes.
  await sortControl(page, "Project").click();
  await expect(header(page, "Project")).toHaveAttribute("aria-sort", "ascending");
  const clicked = page.url();
  expect(sortState(page)).toEqual({ key: "project", dir: "asc" });

  await page.reload();
  await expect(header(page, "Project")).toHaveAttribute("aria-sort", "ascending");
  expect(page.url()).toBe(clicked);
});

test('the pager reports "Page 1 of M"', async ({ page }) => {
  await page.goto(pageUrl(1));
  await expect(page.locator(TABLE)).toBeVisible();
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);

  // plan.md item 3 fixes the wording as "Page N of M"; the brief repeats it.
  await expect(
    page.getByText(new RegExp(`Page\\s+1\\s+of\\s+${TOTAL_PAGES}\\b`, "i")),
    `the pager must read "Page 1 of ${TOTAL_PAGES}"`,
  ).toBeVisible();

  // And M comes from the server total, not from the page length: the same pager
  // states the full count while only PER_PAGE rows are rendered.
  await expect(
    page.getByText(new RegExp(`of\\s+${TOTAL_ROWS}\\b`)),
    "the pager must state the whole result count",
  ).toBeVisible();
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);
});

test("next moves to page 2 and updates the URL", async ({ page }) => {
  await page.goto(pageUrl(1));
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);
  const pageOne = await renderedIds(page);
  expect(pageOne).toHaveLength(PER_PAGE);

  const next = page.locator(`${PAGER} a[rel="next"], ${PAGER} a[rel="last"]`).first();
  await expect(next, "page 1 needs an enabled next control").toBeVisible();
  await next.click();

  await expect(page).toHaveURL(/[?&]page=[23]\b/);
  const landed = Number(new URL(page.url()).searchParams.get("page") ?? "1");
  expect(landed, "next must advance exactly one page").toBe(2);
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);
  // Page position tracks the move: "Page 2 of M" (the shipped copy; the plan
  // asks for the same fact, so the assertion is on the numbers, not the frame).
  await expect(page.locator(`${PAGER} .pager-position`)).toHaveText(
    new RegExp(`^Page\\s+2\\s+of\\s+${TOTAL_PAGES}$`, "i"),
  );

  const pageTwo = await renderedIds(page);
  expect(pageTwo, "page 2 must not repeat page 1's rows").not.toEqual(pageOne);
  expect(pageTwo.filter((id) => pageOne.includes(id))).toEqual([]);

  // Back again returns the exact original slice.
  await page.locator(`${PAGER} a[rel="prev"], ${PAGER} a[rel="first"]`).first().click();
  await expect(page).toHaveURL(/[?&]page=1\b|\/deployments\?(?!.*page=)/);
  expect(await renderedIds(page)).toEqual(pageOne);
});

test("first and previous are disabled or absent on page 1", async ({ page }) => {
  await page.goto(pageUrl(1));
  await expect(page.locator(TABLE)).toBeVisible();

  for (const label of [/^first$/i, /^prev(ious)?$/i]) {
    const interactive = page
      .getByRole("link", { name: label })
      .or(page.getByRole("button", { name: label }));
    if ((await interactive.count()) === 0) {
      // Absent OR rendered as inert text: the shipped pager uses
      // `span[aria-disabled="true"]`, which is a valid way to satisfy
      // "disabled or absent" and is what plan.md item 3 asks for.
      const inert = page.locator(`${PAGER} [aria-disabled="true"]`).filter({ hasText: label });
      await expect(inert, `${String(label)} must be present but inert, or absent`).toHaveCount(1);
      // An inert control must not be announced as clickable.
      await expect(inert).not.toHaveAttribute("href", /.*/);
      continue;
    }
    await expect(interactive.first(), `${String(label)} must not be usable on page 1`).toBeDisabled();
  }

  // Whatever the edge controls are, they must not offer to walk below page 1.
  const hrefs = await page.locator(`${PAGER} a[href]`).evaluateAll((links) =>
    links.map((link) => link.getAttribute("href") ?? ""),
  );
  for (const href of hrefs) {
    expect(new URL(href, "http://x").searchParams.get("page") ?? "1").not.toBe("0");
  }
});

test("an out-of-range ?page=999 explains itself instead of claiming no deployments", async ({
  page,
}) => {
  await page.goto(pageUrl(OUT_OF_RANGE_PAGE));
  await expect(page.locator(`${PAGER} .pager-summary`)).toBeVisible();

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const pagerSummary = (await page.locator(`${PAGER} .pager-summary`).innerText()).replace(
    /\s+/g,
    " ",
  );

  // Half one: an explanation naming the page is present, and the pager still
  // describes the real result set (so the user can navigate out).
  expect(pagerSummary, "an out-of-range page must explain itself").toMatch(
    /page|past the end|out of range/i,
  );
  await expect(page.locator(`${PAGER} .pager-position`)).toContainText(String(OUT_OF_RANGE_PAGE));
  await expect(page.locator(`${PAGER} .pager-position`)).toContainText(String(TOTAL_PAGES));
  await expect(page.locator(ROW)).toHaveCount(0);
  const back = page.locator(`${PAGER} a[href]`).first();
  await expect(back, "the explanation is a dead end without a way back").toBeVisible();

  // Half two: it must NOT also render the empty state. An empty page is not an
  // empty project, and "No deployments" is a false claim about the data.
  expect(
    body,
    `page ${OUT_OF_RANGE_PAGE} also rendered the "No deployments" empty state`,
  ).not.toMatch(/No deployments/i);
  expect(
    body,
    `page ${OUT_OF_RANGE_PAGE} also rendered the empty-state body copy`,
  ).not.toMatch(/No deployment matches this view yet/i);
});

test("sorting reorders rows while the pager keeps the real total", async ({ page }) => {
  // Expected slices come from the fixture, not from a hard-coded state name:
  // the round added history rows, so "which row is oldest" moves.
  const expected = [...seedDeployments]
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .map((deployment) => deployment.id);
  const newestSlice = expected.slice(0, PER_PAGE);
  const oldestSlice = [...expected].reverse().slice(0, PER_PAGE);

  // Descending: newest first. Ascending: oldest first. If the sort did not reach
  // the data layer these two would render the same rows in the same order.
  await page.goto(`/deployments?limit=${PER_PAGE}&sort=requestedAt&dir=desc`);
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);
  expect(await renderedIds(page)).toEqual(newestSlice);

  await page.goto(`/deployments?limit=${PER_PAGE}&sort=requestedAt&dir=asc`);
  await expect(page.locator(ROW)).toHaveCount(PER_PAGE);
  expect(await renderedIds(page)).toEqual(oldestSlice);

  expect(oldestSlice, "asc and desc must not render the same first page").not.toEqual(newestSlice);

  // The pager still describes all rows, not just this page.
  await expect(page.locator(`${PAGER} .pager-summary`)).toContainText(String(TOTAL_ROWS));
  await expect(page.locator(`${PAGER} .pager-position`)).toContainText(String(TOTAL_PAGES));

  // A state sort is not a cosmetic no-op either.
  await page.goto("/deployments?limit=50&sort=state&dir=asc");
  await expect(page.locator(ROW)).toHaveCount(TOTAL_ROWS);
  const states = await page.locator(ROW).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-state") ?? ""),
  );
  expect(states).toEqual([...states].sort());
});

test("the rows the pager addresses are the fixture rows", async ({ page }) => {
  // Guard against a pager that pages over a different source than the table:
  // every rendered id must be a fixture row, and none may repeat. The id set is
  // taken from `seedDeployments` because `MOCK_DEPLOYMENT_IDS` only names the
  // original five; history rows added for the pager are not in that map.
  await page.goto("/deployments?limit=50");
  await expect(page.locator(ROW)).toHaveCount(TOTAL_ROWS);
  const ids = await renderedIds(page);
  expect(new Set(ids).size).toBe(TOTAL_ROWS);
  const fixtureIds: readonly string[] = seedDeployments.map((deployment) => deployment.id);
  for (const id of ids) {
    expect(fixtureIds, `row id ${String(id)} is not a fixture row`).toContain(id);
  }
  // The original five must still be in there; the map is what other specs use.
  for (const known of Object.values(MOCK_DEPLOYMENT_IDS)) {
    expect(ids, `fixture deployment ${known} dropped out of the table`).toContain(known);
  }
});
