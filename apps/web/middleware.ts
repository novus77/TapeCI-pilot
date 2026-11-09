import { NextResponse, type NextRequest } from "next/server";

/**
 * Nonce-based CSP for the console (Next App Router).
 *
 * Next applies the nonce to its own bootstrap/chunk scripts when the CSP travels
 * on the request header; `strict-dynamic` then trusts those scripts only.
 * Inline styles stay allowed because the UI uses React style props and
 * WalletConnect injects styled iframes; scripts never fall back to unsafe-inline.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${dev ? " ws:" : ""}`,
    "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets and the Next image optimizer; pages and API routes get the CSP.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
