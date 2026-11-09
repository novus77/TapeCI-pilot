# Browser wallet approval (EIP-712)

The deployment console can sign approvals with an injected EIP-1193 wallet (e.g. MetaMask) or
WalletConnect instead of the CLI. The browser never receives a private key or an operator key.

## Flow

1. The owner opens a deployment in `PLAN_READY` / `AWAITING_APPROVAL`.
2. **Connect wallet** (injected connector) and switch to **X Layer 196** if needed.
3. The console calls `GET /v1/deployments/:id/approval-payload`, which returns the EIP-712
   domain/types/message and a short-lived nonce:
   - domain `{name:"TapeCI", version:"1", chainId:196, verifyingContract:<SiteRegistry>}`
   - message `{deploymentId, manifestHash, container, costCapWei, nonce, expiresAt}`
   - `expectedSigner` = last observed container owner
   - suggested `costCapWei` = the plan's `recommendedCapWei` (20% margin), or the existing
     approved cap
   - `expiresAt` = now + 15 minutes; the nonce is a fresh UUID
4. The wallet signs `Approval` with `eth_signTypedData_v4`.
5. `POST /v1/deployments/:id/approve` verifies:
   - signature against the owner + domain,
   - `signerAddress` equals the container's last observed owner (403 `NOT_CURRENT_OWNER`
     otherwise),
   - manifest/container binding, cost cap, nonce uniqueness and expiry.
6. On success the deployment moves to `APPROVED` and a temporary operator session is created
   (1 hour). **Execute** then enqueues the deploy worker; **Roll back** (for a Live deployment)
   creates a rollback deployment that needs its own approval.

The page refreshes after each successful action; wallet/network state stays client-side.

## Security properties

- The private key stays in the wallet extension; TapeCI only receives a signature.
- The API re-checks the owner from its last observed container state; a stolen/old signature
  cannot approve after ownership changes.
- Cost cap is bound into the signature, so the UI cannot raise it after signing.
- Nonce + expiry make approvals one-shot and short-lived; the DB has unique constraints on the
  approval digest and nonce.
- The chain guard requires chainId 196 before signing; the UI also shows the current chain.
- Dev/mock mode keeps the old simulated panel; it never enables wallet signing against fixtures.

## WalletConnect

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to enable the optional WalletConnect connector
(`@walletconnect/ethereum-provider` + QR modal). When more than one connector is available the
wallet panel shows a connector selector (Injected / WalletConnect) before **Connect wallet**.
Without the env var, only the injected connector is configured. The project id is public build-time config (not a secret); the relay connection is
made by the wallet, and the same EIP-712 payload is signed. This path is not covered by the
local E2E (no relay/project id in CI).

## Local use

```bash
corepack pnpm db:up && corepack pnpm db:migrate
corepack pnpm api:dev
corepack pnpm web:dev   # without NEXT_PUBLIC_TAPECI_MOCK
```

Connect the wallet that actually owns the container (the owner address shown on the deployment
page). A non-owner wallet will be rejected by the API even if the signature is valid.

## Tests / limits

- `tests/p2/api/flows.test.ts` fetches the payload, signs with the owner, asserts a non-owner is
  rejected with `NOT_CURRENT_OWNER`, then approves and executes.
- `tests/p2/queue/contract-approval.test.ts` covers the EIP-1271 fallback (only accepts when the
  contract verifier returns true).
- Live E2E injects an EIP-1193 provider backed by a test key, connects, signs the real payload
  and asserts the deployment reaches `APPROVED`; the mock E2E keeps the demo panel.
- Injected wallets are always available; WalletConnect requires a project id. Hardware-specific
  connectors are not configured.
- Contract owners are supported through EIP-1271, but the console does not orchestrate the
  off-chain multisig signing ceremony; the owner contract must already hold an `isValidSignature`
  signature when the API receives it.
- EIP-1271 verification uses the configured X Layer operator endpoint; a contract owner must be
  deployed on chain 196.
- Operator sessions are independent of the browser session; a wallet disconnect does not revoke
  an already-created operator session (revoke via API/owner action is future work).
