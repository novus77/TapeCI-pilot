import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  MOCK_CONTAINER_ONE,
  MOCK_DEPLOYMENT_IDS,
  MOCK_PROJECT_IDS,
  MOCK_PROCESSOR,
} from "../lib/mock-data";

const BASE_URL = process.env.TAPECI_QA_BASE_URL ?? "http://127.0.0.1:3103";
const SCREENSHOT_DIR = fileURLToPath(
  new URL("../../../docs/ui-ux/screenshots/", import.meta.url),
);

const DEPLOYMENT_VIEWS = [
  "overview",
  "files",
  "transactions",
  "verification",
  "events",
] as const;

const DEPLOYMENT_IDS = Object.values(MOCK_DEPLOYMENT_IDS);

const KEY_PAGES = [
  ["home", "/"],
  ["projects", "/projects"],
  ["deployments", "/deployments"],
  ["project", `/projects/${MOCK_PROJECT_IDS.tapekit}`],
  ["project-settings", `/projects/${MOCK_PROJECT_IDS.tapekit}/settings`],
  ["project-compare", `/projects/${MOCK_PROJECT_IDS.tapekit}/compare`],
  ["deployment-live", `/deployments/${MOCK_DEPLOYMENT_IDS.live}`],
  ["deployment-verified", `/deployments/${MOCK_DEPLOYMENT_IDS.verified}`],
  ["deployment-uploaded", `/deployments/${MOCK_DEPLOYMENT_IDS.uploaded}`],
  ["deployment-approval", `/deployments/${MOCK_DEPLOYMENT_IDS.approval}`],
  ["deployment-build-failed", `/deployments/${MOCK_DEPLOYMENT_IDS.buildFailed}`],
  ["organizations", "/organizations"],
  ["organization-detail", "/organizations/mock-org"],
  ["audit", "/audit"],
  ["webhooks", "/webhooks"],
  ["container", `/containers/${MOCK_CONTAINER_ONE}`],
  ["new-project", "/projects/new"],
  ["login", "/login"],
  ["resources", "/resources"],
  ["mint", "/resources/mint"],
  ["prepare", `/resources/prepare?processor=${MOCK_PROCESSOR}&tokenId=2`],
  ["preparation", "/preparations/mock-task"],
  ["wallet-check", "/wallet-check"],
] as const;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

const DEPLOYMENT_FIXTURES = [
  ["live", MOCK_DEPLOYMENT_IDS.live],
  ["verified", MOCK_DEPLOYMENT_IDS.verified],
  ["uploaded", MOCK_DEPLOYMENT_IDS.uploaded],
  ["approval", MOCK_DEPLOYMENT_IDS.approval],
  ["build-failed", MOCK_DEPLOYMENT_IDS.buildFailed],
] as const;

const MOBILE_TABLE_PAGES = [
  ["home", "/"],
  ["deployments", "/deployments"],
  ["project", `/projects/${MOCK_PROJECT_IDS.tapekit}`],
  ["project-settings", `/projects/${MOCK_PROJECT_IDS.tapekit}/settings`],
  ["project-compare", `/projects/${MOCK_PROJECT_IDS.tapekit}/compare`],
  ["deployment-live-files", `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=files`],
  [
    "deployment-live-transactions",
    `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=transactions`,
  ],
  [
    "deployment-live-verification",
    `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=verification`,
  ],
  ["organizations", "/organizations"],
  ["organization-detail", "/organizations/mock-org"],
  ["audit", "/audit"],
  ["webhooks", "/webhooks"],
  ["container", `/containers/${MOCK_CONTAINER_ONE}`],
] as const;

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function waitForPageReady(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${path} did not return HTTP 200`).toBe(200);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main .page-header .page-title")).toBeVisible();
  await expect
    .poll(
      async () => {
        const title = await page.title();
        if (title === "") return false;
        await page.waitForTimeout(100);
        return title === (await page.title());
      },
      {
        message: `${path} did not expose a stable non-empty document title`,
      },
    )
    .toBe(true);

  if (path === "/") {
    await expect(page.locator(".workbench-counts a")).toHaveCount(4);
    await expect(
      page.getByTestId("workbench-pipeline"),
    ).toBeVisible();
    await expect(
      page.locator(
        'section[aria-labelledby="recent-heading"] [data-testid="deployment-table"] tbody tr',
      ),
    ).not.toHaveCount(0);
  } else if (path === "/projects") {
    await expect(
      page.locator(".project-list article").first(),
    ).toBeVisible();
  } else if (path === "/deployments") {
    await expect(page.locator('form[aria-labelledby="filter-heading"]')).toBeVisible();
    await expect(page.getByTestId("deployment-row").first()).toBeVisible();
  } else if (path === `/projects/${MOCK_PROJECT_IDS.tapekit}`) {
    await expect(
      page.locator('section[aria-labelledby="project-config-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="container-heading"]'),
    ).toBeVisible();
    await expect(
      page
        .locator('section[aria-labelledby="releases-heading"] table tbody tr')
        .first(),
    ).toBeVisible();
    await expect(
      page
        .locator('section[aria-labelledby="project-deployments-heading"] table tbody tr')
        .first(),
    ).toBeVisible();
  } else if (path.endsWith("/settings")) {
    await expect(
      page.locator(
        'section[aria-labelledby="build-settings-heading"] form.stack-form',
      ),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="members-heading"] table'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="budget-heading"] form'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="policy-heading"] form'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="channels-heading"] table'),
    ).toBeVisible();
  } else if (path.endsWith("/compare")) {
    await expect(page.locator('form[action$="/compare"]')).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="compare-heading"] table'),
    ).toBeVisible();
  } else if (path.startsWith("/deployments/")) {
    const view =
      new URL(path, BASE_URL).searchParams.get("view") ?? "overview";
    await expect(page.getByTestId("deployment-result")).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="milestones-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator("main nav.section-nav"),
    ).toBeVisible();
    if (view === "overview") {
      await expect(
        page.locator('section[aria-labelledby="meta-heading"] dl.meta-grid'),
      ).toBeVisible();
    } else if (view === "files") {
      await expect(
        page.locator('section[aria-labelledby="files-heading"]'),
      ).toBeVisible();
    } else if (view === "transactions") {
      await expect(
        page.locator('section[aria-labelledby="transactions-heading"]'),
      ).toBeVisible();
    } else if (view === "verification") {
      await expect(
        page.locator('section[aria-labelledby="verification-heading"]'),
      ).toBeVisible();
    } else if (view === "events") {
      await expect(
        page.locator('section[aria-labelledby="timeline-heading"]'),
      ).toBeVisible();
    }
  } else if (path === "/organizations") {
    await expect(
      page.locator('section[aria-labelledby="org-list-heading"] table'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="org-create-heading"] form'),
    ).toBeVisible();
  } else if (path.startsWith("/organizations/")) {
    await expect(
      page.locator('section[aria-labelledby="org-members-heading"] table'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="org-budget-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="org-audit-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="org-projects-heading"]'),
    ).toBeVisible();
  } else if (path === "/audit") {
    await expect(page.locator('form.filter-form[action="/audit"]')).toBeVisible();
    await expect(
      page.locator('div[role="region"][aria-label] table'),
    ).toBeVisible();
  } else if (path === "/webhooks") {
    await expect(page.locator('div[role="region"] table')).toBeVisible();
  } else if (path.startsWith("/containers/")) {
    await expect(page.getByTestId("binding-panel")).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="ownership-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="roles-heading"]'),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="sessions-heading"] table'),
    ).toBeVisible();
  } else if (path === "/projects/new") {
    await expect(page.locator("form.wizard")).toBeVisible();
    await expect(
      page.locator('aside[aria-labelledby="what-next-heading"]'),
    ).toBeVisible();
  } else if (path === "/login") {
    await expect(
      page.locator('section[aria-labelledby="login-heading"] .button-row'),
    ).toContainText(/GitHub/i);
  }

  await expect(
    page.locator(".loading-state"),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function assertNoPageOverflow(page: Page, path: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${path} has page-level horizontal overflow at ${page.viewportSize()?.width}px`).toBeLessThanOrEqual(1);
}

async function assertTablesRemainReadable(page: Page, path: string): Promise<void> {
  const tables = page.locator("main table.table");
  const count = await tables.count();
  expect(count, `${path} did not render any tables`).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const table = tables.nth(index);
    const metrics = await table.evaluate((element) => {
      const tableElement = element as HTMLTableElement;
      const rows = Array.from(tableElement.tBodies).flatMap((body) =>
        Array.from(body.rows),
      );
      const columns = Array.from(tableElement.rows).reduce(
        (maximum, row) =>
          Math.max(
            maximum,
            Array.from(row.cells).reduce(
              (sum, cell) => sum + Math.max(1, cell.colSpan),
              0,
            ),
          ),
        0,
      );
      const narrowestCell = Math.min(
        ...Array.from(tableElement.querySelectorAll<HTMLElement>("th, td")).map(
          (cell) => {
            const style = getComputedStyle(cell);
            const horizontalPadding =
              Number.parseFloat(style.paddingLeft) +
              Number.parseFloat(style.paddingRight);
            return cell.getBoundingClientRect().width - horizontalPadding;
          },
        ),
      );
      const headerHeight = Math.max(
        0,
        ...Array.from(tableElement.tHead?.rows ?? []).map(
          (row) => row.getBoundingClientRect().height,
        ),
      );
      const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
      const medianRowHeight = [...rowHeights].sort((a, b) => a - b)[
        Math.floor(rowHeights.length / 2)
      ] ?? 0;
      const columnWidths = Array.from(
        tableElement.querySelectorAll<HTMLElement>("thead tr:first-child th"),
      ).map((cell) => {
        const style = getComputedStyle(cell);
        return (
          cell.getBoundingClientRect().width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight)
        );
      });
      const wrapper = tableElement.closest<HTMLElement>(".table-wrap");
      const scrollMode = wrapper === null ? "page" : getComputedStyle(wrapper).overflowX;
      // Below 720px the same table renders as cards: every cell carries its own
      // column label and the table itself must not scroll sideways.
      const cardMode = tableElement.classList.contains("table-responsive")
        && getComputedStyle(tableElement.tBodies[0]?.rows[0] ?? tableElement).display === "block";
      const labelledCells = Array.from(
        tableElement.querySelectorAll<HTMLElement>("tbody tr:first-child td[data-label]"),
      ).length;
      const tableOverflows = tableElement.scrollWidth > tableElement.clientWidth + 1;
      return {
        cardMode,
        labelledCells,
        tableOverflows,
        columns,
        tableWidth: tableElement.getBoundingClientRect().width,
        columnWidths,
        narrowestCell,
        headerHeight,
        medianRowHeight,
        scrollMode,
      };
    });

    if (metrics.cardMode) {
      // Card presentation: the column-name check is meaningless because each cell
      // is a full-width row; what matters is that no cell lost its label and that
      // the card list does not scroll sideways.
      expect(
        metrics.labelledCells,
        `${path} table ${index + 1} renders as cards but ${metrics.labelledCells} cells carry a label`,
      ).toBeGreaterThan(0);
      expect(
        metrics.tableOverflows,
        `${path} table ${index + 1} still scrolls sideways in card mode`,
      ).toBe(false);
      continue;
    }

    expect(
      metrics.narrowestCell,
      `${path} table ${index + 1} squeezed a cell to ${metrics.narrowestCell}px`,
    ).toBeGreaterThanOrEqual(32);
    expect(
      Math.max(...metrics.columnWidths),
      `${path} table ${index + 1} does not preserve a readable column`,
    ).toBeGreaterThanOrEqual(96);
    expect(
      metrics.headerHeight,
      `${path} table ${index + 1} header wrapped excessively`,
    ).toBeLessThan(60);
    expect(
      metrics.medianRowHeight,
      `${path} table ${index + 1} rows collapsed or wrapped excessively`,
    ).toBeLessThan(96);
    if (metrics.columns >= 4) {
      expect(
        metrics.scrollMode,
        `${path} table ${index + 1} needs a horizontal scroll container`,
      ).toBe("auto");
      expect(
        metrics.tableWidth,
        `${path} table ${index + 1} should retain its natural minimum width`,
      ).toBeGreaterThanOrEqual(480);
    }
  }
}

async function assertConsistentMockOverview(page: Page): Promise<void> {
  await waitForPageReady(page, "/");

  const projectTabs = page.getByRole("navigation", { name: "Switch project" });
  const projectCount = await projectTabs.getByRole("link").count();
  const projectsCount = page.locator('.workbench-counts a[href="/projects"]');
  await expect(projectsCount.locator("strong")).toHaveText(String(projectCount));
  await expect(projectsCount).toHaveAttribute("href", "/projects");
  await expect(page.locator(".console-demo-strip")).toContainText("Demo data");

  const recentSection = page.locator(
    'section[aria-labelledby="recent-heading"]',
  );
  await expect(
    recentSection.getByRole("link", { name: /View all deployments/i }),
  ).toHaveAttribute("href", "/deployments");
}

async function setLocale(page: Page, locale: "en" | "zh"): Promise<void> {
  await page.context().addCookies([
    {
      name: "tapeci_locale",
      value: locale,
      url: BASE_URL,
    },
  ]);
}

/**
 * Runs axe and returns only serious/critical blockers.
 *
 * `document-title` is retried once: Next.js streams the document and can briefly
 * unmount `<title>` between `waitForPageReady` and `analyze()`, which produced an
 * intermittent false failure. Only that one rule is retried — any other violation
 * fails immediately, and a title that is still missing on the second attempt still
 * fails, so this cannot mask a real regression.
 */
async function analyzeBlockers(page: Page, url: string) {
  const analyze = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    return results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
  };

  await waitForPageReady(page, url);
  let blockers = await analyze();
  const onlyTitle = blockers.length > 0 && blockers.every((violation) => violation.id === "document-title");
  if (onlyTitle) {
    await expect
      .poll(async () => (await page.title()) !== "", {
        message: `${url} still had no document title after a retry`,
      })
      .toBe(true);
    blockers = await analyze();
  }
  return blockers;
}

for (const deploymentId of DEPLOYMENT_IDS) {
  for (const view of DEPLOYMENT_VIEWS) {
    test(`axe: deployment ${deploymentId.slice(-2)} ${view}`, async ({ page }) => {
      const url = `/deployments/${deploymentId}?view=${view}`;
      const blockers = await analyzeBlockers(page, url);
      expect(
        blockers,
        blockers
          .map(
            (violation) =>
              `${violation.id} (${violation.impact}): ${violation.nodes
                .map((node) => node.target.join(" "))
                .join(", ")}`,
          )
          .join("\n"),
      ).toEqual([]);
    });
  }
}

test("axe: organization detail has no serious or critical violations", async ({ page }) => {
  await waitForPageReady(page, "/organizations/mock-org");

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
          `${violation.id} (${violation.impact}): ${violation.nodes
            .map((node) => node.target.join(" "))
            .join(", ")}`,
      )
      .join("\n"),
  ).toEqual([]);
});

for (const locale of ["en", "zh"] as const) {
  test(`${locale} page matrix renders without runtime errors or overflow`, async ({ page }) => {
    await setLocale(page, locale);
    const errors = collectBrowserErrors(page);

    for (const [name, path] of KEY_PAGES) {
      await waitForPageReady(page, path);
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        locale === "zh" ? "zh-CN" : "en",
      );
      await expect(
        page.getByRole("navigation", {
          name: locale === "zh" ? "主导航" : "Primary",
        }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).not.toHaveCount(0);

      const visibleText = await page.locator("body").innerText();
      expect(visibleText, `${name} exposed a raw translation key`).not.toMatch(
        /\b(?:console|home|nav|settings|deployment|deployments|project|org|audit|webhooks|login|container|approval|wallet|manual)\.[A-Za-z]/,
      );
      await assertNoPageOverflow(page, path);
    }

    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
  });
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}x${viewport.height} key-page screenshots and overflow`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setLocale(page, "en");
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const errors = collectBrowserErrors(page);

    for (const [name, path] of KEY_PAGES) {
      await waitForPageReady(page, path);
      await assertNoPageOverflow(page, path);
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${viewport.width}x${viewport.height}-${name}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }

    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test(`${viewport.width}x${viewport.height} all deployment fixtures and section views`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setLocale(page, "en");
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const errors = collectBrowserErrors(page);

    for (const [fixture, deploymentId] of DEPLOYMENT_FIXTURES) {
      for (const view of DEPLOYMENT_VIEWS) {
        const path = `/deployments/${deploymentId}?view=${view}`;
        await waitForPageReady(page, path);
        await assertNoPageOverflow(page, path);
        await page.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.width}x${viewport.height}-deployment-${fixture}-${view}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }

    expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
  });
}

test("mobile language switch remains visible and functional in the shell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setLocale(page, "en");
  await waitForPageReady(page, "/");

  const switchers = page.locator('.locale-switch[role="group"]');
  expect(await switchers.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await switchers.count()); index += 1) {
    const switcher = switchers.nth(index);
    if (await switcher.isVisible()) {
      const options = switcher.locator("button.locale-option");
      await expect(options).toHaveCount(2);
      const chinese = options.nth(1);
      await expect(chinese).toBeVisible();
      await expect(chinese).toHaveAttribute("aria-pressed", "false");
      await chinese.click();
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
      break;
    }
  }
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("mobile tables retain usable columns and scroll affordance", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setLocale(page, "en");

  for (const [name, path] of MOBILE_TABLE_PAGES) {
    await waitForPageReady(page, path);
    await assertNoPageOverflow(page, path);
    await assertTablesRemainReadable(page, `${name} (${path})`);
  }
});

test("overview count and section-link copy match their destinations", async ({
  page,
}) => {
  await setLocale(page, "en");
  await assertConsistentMockOverview(page);

  await setLocale(page, "zh");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForPageReady(page, "/");
  const projectCount = await page.locator(".project-switcher a").count();
  await expect(page.locator('.workbench-counts a[href="/projects"] strong')).toHaveText(String(projectCount));
  await expect(page.locator(".console-demo-strip")).toContainText("演示数据");
  await expect(page.locator('section[aria-labelledby="recent-heading"]').getByRole("link", { name: /查看全部部署/ })).toHaveAttribute("href", "/deployments");
});

test("keyboard navigation reaches skip, navigation, disclosures and deployment sections", async ({
  page,
}) => {
  await setLocale(page, "en");
  await page.goto("/");

  const skip = page.getByRole("link", { name: "Skip to main content" });
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);

  const projects = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects", exact: true });
  await projects.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects$/);

  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.buildFailed}`);
  const eligibility = page
    .locator("summary")
    .filter({ hasText: "Action eligibility and blocked reasons" });
  await eligibility.focus();
  await page.keyboard.press("Space");
  await expect(eligibility.locator("..")).toHaveAttribute("open", "");

  const files = page
    .getByRole("navigation", { name: "Deployment sections" })
    .getByRole("link", { name: "Files", exact: true });
  await files.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/view=files$/);
  await expect(page.locator('section[aria-labelledby="files-heading"]')).toBeVisible();
});

test("project settings isolates archive in a danger zone", async ({ page }) => {
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}/settings`);
  const zone = page.locator(".danger-zone");
  await expect(zone).toBeVisible();
  await expect(zone.getByRole("heading", { name: /Danger zone/i })).toBeVisible();
  await expect(zone.getByLabel(/Archive this project/i)).toBeVisible();
  // It must not live inside the routine build-configuration form.
  await expect(page.locator("#build-settings-heading, [aria-labelledby=build-settings-heading]").first().getByLabel(/Archive this project/i)).toHaveCount(0);
});
