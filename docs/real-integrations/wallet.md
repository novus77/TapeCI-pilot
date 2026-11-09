# Real Wallet Integration Verification

This harness verifies the wallet boundary of TapeCI without moving private keys
into the application, the browser, or the test process. It separates four
claims that are often conflated:

1. **Injected browser wallet**: an EIP-1193 provider (for example MetaMask) is
   installed in the browser and can connect and sign.
2. **WalletConnect pairing**: the web build contains the WalletConnect
   connector, the relay/QR pairing succeeds, and the paired wallet signs the
   payload.
3. **Hardware wallet**: a physical device confirms the same address, chain and
   EIP-712 payload. TapeCI currently has no direct Ledger or Trezor connector;
   this route requires MetaMask or a WalletConnect-capable wallet as the bridge.
4. **Real signature verification**: an externally produced signature is
   recovered against the exact TapeCI approval document and the expected owner
   address.

Passing a local deterministic test does not establish any of the four external
claims. A configuration check also does not establish relay, browser, device,
or user-confirmation success.

## Current implementation audit

The repository already has:

- An injected connector through wagmi (`apps/web/lib/wagmi.ts`).
- A conditional WalletConnect connector when
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is present.
- A browser wallet flow that requests chain 196, calls
  `eth_signTypedData_v4`, and submits the resulting signature to the existing
  approval API.
- A manual-signature panel that displays the exact EIP-712 document and accepts
  a 65-byte signature.
- Server-side EIP-712 verification of the domain, message, owner, policy cap,
  budget, nonce, expiry and digest, with an EIP-1271 fallback for contract
  owners (`packages/queue/src/approval.ts` and
  `apps/api/src/routes/deployments.ts`).

The existing Playwright test named “injected wallet signs the EIP-712 approval”
uses a synthetic EIP-1193 provider backed by an in-process test key. It proves
UI wiring and the API path, but it is not evidence that a real extension or
physical device works.

The WalletConnect configuration check only proves connector selection at build
time. It does not prove a relay connection, QR pairing, mobile-wallet
compatibility, or signing.

## Safety model

- No command in this document asks for, reads, prints, or stores a mnemonic or
  private key.
- The real-signature harness accepts a signature file outside the repository.
  The file must be owned by the current user and have mode `0600`.
- The harness rejects unknown fields in the typed data, any domain other than
  `TapeCI` version `1` on chain 196, malformed addresses/hashes, and non-canonical
  unsigned integers.
- The harness prints only booleans, a masked signer address, and a reason code.
- Approval submission is a separate mutation gate. It requires both
  `TAPECI_REAL_WALLET_SUBMIT=1` and the explicit
  `--confirm-submit` command-line flag.
- The submission command never calls the execute route and never sends a chain
  transaction. A later Execute action is a separate operation and needs its own
  authorization.
- The real tests are skipped by default. CI can run the deterministic parser,
  verifier, and safety tests without a browser, relay, device, or wallet.

## Local safe checks

Run the deterministic tests first:

```bash
corepack pnpm exec vitest run tests/real-integrations/wallet/real-wallet.test.ts
```

Expected result without the opt-in variable:

```text
16 passed | 1 skipped
```

Inspect the environment and connector requirements without printing a project
id or wallet address:

```bash
corepack pnpm exec tsx scripts/real-integrations/wallet/preflight.ts
```

The report uses `browser-required` for injected wallets and
`physicalDeviceRequired: true` for hardware wallets. WalletConnect reports only
whether a project id is present and its length. The API health check is skipped
unless `TAPECI_REAL_WALLET_RUN=1`; when enabled, it accepts only a loopback API
URL.

For the human browser step, the read-only checklist helper only validates that
the target is a loopback URL and prints the exact URL to open:

```bash
TAPECI_REAL_WALLET_RUN=1 \
TAPECI_REAL_WALLET_WEB_URL=http://127.0.0.1:3000/deployments/<deployment-id> \
corepack pnpm exec tsx scripts/real-integrations/wallet/browser-checklist.ts
```

It does not automate wallet connection, QR pairing, or signing.

## Injected browser wallet checklist

Use a non-demo, live API build. The mock UI does not exercise the real approval
payload endpoint.

1. Start PostgreSQL, the API, and the web application using the project's
   normal local setup. Set `TAPECI_DEV_AUTH=1` only for a loopback/local test;
   use the GitHub OAuth session for a shared environment.
2. Install and unlock MetaMask or another EIP-1193 wallet in a browser profile
   that is not used for production funds.
3. Add X Layer mainnet, chain id `196`, and switch to it.
4. Open a deployment in `PLAN_READY` or `AWAITING_APPROVAL`.
5. Click **Connect wallet**. Confirm the displayed address is the container
   owner shown by the API.
6. Click **Approve with wallet**. Read the EIP-712 prompt and confirm:
   - domain name `TapeCI`, version `1`, chain id `196`;
   - `verifyingContract` is the deployment's SiteRegistry;
   - `deploymentId`, `manifestHash`, `container`, `costCapWei`, `nonce`, and
     `expiresAt` match the console.
7. Approve the signature in the wallet. Confirm the console reports approval
   recorded and the deployment state changes to `APPROVED`.
8. Do not click **Execute** as part of this wallet test. Execute is a separate
   server mutation and may lead to chain writes after the worker is running.

This proves the real extension can connect, switch to chain 196, request an
EIP-712 signature, and have the API accept that signature. It does not prove
hardware support.

## WalletConnect checklist

Set the public WalletConnect Cloud project id before building the web app:

```bash
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<public-project-id> \
  corepack pnpm web:build
```

The project id is public build-time configuration, not a secret. Changing it at
runtime does not add the connector.

1. Start the web build with the same public project id.
2. Open the same live deployment page.
3. Select **WalletConnect** in the connector selector.
4. Scan the QR code with a mobile wallet that supports EIP-712 and X Layer
   chain 196.
5. Approve the connection and inspect the network and address in the wallet.
6. Follow steps 6–8 of the injected-wallet checklist and confirm the exact
   payload on the phone.

Record only these facts in an evidence file: browser name, connector name,
masked signer, chain id, signature verification boolean, API HTTP status, and
deployment state. Never record the QR URI, session topic, signature, private
key, or mnemonic.

## Hardware wallet checklist

TapeCI has no direct hardware connector. The supported integration route is:

```text
Ledger/Trezor or another hardware device
  -> MetaMask or a WalletConnect-capable host wallet
  -> injected or WalletConnect connector in TapeCI
  -> EIP-712 signature
```

1. Connect the hardware device to its host wallet.
2. Confirm the host wallet shows the expected X Layer account and chain 196.
3. Connect the host wallet through the injected or WalletConnect route above.
4. On the device screen, verify the domain, chain, contract, deployment id,
   manifest hash, cap, nonce, and expiry before confirming.
5. Confirm the signature in the host wallet and verify the resulting API state.

A hardware test is not complete merely because the host wallet connects. The
physical device must display the transaction/typed-data prompt and the user must
confirm it.

## Verify an external signature

The manual signature panel and the API payload endpoint provide a JSON document
containing `domain`, `types`, `primaryType`, and `message`. Save that document
to a temporary file outside the repository. Save the signature to a separate
temporary file, then restrict it:

```bash
chmod 600 /tmp/tapeci-wallet-signature.txt
```

Set the expected signer and wallet kind, then run the read-only verifier:

```bash
TAPECI_REAL_WALLET_RUN=1 \
TAPECI_REAL_WALLET_KIND=injected \
TAPECI_REAL_WALLET_TYPED_DATA_FILE=/tmp/tapeci-wallet-typed-data.json \
TAPECI_REAL_WALLET_SIGNATURE_FILE=/tmp/tapeci-wallet-signature.txt \
TAPECI_REAL_WALLET_SIGNER=<container-owner-address> \
TAPECI_REAL_WALLET_REPO_ROOT="$PWD" \
corepack pnpm exec tsx scripts/real-integrations/wallet/verify-signature.ts
```

`TAPECI_REAL_WALLET_KIND` must be one of `injected`, `walletconnect`, or
`hardware`. The output has this shape and contains no signature material:

```json
{
  "walletKind": "injected",
  "chainId": 196,
  "expectedSigner": "0x1111…1111",
  "recoveredSigner": "0x1111…1111",
  "verified": true,
  "reason": "verified"
}
```

The command exits nonzero when recovery succeeds for a different address or
when signature recovery fails.

The opt-in Vitest path performs the same verification:

```bash
TAPECI_REAL_WALLET_RUN=1 \
TAPECI_REAL_WALLET_KIND=injected \
TAPECI_REAL_WALLET_TYPED_DATA_FILE=/tmp/tapeci-wallet-typed-data.json \
TAPECI_REAL_WALLET_SIGNATURE_FILE=/tmp/tapeci-wallet-signature.txt \
TAPECI_REAL_WALLET_SIGNER=<container-owner-address> \
TAPECI_REAL_WALLET_REPO_ROOT="$PWD" \
corepack pnpm exec vitest run tests/real-integrations/wallet/real-wallet.test.ts
```

The signature file check is intentionally strict. If the file is in the
repository or has group/world-readable permissions, the harness stops before
recovering the signature.

## Optional approval submission

This step mutates the API and creates the normal approval/operator-session
records. It does not execute a deployment or send a chain transaction. Obtain
explicit human authorization before running it against a shared or production
API.

The API needs either a real session cookie or the local development auth
headers. Prefer the session cookie. The cookie is supplied as an environment
variable so it is not echoed by the harness:

```bash
TAPECI_REAL_WALLET_RUN=1 \
TAPECI_REAL_WALLET_SUBMIT=1 \
TAPECI_REAL_WALLET_KIND=injected \
TAPECI_REAL_WALLET_TYPED_DATA_FILE=/tmp/tapeci-wallet-typed-data.json \
TAPECI_REAL_WALLET_SIGNATURE_FILE=/tmp/tapeci-wallet-signature.txt \
TAPECI_REAL_WALLET_SIGNER=<container-owner-address> \
TAPECI_REAL_WALLET_DEPLOYMENT_ID=<deployment-id> \
TAPECI_REAL_WALLET_API_URL=http://127.0.0.1:8787 \
TAPECI_REAL_WALLET_SESSION_COOKIE='tapeci_session=<cookie-value>' \
corepack pnpm exec tsx scripts/real-integrations/wallet/submit-approval.ts \
  --confirm-submit
```

For a loopback-only development API using `TAPECI_DEV_AUTH=1`, the equivalent
local headers can be supplied instead:

```bash
TAPECI_DEV_GITHUB_LOGIN=<dev-login> \
TAPECI_DEV_GITHUB_USER_ID=<dev-user-id> \
...
```

The command verifies the signature locally before sending it, checks that the
typed-data deployment id matches `TAPECI_REAL_WALLET_DEPLOYMENT_ID`, rejects
credential-bearing API URLs, and prints only the HTTP status and a bounded
response size. External API URLs require the additional `--allow-external`
flag. It never calls `/execute`.

## Evidence matrix

| Layer | What can be proven locally | What still needs a human/device |
| --- | --- | --- |
| Payload parser | Exact domain, fields, chain, address/hash shape, uint256 bounds | None |
| EIP-712 recovery | A supplied 65-byte signature recovers to the expected address | Real wallet or device must produce the signature |
| Injected browser | Existing wagmi connector and approval API wiring | Browser extension, chain switch, and wallet prompt |
| WalletConnect | Build-time connector selection | Project id, relay, QR scan, paired wallet prompt |
| Hardware | No direct connector is configured | Physical device through MetaMask/WalletConnect |
| API approval | Existing server-side owner/policy/nonce/expiry checks | Explicit confirmation before a shared/production submission |

## Limitations

- This harness only supports 65-byte ECDSA signatures. EIP-1271 contract-owner
  signatures require the existing server-side verifier and a deployed contract;
  they are not accepted by this local signature file harness.
- A successful signature recovery does not prove the wallet UI displayed the
  payload correctly. The human checklist requires the user to inspect the
  wallet prompt.
- A WalletConnect project id is public configuration, but a valid relay session
  and mobile wallet are required for pairing evidence.
- A hardware bridge can change behavior between wallet versions. Record the
  device model, host-wallet name/version, browser, and chain in the evidence
  file.
- Mainnet transactions, fee charging, DNS/TLS, GitHub App callbacks, and
  PostgreSQL persistence are outside this wallet harness.
