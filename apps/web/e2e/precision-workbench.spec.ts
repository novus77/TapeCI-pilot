import { expect, test } from "@playwright/test";
import { MOCK_DEPLOYMENT_IDS } from "../lib/mock-data";

test("desktop separates pipeline and actionable rail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("/");
  await expect(page.getByTestId("workbench-pending")).toBeVisible();
  await expect(page.getByTestId("workbench-pipeline")).toBeVisible();
  const sidebar = await page.locator(".shell-sidebar").boundingBox();
  const header = await page.locator(".ctxbar").boundingBox();
  const pipeline = await page.getByTestId("workbench-pipeline").boundingBox();
  const pending = await page.getByTestId("workbench-pending").boundingBox();
  expect(sidebar?.width).toBe(232);
  expect(header?.x).toBe(232);
  expect(header?.height).toBe(66);
  expect(pending!.x).toBeGreaterThan(pipeline!.x + pipeline!.width);
  await expect(page.locator(".kpi-grid")).toHaveCount(0);
});

test("phone prioritizes pending approval without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("workbench-pending")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const pending = await page.getByTestId("workbench-pending").boundingBox();
  const table = await page.locator(".workbench-main .table-wrap").boundingBox();
  expect(pending!.y + pending!.height).toBeLessThanOrEqual(844);
  expect(pending!.y).toBeLessThan(table!.y);
  const review = page.getByTestId("workbench-pending").getByRole("link").first();
  if (await review.count()) {
    await review.click();
    await expect(page).toHaveURL(/\/deployments\//);
    return;
  }
  await expect(page.getByTestId("workbench-pending")).toContainText("Nothing is waiting for a signature.");
});

test("search shortcut follows the current shell", async ({ page }) => {
  await page.goto("/");
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(page.locator(".ctxbar-search input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctxbar-search input")).not.toBeFocused();
});

test("collapsed tablet sidebar retains a navigation trigger", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 900 });
  await page.goto("/");
  await expect(page.locator(".shell-sidebar")).toBeHidden();
  await expect(page.locator(".nav-drawer-trigger")).toBeVisible();
  await page.locator(".nav-drawer-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".nav-drawer-trigger")).toBeFocused();
});

test("deployment review keeps guarded actions beside content and retains transactions", async ({ page }) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.approval}`);
  await expect(page.locator(".deployment-rail #actions-heading")).toBeVisible();
  await expect(page.getByTestId("compression-preparation")).toBeVisible();
  const content = await page.locator(".deployment-main").boundingBox();
  const actions = await page.locator(".deployment-rail").boundingBox();
  expect(actions!.x).toBeGreaterThan(content!.x + content!.width);
  await page.locator('.deployment-main a[href$="view=transactions"]').click();
  await expect(page.locator("#transactions-heading")).toBeVisible();
});
