/** GitHub OAuth code exchange and user lookup. All network calls are injectable. */
import type { GitHubFetch } from "@tapeci/github";
import type { ApiEnv } from "./env.js";
import { ApiError } from "./errors.js";

export interface GitHubOAuthUser {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl: string | null;
}

function fetchImpl(fetch: GitHubFetch | undefined): GitHubFetch {
  const implementation = fetch ?? globalThis.fetch;
  if (typeof implementation !== "function") {
    throw new ApiError(500, "GITHUB_OAUTH_FAILED", "no fetch implementation is available");
  }
  return implementation;
}

export async function exchangeOAuthCode(input: {
  readonly env: ApiEnv;
  readonly code: string;
  readonly redirectUri: string;
  readonly fetch?: GitHubFetch;
  readonly oauthBaseUrl?: string;
}): Promise<string> {
  const clientId = input.env.githubOAuthClientId;
  const clientSecret = input.env.githubOAuthClientSecret;
  if (clientId === null || clientSecret === null) {
    throw new ApiError(503, "GITHUB_OAUTH_NOT_CONFIGURED", "GitHub OAuth is not configured");
  }
  const baseUrl = (input.oauthBaseUrl ?? input.env.githubOAuthBaseUrl).replace(/\/+$/, "");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  let response: Awaited<ReturnType<GitHubFetch>>;
  try {
    response = await fetchImpl(input.fetch)(`${baseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "tapeci-api",
      },
      body,
    });
  } catch {
    throw new ApiError(502, "GITHUB_OAUTH_FAILED", "GitHub OAuth token exchange failed", {}, true);
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload["access_token"] !== "string") {
    throw new ApiError(502, "GITHUB_OAUTH_FAILED", "GitHub OAuth token exchange was rejected", {
      status: response.status,
    });
  }
  return payload["access_token"];
}

export async function fetchGithubUser(input: {
  readonly env: ApiEnv;
  readonly token: string;
  readonly fetch?: GitHubFetch;
  readonly apiBaseUrl?: string;
}): Promise<GitHubOAuthUser> {
  const baseUrl = (input.apiBaseUrl ?? input.env.githubApiBaseUrl).replace(/\/+$/, "");
  const response = await fetchImpl(input.fetch)(`${baseUrl}/user`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "user-agent": "tapeci-api",
      "x-github-api-version": "2022-11-28",
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload["id"] !== "number" || typeof payload["login"] !== "string") {
    throw new ApiError(502, "GITHUB_OAUTH_FAILED", "GitHub user lookup failed", {
      status: response.status,
    });
  }
  return {
    id: payload["id"],
    login: payload["login"],
    avatarUrl: typeof payload["avatar_url"] === "string" ? payload["avatar_url"] : null,
  };
}
