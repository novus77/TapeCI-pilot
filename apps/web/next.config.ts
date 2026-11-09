import type { NextConfig } from "next";

/**
 * `distDir` is intentionally not `.next`: the repository-wide ESLint config
 * (`eslint .`) does not ignore dot-directories, and `apps/web/dist` is covered by
 * the existing `dist/` ignore rule. Production output still lands inside the web app.
 */
const nextConfig: NextConfig = {
  distDir: process.env.TAPECI_NEXT_DIST_DIR ?? "dist",
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;
