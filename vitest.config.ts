import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Mainnet reads and Anvil forks are network-bound; run files serially by default.
    fileParallelism: false,
    reporters: ["default"],
  },
});
