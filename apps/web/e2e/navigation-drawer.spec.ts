import { expect, test } from "@playwright/test";

/**
 * Navigation on a phone used to be a horizontally scrolling strip: destinations
 * past the fold were unreachable with no affordance. It is now a drawer.
 */

const MOBILE = { width: 390, height: 844 };

test("the drawer opens, traps nothing, and Escape returns focus to the trigger", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/projects");

  const trigger = page.locator(".nav-drawer-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const drawer = page.locator('#nav-drawer[role="dialog"][aria-modal="true"]');
  await expect(drawer).toBeVisible();
  // 8 destinations now that /resources exists (P2). Update this count whenever a
  // nav entry is added or removed; it is the drawer's completeness check.
  await expect(drawer.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveCount(8);

  // The page behind must not scroll while the drawer is open.
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Focus must come back to the control that opened it, not to the document.
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain(
    "nav-drawer-trigger",
  );
});

test("the drawer is not reachable when closed", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/projects");
  await expect(page.locator('#nav-drawer[role="dialog"]')).toHaveCount(0);
  // Tabbing from the top must not land inside a closed drawer.
  let landedInsideDrawer = false;
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.closest("#nav-drawer") !== null;
    });
    if (inside) {
      landedInsideDrawer = true;
      break;
    }
  }
  expect(landedInsideDrawer).toBe(false);
});

test("a drawer link navigates and closes the drawer", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/projects");
  await page.locator(".nav-drawer-trigger").click();
  await page.locator('#nav-drawer a[href="/deployments"]').click();
  await expect(page).toHaveURL(/\/deployments/);
  await expect(page.locator('#nav-drawer[role="dialog"]')).toHaveCount(0);
});

test("desktop shows the sidebar and no drawer trigger", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/projects");
  await expect(page.locator(".nav-drawer-trigger")).toBeHidden();
  await expect(page.locator(".shell-sidebar .nav-link").first()).toBeVisible();
});

test("/ focuses the top-bar search and ignores typing contexts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/deployments");
  await page.getByRole("heading", { level: 1 }).click();

  await page.keyboard.press("/");
  await expect(page.locator("[data-console-search] input")).toBeFocused();

  // Escape releases it.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-console-search] input")).not.toBeFocused();

  // A `/` typed into a real field must stay in that field.
  const filter = page.getByLabel("Search", { exact: true }).first();
  await filter.click();
  await filter.type("a/b");
  await expect(filter).toHaveValue("a/b");
  await expect(filter).toBeFocused();
});
