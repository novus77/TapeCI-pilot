/**
 * Verify the WalletConnect build-time configuration without a wallet/relay.
 *   pnpm walletconnect:check            # report connector kinds
 *   pnpm walletconnect:check -- --require
 *
 * A real relay/QR/device test still needs a WalletConnect Cloud project id and
 * a physical wallet; this only proves the build would include the connector.
 */
import { normalizeWalletConnectProjectId, walletConnectorKinds } from "../../apps/web/lib/wallet-connectors.js";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const normalized = normalizeWalletConnectProjectId(projectId);
const kinds = walletConnectorKinds(projectId);
const requireWalletConnect = process.argv.includes("--require");
console.log(
  JSON.stringify(
    {
      configured: normalized !== null,
      projectIdLength: normalized?.length ?? 0,
      connectors: kinds,
    },
    null,
    2,
  ),
);
if (requireWalletConnect && normalized === null) {
  console.error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for this check");
  process.exit(1);
}
