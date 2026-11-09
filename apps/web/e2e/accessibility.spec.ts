import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
  MOCK_CONTAINER_ONE,
  MOCK_DEPLOYMENT_IDS,
  MOCK_PROJECT_IDS,
  MOCK_PROCESSOR,
} from "../lib/mock-data";

const PAGES = [
  "/",
  "/resources",
  "/resources/mint",
  `/resources/prepare?processor=${MOCK_PROCESSOR}&tokenId=2`,
  "/preparations/mock-task",
  "/wallet-check",
  "/projects",
  "/deployments",
  `/deployments/${MOCK_DEPLOYMENT_IDS.live}`,
  `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=files`,
  `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=transactions`,
  `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=verification`,
  `/deployments/${MOCK_DEPLOYMENT_IDS.live}?view=events`,
  `/projects/${MOCK_PROJECT_IDS.tapekit}`,
  `/projects/${MOCK_PROJECT_IDS.tapekit}/settings`,
  `/projects/${MOCK_PROJECT_IDS.tapekit}/compare`,
  "/organizations",
  "/audit",
  `/audit?projectId=${MOCK_PROJECT_IDS.tapekit}`,
  "/webhooks",
  `/containers/${MOCK_CONTAINER_ONE}`,
  "/projects/new",
  "/login",
];

for (const path of PAGES) {
  test(`axe: ${path} has no serious or critical violations`, async ({ page }) => {
    await page.goto(path);
    // `networkidle` is flaky with Next prefetch/refresh; the main landmark is the
    // stable signal that the server-rendered page is ready for axe.
    await expect(page.locator("main")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blockers = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      blockers,
      blockers
        .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((n) => n.target.join(" ")).join(", ")}`)
        .join("\n"),
    ).toEqual([]);
  });
}
