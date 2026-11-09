import { expect, test } from "@playwright/test";

/**
 * `/resources/mint` — obtaining a circuit (SPEC §3.2).
 *
 * The catalogue is large (398 processors, 357 with stock), so the screen is a searchable
 * master-detail list rather than a card grid: pick from many, then see the price. The
 * assertions follow that shape — list, filter, detail, then the fee review.
 */
test.describe("/resources/mint flow", () => {
  test("lists the whole catalogue cheapest-first and filters it", async ({ page }) => {
    await page.goto("/resources/mint");

    const rows = page.locator('[data-testid^="processor-row-"]');
    // Two fixtures made this page look empty; the catalogue is large and the list must show it.
    expect(await rows.count()).toBeGreaterThan(20);
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "processor-row-12");

    const search = page.getByTestId("mint-search");
    await search.fill("63");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "processor-row-63");
  });

  test("selecting a processor shows its price before anything is committed", async ({ page }) => {
    await page.goto("/resources/mint");
    await page.getByTestId("processor-row-5").click();

    const detail = page.getByTestId("mint-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("#5");
    await expect(page.getByTestId("detail-total")).toContainText("OKB");
    await expect(page.getByTestId("detail-mint")).toContainText("OKB");
    await expect(page.getByTestId("detail-tapeout")).toContainText("OKB");
    // Browsing is not buying: no fee review until the user chooses.
    await expect(page.getByTestId("mint-confirm")).toHaveCount(0);
  });

  test("choosing moves to a fee review that itemises every payment", async ({ page }) => {
    await page.goto("/resources/mint");
    await page.getByTestId("processor-row-12").click();
    await page.getByTestId("processor-choose-12").click();

    await expect(page.getByTestId("mint-confirm")).toBeVisible();
    await expect(page.getByTestId("quote-mint")).toContainText("OKB");
    await expect(page.getByTestId("quote-tapeout")).toContainText("OKB");
    await expect(page.getByTestId("quote-opener")).toContainText("OKB");
    await expect(page.getByTestId("quote-total")).toContainText("OKB");
    await expect(page.getByTestId("quote-predicted")).toContainText("receipt");
  });

  test("demo mode refuses to send rather than failing at the wallet", async ({ page }) => {
    await page.goto("/resources/mint");
    await page.getByTestId("processor-row-12").click();
    await page.getByTestId("processor-choose-12").click();

    await expect(page.getByTestId("mint-demo")).toBeVisible();
    await expect(page.getByTestId("mint-execute")).toHaveCount(0);
  });

  test("the step bar tracks where the user is", async ({ page }) => {
    await page.goto("/resources/mint");
    await expect(page.getByTestId("mint-steps")).toContainText("Choose processor");
    await page.getByTestId("processor-row-12").click();
    await page.getByTestId("processor-choose-12").click();
    await expect(page.getByTestId("mint-steps")).toContainText("Review and pay");
  });

  test("states that a tapeout is irreversible before any payment", async ({ page }) => {
    await page.goto("/resources/mint");
    await expect(page.getByText(/irreversible/i)).toBeVisible();
    await expect(page.getByText(/the receipt decides/i)).toBeVisible();
  });
});
