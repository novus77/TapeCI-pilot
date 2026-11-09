import { expect, test, type Page } from "@playwright/test";

/**
 * Sweep the real Precision Console header at the original regression widths.
 * Creation remains reachable through the sidebar or mobile navigation trigger;
 * its link is deliberately no longer duplicated in the context toolbar.
 */

const WIDTHS = [
  320, 360, 390, 480, 560, 640, 700, 768, 820, 861, 870, 883, 900, 920, 960, 961, 1024, 1280, 1440,
] as const;

const ROUTES = ["/", "/projects", "/organizations", "/deployments"] as const;

const VIEWPORT_HEIGHT = 800;

const BRAND_SELECTOR = ".sidebar-brand, .ctxbar-brand";
const PRIMARY_ACTION_SELECTOR = '.shell-sidebar a[href="/projects/new"], .ctxbar .nav-drawer-trigger';
const ACTIONS_SELECTOR = ".ctxbar-actions";
const CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]';

/** Sub-pixel layout rounding is not an overflow. */
const OVERFLOW_TOLERANCE = 1;
/** `plan.md` item 4: the cluster may drift at a breakpoint, it must not jump. */
const MAX_ACTION_WIDTH_JUMP = 30;

interface BarBox {
  readonly tag: string;
  readonly className: string;
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

interface BarChild {
  readonly className: string;
  readonly width: number;
  readonly display: string;
}

/** An element that sticks out past the viewport and is not inside a scroller. */
interface OverflowSource {
  readonly label: string;
  readonly right: number;
  readonly width: number;
}

interface BarSample {
  readonly route: string;
  readonly width: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly bodyScrollWidth: number;
  readonly actionsWidth: number;
  readonly innerClientWidth: number;
  readonly innerScrollWidth: number;
  readonly children: readonly BarChild[];
  readonly brand: BarBox | null;
  readonly primary: BarBox | null;
  readonly controls: readonly BarBox[];
  readonly sources: readonly OverflowSource[];
}

interface ActionsSnapshot {
  readonly width: number;
  readonly visibleParts: readonly string[];
}

/** Twice-round-trip of `requestAnimationFrame`: layout has settled after a resize. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * One full measurement of the bar at the current viewport.
 *
 * `clientWidth` (not `innerWidth`) is the usable viewport: it excludes the
 * vertical scrollbar, which the layout does not span. Elements are considered
 * "in the viewport" when their box fits between 0 and `clientWidth`.
 */
async function sampleBar(page: Page, route: string, width: number): Promise<BarSample> {
  return page.evaluate(
    (input) => {
      const round = (value: number): number => Math.round(value * 10) / 10;

      const describe = (element: Element): string => {
        const id = element.id === "" ? "" : `#${element.id}`;
        const firstClass = (element.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
        return `${element.tagName.toLowerCase()}${id}${firstClass === "" ? "" : `.${firstClass}`}`;
      };

      const readBox = (element: Element | null): BarBox | null => {
        if (element === null) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: (element.getAttribute("class") ?? "").trim(),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          left: round(rect.left),
          right: round(rect.right),
          width: round(rect.width),
          height: round(rect.height),
          text: (element.getAttribute("aria-label") ?? element.textContent ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40),
        };
      };

      /**
       * An element that overflows the document only counts as a source when no
       * ancestor scrolls/clips it — a wide cell inside `.table-wrap` is clipped
       * by its own scroller and does not widen the page. `body` is excluded on
       * purpose: it carries `overflow-x: clip` while still widening
       * `documentElement.scrollWidth`, so treating it as a clipper would hide
       * every real source.
       */
      const clippedByAncestor = (element: Element): boolean => {
        let parent = element.parentElement;
        while (parent !== null && parent !== document.body && parent !== document.documentElement) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      };

      const root = document.documentElement;
      const clientWidth = root.clientWidth;
      const scrollWidth = root.scrollWidth;
      const overflow = scrollWidth - clientWidth;

      const actions = document.querySelector(input.actionsSelector);
      const actionsRect = actions === null ? null : actions.getBoundingClientRect();
      const inner = document.querySelector(".ctxbar");
      const innerRect = inner === null ? null : inner.getBoundingClientRect();

      const children: BarChild[] = inner === null
        ? []
        : Array.from(inner.children).map((child) => ({
            className: (child.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "",
            width: round(child.getBoundingClientRect().width),
            display: getComputedStyle(child).display,
          }));

      const controls: BarBox[] =
        actions === null
          ? []
          : Array.from(actions.querySelectorAll(input.controlSelector))
              .map(readBox)
              .filter((box): box is BarBox =>
                box !== null &&
                box.width > 0 &&
                box.height > 0 &&
                box.display !== "none" &&
                box.visibility !== "hidden",
              );

      const sources: OverflowSource[] = [];
      if (overflow > 1) {
        for (const element of Array.from(document.querySelectorAll("body *"))) {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.right <= clientWidth + 1) continue;
          if (clippedByAncestor(element)) continue;
          sources.push({ label: describe(element), right: round(rect.right), width: round(rect.width) });
        }
        sources.sort((left, right) => right.right - left.right);
        sources.length = Math.min(sources.length, 4);
      }

      return {
        route: input.route,
        width: input.width,
        clientWidth,
        scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        actionsWidth: actionsRect === null ? 0 : round(actionsRect.width),
        innerClientWidth: inner === null ? 0 : Math.round(innerRect?.width ?? 0),
        innerScrollWidth: inner === null ? 0 : inner.scrollWidth,
        children,
        brand: readBox(Array.from(document.querySelectorAll(input.brandSelector)).find(element => element.getBoundingClientRect().width > 0) ?? null),
        primary: readBox(Array.from(document.querySelectorAll(input.primarySelector)).find(element => element.getBoundingClientRect().width > 0) ?? null),
        controls,
        sources,
      };
    },
    {
      route,
      width,
      brandSelector: BRAND_SELECTOR,
      primarySelector: PRIMARY_ACTION_SELECTOR,
      actionsSelector: ACTIONS_SELECTOR,
      controlSelector: CONTROL_SELECTOR,
    },
  );
}

/** `.ctxbar-actions` width plus which children are actually rendered. */
async function sampleActions(page: Page): Promise<ActionsSnapshot> {
  return page.evaluate((selector) => {
    const actions = document.querySelector(selector);
    if (actions === null) return { width: 0, visibleParts: [] };
    return {
      width: Math.round(actions.getBoundingClientRect().width * 10) / 10,
      visibleParts: Array.from(actions.children)
        .filter((child) => {
          const rect = child.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(child).display !== "none";
        })
        .map((child) => {
          const text = (child.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 18);
          const firstClass = (child.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
          return firstClass === "" ? text : `.${firstClass}${text === "" ? "" : ` "${text}"`}`;
        }),
    };
  }, ACTIONS_SELECTOR);
}

function formatBox(box: BarBox | null): string {
  if (box === null) return "<element missing from the DOM>";
  const name = `.${box.className.split(" ")[0] ?? box.tag}`;
  return (
    `${name} display=${box.display} visibility=${box.visibility} opacity=${box.opacity} ` +
    `x=${box.left}..${box.right} w=${box.width} h=${box.height} "${box.text}"`
  );
}

/** `null` when the box is present, non-zero and fully inside the viewport. */
function boxProblem(box: BarBox | null, clientWidth: number): string | null {
  if (box === null) return "element missing from the DOM";
  if (box.width <= 0 || box.height <= 0) {
    return `no box (w=${box.width} h=${box.height}); element is removed, not clipped`;
  }
  if (box.right > clientWidth + OVERFLOW_TOLERANCE) {
    return `right edge ${box.right}px is past the ${clientWidth}px viewport (clipped by overflow)`;
  }
  if (box.left < -OVERFLOW_TOLERANCE) return `left edge ${box.left}px is off the viewport`;
  return null;
}

test("no swept width overflows, hides the primary action or clips a bar control", async ({ page }) => {
  const samples: BarSample[] = [];

  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(".ctxbar")).toBeVisible();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await settle(page);
      samples.push(await sampleBar(page, route, width));
    }
  }

  // The raw numbers, as a route × width grid, so a failure and the report can
  // both be read without re-running the sweep.
  const grid = ROUTES.map((route) => {
    const cells = WIDTHS.map((width) => {
      const sample = samples.find((entry) => entry.route === route && entry.width === width);
      return sample === undefined ? "?" : `${sample.scrollWidth - sample.clientWidth}`;
    });
    return `${route}\t${cells.join("\t")}`;
  });
  console.log(
    [
      "[sweep] overflow = documentElement.scrollWidth - clientWidth, px",
      `width\t${WIDTHS.join("\t")}`,
      ...grid,
    ].join("\n"),
  );

  // --- 1. no horizontal overflow -----------------------------------------
  const overflow = samples.filter(
    (sample) => sample.scrollWidth > sample.clientWidth + OVERFLOW_TOLERANCE,
  );
  const overflowReport = overflow
    .map((sample) => {
      const parts = sample.children
        .map((child) => `${child.className || "(no class)"}=${child.width}${child.display === "none" ? "(hidden)" : ""}`)
        .join(" ");
      const sources =
        sample.sources.length === 0
          ? "not localised"
          : sample.sources.map((source) => `${source.label} right=${source.right} w=${source.width}`).join(" | ");
      return [
        `${sample.route} @ ${sample.width}px: overflow +${sample.scrollWidth - sample.clientWidth}px ` +
          `(scrollWidth=${sample.scrollWidth} clientWidth=${sample.clientWidth} bodyScrollWidth=${sample.bodyScrollWidth})`,
        `    .ctxbar width=${sample.innerClientWidth} scrollWidth=${sample.innerScrollWidth} | .ctxbar-actions=${sample.actionsWidth}`,
        `    children: ${parts}`,
        `    overflowing: ${sources}`,
      ].join("\n");
    })
    .join("\n");
  expect.soft(
    overflow.map((sample) => `${sample.route}@${sample.width}`),
    `${overflow.length} of ${samples.length} route/width combinations overflow horizontally ` +
      `(allowed: scrollWidth <= clientWidth + ${OVERFLOW_TOLERANCE}):\n${overflowReport}`,
  ).toEqual([]);

  // --- 2. brand and primary action stay visible ---------------------------
  const visibility: string[] = [];
  for (const sample of samples) {
    const brand = boxProblem(sample.brand, sample.clientWidth);
    if (brand !== null) {
      visibility.push(`${sample.route} @ ${sample.width}px: brand — ${brand}\n    ${formatBox(sample.brand)}`);
    }
    const primary = boxProblem(sample.primary, sample.clientWidth);
    if (primary !== null) {
      visibility.push(
        `${sample.route} @ ${sample.width}px: primary action — ${primary}\n    ${formatBox(sample.primary)}`,
      );
    }
  }
  expect.soft(
    visibility.map((line) => line.split("\n")[0] ?? line),
    `brand / primary action must have a non-zero box inside the viewport at every width:\n${visibility.join("\n")}`,
  ).toEqual([]);

  // --- 3. no clipped controls --------------------------------------------
  const clipped: string[] = [];
  for (const sample of samples) {
    for (const control of sample.controls) {
      if (control.right > sample.clientWidth + OVERFLOW_TOLERANCE) {
        clipped.push(
          `${sample.route} @ ${sample.width}px: ${formatBox(control)} — right edge is ${control.right - sample.clientWidth}px past the viewport`,
        );
      }
      if (control.left < -OVERFLOW_TOLERANCE) {
        clipped.push(`${sample.route} @ ${sample.width}px: ${formatBox(control)} — left edge is off the viewport`);
      }
    }
  }
  expect.soft(clipped, `visible .ctxbar-actions controls pushed outside the viewport:\n${clipped.join("\n")}`).toEqual([]);

  // Guard against a vacuous pass: the cluster always renders the locale switch,
  // the notification bell and the avatar, so zero controls means the selector
  // stopped matching, not that the bar is clean.
  const empty = samples
    .filter((sample) => sample.controls.length === 0)
    .map((sample) => `${sample.route}@${sample.width}`);
  expect.soft(empty, `no visible .ctxbar-actions control was found at these widths — selector drift`).toEqual([]);
});

test("the action cluster width does not jump across the 961px boundary", async ({ page }) => {
  const rows: { route: string; before: ActionsSnapshot; after: ActionsSnapshot }[] = [];

  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator(".ctxbar")).toBeVisible();

    await page.setViewportSize({ width: 960, height: VIEWPORT_HEIGHT });
    await settle(page);
    const before = await sampleActions(page);

    await page.setViewportSize({ width: 961, height: VIEWPORT_HEIGHT });
    await settle(page);
    const after = await sampleActions(page);

    rows.push({ route, before, after });
  }

  const jumps = rows.filter((row) => Math.abs(row.after.width - row.before.width) > MAX_ACTION_WIDTH_JUMP);
  const detail = jumps
    .map(
      (row) =>
        `${row.route} @ 960→961px: .ctxbar-actions ${row.before.width}px → ${row.after.width}px ` +
        `(delta ${Math.round((row.after.width - row.before.width) * 10) / 10}px, allowed ${MAX_ACTION_WIDTH_JUMP}px)\n` +
        `    visible at 960: ${row.before.visibleParts.join(", ") || "<none>"}\n` +
        `    visible at 961: ${row.after.visibleParts.join(", ") || "<none>"}`,
    )
    .join("\n");

  expect.soft(
    jumps.map((row) => `${row.route}@961`),
    `the cluster must not grow/shrink by more than ${MAX_ACTION_WIDTH_JUMP}px between 960px and 961px:\n${detail}`,
  ).toEqual([]);

  // The same numbers for the passing case, so the report can quote them.
  console.log(
    `[961] ${rows
      .map((row) => `${row.route}: 960=${row.before.width} 961=${row.after.width}`)
      .join(" | ")}`,
  );
});

test("the top bar stays pinned to the top of the viewport while scrolling", async ({ page }) => {
  const viewports = [
    { width: 1280, height: 700 },
    { width: 390, height: 700 },
  ] as const;
  const failures: string[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/deployments");
    await expect(page.locator(".ctxbar")).toBeVisible();

    // Hydration streams in after the shell, so the document can still be shorter
    // than the viewport for a moment. Scrolling then silently does nothing, which
    // once produced a bogus "did not scroll" fixture failure — wait for real
    // scrollable height instead of sleeping.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const scrollHeight = Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            );
            return scrollHeight - window.innerHeight;
          }),
        {
          message:
            `/deployments @ ${viewport.width}x${viewport.height}: the page never ` +
            `became tall enough to scroll, so sticky cannot be observed`,
        },
      )
      .toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 900));
    await settle(page);

    const state = await page.evaluate(() => {
      const bar = document.querySelector(".ctxbar");
      const rect = bar === null ? null : bar.getBoundingClientRect();
      return {
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        ),
        innerHeight: window.innerHeight,
        barTop: rect === null ? null : Math.round(rect.top),
        barBottom: rect === null ? null : Math.round(rect.bottom),
        position: bar === null ? "missing" : getComputedStyle(bar).position,
      };
    });

    const where = `/deployments @ ${viewport.width}x${viewport.height}`;
    if (state.scrollY === 0) {
      // A page that cannot scroll would make the assertion below pass for the
      // wrong reason; flag it as a fixture problem instead of a sticky pass.
      failures.push(
        `[fixture] ${where}: the page did not scroll (scrollY=0, scrollHeight=${state.scrollHeight}, ` +
          `innerHeight=${state.innerHeight}) — sticky cannot be observed`,
      );
      continue;
    }
    if (state.barTop === null || Math.abs(state.barTop) > OVERFLOW_TOLERANCE) {
      failures.push(
        `[product] ${where}: after scrolling to y=${state.scrollY} the bar top is ${String(state.barTop)}px ` +
          `instead of 0px (position=${state.position}, bottom=${String(state.barBottom)})`,
      );
    }
  }

  expect.soft(failures, failures.join("\n")).toEqual([]);
});
