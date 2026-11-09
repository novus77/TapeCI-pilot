# Real integration verification: chain, fees, gateway, DNS, and TLS

TapeCI already had separate mainnet probes, receipt checks, and release verification. This
harness adds one explicit, read-only path that turns those observations into machine-readable
evidence without adding a signing or broadcast capability.

## Safety boundary

Every network command is disabled unless `TAPECI_REAL_INTEGRATION=1`. The CLI rejects
`--send`, `--sign`, `--transfer`, and `--write-dns`; it has no private-key input and emits no
transaction or DNS mutation. Evidence serialization rejects secret-like field names before writing
a file. Do not place RPC credentials, private keys, mnemonics, or authorization headers in command
arguments or evidence.

The command is read-only. A successful receipt is not sufficient for release LIVE: the gateway
command also requires the DomainBinding state on two independent RPC operators, a matching pinned
block, DNS records, strict TLS validation, hostname validation, certificate validity, an HTTPS 2xx
response, and an expected response SHA-256.

## Commands

Run from the repository root:

```bash
export TAPECI_REAL_INTEGRATION=1

# 1. Two-operator preflight: chain, owner, opened container, balance, fee headroom
corepack pnpm tsx scripts/real-integrations/chain/cli.ts preflight \
  --container 0xC0B4900262d0Bc13F2C67C0Fc4CF92c04E0aB814 \
  --owner 0x25063c2210a0BCcCE3e15d250573179483275f22 \
  --signer 0x25063c2210a0BCcCE3e15d250573179483275f22 \
  --budget-cap-wei 1000000000000000 \
  --out docs/evidence/real-integration-preflight.json

# 2. Existing transaction: receipt, confirmations, actual fee, and exact adjacent-block debit
corepack pnpm tsx scripts/real-integrations/chain/cli.ts transaction \
  --hash 0xe2e54ada36423abac9a5c8a0b73d08d83d3de5cea838a64bf7321a6b0bd6503f \
  --from 0x6c723d1Dc3861C0897848b79e231caA2c57622eb \
  --to 0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6 \
  --max-fee-wei 20000000000000 \
  --min-confirmations 12 \
  --balance-before-block 74093810 \
  --out docs/evidence/real-integration-transaction.json

# 3. DomainBinding LIVE + DNS + strict TLS + HTTPS content
corepack pnpm tsx scripts/real-integrations/chain/cli.ts gateway \
  --domain 10.2.4.tape \
  --container 0xC0B4900262d0Bc13F2C67C0Fc4CF92c04E0aB814 \
  --url https://10-2-4.tapekit.org/ \
  --expected-content-sha256 0x3cae50fd41819c41851cc8fe28d07d2f3c686298571194857033ac1d61da1941 \
  --out docs/evidence/real-integration-gateway.json
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Evidence status is `READY` or `VERIFIED`. |
| `1` | Evidence was produced and is `BLOCKED`. |
| `2` | Opt-in, arguments, serialization, or transport failed before a verdict. |

## What each evidence file proves

All files contain `schema`, `schemaVersion`, `observedAt`, `readOnly: true`,
`writeActionsPerformed: false`, the expected authorization values, operator observations, and
`blockers`.

`preflight` reads one block from each independent operator, requires matching block hashes and
chainId 196, inspects the canonical ERC-6551 container, checks the current owner and opened state,
and compares signer balance with the declared cap. It also requires 100,000 gas at the highest
observed gas price to fit inside the cap.

`transaction` requires two independent operators to return the same successful receipt. It
checks the hash, sender, recipient, confirmation count, gas used, effective gas price, and
`gasUsed * effectiveGasPrice <= maxFeeWei`. Its balance check reads the signer at the block
immediately before the receipt block and at the receipt block. Those reads are EIP-1898 block
state reads, not a historical balance API. The delta must equal `fee + transaction.value`.
`debug_traceTransaction` is not required because the public X Layer RPCs do not expose it.

`gateway` requires two operators to agree on `DomainBinding.isLive`,
`DomainBinding.isContainerLive`, `containerPaidUntil`, the pinned block, and the allowlisted
DomainBinding implementation. It then requires DNS A, AAAA, or CNAME records; an authorized
certificate matching the hostname and current time; an HTTPS 2xx response from the expected origin;
and the response body's SHA-256.

## Existing real evidence

The harness was exercised against existing X Layer mainnet activity:

| Check | Observation |
|---|---|
| Preflight | `READY`; OKX and dRPC agreed at one pinned block; container `0xC0B4…B814`, owner `0x2506…5F22`, opened; signer balance `40,360,737,619,036,881 wei` |
| Canary transaction | `0xe2e54a…503f` at block `74,093,811`; both operators returned success; 115,089 confirmations during the run |
| Actual fee | `190,358 × 20,000,001 = 3,807,160,190,358 wei` (`0.000003807160190358 OKB`) |
| Exact debit | Balance fell from `38,977,058,878,852,944` to `38,973,251,718,662,586` wei; delta `3,807,160,190,358 wei` equals the fee |
| Domain state | `10.2.4.tape` and its container were LIVE on both operators; paid until `2026-11-24T09:38:10Z` |
| DNS | `104.21.71.52`, `172.67.143.110`; no AAAA/CNAME |
| TLS | Let's Encrypt wildcard `*.tapekit.org`; authorized and hostname-matched; valid through `2026-12-12T17:50:25Z` |
| HTTPS | `200`, `text/html`, body SHA-256 `0x3cae50…1941` |

The full evidence files from that run are intentionally local outputs. Existing committed
evidence remains under `docs/evidence/`.

## Tests

```bash
corepack pnpm vitest run tests/real-integrations/chain
TAPECI_REAL_INTEGRATION=1 corepack pnpm vitest run tests/real-integrations/chain/live.test.ts
corepack pnpm exec eslint scripts/real-integrations/chain tests/real-integrations/chain
```

The default suite performs no network I/O. The live suite is skipped unless the opt-in is set.

## Mainnet write authorization

No mainnet write is available through this harness. A write run must use the existing product
approval and execution path and requires explicit, per-run authorization with all of these values:

| Input | Required value |
|---|---|
| Chain | X Layer `196` |
| Container | Exact address, opened and derived from the processor token |
| Owner signer | Current owner address; owner must match on both RPC operators |
| Operator | Delegated operator address or owner, with current authorization |
| Operation | Exact deployment/release and manifest hash |
| Budget | Decimal wei total cap and per-transaction gas-price cap |
| Timing | UTC start/end and approval expiry no later than one hour |
| Rollback | Existing verified release id and its expected entry SHA-256 |
| Attempts | One attempt for the first real-money run unless explicitly authorized otherwise |
| Evidence destination | Local path under `docs/evidence/` |

Before a write, capture preflight and plan evidence, verify the EIP-712 digest and expected signer,
and confirm there is no other in-flight writer for the container. After a write, record every
transaction hash, wait for both operators to reach the block, verify receipt success, actual fee,
adjacent-block debit, on-chain file bytes, DomainBinding LIVE, DNS, TLS, and HTTPS content, and
retain rollback evidence. A mismatch stops the run; a successful receipt alone is never LIVE.

The current preflight is `READY` for read-only checks only. It does not authorize a write.
