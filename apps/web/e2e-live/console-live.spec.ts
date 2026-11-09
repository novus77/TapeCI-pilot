import { expect, test, type Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_READY_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const collected: string[] = [];
  browserErrors.set(page, collected);
  page.on("console", (message) => {
    if (message.type() === "error") collected.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => collected.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
});

test("dashboard renders live API data, not mock fixtures", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText("acme/live-site").first()).toBeVisible();
  await expect(page.getByText("Mock fixtures")).toHaveCount(0);
  await expect(page.getByTestId("release-legend").locator("li")).toHaveCount(4);
  await expect(page.locator('[data-stage="LIVE"]').first()).toBeVisible();
});

test("deployment detail shows plan, files, transactions and verification from the API", async ({
  page,
}) => {
  await page.goto(`/deployments/${DEPLOYMENT_ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("acme/live-site");
  await expect(page.locator('[data-stage="LIVE"]').first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Execution plan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release files" })).toBeVisible();
  await expect(page.getByText("releases/r-live/assets/app.js")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chain transactions" })).toBeVisible();
  await expect(page.getByText("putFile").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verification evidence" })).toBeVisible();
  await expect(page.getByTestId("event-timeline")).toBeVisible();
});

test("deployments list, project page and primary navigation use live data", async ({ page }) => {
  await page.goto("/deployments");
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  await expect(page.getByTestId("deployment-row")).toHaveCount(2);
  await page.getByRole("link", { name: "acme/live-site" }).first().click();
  await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("acme/live-site").first()).toBeVisible();
  await expect(page.getByText("Current").first()).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("top bar shows the signed-in user and can sign out", async ({ page }) => {
  await page.goto("/");
  const avatar = page.getByLabel("Signed in as dev-user");
  await expect(avatar).toBeVisible();
  await avatar.click();
  await expect(page.getByText("Signed in as", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("injected wallet signs the EIP-712 approval and the API records it", async ({ page }) => {
  await page.exposeFunction("__tapeciSignTypedData", async (typed: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => {
    const types = Object.fromEntries(
      Object.entries(typed.types).filter(([name]) => name !== "EIP712Domain"),
    );
    const message: Record<string, unknown> = { ...typed.message };
    for (const field of types[typed.primaryType] ?? []) {
      if (field.type === "uint256") message[field.name] = BigInt(String(message[field.name]));
    }
    return OWNER.signTypedData({
      domain: typed.domain,
      types,
      primaryType: typed.primaryType,
      message,
    } as never);
  });
  await page.addInitScript((address: string) => {
    const provider = {
      isMetaMask: true,
      on: () => undefined,
      removeListener: () => undefined,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0xc4";
        if (method === "net_version") return "196";
        if (method === "eth_blockNumber") return "0x1";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_signTypedData_v4") {
          const typed = JSON.parse(String(params?.[1]));
          return (window as unknown as {
            __tapeciSignTypedData: (value: unknown) => Promise<string>;
          }).__tapeciSignTypedData(typed);
        }
        throw new Error(`unsupported method ${method}`);
      },
    };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
  }, OWNER.address);

  await page.goto(`/deployments/${PLAN_READY_DEPLOYMENT_ID}`);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByText(`${OWNER.address.slice(0, 6)}…${OWNER.address.slice(-4)}`).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve with wallet" }).click();
  await expect(page.getByText("APPROVED").first()).toBeVisible({ timeout: 30_000 });
});
