import { expect, test } from "@playwright/test";
import { MOCK_DEPLOYMENT_IDS } from "../lib/mock-data";

test("reviews original preparation without enabling unqualified compression in demo", async ({ page }) => {
  await page.goto(`/deployments/${MOCK_DEPLOYMENT_IDS.approval}?view=overview`);
  const panel = page.getByTestId("compression-preparation");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Strategy")).toHaveValue("original");
  await expect(panel.getByRole("button", { name: "Create a new approval plan" })).toBeDisabled();
  await expect(panel).toContainText("No matching gateway is configured");
  await expect(panel).toContainText("No snapshot recorded");
  // §15: the panel shows the recorded plan's own cost lines, and explains why automatic
  // selection stayed original instead of leaving the user to guess.
  await expect(panel.getByTestId("compression-cost")).toBeVisible();
  await expect(panel.getByTestId("compression-cost-estimate")).toContainText("wei");
  await expect(panel.getByTestId("compression-selection")).toContainText("Automatic selection");
  await expect(panel.getByTestId("compression-selection")).toContainText(
    "a production-compatible transaction simulation does not exist yet",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "中", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "压缩与产物审批" })).toBeVisible();
  await expect(panel).toContainText("没有配置匹配目标的网关");
});
