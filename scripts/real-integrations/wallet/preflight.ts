import { pathToFileURL } from "node:url";
import type { WalletIntegrationKind } from "./harness.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface WalletPreflightReport {
  readonly optIn: boolean;
  readonly walletKind: WalletIntegrationKind | "unspecified" | "invalid";
  readonly injected: {
    readonly configured: "browser-required";
    readonly requirement: "MetaMask or another EIP-1193 extension on chain 196";
  };
  readonly walletConnect: {
    readonly configured: boolean;
    readonly projectIdLength: number;
  };
  readonly hardware: {
    readonly directConnector: false;
    readonly supportedRoute: "MetaMask or WalletConnect with a physical device";
    readonly physicalDeviceRequired: true;
  };
  readonly externalSignature: {
    readonly runRequested: boolean;
    readonly typedDataFilePresent: boolean;
    readonly signatureFilePresent: boolean;
    readonly signerPresent: boolean;
  };
  readonly approvalSubmission: {
    readonly optIn: boolean;
    readonly confirmationFlagRequired: true;
  };
}

export interface WalletPreflightResult {
  readonly report: WalletPreflightReport;
  readonly apiCheck: "skipped" | "passed" | "failed";
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function walletKind(value: string | undefined): WalletIntegrationKind | "unspecified" | "invalid" {
  if (!present(value)) return "unspecified";
  if (value === "injected" || value === "walletconnect" || value === "hardware") return value;
  return "invalid";
}

export function inspectWalletPreflight(env: Environment): WalletPreflightReport {
  const projectId = env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";
  return {
    optIn: env.TAPECI_REAL_WALLET_RUN === "1",
    walletKind: walletKind(env.TAPECI_REAL_WALLET_KIND),
    injected: {
      configured: "browser-required",
      requirement: "MetaMask or another EIP-1193 extension on chain 196",
    },
    walletConnect: {
      configured: projectId.length > 0,
      projectIdLength: projectId.length,
    },
    hardware: {
      directConnector: false,
      supportedRoute: "MetaMask or WalletConnect with a physical device",
      physicalDeviceRequired: true,
    },
    externalSignature: {
      runRequested: env.TAPECI_REAL_WALLET_RUN === "1",
      typedDataFilePresent: present(env.TAPECI_REAL_WALLET_TYPED_DATA_FILE),
      signatureFilePresent: present(env.TAPECI_REAL_WALLET_SIGNATURE_FILE),
      signerPresent: present(env.TAPECI_REAL_WALLET_SIGNER),
    },
    approvalSubmission: {
      optIn: env.TAPECI_REAL_WALLET_SUBMIT === "1",
      confirmationFlagRequired: true,
    },
  };
}

function loopbackApiUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("TAPECI_REAL_WALLET_API_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TAPECI_REAL_WALLET_API_URL must use HTTP or HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("TAPECI_REAL_WALLET_API_URL must not contain credentials");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("wallet API preflight is limited to a loopback URL");
  }
  return url;
}

export async function runWalletPreflight(options: {
  readonly env: Environment;
  readonly fetchHealth?: (url: string) => Promise<Response>;
}): Promise<WalletPreflightResult> {
  const report = inspectWalletPreflight(options.env);
  if (options.env.TAPECI_REAL_WALLET_RUN !== "1") {
    return { report, apiCheck: "skipped" };
  }
  const baseUrl = loopbackApiUrl(
    options.env.TAPECI_REAL_WALLET_API_URL?.trim() ?? "http://127.0.0.1:8787",
  );
  const healthUrl = new URL("/health", baseUrl).toString();
  try {
    const response = await (options.fetchHealth ?? fetch)(healthUrl);
    return { report, apiCheck: response.ok ? "passed" : "failed" };
  } catch {
    return { report, apiCheck: "failed" };
  }
}

async function main(): Promise<void> {
  const result = await runWalletPreflight({ env: process.env });
  console.log(JSON.stringify({ ...result.report, apiCheck: result.apiCheck }, null, 2));
  if (result.report.walletKind === "invalid") {
    console.error("TAPECI_REAL_WALLET_KIND must be injected, walletconnect or hardware");
    process.exitCode = 1;
  }
  if (result.apiCheck === "failed") {
    console.error("wallet API health check failed");
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
