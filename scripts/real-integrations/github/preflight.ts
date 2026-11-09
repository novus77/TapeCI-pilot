import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listAppInstallations } from "@tapeci/github";
import {
  githubCredentialPresence,
  realIntegrationEnabled,
  type Environment,
} from "../common.js";

export const REQUIRED_GITHUB_APP_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

export const OPTIONAL_GITHUB_APP_KEYS = [
  "GITHUB_APP_SLUG",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
] as const;

export function parseGithubAppEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error("invalid dotenv line");
    const key = line.slice(0, index).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid dotenv key: ${key}`);
    if (key in result) throw new Error(`duplicate dotenv key: ${key}`);
    const rawValue = line.slice(index + 1).trim();
    let value = rawValue;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"') || rawValue.length < 2) {
        throw new Error(`quoted dotenv value is unterminated: ${key}`);
      }
      try {
        value = JSON.parse(rawValue) as string;
      } catch {
        throw new Error(`quoted dotenv value is invalid: ${key}`);
      }
    }
    result[key] = value;
  }
  return result;
}

export function credentialFileSummary(env: Environment): {
  readonly present: string[];
  readonly missing: string[];
} {
  const presence = githubCredentialPresence(env);
  const required: Record<(typeof REQUIRED_GITHUB_APP_KEYS)[number], boolean> = {
    GITHUB_APP_ID: presence.appId,
    GITHUB_APP_PRIVATE_KEY: presence.privateKey,
    GITHUB_WEBHOOK_SECRET: presence.webhookSecret,
  };
  const all = [...REQUIRED_GITHUB_APP_KEYS, ...OPTIONAL_GITHUB_APP_KEYS];
  return {
    present: all.filter((key) => {
      if (key in required) return required[key as keyof typeof required];
      const value = env[key];
      return value !== undefined && value.trim().length > 0;
    }),
    missing: all.filter((key) => {
      if (key in required) return !required[key as keyof typeof required];
      const value = env[key];
      return value === undefined || value.trim().length === 0;
    }),
  };
}

export interface PreflightReportInput {
  readonly file: string;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly apiBaseUrl: string;
  readonly networkCheck: "passed" | "failed" | "skipped";
  readonly appId?: string;
  readonly installations?: number;
  readonly errorCode?: string;
}

export function formatPreflightReport(input: PreflightReportInput): string {
  const lines = [
    `file=${input.file}`,
    `credentials=${input.present.length}/${input.present.length + input.missing.length}`,
    `present=${input.present.join(",") || "(none)"}`,
    `missing=${input.missing.join(",") || "(none)"}`,
    `api=${input.apiBaseUrl}`,
    `network=${input.networkCheck}`,
  ];
  if (input.appId !== undefined) lines.push(`app_id=${input.appId}`);
  if (input.installations !== undefined) lines.push(`installations=${input.installations}`);
  if (input.errorCode !== undefined) lines.push(`error=${input.errorCode}`);
  return lines.join("\n");
}

export interface GithubPreflightOptions {
  readonly env?: Environment;
  readonly credentialFile?: string;
  readonly checkNetwork?: boolean;
  readonly listInstallations?: typeof listAppInstallations;
}

export async function runGithubPreflight(
  options: GithubPreflightOptions = {},
): Promise<{ readonly report: string; readonly ok: boolean }> {
  const env = options.env ?? process.env;
  const credentialFile =
    options.credentialFile ?? join(process.cwd(), ".tapeci", "github-app.env");
  let merged: Environment = env;
  try {
    merged = { ...parseGithubAppEnv(await readFile(credentialFile, "utf8")), ...env };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        report: formatPreflightReport({
          file: credentialFile,
          present: [],
          missing: [...REQUIRED_GITHUB_APP_KEYS, ...OPTIONAL_GITHUB_APP_KEYS],
          apiBaseUrl: env.GITHUB_API_BASE_URL ?? "https://api.github.com",
          networkCheck: "skipped",
          errorCode: "INVALID_CREDENTIAL_FILE",
        }),
      };
    }
  }
  const summary = credentialFileSummary(merged);
  const requiredMissing = REQUIRED_GITHUB_APP_KEYS.filter((key) => summary.missing.includes(key));
  if (requiredMissing.length > 0) {
    return {
      ok: false,
      report: formatPreflightReport({
        file: credentialFile,
        ...summary,
        apiBaseUrl: merged.GITHUB_API_BASE_URL ?? "https://api.github.com",
        networkCheck: "skipped",
        errorCode: "REQUIRED_CREDENTIALS_MISSING",
      }),
    };
  }
  if (options.checkNetwork !== true) {
    return {
      ok: true,
      report: formatPreflightReport({
        file: credentialFile,
        ...summary,
        apiBaseUrl: merged.GITHUB_API_BASE_URL ?? "https://api.github.com",
        networkCheck: "skipped",
      }),
    };
  }
  if (!realIntegrationEnabled(env)) {
    return {
      ok: false,
      report: formatPreflightReport({
        file: credentialFile,
        ...summary,
        apiBaseUrl: merged.GITHUB_API_BASE_URL ?? "https://api.github.com",
        networkCheck: "skipped",
        errorCode: "REAL_INTEGRATION_OPT_IN_REQUIRED",
      }),
    };
  }
  try {
    const installations = await (options.listInstallations ?? listAppInstallations)({
      appId: merged.GITHUB_APP_ID!,
      privateKey: merged.GITHUB_APP_PRIVATE_KEY!,
      ...(merged.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: merged.GITHUB_API_BASE_URL }),
    });
    return {
      ok: true,
      report: formatPreflightReport({
        file: credentialFile,
        ...summary,
        apiBaseUrl: merged.GITHUB_API_BASE_URL ?? "https://api.github.com",
        networkCheck: "passed",
        ...(merged.GITHUB_APP_ID === undefined ? {} : { appId: merged.GITHUB_APP_ID }),
        installations: installations.length,
      }),
    };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "GITHUB_PREFLIGHT_FAILED";
    return {
      ok: false,
      report: formatPreflightReport({
        file: credentialFile,
        ...summary,
        apiBaseUrl: merged.GITHUB_API_BASE_URL ?? "https://api.github.com",
        networkCheck: "failed",
        ...(merged.GITHUB_APP_ID === undefined ? {} : { appId: merged.GITHUB_APP_ID }),
        errorCode: code,
      }),
    };
  }
}

async function main(): Promise<void> {
  const checkNetwork = process.argv.includes("--network");
  const result = await runGithubPreflight({ checkNetwork });
  console.log(result.report);
  if (!result.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

