/**
 * Stateless signed sessions and CSRF state tokens.
 *
 * The cookie carries a short JWT (HS256, SESSION_SIGNING_SECRET) with the local
 * user id. OAuth `state` uses the same secret but a separate purpose claim and a
 * double-submit cookie, so a state from one flow cannot be replayed in another.
 */
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiEnv } from "./env.js";

export const SESSION_COOKIE = "tapeci_session";
export const OAUTH_STATE_COOKIE = "tapeci_oauth_state";
export const INSTALL_STATE_COOKIE = "tapeci_install_state";

export interface SessionUser {
  readonly userId: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
}

interface StateClaims {
  readonly purpose: "oauth" | "install";
  readonly nonce: string;
  readonly returnTo: string;
  readonly userId?: string;
}

function key(env: ApiEnv): Uint8Array {
  return new TextEncoder().encode(env.sessionSecret);
}

export async function signSession(env: ApiEnv, user: SessionUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    githubUserId: user.githubUserId,
    githubLogin: user.githubLogin,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + env.sessionTtlSeconds)
    .sign(key(env));
}

export async function verifySession(env: ApiEnv, token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, key(env), { algorithms: ["HS256"] });
    const userId = payload.sub;
    const githubUserId = payload["githubUserId"];
    const githubLogin = payload["githubLogin"];
    if (
      typeof userId !== "string" ||
      typeof githubUserId !== "number" ||
      typeof githubLogin !== "string"
    ) {
      return null;
    }
    return { userId, githubUserId, githubLogin };
  } catch {
    return null;
  }
}

export async function signState(
  env: ApiEnv,
  purpose: StateClaims["purpose"],
  returnTo: string,
  userId?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  return new SignJWT({
    purpose,
    nonce,
    returnTo,
    ...(userId === undefined ? {} : { userId }),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setJti(nonce)
    .sign(key(env));
}

export async function verifyState(
  env: ApiEnv,
  token: string,
  purpose: StateClaims["purpose"],
): Promise<StateClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(env), { algorithms: ["HS256"] });
    if (payload["purpose"] !== purpose || typeof payload["nonce"] !== "string") return null;
    if (typeof payload["returnTo"] !== "string") return null;
    return {
      purpose,
      nonce: payload["nonce"],
      returnTo: payload["returnTo"],
      ...(typeof payload["userId"] === "string" ? { userId: payload["userId"] } : {}),
    };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header === "") return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  return parseCookies(typeof header === "string" ? header : undefined)[name];
}

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: "Lax" | "Strict" | "None";
  readonly path?: string;
  readonly domain?: string;
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure === true) parts.push("Secure");
  return parts.join("; ");
}

export function appendCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const list = Array.isArray(existing)
    ? existing.map(String)
    : existing === undefined
      ? []
      : [String(existing)];
  list.push(cookie);
  reply.header("set-cookie", list);
}

export function cookieOptions(env: ApiEnv, maxAgeSeconds: number): CookieOptions {
  return {
    maxAgeSeconds,
    secure: env.publicApiUrl.startsWith("https://"),
    httpOnly: true,
    sameSite: "Lax",
    ...(env.cookieDomain === undefined || env.cookieDomain === null
      ? {}
      : { domain: env.cookieDomain }),
  };
}

export function clearCookie(reply: FastifyReply, env: ApiEnv, name: string): void {
  appendCookie(reply, serializeCookie(name, "", { ...cookieOptions(env, 0), maxAgeSeconds: 0 }));
}
