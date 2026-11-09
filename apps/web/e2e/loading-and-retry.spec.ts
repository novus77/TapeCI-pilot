import { expect, test } from "@playwright/test";

/**
 * Loading shows the shape of the page instead of a bare spinner, and a failed
 * load offers a retry that re-runs the server render.
 */

test("the loading shell mirrors the page layout instead of a spinner", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  // Slow the document so the streamed loading shell is observable.
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 1200,
    downloadThroughput: 200 * 1024,
    uploadThroughput: 200 * 1024,
  });

  const navigation = page.goto("/deployments", { waitUntil: "commit" }).catch(() => null);
  await page.waitForTimeout(1800);

  const during = await page.evaluate(() => ({
    skeletons: document.querySelectorAll(".skeleton").length,
    busy: document.querySelector('[aria-busy="true"]') !== null,
    spinner: document.querySelectorAll(".button-spinner").length,
  }));
  expect(during.skeletons, "the loading shell must render layout placeholders").toBeGreaterThan(8);
  expect(during.busy, "the region must announce that it is busy").toBe(true);
  expect(during.spinner, "the bare spinner is replaced by skeletons").toBe(0);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await navigation;
  await page.waitForLoadState("networkidle");
  // The placeholders must disappear once the real content arrives.
  await expect(page.locator(".skeleton")).toHaveCount(0);
});

/**
 * NOT COVERED HERE, and why: the error notice is produced by a *server-side*
 * loader failure, and `page.route` cannot intercept requests the Next server makes
 * from Node. Reproducing it needs the API unreachable at server start:
 *
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:9 TAPECI_API_URL=http://127.0.0.1:9 \
 *     pnpm exec next dev apps/web -p 3000
 *
 * Verified that way by hand: the deployments page renders one `.notice-critical`
 * with one `[data-testid="retry-button"]` labelled "Try again". Attempting it with
 * `page.route` only aborts the browser's own requests, so the server still renders
 * the success path and the assertion would fail for the wrong reason.
 */
