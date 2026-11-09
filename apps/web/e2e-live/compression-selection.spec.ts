import { expect, test } from "@playwright/test";

const sourceId = "33333333-3333-4333-8333-333333333333";
test("selects compression through the real API and pins a separate unapproved deployment", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/deployments/${sourceId}`);
  const panel = page.getByTestId("compression-preparation");
  await expect(panel.getByLabel("Strategy")).toHaveValue("original");
  await panel.getByLabel("Strategy").selectOption("gzip-whole");
  await expect(panel.getByLabel("Target gateway")).toHaveValue("local-fixture");
  await panel.getByRole("button", { name: "Create a new approval plan" }).click();
  await expect(page).not.toHaveURL(new RegExp(`${sourceId}$`));
  await expect(panel).toContainText("Gzip whole bundle");
  await expect(panel).not.toContainText("No snapshot recorded");
  await expect(panel.getByRole("button", { name: "Create a new approval plan" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("compression-desktop.png"), fullPage: true });
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const headers = { "x-tapeci-github-login": "compression-review", "x-tapeci-github-user-id": "82031" };
  const result = await request.get(`http://127.0.0.1:8793/v1/deployments/${id}`, { headers });
  expect(result.ok()).toBe(true);
  expect((await result.json()).deployment).toMatchObject({ state: "BUILT", manifestSha256: null, approvedCostCapWei: null, hasPlan: false });
  const original = await request.get(`http://127.0.0.1:8793/v1/deployments/${sourceId}/preparation`, { headers });
  expect(await original.json()).toMatchObject({ request: { mode: "original" }, snapshotSha256: null });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "中", exact: true }).click();
  await expect(panel).toContainText("整包 Gzip");
  await expect(panel).not.toContainText("尚未记录产物快照");
  await page.screenshot({ path: testInfo.outputPath("compression-mobile-zh.png"), fullPage: true });
  expect(errors).toEqual([]);
});


test("uses the replacement configured gateway when the recorded gateway was removed", async ({ page }) => {
  await page.goto("/deployments/44444444-4444-4444-8444-444444444444");
  const panel = page.getByTestId("compression-preparation");
  await expect(panel).toContainText("removed-gateway");
  await expect(panel.getByLabel("Target gateway")).toHaveValue("local-fixture");
  await panel.getByRole("button", { name: "Create a new approval plan" }).click();
  await expect(page).not.toHaveURL(/44444444-4444-4444-8444-444444444444$/);
  await expect(panel).not.toContainText("No snapshot recorded");
  await expect(panel).toContainText("local-fixture");
});
