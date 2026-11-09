import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Manual-signature fallback — `.superpowers/sdd/unblock-approval/plan.md`.
 *
 * Required behavior: when the browser has no injected EIP-1193 wallet, the page
 * must say so (instead of offering a dead "Connect wallet" button) and offer a
 * manual signature panel that renders the exact EIP-712 payload, so the container
 * owner can sign it elsewhere (wallet app / `cast` / `scripts/p2/sign-approval.ts`)
 * and paste the 65-byte signature back.
 *
 * These tests live in the live-mode suite on purpose. `WalletDeploymentActions`
 * is only mounted when the console is NOT in demo mode:
 *   apps/web/components/deployment-actions.tsx:32
 *     `props.demoMode ? <DemoDeploymentActions/> : <WalletDeploymentActions/>`
 * and `apps/web/app/deployments/[id]/page.tsx:286` passes `demoMode={isMockMode()}`.
 * The mock suite (`apps/web/e2e/`, `NEXT_PUBLIC_TAPECI_MOCK=1`) therefore renders
 * the simulated demo panel, and `getApprovalPayload` has no mock branch at all
 * (`apps/web/lib/api.ts:787` always calls the API). The no-wallet fallback can
 * only be exercised against a real API.
 *
 * Selectors are the contract agreed in the plan/tasks:
 *   [data-testid="manual-signature"]          disclosure toggle
 *   [data-testid="manual-signature-payload"]  domain/types/message JSON
 *   [data-testid="manual-signature-input"]    65-byte signature field
 *   [data-testid="manual-signature-submit"]   submit button
 *
 * No transaction is sent: the fixture deployment is PLAN_READY and these tests
 * never submit a signature.
 */

/** PLAN_READY deployment seeded by scripts/p2/live-console-server.ts. */
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const APPROVAL_URL = `/deployments/${DEPLOYMENT_ID}`;
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const MANIFEST_SHA = `0x${"ba".repeat(32)}`;
const STUB_ADDRESS = "0x1111111111111111111111111111111111111111";
const STUB_ADDRESS_SHORT = `${STUB_ADDRESS.slice(0, 6)}…${STUB_ADDRESS.slice(-4)}`;

function approvalPanel(page: Page) {
  return page.getByRole("region", { name: "Approval & execution" });
}

/**
 * The manual panel only renders while approval is still possible
 * (`canApprove` in wallet-actions.tsx), and the seeded API is a single mutable
 * fixture: `console-live.spec.ts` signs the same PLAN_READY deployment and flips
 * it to APPROVED. Playwright runs files in filename order, so this spec is named
 * `approval-fallback.spec.ts` to run first. Assert the precondition so a reorder
 * fails loudly here instead of looking like a missing UI.
 */
async function requireApprovableFixture(page: Page): Promise<void> {
  await page.goto(APPROVAL_URL);
  await expect(page.locator("main")).toBeVisible();
  await expect(approvalPanel(page)).toBeVisible();
  const stateChip = approvalPanel(page).locator("span.panel-meta");
  await expect(stateChip).toContainText(/PLAN_READY|AWAITING_APPROVAL/, {
    timeout: 15_000,
  });
}

/** Open the disclosure whether it is a `<details>` or a plain toggle button. */
async function openManualSignature(page: Page): Promise<void> {
  const disclosure = page.getByTestId("manual-signature");
  await expect(disclosure).toBeVisible();
  const summary = disclosure.locator("summary");
  if ((await summary.count()) > 0) {
    await summary.click();
  } else {
    await disclosure.click();
  }
}

test.describe("approval is never a dead end", () => {
  test("no injected wallet: page says so and the manual panel shows the payload JSON", async ({
    page,
  }) => {
    await requireApprovableFixture(page);

    // Guard the premise: this browser context really has no EIP-1193 provider.
    expect(await page.evaluate(() => (window as { ethereum?: unknown }).ethereum)).toBeUndefined();

    // 1. The page explains why it cannot sign instead of offering a dead button.
    await expect(page.getByText(/no (browser )?wallet (was )?detected/i).first()).toBeVisible();

    // 2. The connect control is disabled with an actionable message.
    const connect = page.getByRole("button", { name: /connect wallet/i });
    await expect(connect).toBeVisible();
    await expect(connect).toBeDisabled();

    // 3. The manual fallback opens.
    await openManualSignature(page);

    // 4. It shows the exact payload that must be signed: domain (chain 196 +
    //    registry), types and message, so it can be signed on another device.
    const payload = page.getByTestId("manual-signature-payload");
    await expect(payload).toBeVisible();
    await expect(payload).toContainText(/"chainId"\s*:\s*196/);
    await expect(payload).toContainText(new RegExp(REGISTRY, "i"));
    await expect(payload).toContainText(new RegExp(`"deploymentId"\\s*:\\s*"${DEPLOYMENT_ID}"`));
    await expect(payload).toContainText(new RegExp(`"manifestHash"\\s*:\\s*"${MANIFEST_SHA}"`, "i"));
    await expect(payload).toContainText(/"costCapWei"\s*:\s*"\d+"/);
    await expect(payload).toContainText(/"nonce"\s*:\s*"[^"]+"/);
    await expect(payload).toContainText(/"expiresAt"\s*:\s*"\d+"/);

    // 5. A 65-byte signature can be pasted back and submitted without a wallet.
    await expect(page.getByTestId("manual-signature-input")).toBeVisible();
    await expect(page.getByTestId("manual-signature-submit")).toBeVisible();
  });

  /**
   * The panel is the new surface, so scan it directly. The full live page still
   * has two PRE-EXISTING serious violations that the mock axe gate never sees
   * (milestone muted-copy contrast on pending stages, and the notification
   * button's `aria-label` not containing its visible count). Scanning the whole
   * live page would fail on those regardless of this feature, so this test
   * scopes to `.manual-signature` and would still catch a regression inside the
   * new panel. See report-e2e.md for the full-page numbers.
   */
  test("manual signature panel is axe-clean when opened", async ({ page }) => {
    await requireApprovableFixture(page);
    await openManualSignature(page);
    await expect(page.getByTestId("manual-signature-payload")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include(".manual-signature")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blockers = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      blockers,
      blockers
        .map(
          (violation) =>
            `${violation.id} (${violation.impact}): ${violation.nodes
              .map((node) => node.target.join(" "))
              .join(", ")}`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  test("injected wallet stub: the wallet path stays available", async ({ page }) => {
    await page.addInitScript((address: string) => {
      const provider = {
        isMetaMask: true,
        on: () => undefined,
        removeListener: () => undefined,
        request: async ({ method }: { method: string }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
          if (method === "eth_chainId") return "0xc4";
          if (method === "net_version") return "196";
          if (method === "eth_blockNumber") return "0x1";
          if (method === "wallet_switchEthereumChain") return null;
          throw new Error(`unsupported method ${method}`);
        },
      };
      (window as unknown as { ethereum: unknown }).ethereum = provider;
    }, STUB_ADDRESS);

    await requireApprovableFixture(page);

    // A detected wallet must not produce the no-wallet warning.
    await expect(page.getByText(/no (browser )?wallet (was )?detected/i)).toHaveCount(0);

    const connect = page.getByRole("button", { name: /connect wallet/i });
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(approvalPanel(page)).toContainText(STUB_ADDRESS_SHORT);
  });
});
