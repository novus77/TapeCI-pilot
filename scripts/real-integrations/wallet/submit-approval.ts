/**
 * Submit one externally produced EIP-712 approval after verification.
 *
 * This command mutates server state. It requires both
 * TAPECI_REAL_WALLET_SUBMIT=1 and --confirm-submit.
 */
import { pathToFileURL } from "node:url";
import {
  assertApprovalSubmissionAllowed,
  maskAddress,
  parseSignature,
  readExternalSignatureCase,
  verifyApprovalTypedData,
} from "./harness.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ApprovalSubmissionInput {
  readonly apiUrl: string;
  readonly allowExternal?: boolean;
  readonly deploymentId: string;
  readonly signerAddress: string;
  readonly signature: string;
  readonly approval: {
    readonly manifestHash: string;
    readonly container: string;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
}

export interface ApprovalSubmissionRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

function absoluteHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("API URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use HTTP or HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("API URL must not contain embedded credentials");
  }
  return url;
}

export function buildApprovalSubmissionRequest(
  input: ApprovalSubmissionInput,
): ApprovalSubmissionRequest {
  const apiUrl = absoluteHttpUrl(input.apiUrl);
  const host = apiUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && input.allowExternal !== true) {
    throw new Error("external approval submission requires an explicit allowExternal gate");
  }
  const url = new URL(
    `/v1/deployments/${encodeURIComponent(input.deploymentId)}/approve`,
    apiUrl,
  );
  return {
    url: url.toString(),
    body: JSON.stringify({
      signerAddress: input.signerAddress,
      signature: input.signature,
      approval: input.approval,
    }),
    headers: { "content-type": "application/json" },
  };
}

function authHeaders(env: Environment): Record<string, string> {
  const session = env.TAPECI_REAL_WALLET_SESSION_COOKIE?.trim();
  if (session !== undefined && session.length > 0) {
    return { cookie: session };
  }
  const login = env.TAPECI_DEV_GITHUB_LOGIN?.trim();
  if (login === undefined || login.length === 0) {
    throw new Error(
      "set TAPECI_REAL_WALLET_SESSION_COOKIE or local-only TAPECI_DEV_GITHUB_LOGIN",
    );
  }
  return {
    "x-tapeci-github-login": login,
    "x-tapeci-github-user-id": env.TAPECI_DEV_GITHUB_USER_ID?.trim() ?? "1",
  };
}

async function main(): Promise<void> {
  assertApprovalSubmissionAllowed(
    process.env,
    process.argv.includes("--confirm-submit"),
  );
  const external = await readExternalSignatureCase(process.env);
  const verification = await verifyApprovalTypedData({
    document: external.document,
    expectedSigner: external.expectedSigner,
    signature: external.signature,
  });
  if (!verification.verified) {
    throw new Error(`signature verification failed: ${verification.reason}`);
  }
  const deploymentId = process.env.TAPECI_REAL_WALLET_DEPLOYMENT_ID?.trim();
  if (deploymentId === undefined || deploymentId.length === 0) {
    throw new Error("TAPECI_REAL_WALLET_DEPLOYMENT_ID is required");
  }
  if (external.document.message.deploymentId !== deploymentId) {
    throw new Error("typed data is bound to a different deployment");
  }
  const request = buildApprovalSubmissionRequest({
    apiUrl: process.env.TAPECI_REAL_WALLET_API_URL?.trim() ?? "http://127.0.0.1:8787",
    allowExternal: process.argv.includes("--allow-external"),
    deploymentId,
    signerAddress: external.expectedSigner,
    signature: parseSignature(external.signature),
    approval: {
      manifestHash: external.document.message.manifestHash,
      container: external.document.message.container,
      costCapWei: external.document.message.costCapWei.toString(),
      nonce: external.document.message.nonce,
      expiresAt: external.document.message.expiresAt.toString(),
    },
  });
  const response = await fetch(request.url, {
    method: "POST",
    headers: { ...request.headers, ...authHeaders(process.env) },
    body: request.body,
    redirect: "error",
  });
  const body = await response.text();
  console.log(
    JSON.stringify(
      {
        walletKind: external.walletKind,
        deploymentId,
        signer: maskAddress(external.expectedSigner),
        verifiedBeforeSubmit: true,
        status: response.status,
        ok: response.ok,
        responseBytes: Buffer.byteLength(body, "utf8"),
      },
      null,
      2,
    ),
  );
  if (!response.ok) {
    let code = "unknown";
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      if (typeof parsed.error?.code === "string") code = parsed.error.code;
    } catch {
      // The response body is intentionally not echoed: it may contain wallet data.
    }
    console.error(`approval submission failed: HTTP ${response.status} ${code}`);
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
