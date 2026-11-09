import { expect, test, type Page } from "@playwright/test";

import {
  MOCK_CONTAINER_ONE,
  MOCK_DEPLOYMENT_IDS,
  MOCK_PROJECT_IDS,
  seedDeployments,
} from "../lib/mock-data";

/**
 * Derived from the fixture, never hard-coded: the seed grew from 5 to 12 rows
 * when paging was added, and a literal count silently rots the moment the
 * fixture changes.
 */
const DEFAULT_PAGE_SIZE = 50;
const FIXTURE_TOTAL = seedDeployments.length;
const FIRST_PAGE_ROWS = Math.min(FIXTURE_TOTAL, DEFAULT_PAGE_SIZE);
const LIVE_ROWS = seedDeployments.filter((deployment) => deployment.state === "LIVE").length;

test.describe.configure({ mode: "serial" });

const browserErrors = new WeakMap<Page, string[]>();

function errorsFor(page: Page): string[] {
  return browserErrors.get(page) ?? [];
}

test.beforeEach(async ({ page }) => {
  const collected: string[] = [];
  browserErrors.set(page, collected);
  page.on("console", (message) => {
    if (message.type() === "error") collected.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    collected.push(`pageerror: ${error.message}`);
  });
});

test.afterEach(async ({ page }) => {
  const collected = errorsFor(page);
  expect(collected, `unexpected browser errors:\n${collected.join("\n")}`).toEqual([]);
});

test("dashboard shows projects and all four distinct release states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  // The summary moved from four cards to one compact row; the fact it reports is the same.
  await expect(page.locator(".workbench-counts a").filter({ hasText: "Projects" })).toContainText("2");

  await page.locator("details").filter({ has: page.getByTestId("release-legend") }).locator("summary").click();
  const legend = page.getByTestId("release-legend");
  await expect(legend.locator("li")).toHaveCount(4);
  for (const stage of ["BUILD_SUCCESS", "UPLOADED", "VERIFIED", "LIVE"]) {
    await expect(legend.locator(`li[data-stage="${stage}"]`)).toBeVisible();
  }
  for (const label of ["Build Success", "Uploaded", "Verified", "Live"]) {
    await expect(legend.getByText(label, { exact: true })).toBeVisible();
  }

  for (const stage of ["BUILD_SUCCESS", "UPLOADED", "VERIFIED", "LIVE"]) {
    await expect(
      page.locator(`[data-testid="deployment-row"] [data-stage="${stage}"]`).first(),
    ).toBeVisible();
  }

  const failedRow = page.locator(
    `[data-deployment-id="${MOCK_DEPLOYMENT_IDS.buildFailed}"]`,
  );
  await expect(failedRow.getByText("Build failed", { exact: true })).toBeVisible();
  await expect(failedRow.getByText("Live", { exact: true })).toHaveCount(0);
});

test("primary navigation reaches the list views", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });

  await nav.getByRole("link", { name: "Deployments", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();

  await nav.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator(".project-list article")).toHaveCount(2);

  await nav.getByRole("link", { name: "New project", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();

  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("deployment list filters by durable state", async ({ page }) => {
  await page.goto("/deployments");
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  await expect(page.getByTestId("deployment-row")).toHaveCount(FIRST_PAGE_ROWS);
  await expect(page.getByTestId("deployment-table")).toContainText(
    "tapeoutprotocol/docs-site",
  );

  await page.getByLabel("Deployment state").selectOption("LIVE");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/state=LIVE/);
  await expect(page.getByTestId("deployment-row")).toHaveCount(Math.min(LIVE_ROWS, DEFAULT_PAGE_SIZE));
  await expect(
    page.getByTestId("deployment-row").first().locator('[data-stage="LIVE"]'),
  ).toBeVisible();
});

test("project detail shows container, configuration and releases", async ({ page }) => {
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}`);
  await expect(
    page.getByRole("heading", { level: 1, name: /tapekit-site/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Build configuration" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Container" })).toBeVisible();
  await expect(page.getByRole("link", { name: MOCK_CONTAINER_ONE })).toBeVisible();

  const releases = page.locator('section[aria-labelledby="releases-heading"]');
  await expect(releases.getByRole("table")).toContainText("Current");
  await expect(releases.getByRole("table")).toContainText("r-5f3a1b2c9d4e");
});

test("live deployment detail shows milestones, evidence, files and transactions", async ({
  page,
}) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.live}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("tapekit-site");
  await expect(page.locator('[data-stage="LIVE"]').first()).toBeVisible();

  const milestones = page
    .getByRole("list", { name: "Release lifecycle milestones" })
    .locator("[data-milestone]");
  await expect(milestones).toHaveCount(4);
  for (const stage of ["BUILD_SUCCESS", "UPLOADED", "VERIFIED", "LIVE"]) {
    await expect(
      page.locator(
        `[aria-label="Release lifecycle milestones"] [data-stage="${stage}"][data-milestone="done"]`,
      ),
    ).toBeVisible();
  }

  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Files", exact: true }).click();
  const files = page.locator('section[aria-labelledby="files-heading"]');
  await expect(files.getByRole("table")).toContainText("releases/r-");
  await expect(files.getByRole("table")).toContainText("VERIFIED");

  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Transactions", exact: true }).click();
  const transactions = page.locator('section[aria-labelledby="transactions-heading"]');
  await expect(transactions.locator("tbody tr")).toHaveCount(6);
  await expect(transactions.getByRole("table")).toContainText("setEntry");

  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Events", exact: true }).click();
  await expect(page.getByTestId("event-timeline")).toBeVisible();
  await expect(page.getByTestId("event-timeline").locator("li")).toHaveCount(12);

  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Verification", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verification evidence" }),
  ).toBeVisible();
  await expect(page.getByText("releaseMatch", { exact: true })).toBeVisible();
  await expect(page.getByText("VERIFIED", { exact: true }).first()).toBeVisible();

  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  // AC-P6-17: the server did not grant rollback (another chain writer is in flight), so
  // the console must not render the control at all — but it must still say why.
  await expect(page.getByTestId("rollback-button")).toHaveCount(0);
  await expect(
    page.getByText("Another chain-writing deployment is in flight for this container.").first(),
  ).toBeVisible();
});

test("verified deployment is shown as Verified, not Live", async ({ page }) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.verified}`);
  await expect(page.locator('[data-stage="VERIFIED"]').first()).toBeVisible();
  await expect(
    page.locator('[aria-label="Release lifecycle milestones"] [data-stage="LIVE"]'),
  ).toHaveAttribute("data-milestone", "pending");
  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Verification", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Verification evidence" }),
  ).toBeVisible();
});

test("a failed build stays failed and offers no chain actions", async ({ page }) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.buildFailed}`);
  await expect(page.locator('[data-stage="FAILED"]').first()).toBeVisible();
  await expect(page.getByText("BUILD_FAILED", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(/No artifact was uploaded and no chain transaction was sent/i),
  ).toBeVisible();
  await page.getByText("Action eligibility and blocked reasons", { exact: true }).click();
  await expect(
    page.getByText("The build failed, so there is no artifact to execute."),
  ).toBeVisible();
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  await expect(page.getByTestId("execute-button")).toHaveCount(0);
  await expect(page.getByTestId("rollback-button")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Events", exact: true }).click();
  await expect(page.getByTestId("event-timeline")).toContainText("build.failed");
});

test("container page shows owner, roles, operator sessions and TTL risk", async ({
  page,
}) => {
  await page.goto(`/containers/${MOCK_CONTAINER_ONE}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("0x1f0a2b3c");
  await expect(
    page.getByRole("heading", { name: "Ownership & open state" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contract roles" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operator sessions" })).toBeVisible();
  await expect(
    page.getByText(/TTL risk: operator sessions are temporary chain-write grants/i),
  ).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="sessions-heading"] tbody tr'),
  ).toHaveCount(3);
  await expect(
    page.locator('section[aria-labelledby="sessions-heading"]'),
  ).toContainText("Expires");
});

test("mobile layout is readable without page-level horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByTestId("release-legend").locator("li")).toHaveCount(4);
  const localeSwitch = page.getByRole("group", { name: "Language" });
  await expect(localeSwitch).toBeVisible();
  await expect(localeSwitch.getByRole("button").nth(1)).toBeVisible();
  await expect(page.locator('section[aria-labelledby="recent-heading"] .table-wrap')).toBeVisible();
  // Below 720px the table reflows into cards, so it must fit the viewport instead of
  // forcing a 650px-wide scroll strip (the previous contract).
  const recent = await page
    .locator('section[aria-labelledby="recent-heading"] table')
    .evaluate((element) => {
      const table = element as HTMLTableElement;
      return {
        width: table.getBoundingClientRect().width,
        cardMode: getComputedStyle(table.tBodies[0]?.rows[0] ?? table).display === "block",
        overflows: table.scrollWidth > table.clientWidth + 1,
        labelled: table.querySelectorAll("tbody tr:first-child td[data-label]").length,
      };
    });
  expect(recent.cardMode, "the recent table must render as cards at 390px").toBe(true);
  expect(recent.overflows, "the card list must not scroll sideways").toBe(false);
  expect(recent.labelled, "every card cell keeps its column label").toBeGreaterThan(0);
  expect(recent.width, "the card list fits the viewport").toBeLessThanOrEqual(390);
  const dashboardOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(dashboardOverflow).toBeLessThanOrEqual(1);

  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.live}`);
  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Files", exact: true }).click();
  await expect(
    page.locator('section[aria-labelledby="files-heading"] .table-wrap'),
  ).toBeVisible();
  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Events", exact: true }).click();
  await expect(page.getByTestId("event-timeline")).toBeVisible();
  const detailOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(detailOverflow).toBeLessThanOrEqual(1);
});

test("demo approval is disabled until the API confirms, then records a demo approval", async ({
  page,
}) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.approval}`);
  await expect(page.locator('[data-stage="BUILD_SUCCESS"]').first()).toBeVisible();
  await expect(page.getByText("Build Success", { exact: true }).first()).toBeVisible();

  const approve = page.getByTestId("approve-button");
  await expect(approve).toBeEnabled();
  await expect(page.getByTestId("execute-button")).toHaveCount(0);
  await expect(page.getByText(/Demo mode/i).first()).toBeVisible();

  await approve.click();
  await expect(page.getByText("Action recorded")).toBeVisible();
  await expect(page.getByText(/Approval recorded in demo mode/i)).toBeVisible();
});

test("project wizard validates on the client and submits", async ({ page }) => {
  await page.goto("/projects/new");
  await expect(
    page.getByRole("heading", { level: 1, name: "New project" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Fix 1 field/)).toBeVisible();

  await page.getByLabel("Repository").fill("not-a-repo");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-repoFullName-error")).toContainText(
    "Use exactly one slash",
  );

  await page.getByLabel("Repository").fill("tapeoutprotocol/new-site");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("group", { name: "Container and build" })).toBeVisible();

  await page.getByLabel("Container address").fill("0x1234");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#project-containerAddress-error")).toContainText(
    "40 hex characters",
  );

  await page.getByLabel("Container address").fill(MOCK_CONTAINER_ONE);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project-created")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Project created" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open project" })).toBeVisible();
});

test("project audit link opens the audit log filtered to that project", async ({ page }) => {
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}`);
  await page.locator(".page-actions").getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/audit\\?projectId=${MOCK_PROJECT_IDS.tapekit}$`),
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Audit log" }),
  ).toBeVisible();
  // Mock mode returns no events, so the page must still render its empty state
  // and keep the project filter visible (and re-submittable) rather than 404.
  await expect(
    page.getByText("No audit events recorded for this project yet."),
  ).toBeVisible();
  await expect(
    page.locator('form.filter-form input[name="projectId"]'),
  ).toHaveValue(MOCK_PROJECT_IDS.tapekit);
});

test("audit status filter preserves the project filter", async ({ page }) => {
  await page.goto(`/audit?projectId=${MOCK_PROJECT_IDS.tapekit}`);
  await page.getByLabel("HTTP status").selectOption("422");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]status=422/);
  // A GET form submits in DOM order, so assert the params rather than the raw
  // query string: the project filter must survive the status filter submit.
  const url = new URL(page.url());
  expect(url.pathname).toBe("/audit");
  expect(url.searchParams.get("projectId")).toBe(MOCK_PROJECT_IDS.tapekit);
  expect(url.searchParams.get("status")).toBe("422");
  await expect(page.locator('form.filter-form input[name="projectId"]')).toHaveValue(
    MOCK_PROJECT_IDS.tapekit,
  );
});

test("search filters deployments by repo, commit or id", async ({ page }) => {
  await page.goto("/deployments?q=dead00be");
  await expect(page.getByTestId("deployment-row")).toHaveCount(1);
  await expect(page.getByTestId("deployment-table")).toContainText("tapeoutprotocol/tapekit-site");
  await page.goto("/deployments?q=no-such-deployment");
  await expect(page.getByTestId("deployment-row")).toHaveCount(0);
});

test("deployment evidence is downloadable as JSON", async ({ page, request }) => {
  const response = await request.get(`/deployments/${MOCK_DEPLOYMENT_IDS.live}/evidence`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("attachment");
  const body = (await response.json()) as { schemaVersion: string; deployment: { id: string } };
  expect(body.schemaVersion).toBe("tapeci.evidence.v1");
  expect(body.deployment.id).toBe(MOCK_DEPLOYMENT_IDS.live);
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.live}`);
  await expect(page.getByRole("link", { name: /Export evidence/ })).toBeVisible();
});


test("overview attention links preserve the counted snapshot and filter scope", async ({ page }) => {
  await page.goto("/");
  const attention = page.locator(".workbench-counts a").filter({ hasText: "Needs attention" });
  const count = Number(await attention.locator("strong").innerText());
  await attention.click();
  await expect(page).toHaveURL(/\/deployments\?.*scope=attention.*limit=10/);
  expect(new URL(page.url()).searchParams.get("scope")).toBe("attention");
  expect(new URL(page.url()).searchParams.get("limit")).toBe("10");
  await expect(page.getByTestId("deployment-row")).toHaveCount(count);
  await expect(page.getByText(/Search and grouped filters apply only/)).toBeVisible();
  await page.getByLabel("Deployment state").selectOption("LIVE");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByTestId("deployment-row")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("scope")).toBe("attention");
  expect(new URL(page.url()).searchParams.get("limit")).toBe("10");
});

test("deployment section URLs retain evidence through reload and history", async ({ page }) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=files`);
  await expect(page.locator('section[aria-labelledby="files-heading"] tbody tr')).not.toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Files", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Deployment sections" }).getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("LIVE", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deployment details", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator('section[aria-labelledby="files-heading"]')).toBeVisible();
  await page.locator(".release-context summary").click();
  await expect(page.getByRole("link", { name: "Check domain and site access" })).toHaveAttribute("href", `/containers/${MOCK_CONTAINER_ONE}`);
});

test("settings success navigation is not caught as a redirect error", async ({ page }) => {
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}/settings`);
  await page.locator('section[aria-labelledby="build-settings-heading"]').getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/saved=1/);
  await expect(page.locator("main")).not.toContainText("NEXT_REDIRECT");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("organization success navigation is not caught as a redirect error", async ({ page }) => {
  await page.goto("/organizations");
  await page.getByLabel("Name").fill("QA organization");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/saved=1/);
  await expect(page.locator("main")).not.toContainText("NEXT_REDIRECT");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("organization detail renders its role-gated read-only state", async ({ page }) => {
  await page.goto("/organizations/mock-org");
  await expect(page.getByRole("heading", { level: 1, name: "Mock org" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization budget" })).toBeVisible();
  await expect(
    page.getByText("Only organization owners/admins can manage members."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save budget", exact: true })).toHaveCount(0);
});
