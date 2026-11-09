import { expect, test } from "@playwright/test";
import { MOCK_PROJECT_IDS } from "../lib/mock-data";

test("settings use a readable column and expose every section without artificial empty rows", async ({ page }) => {
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}/settings`);
  const build = page.locator('section[aria-labelledby="build-settings-heading"]');
  const members = page.locator('section[aria-labelledby="members-heading"]');
  await expect(build).toBeVisible();
  const first = await build.boundingBox();
  const second = await members.boundingBox();
  expect(first!.width).toBeGreaterThan(600);
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  const sections = page.getByRole("navigation", { name: "On this page" });
  await expect(sections.locator('a[href="#channels-heading"]')).toBeVisible();
  await sections.locator('a[href="#channels-heading"]').click();
  await expect(page).toHaveURL(/#channels-heading$/);
  const grid = await page.locator(".settings-grid").boundingBox();
  const channels = await page.locator('section[aria-labelledby="channels-heading"]').boundingBox();
  expect(grid!.y + grid!.height - channels!.y - channels!.height).toBeLessThan(60);
});

test("project list retains release and container links in aligned repository rows", async ({ page }) => {
  await page.goto("/projects");
  const row = page.locator(".project-card").first();
  await expect(row.locator(".project-mark")).toBeVisible();
  await expect(row.locator(".project-identity")).toBeVisible();
  await expect(row.locator('a[href^="/containers/"]').first()).toBeVisible();
  await expect(row.locator("dt")).toHaveCount(4);
});

test("wallet discovery precedes manual lookup and mint has one main landmark", async ({ page }) => {
  await page.goto("/resources");
  await expect(page.locator(".resource-discovery")).toBeVisible();
  const wallet = await page.locator(".resource-discovery").boundingBox();
  const manual = await page.locator('.resource-address-lookup').boundingBox();
  expect(wallet!.y).toBeLessThan(manual!.y);
  await page.goto("/resources/mint");
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByTestId("mint-choose")).toBeVisible();
});


test("mobile settings anchors leave the destination below the sticky navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${MOCK_PROJECT_IDS.tapekit}/settings`);
  const sections = page.getByRole("navigation", { name: "On this page" });
  await sections.locator('a[href="#channels-heading"]').click();
  await expect(page).toHaveURL(/#channels-heading$/);
  await expect.poll(async () => {
    const heading = await page.locator("#channels-heading").boundingBox();
    const navigation = await sections.boundingBox();
    return heading!.y - navigation!.y - navigation!.height;
  }).toBeGreaterThanOrEqual(0);
});
