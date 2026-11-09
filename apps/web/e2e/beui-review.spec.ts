import { expect, test } from "@playwright/test";
import { MOCK_DEPLOYMENT_IDS } from "../lib/mock-data";

const approval = `/deployments/${MOCK_DEPLOYMENT_IDS.approval}`;

test("Chinese lifecycle is compact, localized and retains expandable stage definitions", async ({ page }) => {
  await page.context().addCookies([{ name: "tapeci_locale", value: "zh", url: "http://127.0.0.1:3100" }]);
  await page.goto(approval);
  const lifecycle = page.locator('section[aria-labelledby="milestones-heading"]');
  await expect(lifecycle).toBeVisible();
  await expect(lifecycle.locator('[data-stage="BUILD_SUCCESS"] .milestone-label')).toHaveText("构建成功");
  await expect(lifecycle.locator(".milestone-copy")).toHaveCount(0);
  expect((await lifecycle.boundingBox())!.height).toBeLessThan(260);
  await expect(lifecycle.locator("[data-milestone=done]")).toHaveCount(1);
  await lifecycle.getByText("阶段说明", { exact: true }).click();
  await expect(lifecycle.locator(".milestone-definitions")).toBeVisible();
  await expect(lifecycle.locator(".milestone-definitions")).toContainText("RPC");
});

test("approval review includes target, signature digest and fee cap before the action", async ({ page }) => {
  await page.goto(approval);
  const review = page.getByTestId("approval-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("0.3700 OKB");
  await expect(review).toContainText("0.5000 OKB");
  await expect(review.locator('a[href^="/containers/"]')).toBeVisible();
  await expect(review.getByRole("button", { name: "Copy manifest SHA-256" })).toBeVisible();
  await expect(page.getByTestId("approve-button")).toBeEnabled();
});

test("review tabs remain links with history and keyboard support", async ({ page }) => {
  await page.goto(approval);
  const sections = page.getByRole("navigation", { name: "Deployment sections" });
  await expect(sections.locator(".tab-indicator")).toHaveCount(1);
  const files = sections.getByRole("link", { name: "Files", exact: true });
  await files.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/view=files$/);
  await expect(files).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(sections.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
});

test("mobile reduced-motion review fits and disclosures work from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(approval);
  const summary = page.locator('.lifecycle-definitions summary');
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".milestone-definitions")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("approval-review")).toBeVisible();
});
