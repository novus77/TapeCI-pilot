import { expect, test, type Page } from "@playwright/test";

import { MOCK_PROJECT_IDS } from "../lib/mock-data";

/**
 * Settings page layout contract — `.superpowers/sdd/settings-ui/plan.md`
 * ("Tester" row) plus the gates in `docs/ui-ux/README.md`.
 *
 * Fixture: `MOCK_PROJECT_IDS.tapekit` from `apps/web/lib/mock-data.ts` renders
 * `buildCommand = "npm run build"`, `isArchived = false` and 3 members, so the
 * archive checkbox starts unchecked and every section owns a real control.
 *
 * Selectors pinned here, all present in the server-rendered markup:
 *   nav.section-nav                             the in-page section rail
 *   section[aria-labelledby="<id>-heading"]     one per settings section
 *   .danger-zone input[type=checkbox]           the archive toggle
 *   .danger-zone button[type=submit]            "Save archive state"
 *   #buildCommand                               first field of the build form
 */

const SETTINGS_PATH = `/projects/${MOCK_PROJECT_IDS.tapekit}/settings`;

test.beforeEach(async ({ page, baseURL }) => {
  // Pin the locale: every accessible name asserted below is the English string.
  await page.context().addCookies([
    { name: "tapeci_locale", value: "en", url: baseURL ?? "http://127.0.0.1:3100" },
  ]);
});

/**
 * Opens the settings page and waits until the server-rendered body is complete.
 * `networkidle` is flaky with Next prefetch; the danger zone is the last section
 * in the document, so its presence means nothing further is missing.
 */
async function openSettings(page: Page): Promise<void> {
  await page.goto(SETTINGS_PATH);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".danger-zone")).toBeVisible();
}

/** Section heading ids whose section owns a form, in document order. */
async function formSectionIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLFormElement>(".settings-grid form"))
      .map((form) => form.closest("section[aria-labelledby]")?.getAttribute("aria-labelledby") ?? null)
      .filter((id): id is string => id !== null),
  );
}

/**
 * True when a `beforeunload` listener has armed the native prompt.
 *
 * Playwright cannot observe the native beforeunload bubble: it is not a
 * `dialog` event, so `page.on("dialog")` never fires for it, and the browser
 * only shows the prompt during a real navigation that Playwright would have to
 * accept (Chromium's `--disable-prompt-on-repost` / headless paths swallow it).
 * Instead we dispatch a cancelable `beforeunload` event and read
 * `defaultPrevented` — the exact signal the browser inspects before prompting.
 * Dispatching also runs the real listener (its `event.preventDefault()` call),
 * so a guard wired only through `window.onbeforeunload = ...` fails this check
 * while `window.onbeforeunload !== null` would have passed it.
 */
async function beforeUnloadCancelled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

interface FocusSnapshot {
  readonly description: string;
  /** Section of the focused control, but only when the control is inside a form. */
  readonly formSection: string | null;
  readonly isDangerSave: boolean;
}

async function activeElement(page: Page): Promise<FocusSnapshot> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) {
      return { description: "body", formSection: null, isDangerSave: false };
    }
    const id = element.id === "" ? "" : `#${element.id}`;
    const className =
      typeof element.className === "string" && element.className.trim() !== ""
        ? `.${element.className.trim().split(/\s+/).join(".")}`
        : "";
    const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    // Only form controls count: a focused heading or rail link must not make a
    // section look "reachable through its form".
    const formSection =
      element.closest("form")?.closest("section[aria-labelledby]")?.getAttribute("aria-labelledby") ??
      null;
    return {
      description: `${element.tagName.toLowerCase()}${id}${className}${label === "" ? "" : ` "${label.slice(0, 48)}"`}`,
      formSection,
      isDangerSave: element === document.querySelector(".danger-zone button[type=submit]"),
    };
  });
}

test("danger zone archive checkbox and its label share one line at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const checkbox = page.locator('.danger-zone input[type="checkbox"][name="isArchived"]');
  await expect(checkbox).toBeVisible();

  const geometry = await checkbox.evaluate((element) => {
    const input = element as HTMLInputElement;
    // `labels` covers a wrapping <label> and a separate `for=` label, so this
    // keeps working whichever markup the designer settles on.
    const label = input.labels?.[0] ?? null;
    if (label === null) return null;

    const inputRect = input.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    // One rect per rendered line: the reported bug was "Archive / this /
    // project" wrapping to three lines inside a 56px tall field.
    const textRects: { top: number; bottom: number; left: number; right: number; height: number }[] = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        textRects.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          height: rect.height,
        });
      }
    }
    return {
      text: (label.textContent ?? "").trim(),
      input: {
        top: inputRect.top,
        bottom: inputRect.bottom,
        left: inputRect.left,
        right: inputRect.right,
      },
      labelHeight: labelRect.height,
      textRects,
    };
  });

  expect(geometry, "the archive checkbox must be associated with a <label>").not.toBeNull();
  if (geometry === null) return;

  expect(geometry.text.toLowerCase()).toContain("archive");
  expect(
    geometry.textRects,
    `label text "${geometry.text}" must render on a single line`,
  ).toHaveLength(1);
  // min-height:24px is the hit target, so 24 is one line, not two.
  expect(geometry.labelHeight, "the label must be one line tall").toBeLessThan(30);

  const line = geometry.textRects[0];
  expect(line).toBeDefined();
  if (line === undefined) return;
  // A single 13px text line is ~18px; the row may legitimately be 24px because
    // `.checkbox-field` has min-height:24px as a hit target. A wrapped label
    // would be 40px or more, so 30px is the discriminating threshold.
    expect(line.height, "the label's text must be one line tall").toBeLessThan(30);

  // One row: the checkbox box and the glyphs overlap vertically.
  const verticalOverlap =
    Math.min(geometry.input.bottom, line.bottom) - Math.max(geometry.input.top, line.top);
  expect(verticalOverlap, "checkbox and label must overlap vertically (one row)").toBeGreaterThan(0);

  // Side by side: the text follows the box rather than sitting above or below it.
  expect(line.left, "label text must start to the right of the checkbox").toBeGreaterThanOrEqual(
    geometry.input.right - 1,
  );
});

test("section rail tracks the section in view, there and back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  // Exactly one rail: a second `nav.section-nav` would make these locators
  // ambiguous, and Playwright's strict-mode error is the right signal for that.
  const rail = page.locator("nav.section-nav");
  await expect(rail).toBeVisible();

  const buildLink = rail.getByRole("link", { name: "Build configuration", exact: true });
  // Budget sits on its own row below Build/Members, which share a row in the
  // two-column grid. A shared row makes "which of the pair is current" ambiguous
  // by construction, so the round trip uses sections that own a row each.
  const budgetLink = rail.getByRole("link", { name: "Cost budget", exact: true });
  await expect(buildLink).toBeVisible();
  await expect(budgetLink).toBeVisible();

  /** Which rail entry is current, plus the geometry that explains the answer. */
  const railState = () =>
    page.evaluate(() => {
      const heading = document.getElementById("members-heading");
      const buildPanel = document.querySelector('section[aria-labelledby="build-settings-heading"]');
      const panel = document.querySelector('section[aria-labelledby="members-heading"]');
      return {
        current: document.querySelector('nav.section-nav a[aria-current="true"]')?.textContent ?? null,
        scrollY: Math.round(window.scrollY),
        membersHeadingTop: heading === null ? null : Math.round(heading.getBoundingClientRect().top),
        membersPanelTop: panel === null ? null : Math.round(panel.getBoundingClientRect().top),
        buildPanelBottom: buildPanel === null ? null : Math.round(buildPanel.getBoundingClientRect().bottom),
      };
    });

  const initial = await railState();
  await expect(buildLink, `rail on load: ${JSON.stringify(initial)}`).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Leg 1: scroll to the Cost budget section. The rail updates from a scroll
  // listener, so poll until it settles instead of reading the state immediately.
  await page
    .locator('section[aria-labelledby="budget-heading"]')
    .evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(budgetLink).toHaveAttribute("aria-current", "true");
  const atBudget = await railState();

  // Leg 2: scroll back to Build configuration.
  await page
    .locator('section[aria-labelledby="build-settings-heading"]')
    .evaluate((section) => section.scrollIntoView({ block: "start" }));
  await expect(buildLink).toHaveAttribute("aria-current", "true");
  const backAtBuild = await railState();

  // Assert both legs together so one run reports the whole round trip.
  expect(
    { atBudget: atBudget.current, backAtBuild: backAtBuild.current },
    [
      "the rail did not follow the round trip",
      `initial:      ${JSON.stringify(initial)}`,
      `at budget:    ${JSON.stringify(atBudget)}`,
      `back at build: ${JSON.stringify(backAtBuild)}`,
    ].join("\n"),
  ).toEqual({ atBudget: "Cost budget", backAtBuild: "Build configuration" });

  await expect(rail.locator('[aria-current="true"]')).toHaveCount(1);
});

test("editing the build command arms the beforeunload prompt", async ({ page }) => {
  await openSettings(page);

  const buildCommand = page.locator("#buildCommand");
  await expect(buildCommand).toBeVisible();

  // Baseline: a pristine page must not warn, otherwise "armed" proves nothing.
  expect(
    await beforeUnloadCancelled(page),
    "a pristine settings page must not warn before unload",
  ).toBe(false);

  // The guard is a React effect, so it attaches after hydration. Re-typing until
  // the listener answers avoids a false negative from keystrokes that land before
  // the effect has run.
  await buildCommand.click();
  await expect
    .poll(
      async () => {
        await buildCommand.press("End");
        await buildCommand.press("x");
        return beforeUnloadCancelled(page);
      },
      { message: "typing into #buildCommand must arm the beforeunload guard", timeout: 15_000 },
    )
    .toBe(true);

  const dispatch = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const notCancelled = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, notCancelled };
  });
  expect(dispatch.defaultPrevented).toBe(true);
  expect(dispatch.notCancelled, "dispatchEvent must report the event as cancelled").toBe(false);
});

test("settings page has no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  // The rail and every panel must have painted before measuring widths.
  await expect(page.locator('section[aria-labelledby="danger-heading"]')).toBeVisible();

  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    width.scrollWidth,
    `documentElement.scrollWidth ${width.scrollWidth} exceeds clientWidth ${width.clientWidth} at 390px`,
  ).toBeLessThanOrEqual(width.clientWidth + 1);
});

test("tab order reaches every settings form and the danger-zone save button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const dangerSave = page.locator('.danger-zone button[type="submit"]');
  await expect(dangerSave).toBeVisible();

  const sections = await formSectionIds(page);
  expect(sections.length, "the settings page should render forms").toBeGreaterThan(0);

  const visited: string[] = [];
  const visitedSections = new Set<string>();
  let reachedDangerSave = false;
  for (let step = 0; step < 80 && !reachedDangerSave; step += 1) {
    const snapshot = await activeElement(page);
    visited.push(snapshot.description);
    if (snapshot.formSection !== null) visitedSections.add(snapshot.formSection);
    reachedDangerSave = snapshot.isDangerSave;
    if (!reachedDangerSave) await page.keyboard.press("Tab");
  }

  const trace = visited.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
  expect(
    reachedDangerSave,
    `tab order never reached "Save archive state". Focus trail:\n${trace}`,
  ).toBe(true);
  await expect(dangerSave).toBeFocused();

  // Sections that own a form and sit before the danger zone must all have been
  // traversed. Channel forms live after it, so they are outside this traversal;
  // they are covered by the same DOM-order rule if the page is reordered.
  const dangerIndex = sections.indexOf("danger-heading");
  const preceding = dangerIndex === -1 ? sections : sections.slice(0, dangerIndex + 1);
  const unreachable = preceding.filter((id) => !visitedSections.has(id));
  expect(
    unreachable,
    `sections whose form was never focused while tabbing to the danger zone:\n${trace}`,
  ).toEqual([]);
});
