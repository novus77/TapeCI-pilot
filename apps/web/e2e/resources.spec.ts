import { expect, test } from "@playwright/test";

import {
  MOCK_RESOURCE_CATALOGUE,
  MOCK_RESOURCES_EMPTY_ADDRESS,
  MOCK_RESOURCES_PARTIAL_ADDRESS,
  MOCK_RESOURCES_READY_ADDRESS,
  MOCK_RESOURCES_UNAVAILABLE_ADDRESS,
  MOCK_WALLET_RESOURCES_EMPTY,
  MOCK_WALLET_RESOURCES_PARTIAL,
  MOCK_WALLET_RESOURCES_READY,
  MOCK_WALLET_RESOURCES_UNAVAILABLE,
} from "../lib/mock-data";

/**
 * `/resources` end-to-end contract: SPEC §3.1 (existing-resource journey), §3.2.1
 * ("no assets" only after a *complete* scan; a failed read is never an empty
 * wallet), §3.4, §15.1 (UI completes the existing-resource flow without skipping a
 * state), and `product-p2.md` §2 (the four states and W1–W10).
 *
 * Every expected value is derived from the fixture the mock store serves, so a
 * fixture change moves the assertions with it instead of silently disagreeing.
 * The four fixture addresses are the only inputs; the hex is never inlined here.
 */

/** The four fixture addresses and the state the page must derive from each. */
const FIXTURES = [
  {
    name: "ready",
    address: MOCK_RESOURCES_READY_ADDRESS,
    state: "ready",
    rows: MOCK_WALLET_RESOURCES_READY.resources.length,
    emptyCopy: false,
  },
  {
    name: "partial scan",
    address: MOCK_RESOURCES_PARTIAL_ADDRESS,
    state: "partial",
    rows: MOCK_WALLET_RESOURCES_PARTIAL.resources.length,
    emptyCopy: false,
  },
  {
    name: "read unavailable",
    address: MOCK_RESOURCES_UNAVAILABLE_ADDRESS,
    state: "unavailable",
    rows: MOCK_WALLET_RESOURCES_UNAVAILABLE.resources.length,
    emptyCopy: false,
  },
  {
    // The only fixture allowed to say "No circuits": ready + complete + 0 rows.
    name: "complete and empty",
    address: MOCK_RESOURCES_EMPTY_ADDRESS,
    state: "ready",
    rows: MOCK_WALLET_RESOURCES_EMPTY.resources.length,
    emptyCopy: true,
  },
] as const;

const EMPTY_SENTENCE = /No circuits were found/i;
const PARTIAL_SENTENCE = /Scan incomplete/i;
const UNAVAILABLE_SENTENCE = /Could not read circuits/i;

/**
 * The three state sentences are keyed to `resources.empty` / `resources.scanIncomplete`
 * / `resources.readFailed`, which W1 requires to be mutually exclusive per render.
 */
const STATE_SENTENCES = [EMPTY_SENTENCE, PARTIAL_SENTENCE, UNAVAILABLE_SENTENCE] as const;

/** W1/W2: which single sentence, if any, this fixture is allowed to render. */
function allowedSentence(fixture: (typeof FIXTURES)[number]): RegExp | null {
  if (fixture.emptyCopy) return EMPTY_SENTENCE;
  if (fixture.state === "partial") return PARTIAL_SENTENCE;
  if (fixture.state === "unavailable") return UNAVAILABLE_SENTENCE;
  return null;
}

/** §0.3 / AC-P2-31: purchase stays closed, so no affordance may name it. */
const PURCHASE_AFFORDANCE = /buy|purchase|top[\s-]?up|price|checkout|cart/i;

/**
 * Purchase vocabulary may survive in *warning* copy ("no purchase", "never buys");
 * what must never exist is a sentence that offers one. Splitting on sentence
 * punctuation lets the scan distinguish the two instead of passing because the
 * words were simply absent.
 */
const PURCHASE_VOCABULARY =
  /\b(buy|buys|buying|purchase|purchases|purchased|purchasing|top[\s-]?up|price|pricing|checkout|cart)\b/i;
const NEGATION = /\b(no|not|never|nothing|without)\b/i;

for (const fixture of FIXTURES) {
  test(`${fixture.name}: data-state and row count match the fixture`, async ({ page }) => {
    await page.goto(`/resources?address=${fixture.address}`);
    const root = page.locator('[data-testid="resources-state"]:visible');

    // §2.1: one root element carries `data-state`, so state is machine-readable
    // without matching copy.
    await expect(root).toHaveCount(1);
    await expect(root).toHaveAttribute("data-state", fixture.state);
    await expect(page.locator("tbody tr")).toHaveCount(fixture.rows);

    // §3.2.1 / W1 / W2: the partial and unavailable fixtures must not borrow the
    // empty sentence — "we have not finished looking" / "the read failed" is the
    // opposite claim from "no circuits", and only ready+complete+0 rows may say it.
    const expected = allowedSentence(fixture);
    for (const sentence of STATE_SENTENCES) {
      await expect(page.getByText(sentence)).toHaveCount(sentence === expected ? 1 : 0);
    }
  });
}

test("a complete scan reports the block it read and the rows it found", async ({ page }) => {
  await page.goto(`/resources?address=${MOCK_RESOURCES_READY_ADDRESS}`);
  const root = page.locator('[data-testid="resources-state"]:visible');
  await expect(root).toHaveAttribute("data-state", "ready");
  await expect(root).toContainText("Scan complete for the factory catalogue");
  await expect(root.getByText(`Read at block ${MOCK_WALLET_RESOURCES_READY.observedBlock}`)).toBeVisible();
  await expect(
    root.getByText(`${MOCK_WALLET_RESOURCES_READY.resources.length} circuit(s) found`),
  ).toBeVisible();
});

test("a partial scan shows coverage and a found-so-far count, never a total", async ({ page }) => {
  await page.goto(`/resources?address=${MOCK_RESOURCES_PARTIAL_ADDRESS}`);
  const root = page.locator('[data-testid="resources-state"]:visible');
  await expect(root).toHaveAttribute("data-state", "partial");
  await expect(root).toContainText("Scan incomplete");

  // W4: an unfinished scan may not present a total.
  await expect(
    root.getByText(`${MOCK_WALLET_RESOURCES_PARTIAL.resources.length} circuit(s) found so far`),
  ).toBeVisible();

  // W10: the banner carries the block range actually covered, from the fixture.
  const indexedThrough = MOCK_WALLET_RESOURCES_PARTIAL.indexedThroughBlock;
  expect(indexedThrough, "the partial fixture must name the block it reached").not.toBeNull();
  await expect(root.getByText(`Indexed through block ${indexedThrough}.`)).toBeVisible();

  // W3: an unfinished scan must not wear the "complete" chip as well.
  await expect(root.getByText("Scan complete for the factory catalogue")).toHaveCount(0);
});

test("a failed read renders failure, never an empty table", async ({ page }) => {
  await page.goto(`/resources?address=${MOCK_RESOURCES_UNAVAILABLE_ADDRESS}`);
  const root = page.locator('[data-testid="resources-state"]:visible');
  await expect(root).toHaveAttribute("data-state", "unavailable");
  await expect(root).toContainText("Could not read circuits on X Layer 196");
  await expect(root).toContainText("RESOURCE_READ_UNAVAILABLE");

  // §2.5: no table, not an empty one — an empty table would be a claim. No row
  // may render a boolean fact from a read that did not happen (W5, AC-P2-17).
  await expect(page.locator("table")).toHaveCount(0);
  await expect(page.locator("[data-read-status]")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

test("complete-and-empty is the only state that may say no circuits, and it carries coverage", async ({
  page,
}) => {
  await page.goto(`/resources?address=${MOCK_RESOURCES_EMPTY_ADDRESS}`);
  const root = page.locator('[data-testid="resources-state"]:visible');
  await expect(root).toHaveAttribute("data-state", "ready");
  await expect(root.getByText("No circuits were found for this address")).toBeVisible();

  // W10: the empty sentence never travels alone. Completeness is catalogue-scoped,
  // so the clause must name both the catalogue size and the block scanned.
  const scannedBlock = MOCK_WALLET_RESOURCES_EMPTY.indexedThroughBlock;
  expect(scannedBlock, "the empty fixture must name the block its complete scan reached").not.toBeNull();
  await expect(
    root.getByText(
      `The factory catalogue lists ${MOCK_RESOURCE_CATALOGUE.processors.length} processor(s) and the scan reached block ${scannedBlock}.`,
    ),
  ).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
});

test("null is not false: a failed or absent row says Not read, not Not opened", async ({ page }) => {
  await page.goto(`/resources?address=${MOCK_RESOURCES_READY_ADDRESS}`);
  await expect(page.locator('[data-testid="resources-state"]:visible')).toHaveAttribute("data-state", "ready");

  // `unavailable` row: every fact is null. It must say "Not read" (three times:
  // owner, deployed, opened), "Not derived" for the container, and "—" for the
  // unread block — never a boolean rendered from a null (W5, W6).
  const failedRow = page.locator('tr[data-read-status="unavailable"]');
  await expect(failedRow).toHaveCount(1);
  await expect(failedRow.getByText("Not read", { exact: true })).toHaveCount(3);
  await expect(failedRow.getByText("Not derived", { exact: true })).toHaveCount(1);
  await expect(failedRow.getByText("—", { exact: true })).toHaveCount(1);
  await expect(failedRow.getByText(/not opened|not deployed|not activated/i)).toHaveCount(0);
  // W7: an unreadable row offers no "use" action.
  await expect(failedRow.locator("a")).toHaveCount(0);

  // `not_found` row: explicit absence is its own sentence, not "no circuits" and
  // not a failed read.
  const absentRow = page.locator('tr[data-read-status="not_found"]');
  await expect(absentRow).toHaveCount(1);
  await expect(absentRow).toContainText("Not found");
  await expect(absentRow).toContainText("This circuit does not exist on this processor.");
  await expect(absentRow.getByText("Not read", { exact: true })).toHaveCount(3);
  await expect(absentRow.getByText("Not derived", { exact: true })).toHaveCount(1);
  await expect(absentRow.getByText(/not opened|not deployed|not activated/i)).toHaveCount(0);
  await expect(absentRow.locator("a")).toHaveCount(0);

  // The positive half of W5: a real `false` is a different fact from a `null`, and
  // it renders "Not opened" *with the block it was read at*.
  const realFalse = MOCK_WALLET_RESOURCES_READY.resources.find((row) => row.opened === false);
  if (realFalse === undefined || realFalse.observedBlock === null) {
    throw new Error("the ready fixture must carry a verified row with opened === false");
  }
  const falseRow = page
    .locator('tbody tr[data-read-status="verified"]')
    .filter({ hasText: `#${realFalse.resource.tokenId}` });
  // The value and its block live in the same cell, so a false fact cannot be read
  // without the block it was read at (§2.3, W5).
  const openedCell = falseRow.locator("td").filter({ hasText: "Not opened" });
  await expect(openedCell).toHaveCount(1);
  await expect(openedCell).toContainText(`block ${realFalse.observedBlock}`);
  // Only rows whose `opened` was actually read as `false` may say it; the null
  // rows above must not. The fixture carries two genuine false rows, so the count
  // comes from the fixture rather than from a guess of one.
  const falseOpenedRows = MOCK_WALLET_RESOURCES_READY.resources.filter(
    (row) => row.opened === false,
  );
  await expect(page.locator("tbody tr").filter({ hasText: "Not opened" })).toHaveCount(
    falseOpenedRows.length,
  );
});

test("no purchase surface exists in any state", async ({ page }) => {
  // §0.3, §2.7, AC-P2-31: purchase is closed in P2, so there is no link, button or
  // heading for it — and no price, currency or wei amount either.
  const paths = ["/resources", ...FIXTURES.map((fixture) => `/resources?address=${fixture.address}`)];

  for (const path of paths) {
    await page.goto(path);
    await expect(page.locator('[data-testid="resources-state"]:visible')).toBeVisible();

    await expect(page.getByRole("link", { name: PURCHASE_AFFORDANCE })).toHaveCount(0);
    await expect(page.getByRole("button", { name: PURCHASE_AFFORDANCE })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: PURCHASE_AFFORDANCE })).toHaveCount(0);

    const text = await page.locator("main").innerText();
    // A disclaimer may name the closed door; no sentence may offer it.
    const offers = text
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => PURCHASE_VOCABULARY.test(sentence))
      .filter((sentence) => !NEGATION.test(sentence));
    expect(offers, `${path} renders purchase vocabulary as an offer`).toEqual([]);

    expect(text, `${path} renders a dollar amount`).not.toMatch(/\$\s?\d/);
    expect(text, `${path} renders a currency amount`).not.toMatch(/\b\d[\d.,]*\s?(usdc|usdt|usd)\b/i);
    expect(text, `${path} renders a wei amount`).not.toMatch(/\bwei\b/i);
  }
});

test("the sidebar entry reaches /resources and marks itself current", async ({ page }) => {
  await page.goto("/deployments");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const link = nav.getByRole("link", { name: "Resources" });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/resources$/);
  await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();
  // §3.4/S4: the entry is not lost or duplicated after navigation.
  await expect(link).toHaveAttribute("aria-current", "page");
});

test("an invalid address shows the validation message and never reaches a result", async ({
  page,
}) => {
  await page.goto("/resources");
  const root = page.locator('[data-testid="resources-state"]:visible');
  await expect(root).toHaveAttribute("data-state", "idle");

  const form = page.locator("form").filter({ has: page.locator("#resources-address") });
  await form.getByLabel("Address").fill("not-an-address");
  await form.getByRole("button", { name: "Check circuits" }).click();

  // The form is a native GET form, so the browser does re-issue the same route with
  // the bad input in the query string; what matters is that the page stays on
  // /resources, refuses the value, and renders no result and no table.
  await expect(page).toHaveURL(/\/resources\?address=not-an-address$/);
  await expect(
    page.getByText("Enter a 20-byte hex address: 0x followed by 40 hex characters.").first(),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/resources");
  await expect(root).toHaveAttribute("data-state", "idle");
  await expect(page.locator("table")).toHaveCount(0);
});

test("the address form is Tab-reachable and submits with Enter", async ({ page }) => {
  await page.goto("/resources");
  const input = page.locator("#resources-address");
  await expect(input).toBeVisible();

  let inputReached = false;
  for (let step = 0; step < 40 && !inputReached; step += 1) {
    await page.keyboard.press("Tab");
    inputReached = await page.evaluate(
      () => document.activeElement?.id === "resources-address",
    );
  }
  expect(inputReached, "the address input must be reachable with Tab").toBe(true);

  // The submit control is the next stop in that form, in DOM order.
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const field = document.querySelector("#resources-address");
      return (
        document.activeElement ===
        field?.closest("form")?.querySelector('button[type="submit"]')
      );
    }),
    "the submit control must be reachable with Tab right after the input",
  ).toBe(true);

  // Implicit submission: Enter in the input runs the form.
  await input.fill(MOCK_RESOURCES_PARTIAL_ADDRESS);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(MOCK_RESOURCES_PARTIAL_ADDRESS));
  await expect(page.locator('[data-testid="resources-state"]:visible')).toHaveAttribute("data-state", "partial");
});

test("Chinese renders each state's own copy with no placeholder token leak", async ({ page }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "tapeci_locale", value: "zh", url: origin }]);

  // AC-P2-30 / F11: every one of the four contract states has its own Chinese copy,
  // and no English fallback carries the state sentence.
  const zhStates = [
    { name: "idle", path: "/resources", state: "idle", copy: "查询地址" },
    {
      name: "ready",
      path: `/resources?address=${MOCK_RESOURCES_READY_ADDRESS}`,
      state: "ready",
      copy: "工厂目录已完整扫描",
    },
    {
      name: "partial",
      path: `/resources?address=${MOCK_RESOURCES_PARTIAL_ADDRESS}`,
      state: "partial",
      copy: "扫描未完成",
    },
    {
      name: "unavailable",
      path: `/resources?address=${MOCK_RESOURCES_UNAVAILABLE_ADDRESS}`,
      state: "unavailable",
      copy: "无法读取 X Layer 196 上的电路",
    },
    {
      name: "empty",
      path: `/resources?address=${MOCK_RESOURCES_EMPTY_ADDRESS}`,
      state: "ready",
      copy: "未找到该地址的电路",
    },
  ] as const;

  for (const zh of zhStates) {
    await page.goto(zh.path);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("heading", { level: 1, name: "资源" })).toBeVisible();
    const root = page.locator('[data-testid="resources-state"]:visible');
    await expect(root).toHaveAttribute("data-state", zh.state);
    await expect(root).toContainText(zh.copy);

    const text = await page.locator("main").innerText();
    expect(text, `${zh.name} leaks a {placeholder} token`).not.toMatch(/\{[a-zA-Z][^}]*\}/);
    expect(text, `${zh.name} falls back to English`).not.toMatch(
      /No circuits|Scan incomplete|Could not read circuits/,
    );
  }
});
