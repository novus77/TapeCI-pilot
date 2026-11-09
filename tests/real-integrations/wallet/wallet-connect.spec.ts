import { expect, test } from "@playwright/test";

const PLAN_READY_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

test.skip(
  process.env.TAPECI_REAL_WALLET_BROWSER !== "1",
  "set TAPECI_REAL_WALLET_BROWSER=1 to run the browser connector check",
);

test("WalletConnect stays selectable without an injected provider", async ({ page }) => {
  await page.goto(`/deployments/${PLAN_READY_DEPLOYMENT_ID}`);

  expect(await page.evaluate(() => (window as { ethereum?: unknown }).ethereum)).toBeUndefined();

  const selector = page.getByLabel("Wallet connector");
  await expect(selector).toBeVisible();
  await selector.selectOption({ label: "WalletConnect" });
  await expect(selector).toHaveValue("walletConnect");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
});
