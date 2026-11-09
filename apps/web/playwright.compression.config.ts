import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "compression-review.spec.ts",
  outputDir: "./test-results/compression",
  use: { ...base.use, baseURL: "http://127.0.0.1:3191" },
  webServer: {
    ...base.webServer,
    command: "node node_modules/next/dist/bin/next build --webpack && exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3191",
    url: "http://127.0.0.1:3191",
    reuseExistingServer: false,
  },
});
