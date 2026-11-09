/**
 * P2-02: GitHub App authentication.
 *
 * - `signAppJwt` builds the short-lived RS256 App JWT GitHub expects
 *   (`iss=appId`, `iat=now-60s`, `exp=now+9min`).
 * - `getInstallationToken` exchanges it for an installation access token with an
 *   injectable `fetch` so tests never touch the network.
 *
 * Secret handling: App private keys and installation tokens are never logged or
 * embedded in error messages/details. Errors carry only an HTTP status.
 */
import { SignJWT, importPKCS8, type KeyInput } from "jose";
import { GithubError } from "./errors.js";

/** GitHub REST API base URL. Tests always inject a fake fetch. */
export const GITHUB_API_BASE_URL = "https://api.github.com";
/** `iat` is backdated by 60s to absorb clock drift (GitHub recommendation). */
export const APP_JWT_ISSUED_AT_SKEW_SECONDS = 60;
/** App JWTs may live at most 10 minutes; stay at 9 minutes from `now`. */
export const APP_JWT_LIFETIME_SECONDS = 9 * 60;
/** Pinned REST API version so response shapes are stable. */
export const GITHUB_API_VERSION = "2022-11-28";

export type GitHubFetch = typeof globalThis.fetch;

export interface GitHubAppConfig {
  /** GitHub App id (`GITHUB_APP_ID`). */
  readonly appId: number | string;
  /**
   * PKCS#8 RSA private key (`GITHUB_APP_PRIVATE_KEY`), either as a PEM string
   * (literal or `\\n`-escaped) or as an already-imported WebCrypto key.
   */
  readonly privateKey: string | KeyInput;
  /** Override for tests; must never point at a real GitHub instance in tests. */
  readonly apiBaseUrl?: string;
  /** Injectable fetch (tests pass a fake; production uses global fetch). */
  readonly fetch?: GitHubFetch;
  /** Injectable clock. */
  readonly now?: () => Date;
}

export interface GetInstallationTokenOptions extends GitHubAppConfig {
  readonly installationId: number | string;
}

export interface GitHubInstallationToken {
  /** Installation access token (`ghs_…`). Never log this value. */
  readonly token: string;
  readonly expiresAt: Date;
}

function isoSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function parseAppId(appId: number | string): string {
  const raw = typeof appId === "number" ? String(appId) : appId.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "GITHUB_APP_ID must be a positive integer", {
      details: { appIdType: typeof appId },
    });
  }
  return raw;
}

function parseInstallationId(installationId: number | string): number {
  const raw = typeof installationId === "number" ? String(installationId) : installationId.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new GithubError(
      "GITHUB_APP_CONFIG_INVALID",
      "installation id must be a positive integer",
      { details: { installationIdType: typeof installationId } },
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "installation id is outside the safe integer range");
  }
  return parsed;
}

/** Import a PEM PKCS#8 RSA key, tolerating `\\n`-escaped environment values. */
export async function importGitHubAppPrivateKey(pem: string): Promise<KeyInput> {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  if (!normalized.includes("BEGIN") || !normalized.includes("PRIVATE KEY")) {
    throw new GithubError("GITHUB_APP_KEY_INVALID", "GitHub App private key must be a PKCS#8 PEM block");
  }
  try {
    return await importPKCS8(normalized, "RS256");
  } catch (cause) {
    throw new GithubError("GITHUB_APP_KEY_INVALID", "could not import the GitHub App private key", {
      cause,
    });
  }
}

async function resolvePrivateKey(privateKey: string | KeyInput): Promise<KeyInput> {
  if (typeof privateKey === "string") return importGitHubAppPrivateKey(privateKey);
  return privateKey;
}

/**
 * Sign the GitHub App JWT (RS256). The JWT is single-use, short-lived and never
 * returned in error details.
 */
export async function signAppJwt(config: GitHubAppConfig): Promise<string> {
  const issuer = parseAppId(config.appId);
  const privateKey = await resolvePrivateKey(config.privateKey);
  const now = config.now?.() ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "now() must return a valid Date");
  }
  const issuedAt = isoSeconds(now) - APP_JWT_ISSUED_AT_SKEW_SECONDS;
  const expiresAt = isoSeconds(now) + APP_JWT_LIFETIME_SECONDS;
  try {
    return await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(issuer)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(privateKey);
  } catch (cause) {
    throw new GithubError("GITHUB_APP_JWT_FAILED", "could not sign the GitHub App JWT", {
      cause,
    });
  }
}

interface InstallationTokenResponse {
  readonly token?: unknown;
  readonly expires_at?: unknown;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function parseTokenResponse(
  response: Awaited<ReturnType<GitHubFetch>>,
  now: Date,
): Promise<GitHubInstallationToken> {
  if (response.status === 404) {
    throw new GithubError("GITHUB_INSTALLATION_NOT_FOUND", "GitHub installation was not found");
  }
  if (response.status === 401 || response.status === 403) {
    throw new GithubError(
      "GITHUB_API_UNAUTHORIZED",
      "GitHub rejected the App JWT or installation scope",
      { details: { status: response.status } },
    );
  }
  if (!response.ok) {
    throw new GithubError(
      "GITHUB_API_ERROR",
      `GitHub installation token request failed with status ${response.status}`,
      { retryable: retryableStatus(response.status), details: { status: response.status } },
    );
  }
  let body: InstallationTokenResponse;
  try {
    body = (await response.json()) as InstallationTokenResponse;
  } catch (cause) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub installation token response was not valid JSON",
      { cause },
    );
  }
  const token = body.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub installation token response is missing a token",
    );
  }
  const rawExpiry = body.expires_at;
  if (typeof rawExpiry !== "string") {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub installation token response is missing expires_at",
    );
  }
  const expiresAt = new Date(rawExpiry);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new GithubError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub installation token response has an invalid expiry",
    );
  }
  return { token, expiresAt };
}

/**
 * Exchange the App JWT for an installation access token.
 *
 * Injection points: `fetch`, `apiBaseUrl` and `now`. The returned token is
 * never logged and never attached to a thrown error.
 */
export async function getInstallationToken(
  options: GetInstallationTokenOptions,
): Promise<GitHubInstallationToken> {
  const installationId = parseInstallationId(options.installationId);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "no fetch implementation is available");
  }
  const appJwt = await signAppJwt(options);
  const baseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const now = options.now?.() ?? new Date();
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(`${baseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "user-agent": "tapeci-github-app",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: "",
    });
  } catch (cause) {
    throw new GithubError("GITHUB_API_ERROR", "GitHub API request failed", {
      retryable: true,
      cause,
    });
  }
  return parseTokenResponse(response, now);
}

// ---------------------------------------------------------------------------
// Installation token cache + installation/repository reads
// ---------------------------------------------------------------------------

export interface InstallationTokenCacheOptions extends GitHubAppConfig {
  /** Refresh this many seconds before GitHub's expiry (default 60). */
  readonly safetySeconds?: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * In-memory installation-token cache. Tokens are scoped to one installation and
 * refreshed shortly before expiry; the cache is intentionally per-process (a
 * multi-instance API may issue one token per instance, which is harmless).
 */
export class InstallationTokenCache {
  private readonly options: InstallationTokenCacheOptions;
  private readonly cache = new Map<string, CachedToken>();

  constructor(options: InstallationTokenCacheOptions) {
    this.options = options;
  }

  get(installationId: number | string): Promise<GitHubInstallationToken> {
    const key = String(installationId);
    const now = this.options.now?.() ?? new Date();
    const cached = this.cache.get(key);
    const safetyMs = (this.options.safetySeconds ?? 60) * 1000;
    if (cached !== undefined && cached.expiresAt.getTime() - safetyMs > now.getTime()) {
      return Promise.resolve(cached);
    }
    return getInstallationToken({
      ...this.options,
      installationId,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    }).then((fresh) => {
      this.cache.set(key, fresh);
      return fresh;
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export interface GitHubInstallationAccount {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

export interface GitHubInstallationDetails {
  readonly id: number;
  readonly account: GitHubInstallationAccount;
  readonly suspendedAt: Date | null;
}

export interface GetInstallationOptions extends GitHubAppConfig {
  readonly installationId: number | string;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "tapeci-github-app",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

/** Read one installation through the App JWT (`GET /app/installations/{id}`). */
export async function getInstallation(
  options: GetInstallationOptions,
): Promise<GitHubInstallationDetails> {
  const installationId = parseInstallationId(options.installationId);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "no fetch implementation is available");
  }
  const appJwt = await signAppJwt(options);
  const baseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(`${baseUrl}/app/installations/${installationId}`, {
      method: "GET",
      headers: githubHeaders(`Bearer ${appJwt}`),
    });
  } catch (cause) {
    throw new GithubError("GITHUB_API_ERROR", "GitHub API request failed", {
      retryable: true,
      cause,
    });
  }
  if (response.status === 404) {
    throw new GithubError("GITHUB_INSTALLATION_NOT_FOUND", "GitHub installation was not found");
  }
  if (!response.ok) {
    throw new GithubError(
      response.status === 401 ? "GITHUB_API_UNAUTHORIZED" : "GITHUB_API_ERROR",
      `GitHub API returned HTTP ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const account = body["account"];
  if (
    typeof body["id"] !== "number" ||
    typeof account !== "object" ||
    account === null ||
    typeof (account as Record<string, unknown>)["id"] !== "number" ||
    typeof (account as Record<string, unknown>)["login"] !== "string"
  ) {
    throw new GithubError("GITHUB_API_INVALID_RESPONSE", "invalid installation response");
  }
  const accountRecord = account as Record<string, unknown>;
  const suspendedAt =
    typeof body["suspended_at"] === "string" ? new Date(body["suspended_at"]) : null;
  return {
    id: body["id"],
    account: {
      id: accountRecord["id"] as number,
      login: accountRecord["login"] as string,
      type: typeof accountRecord["type"] === "string" ? accountRecord["type"] : "User",
    },
    suspendedAt,
  };
}

export interface GitHubRepositorySummary {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly archived: boolean;
}

export interface ListInstallationRepositoriesOptions {
  readonly token: string;
  readonly fetch?: GitHubFetch;
  readonly apiBaseUrl?: string;
  readonly perPage?: number;
}

/** List repositories granted to one installation token (`/installation/repositories`). */
export async function listInstallationRepositories(
  options: ListInstallationRepositoriesOptions,
): Promise<readonly GitHubRepositorySummary[]> {
  if (typeof options.token !== "string" || options.token.length === 0) {
    throw new GithubError("GITHUB_API_UNAUTHORIZED", "installation token is required");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "no fetch implementation is available");
  }
  const baseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const perPage = Math.min(Math.max(options.perPage ?? 100, 1), 100);
  const repositories: GitHubRepositorySummary[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(
      `${baseUrl}/installation/repositories?per_page=${perPage}&page=${page}`,
      { method: "GET", headers: githubHeaders(`Bearer ${options.token}`) },
    );
    if (!response.ok) {
      throw new GithubError(
        response.status === 401 ? "GITHUB_API_UNAUTHORIZED" : "GITHUB_API_ERROR",
        `GitHub API returned HTTP ${response.status}`,
        { retryable: response.status >= 500 },
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const list = body["repositories"];
    if (!Array.isArray(list)) {
      throw new GithubError("GITHUB_API_INVALID_RESPONSE", "invalid repositories response");
    }
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      if (
        typeof row["id"] !== "number" ||
        typeof row["name"] !== "string" ||
        typeof row["full_name"] !== "string" ||
        typeof row["default_branch"] !== "string"
      ) {
        continue;
      }
      repositories.push({
        id: row["id"],
        name: row["name"],
        fullName: row["full_name"],
        private: row["private"] === true,
        defaultBranch: row["default_branch"],
        archived: row["archived"] === true,
      });
    }
    if (list.length < perPage) break;
  }
  return repositories;
}

export interface ListAppInstallationsOptions extends GitHubAppConfig {
  /** Page size, 1..100 (default 100). */
  readonly perPage?: number;
}

/**
 * List every installation of this GitHub App (`GET /app/installations`).
 *
 * Used by the reconciler. Pagination is bounded (10 pages) so a malformed
 * response cannot loop forever; any non-2xx response throws instead of returning
 * a partial list, because a partial list would mark healthy installations as
 * deleted.
 */
export async function listAppInstallations(
  options: ListAppInstallationsOptions,
): Promise<readonly GitHubInstallationDetails[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GithubError("GITHUB_APP_CONFIG_INVALID", "no fetch implementation is available");
  }
  const appJwt = await signAppJwt(options);
  const baseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const perPage = Math.min(Math.max(options.perPage ?? 100, 1), 100);
  const installations: GitHubInstallationDetails[] = [];
  for (let page = 1; page <= 10; page += 1) {
    let response: Awaited<ReturnType<GitHubFetch>>;
    try {
      response = await fetchImpl(`${baseUrl}/app/installations?per_page=${perPage}&page=${page}`, {
        method: "GET",
        headers: githubHeaders(`Bearer ${appJwt}`),
      });
    } catch (cause) {
      throw new GithubError("GITHUB_API_ERROR", "GitHub API request failed", {
        retryable: true,
        cause,
      });
    }
    if (!response.ok) {
      throw new GithubError(
        response.status === 401 ? "GITHUB_API_UNAUTHORIZED" : "GITHUB_API_ERROR",
        `GitHub API returned HTTP ${response.status}`,
        { retryable: response.status >= 500 },
      );
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new GithubError("GITHUB_API_INVALID_RESPONSE", "invalid installations response");
    }
    for (const item of body) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      const account = row["account"];
      if (
        typeof row["id"] !== "number" ||
        typeof account !== "object" ||
        account === null ||
        typeof (account as Record<string, unknown>)["id"] !== "number" ||
        typeof (account as Record<string, unknown>)["login"] !== "string"
      ) {
        continue;
      }
      const accountRecord = account as Record<string, unknown>;
      installations.push({
        id: row["id"],
        account: {
          id: accountRecord["id"] as number,
          login: accountRecord["login"] as string,
          type: typeof accountRecord["type"] === "string" ? accountRecord["type"] : "User",
        },
        suspendedAt:
          typeof row["suspended_at"] === "string" ? new Date(row["suspended_at"]) : null,
      });
    }
    if (body.length < perPage) break;
  }
  return installations;
}
