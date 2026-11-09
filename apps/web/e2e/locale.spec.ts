import { expect, test } from "@playwright/test";

/**
 * The locale is a cookie read on the server, so switching must change the rendered
 * HTML (including `<html lang>`) and survive a reload without a hydration warning.
 */
test("switches the console between English and Chinese and persists the choice", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText("Deployments");

  await page.getByRole("button", { name: "中文" }).click();
  await expect(html).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("部署");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "新建项目" })).toBeVisible();

  await page.reload();
  await expect(html).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("部署");

  await page.getByRole("button", { name: "English" }).click();
  await expect(html).toHaveAttribute("lang", "en");
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText("Deployments");
});

test("keeps the deployment page in Chinese when the cookie is preset", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "tapeci_locale", value: "zh", url: origin },
  ]);
  await page.goto(`/deployments/${"44444444-4444-4444-8444-444444444444"}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("部署");
});
