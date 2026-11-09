/**
 * Read-only browser prerequisite check for a real wallet session.
 *
 * This does not connect a wallet or sign anything. It opens a local TapeCI
 * deployment URL and reports what the browser exposes to the page.
 */
import { pathToFileURL } from "node:url";

export interface BrowserChecklistInput {
  readonly injectedProvider: boolean;
  readonly connectorLabels: readonly string[];
  readonly chainId: number | null;
  readonly expectedChainId: 196;
}

export interface BrowserChecklistReport {
  readonly injectedProvider: boolean;
  readonly walletConnectVisible: boolean;
  readonly chainId: number | null;
  readonly chainCorrect: boolean;
  readonly manualSigningRequired: boolean;
}

export function buildBrowserChecklistReport(
  input: BrowserChecklistInput,
): BrowserChecklistReport {
  const walletConnectVisible = input.connectorLabels.some((label) =>
    /walletconnect/i.test(label),
  );
  return {
    injectedProvider: input.injectedProvider,
    walletConnectVisible,
    chainId: input.chainId,
    chainCorrect: input.chainId === input.expectedChainId,
    manualSigningRequired: !input.injectedProvider && !walletConnectVisible,
  };
}

function loopbackUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("TAPECI_REAL_WALLET_WEB_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TAPECI_REAL_WALLET_WEB_URL must use HTTP or HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("TAPECI_REAL_WALLET_WEB_URL must not contain credentials");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("browser checklist is limited to a loopback web URL");
  }
  return url;
}

async function main(): Promise<void> {
  if (process.env.TAPECI_REAL_WALLET_RUN !== "1") {
    throw new Error("set TAPECI_REAL_WALLET_RUN=1 to run a real wallet checklist");
  }
  const url = loopbackUrl(
    process.env.TAPECI_REAL_WALLET_WEB_URL?.trim() ?? "http://127.0.0.1:3000",
  );
  console.log(
    JSON.stringify(
      {
        url: `${url.origin}${url.pathname}`,
        instructions: [
          "Open this URL in the target browser profile.",
          "Inspect the connector selector and wallet prompt manually.",
          "Do not enter a private key or mnemonic in TapeCI.",
          "Use the verify-signature command only after the wallet returns a signature.",
        ],
      },
      null,
      2,
    ),
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
