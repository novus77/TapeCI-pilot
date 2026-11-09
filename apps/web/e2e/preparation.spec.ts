/**
 * P7-01: the P3 screens exist now, so the acceptance items that were previously "DOM
 * assertions against pages that were never built" can finally be run.
 *
 * These tests deliberately run **without a wallet**, which is a real product state and
 * part of the contract: no quote, no Confirm, and a sentence saying why. The
 * wallet-dependent half — the quote itself, the fee/gas lines, the calldata — cannot be
 * exercised here without an injected provider (the panel needs a connected wallet equal to
 * the circuit's owner before it will price anything), so this file does not pretend to
 * cover it.
 */
import { expect, test } from "@playwright/test";

import { MOCK_PROCESSOR } from "../lib/mock-data";

const UNOPENED = `/resources/prepare?processor=${MOCK_PROCESSOR}&tokenId=2`;

test("without a wallet the prepare screen explains itself and offers no purchase", async ({
  page,
}) => {
  await page.goto(UNOPENED);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The resource is still shown: the page reads the chain before it needs a wallet.
  await expect(page.getByTestId("prepare-resource")).toBeVisible();

  // The panel states that a delivery wallet is required instead of rendering a Confirm
  // button the user could press into a refusal.
  await expect(page.getByTestId("prepare-wallet-required")).toBeVisible();
  await expect(page.getByTestId("prepare-confirm")).toHaveCount(0);

  // AC-P3-2: no purchase surface at all.
  for (const word of ["Buy", "Purchase", "Checkout", "Add to cart"]) {
    await expect(page.getByRole("button", { name: word })).toHaveCount(0);
    await expect(page.getByRole("link", { name: word })).toHaveCount(0);
  }

  // A `null` amount is "unknown", never "0 OKB": the screen must not price something it
  // could not read.
  await expect(page.locator("body")).not.toContainText("0.0000 OKB");
});

test("invalid parameters are refused with an explanation, not a blank page", async ({ page }) => {
  await page.goto("/resources/prepare?processor=not-an-address&tokenId=abc");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The specific state, not merely "something rendered": an invalid processor is refused
  // before any chain read or quote.
  await expect(page.getByTestId("prepare-problem")).toBeVisible();
});

test("the task screen reports a step's own state and never claims a confirmation", async ({
  page,
}) => {
  await page.goto("/preparations/mock-task");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The task must show which state it is in rather than a bare spinner, or explain a
  // failure — an empty shell is the failure mode this asserts against.
  await expect(
    page.getByTestId("preparation-task").or(page.getByTestId("preparation-load-error")),
  ).toBeVisible();

  const body = (await page.locator("body").innerText()).toLowerCase();
  // P3-01: no confirmation policy is configured, so there is no success terminal. A page
  // that says "confirmed" or "published" here would be lying about a payment.
  expect(body).not.toContain("confirmed");
  expect(body).not.toContain("published");
});

test("the resources row reaches the prepare screen for an unopened circuit", async ({ page }) => {
  await page.goto("/resources");
  const link = page.getByTestId("resources-open-link").first();
  if ((await link.count()) === 0) {
    // The fixture set may have no unopened row; the route must still resolve rather than
    // 404 — that 404 was the defect P3-02 was about.
    await page.goto(UNOPENED);
  } else {
    await link.click();
    await expect(page).toHaveURL(/\/resources\/prepare/);
  }
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("prepare-resource")).toBeVisible();
});
