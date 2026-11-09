import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const apiPort = Number(process.env.TAPECI_WALLET_E2E_API_PORT ?? "8792");
const webPort = Number(process.env.TAPECI_WALLET_E2E_WEB_PORT ?? "3105");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "tapeci-local-walletconnect-ui";

export default defineConfig({
  testDir: ".",
  testMatch: "wallet-connect.spec.ts",
  outputDir: "/private/tmp/tapeci-wallet-browser-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome-wallet",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: [
    {
      command: "node_modules/.bin/tsx scripts/p2/live-console-server.ts",
      cwd: repoRoot,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { TAPECI_LIVE_API_PORT: String(apiPort) },
    },
    {
      command: `./node_modules/.bin/next build && ./node_modules/.bin/next start -H 127.0.0.1 -p ${webPort}`,
      cwd: `${repoRoot}/apps/web`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: walletConnectProjectId,
        TAPECI_DEV_GITHUB_LOGIN: "dev-user",
        TAPECI_DEV_GITHUB_USER_ID: "4242",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
