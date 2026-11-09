import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      ".pnpm-store/**",
      ".pnpm-cache/**",
      ".npm-cache/**",
      ".corepack/**",
      ".tapeci/**",
      "apps/web/.next/**",
      "apps/web/test-results-live/**",
      ".superpowers/**",
      "superpowers/**",
      "coverage/**",
      "tests/fixtures/**",
      // Research scratch scripts under docs are not part of the lint surface: they are
      // one-off measurements (e.g. a compression study run against a build directory)
      // that take Node globals and are never imported by the application.
      "docs/research/**/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
    },
  },
);
