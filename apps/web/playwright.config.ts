import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * E2E runs against the real Next dev server with deterministic fixtures.
 * `channel: "chrome"` uses the locally installed Google Chrome; no browser is
 * downloaded by this repository.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: `node node_modules/next/dist/bin/next build && exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NEXT_PUBLIC_TAPECI_MOCK: "1",
      TAPECI_MOCK: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
