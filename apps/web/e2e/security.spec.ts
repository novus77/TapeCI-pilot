import { expect, test } from "@playwright/test";

test("console sends a nonce-based CSP without unsafe-inline scripts", async ({ page }) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
});
