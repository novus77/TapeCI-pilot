import { NextResponse } from "next/server";

import { apiBaseUrl, isMockMode } from "@/lib/api";

function clearSessionCookie(): string {
  return "tapeci_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
}

/**
 * Sign out proxy: call the API so it can clear its session cookie, forward the
 * Set-Cookie header to the browser, then redirect to the sign-in page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const redirect = NextResponse.redirect(new URL("/login", request.url), 303);
  if (isMockMode()) {
    redirect.headers.append("set-cookie", clearSessionCookie());
    return redirect;
  }
  const incomingCookie = request.headers.get("cookie") ?? "";
  const headers = new Headers({ cookie: incomingCookie });
  const devLogin = process.env.TAPECI_DEV_GITHUB_LOGIN;
  if (devLogin !== undefined && devLogin.length > 0) {
    headers.set("x-tapeci-github-login", devLogin);
  }
  const devUserId = process.env.TAPECI_DEV_GITHUB_USER_ID;
  if (devUserId !== undefined && devUserId.length > 0) {
    headers.set("x-tapeci-github-user-id", devUserId);
  }
  try {
    const response = await fetch(new URL("/v1/auth/logout", apiBaseUrl()), {
      method: "POST",
      headers,
      cache: "no-store",
    });
    const setCookie = response.headers.get("set-cookie");
    redirect.headers.append("set-cookie", setCookie ?? clearSessionCookie());
  } catch {
    redirect.headers.append("set-cookie", clearSessionCookie());
  }
  return redirect;
}
