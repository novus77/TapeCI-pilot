# Real integration verification — 2026-10-26

Scope requested: real wallet, WalletConnect, hardware device, real signature, mainnet transactions
and fees, gateway/DNS/TLS, real GitHub App callback, PostgreSQL persistence.

Verdict per item below. Four are **VERIFIED with measured evidence**; three need a device and are
served by a self-service acceptance page that turns the manual run into reproducible evidence.

## VERIFIED

| Item | Evidence | Result |
|---|---|---|
| **Injected browser wallet** | `wallet-acceptance-2026-10-26.json` | The user's extension wallet on chain 196 signed the acceptance payload; browser recovery **and** an independent offline tool both recover `0x2506…5F22`. `PASS`. |
| **Real signature** | `docs/evidence/real-integrations/signature-2026-10-26.json` | The EIP-712 approval behind the live release was re-derived from stored values and recovered to `0x2506…5F22`, the container owner. 65-byte secp256k1. |
| **Mainnet transactions and fees** | `chain-fees-2026-10-26.json` | 21/21 transactions: the operator balance debit equals `gasUsed × effectiveGasPrice` exactly. Total **0.0010972 OKB**, below the approved cap 0.00129. Domain bind fee 0.0000037 OKB paid by the holder. |
| **Gateway / DNS / TLS** | `gateway-audit-2026-10-26.json` | A records on Cloudflare; TLS 1.3, Let's Encrypt, valid to 2026-12-12, chain authorized. Content: raw HTTP is the service-worker bootstrap (by design), and after the SW takes over the fetched bytes are **12,340 B hashing to `0xa116a0da…`, identical to the on-chain declared SHA-256**. Negative control: a nonexistent circuit is refused. |
| **GitHub App callback + PostgreSQL** | `github-postgres-2026-10-26.json` | App 5383055 identified with a locally signed RS256 JWT. Signed `push` delivery → **202 accepted** and a deployment row; replay → **200 duplicate**, still one row (idempotent); wrong HMAC → **401**; malformed payload → **422**. API restart: 6 deliveries / 23 deployments / 45 audit events identical before and after. |

## HUMAN_REQUIRED (by design, not a gap)

| Item | Why not automated | How to prove it now |
|---|---|---|
| **WalletConnect** | Project id is configured and the handshake is verified (`walletconnect-handshake-2026-10-26.json`: relay socket + project-scoped attestation + rendered QR). A phone wallet has not scanned yet. | Same page, "WalletConnect" button, scan the QR, sign on the phone, record the phone wallet name/version in the device note. |
| **Hardware device** | Needs the physical device through a host wallet bridge | Same page through MetaMask's hardware bridge; record device model, host wallet version, browser, and connection. |

Manual run then becomes evidence:

```bash
pnpm wallet:acceptance:verify -- wallet-acceptance-<ts>.json
```

That recomputes the recovery offline with viem and prints `PASS`/`FAIL` against the address in the
record. The acceptance payload uses a test deployment id (`acceptance-…`), the zero address as the
verifying contract, `costCapWei = 0` and a one-hour expiry, so it cannot authorize a release.

## What the console needed to make this work

- `apps/web/app/wallet-check/page.tsx` + `components/wallet-acceptance.tsx`: connector/address/chain
  display, a test EIP-712 signature, in-browser recovery, device note, JSON export.
- `apps/web/lib/wagmi.ts`: the lazy WalletConnect connector is now typed so `next build` succeeds
  (it previously failed `tsc -p apps/web` with an incompatible connector return type).
- `scripts/real-integrations/wallet/verify-acceptance.ts` (`pnpm wallet:acceptance:verify`).

## Residual risks

1. The gateway bootstrap-then-service-worker dance means a naive HTTP hash check always disagrees with
   the chain; the existing `chain gateway` command reports `BLOCKED` for that reason. The
   service-worker fetch is the authoritative check and is recorded above.
2. WalletConnect cannot even be attempted until `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set; the
   connector is only registered when that variable exists.
3. Fee measurements assume the operator received no funds in the same block; all 21 were clean, but
   the method reports `INCONCLUSIVE` rather than guessing if that ever happens.

---

## Close-out (2026-10-26, later the same day)

Fixes made while finishing:

- `pnpm wallet:acceptance:verify -- file` now works (the literal `--` that pnpm forwards is skipped).
- The device note is prefilled from the connector and browser UA, and signing is blocked until it has
  content, so a rushed run cannot produce an empty note.
- `.meta-item dd.mono` truncates with an ellipsis rather than becoming a scroll container; the earlier
  `overflow-x: auto` tripped axe `scrollable-region-focusable` on the container page.

Final gate: typecheck (root + web), lint, unit **349**, P2 **233**, e2e **84**, CI green.

Still HUMAN_REQUIRED, and deliberately not claimed as done:

1. **WalletConnect session** — scan the QR with a phone wallet on chain 196, sign, then
   `pnpm wallet:acceptance:verify -- <record.json>`.
2. **Hardware wallet** — sign through the host wallet's hardware bridge and record the device model,
   host wallet version, browser and connection.
3. **Username/hostname decision** — the site is served under the shared `*.tapekit.org` gateway; a
   user-owned domain would need the TapeKit domain-binding path, which is out of scope for this round.
