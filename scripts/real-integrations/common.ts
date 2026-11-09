export const REAL_INTEGRATIONS_ENV = "TAPECI_REAL_INTEGRATIONS";

export type Environment = Readonly<Record<string, string | undefined>>;

export function realIntegrationEnabled(env: Environment = process.env): boolean {
  return env[REAL_INTEGRATIONS_ENV] === "1";
}

export interface GithubCredentialPresence {
  readonly appId: boolean;
  readonly privateKey: boolean;
  readonly webhookSecret: boolean;
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Return booleans only; credential values must never enter logs or reports. */
export function githubCredentialPresence(env: Environment): GithubCredentialPresence {
  return {
    appId: present(env.GITHUB_APP_ID),
    privateKey: present(env.GITHUB_APP_PRIVATE_KEY),
    webhookSecret: present(env.GITHUB_WEBHOOK_SECRET),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Validate a webhook target before a harness can send a signed request.
 * Loopback delivery is local; any public target needs its own explicit gate.
 */
export function assertWebhookTargetAllowed(
  rawUrl: string,
  options: { readonly allowExternal?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("webhook target must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("webhook target must use HTTP or HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("webhook target must not contain embedded credentials");
  }
  if (!isLoopbackHost(url.hostname) && options.allowExternal !== true) {
    throw new Error(
      "external webhook delivery requires an explicit allowExternal approval gate",
    );
  }
  return url;
}
