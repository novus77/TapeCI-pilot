import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Run against the explicitly started mock console; never rebuild a shared server. */
export default defineConfig({
  ...base,
  webServer: undefined,
  outputDir: "./test-results/precision",
});
