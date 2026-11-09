import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Member table — `.superpowers/sdd/members-ui/plan.md` items 1, 3 and 5.
 *
 * This file complements `members.spec.ts` (the smoke coverage) with the parts
 * that can silently regress: the avatar's deterministic colour and AA text, the
 * relative-time contract, the client-side scope note, sort order, the ZH
 * rendering, and axe.
 *
 * Fixture: `getOrganization()` in `apps/web/lib/mock.ts` returns
 * `MOCK_ORGANIZATION_MEMBERS` from `apps/web/lib/mock-data.ts`:
 *
 *   novus77        owner   2026-10-01  lastActivityAt 2026-10-26T02:49:04Z
 *   tapeci-bot     admin   2026-10-05  lastActivityAt 2026-10-25T10:15:44Z
 *   reviewer-olga  member  2026-10-12  lastActivityAt null  → "No activity yet"
 *
 * `novus77` is the only owner. The default mock is read-only; the isolated
 * `mock-managed-org` fixture exercises manager controls and owner protection.
 *
 * Selectors pinned here (from `apps/web/components/member-table.tsx`):
 *   [data-testid="member-table"]        the table
 *   [data-testid="member-row"]          one row per rendered member
 *   [data-testid="member-role-select"]  in-place role control (manager only)
 *   [data-testid="member-remove"]       row remove action (manager only)
 *   .member-avatar / .member-login      initials chip (aria-hidden) / login text
 *   #member-filter / #member-role / #member-sort   toolbar controls
 */

const ORG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG_PATH = `/organizations/${ORG_ID}`;
/** Id a future manager variant of `getOrganization()` should key on. */
const MANAGER_ORG_PATH = "/organizations/mock-managed-org";

/** `AVATAR_COLORS` entries these logins hash to, as computed CSS. */
const AVATAR_RGB = {
  novus77: "rgb(75, 63, 143)", // #4b3f8f
  "tapeci-bot": "rgb(74, 74, 82)", // #4a4a52
  "reviewer-olga": "rgb(27, 94, 138)", // #1b5e8a
} as const;

function table(page: Page) {
  return page.getByTestId("member-table");
}

function row(page: Page, login: string) {
  return page.getByTestId("member-row").filter({ hasText: login });
}

function roleSelect(page: Page, login: string) {
  return page.getByTestId("member-role-select").and(
    page.locator(`[aria-label="Change role for ${login}"]`),
  );
}

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto(ORG_PATH);
  await expect(table(page)).toBeVisible();
});

test("derives a stable, AA-safe initials chip from each login", async ({ page }) => {
  await expect(page.getByTestId("member-row")).toHaveCount(3);

  const expected: ReadonlyArray<readonly [string, string]> = [
    ["novus77", "NO"],
    ["tapeci-bot", "TB"],
    ["reviewer-olga", "RO"],
  ];

  for (const [login, chips] of expected) {
    const avatar = row(page, login).locator(".member-avatar");
    await expect(avatar, login).toHaveText(chips);
    // Decorative: the login text is the accessible name.
    await expect(avatar, login).toHaveAttribute("aria-hidden", "true");
    await expect(avatar, login).toHaveCSS("border-radius", "999px");
    await expect(avatar, login).toHaveCSS("background-color", AVATAR_RGB[login as keyof typeof AVATAR_RGB]);
    // White on every ramp colour is >= 4.5:1 (docs/ui-ux/README.md).
    await expect(avatar, login).toHaveCSS("color", "rgb(255, 255, 255)");
  }
});

test("gives two different logins two different chip colours", async ({ page }) => {
  const colours = await page.locator(".member-avatar").evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(new Set(colours).size).toBeGreaterThan(1);
});

test("renders each member's role as a badge in the read-only mock org", async ({ page }) => {
  // `getOrganization()` returns `canManage: false`, so `MemberTable` takes its
  // read-only branch: no select, a static badge per row.
  await expect(page.getByTestId("member-role-select")).toHaveCount(0);
  await expect(row(page, "novus77").locator(".badge")).toHaveText("Owner");
  await expect(row(page, "tapeci-bot").locator(".badge")).toHaveText("Admin");
  await expect(row(page, "reviewer-olga").locator(".badge")).toHaveText("Member");
});

test("hides the destructive row action for a read-only viewer", async ({ page }) => {
  await expect(page.getByTestId("member-remove")).toHaveCount(0);
});

test("shows relative activity with the absolute value in the tooltip", async ({ page }) => {
  const active = row(page, "novus77").locator("time");
  await expect(active).toHaveAttribute("datetime", "2026-10-26T02:49:04.000Z");
  await expect(active).toHaveAttribute("title", "2026-10-26T02:49:04.000Z");
  // The relative copy depends on the wall clock; pin its shape, not its value.
  await expect(active).toHaveText(/^(just now|\d+ (minute|hour|day)s? ago|\d{4}-\d{2}-\d{2})$/);
});

test("says no activity yet instead of inventing a date", async ({ page }) => {
  const quiet = row(page, "reviewer-olga");
  await expect(quiet.getByText("No activity yet")).toBeVisible();
  await expect(quiet.locator("time")).toHaveCount(0);
});

test("filters by login substring, case-insensitively, without a reload", async ({ page }) => {
  const filter = page.locator("#member-filter");

  await filter.fill("OLGA");
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("member-row")).toContainText("reviewer-olga");

  await filter.fill("tape");
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("member-row")).toContainText("tapeci-bot");

  await filter.fill("");
  await expect(page.getByTestId("member-row")).toHaveCount(3);
});

test("filters by role and intersects it with the login filter", async ({ page }) => {
  await page.locator("#member-role").selectOption("admin");
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("member-row")).toContainText("tapeci-bot");

  // An impossible intersection shows the empty state, not a stale row.
  await page.locator("#member-filter").fill("novus");
  await expect(page.getByTestId("member-row")).toHaveCount(0);
  await expect(page.getByText("No members match these filters")).toBeVisible();

  await page.locator("#member-role").selectOption("");
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("member-row")).toContainText("novus77");
});

test("sorts by role (owner first) by default and by created date on demand", async ({ page }) => {
  const logins = page.locator(".member-login");
  await expect(logins).toHaveText(["novus77", "tapeci-bot", "reviewer-olga"]);

  // Newest first: reviewer-olga (10-12), tapeci-bot (10-05), novus77 (10-01).
  await page.locator("#member-sort").selectOption("newest");
  await expect(logins).toHaveText(["reviewer-olga", "tapeci-bot", "novus77"]);

  await page.locator("#member-sort").selectOption("role");
  await expect(logins).toHaveText(["novus77", "tapeci-bot", "reviewer-olga"]);
});

test("states that filtering happens within the fetched members", async ({ page }) => {
  await expect(page.getByText("Filtering within the 3 fetched members")).toBeVisible();
});

test("clear filters restores the full list from the empty state", async ({ page }) => {
  await page.locator("#member-filter").fill("nobody-by-this-login");
  await expect(page.getByTestId("member-row")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("member-row")).toHaveCount(3);
});

test("renders the member table in Chinese with no untranslated string", async ({ page }) => {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "tapeci_locale", value: "zh", url: origin }]);
  await page.goto(ORG_PATH);

  await expect(table(page)).toBeVisible();
  await expect(page.getByLabel("筛选成员")).toBeVisible();
  await expect(page.getByText("在已获取的 3 位成员中筛选")).toBeVisible();
  await expect(page.getByText("暂无活跃记录")).toBeVisible();
  // No leftover English from the new toolbar.
  await expect(page.getByText("No activity yet")).toHaveCount(0);
  await expect(page.getByText("Filtering within")).toHaveCount(0);
});

test("axe: the member table has no serious or critical violations", async ({ page }) => {
  await expect(table(page)).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blockers = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blockers,
    blockers
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      )
      .join("\n"),
  ).toEqual([]);
});

/** Manager fixture: last-owner protection and privileged controls. */
test("disables the only owner's role control and explains the rule", async ({ page }) => {
  await page.goto(MANAGER_ORG_PATH);
  await expect(table(page)).toBeVisible();

  await expect(roleSelect(page, "novus77")).toBeDisabled();
  await expect(roleSelect(page, "novus77")).toHaveAttribute(
    "title",
    "An organization needs at least one owner.",
  );
  await expect(roleSelect(page, "tapeci-bot")).toBeEnabled();
  await expect(roleSelect(page, "reviewer-olga")).toBeEnabled();
});

test("offers the role control and row actions to a manager", async ({ page }) => {
  await page.goto(MANAGER_ORG_PATH);
  await expect(table(page)).toBeVisible();

  await expect(page.getByTestId("member-role-select")).toHaveCount(3);
  await expect(roleSelect(page, "tapeci-bot")).toHaveValue("admin");
  await expect(roleSelect(page, "reviewer-olga")).toHaveValue("member");
  await expect(roleSelect(page, "novus77")).toHaveValue("owner");

  // The last owner is not removable; the other rows are.
  await expect(row(page, "novus77").getByTestId("member-remove")).toHaveCount(0);
  await expect(row(page, "tapeci-bot").getByTestId("member-remove")).toHaveCount(1);
});
