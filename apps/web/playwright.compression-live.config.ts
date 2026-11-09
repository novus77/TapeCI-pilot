import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./e2e-live",
  testMatch: "compression-selection.spec.ts",
  outputDir: "./test-results/compression-live",
  use: { ...base.use, baseURL: "http://127.0.0.1:3192" },
  webServer: [
    {
      command: "node --import tsx scripts/compression/review-server.ts",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      url: "http://127.0.0.1:8793/health", reuseExistingServer: false,
      timeout: 60_000, stdout: "pipe", stderr: "pipe",
    },
    {
      command: "node node_modules/next/dist/bin/next build --webpack && exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3192",
      url: "http://127.0.0.1:3192", reuseExistingServer: false,
      timeout: 180_000, stdout: "pipe", stderr: "pipe",
      env: { TAPECI_NEXT_DIST_DIR: "dist/compression-live", TAPECI_MOCK: "0", NEXT_PUBLIC_TAPECI_MOCK: "0", NEXT_PUBLIC_API_URL: "http://127.0.0.1:8793", TAPECI_DEV_GITHUB_LOGIN: "compression-review", TAPECI_DEV_GITHUB_USER_ID: "82031", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
