import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const API_PORT = 8788;
const WEB_PORT = 3101;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Live-mode smoke: no mock fixtures. The API process seeds an ephemeral DB with
 * one LIVE project, and the console is built with NEXT_PUBLIC_API_URL pointed at
 * that API. Chrome is the locally installed browser (no download).
 */
export default defineConfig({
  testDir: "./e2e-live",
  outputDir: "./test-results-live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
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
      name: "chrome-live",
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: [
    {
      command: "node_modules/.bin/tsx scripts/p2/live-console-server.ts",
      cwd: repoRoot,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `./node_modules/.bin/next build && ./node_modules/.bin/next start -H 127.0.0.1 -p ${WEB_PORT}`,
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
        TAPECI_DEV_GITHUB_LOGIN: "dev-user",
        TAPECI_DEV_GITHUB_USER_ID: "4242",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
