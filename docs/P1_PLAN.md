# P1-05 — on-chain diff and fee plan

**Date:** 2026-10-19 · **Scope:** read-only release planning. No transaction is signed or sent.
**Code:** [`packages/deployer/src/release-plan.ts`](../packages/deployer/src/release-plan.ts),
[`cost.ts`](../packages/deployer/src/cost.ts), CLI [`scripts/plan/plan.ts`](../scripts/plan/plan.ts).
**Tests:** [`tests/unit/p1-plan.test.ts`](../tests/unit/p1-plan.test.ts),
[`tests/mainnet/plan.test.ts`](../tests/mainnet/plan.test.ts).
**Evidence log:** [`docs/evidence/logs/p1-plan.log`](./evidence/logs/p1-plan.log).

---

## 1. What a plan answers

Given a P1-04 release manifest and the exact uploaded bytes, `planRelease()`:

1. pins **one block** across the configured independent RPC operators (default OKX + dRPC);
2. requires every operator to return the same block hash and the same ERC-1967
   implementation addresses, and refuses to proceed on any disagreement or allowlist drift;
3. checks the target container is a **real, derived, opened** TapeOut container at that block;
4. reads `fileInfo` for every target path from every operator and requires exact agreement;
5. classifies each file (`WRITE` / `UNCHANGED` / `CONFLICT`), counts chunks and bytes;
6. estimates gas/cost from a fork-calibrated model and the block's base fee;
7. compares the estimate with an optional user **cost cap** and the signer balance;
8. returns a machine-readable `tapeci.plan.v1` plan with per-file evidence and blockers.

It never signs, sends, or stores a key.

## 2. Diff rules

| On-chain state at the pinned block | Result |
|---|---|
| path missing (`chunkCount == 0`) | `WRITE` — "missing on chain" |
| same `size` and same raw SHA-256 | `UNCHANGED` — zero gas |
| differs, and `path == manifest.entryPath` | `WRITE` — "entry replacement (controlled cutover)" |
| differs, any other path | `CONFLICT` — blocks the plan (`UPLOAD_CONFLICT`) |

Versioned assets are published under `releases/<releaseId>/…`, so a same-path/different-hash
asset means a release-id collision or tampering and is never overwritten silently. The root
entry is the only controlled replacement, and the deployer must switch it **after** the assets
are written and verified (P1-08).

## 3. Gas model (calibrated on the P0 fork)

Each chunk is stored as deployed contract code, so cost grows with bytes:

```
gas(file) = putFileBase
          + (chunks - 1) × appendChunkBase
          + size × (200 code-deposit + 16 calldata gas/byte)
```

Current constants (`OBSERVED_XLAYER_GAS_MODEL`):

| Constant | Value | Source |
|---|---|---|
| `putFileBaseGas` | 310,000 | rounded up from 296,698 (1-byte estimate) |
| `appendChunkBaseGas` | 180,000 | rounded up from 166,903 (1-byte estimate) |
| code deposit | 200 gas/byte | EVM `CREATE` code deposit |
| calldata | 16 gas/byte | non-zero calldata |
| default margin | 2,000 bps (+20%) | applied only to the **recommended cap**, not to the gas estimate |

Sanity: 24,000 bytes → **5,494,000 gas**, which is ≥ the **5,490,912 gas** measured for a
24,000-byte `putFile` in `docs/evidence/fork-upload.json`. Unit tests pin this inequality so the
model cannot silently start under-quoting.

The model is an estimate, not a receipt. P1-06 will record actual gas per transaction and can
tighten the model with observed data.

## 4. Cost, cap and blockers

- `estimatedCostWei = estimatedGas × gasPriceWei`, where the gas price is the pinned block's
  `baseFeePerGas`; if unavailable, the latest `eth_gasPrice` is used and a warning is recorded.
- `recommendedCapWei = ceil(estimatedCost × (1 + marginBps/10000))`.
- `withinBudget` compares the **estimate** with the approved cap; a cap below the estimate is
  blocked (`FEE_OVER_BUDGET`). A cap that covers the estimate but not the recommended margin is
  allowed with a warning.
- If a signer address is supplied, its balance is read from every operator at the same pin and
  must agree; below the estimate the plan is blocked (`INSUFFICIENT_BALANCE`).
- The signer is checked against the current container holder. A non-holder signer is **warned,
  not trusted**: `setOperator` TTL/revocation is enforced by the contract, and TapeCI cannot
  enumerate operators from chain state; the approval/deployer layer must verify it.

Blocking reasons are `UPLOAD_CONFLICT`, `FEE_OVER_BUDGET`, `INSUFFICIENT_BALANCE`; a plan is
`PLAN_READY` only when all three are clear.

## 5. Plan schema (`tapeci.plan.v1`)

Top-level fields: `schemaVersion`, `chainId` (196), `container`, `siteRegistry`, `commitSha`,
`releaseId`, `artifactDigest`, `releaseManifestHash`, `entryPath`, `pinnedBlockNumber`,
`pinnedBlockHash`, `operators`, `observedAt`, `containerOwner`, `containerOpened`,
`signer`, `signerIsHolder`, `signerBalanceWei`, `sufficientBalance`, `blocked`,
`blockedReasons`, `warnings`, `files[]`, `totals`, `fees`.

Every file row: `path`, `sourcePath`, `action`, `reason`, `size`, `sha256`, `chunks`,
`estimatedGas` (0 unless `WRITE`), `onChain` (`exists/size/sha256/contentType/chunkCount` or
`null`).

`totals` = `files/writes/unchanged/conflicts/chunks/bytes`; `fees` =
`gasPriceWei/estimatedGas/estimatedCostWei/marginBps/recommendedCapWei/costCapWei/withinBudget/overBudgetByWei`.

`planToJson()` converts every `bigint` to a decimal string for JSON/evidence.

## 6. CLI

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

corepack pnpm plan \
  --config .tapeci.json \
  --commit <40-hex-fixed-commit> \
  --repository-id <numeric-github-repo-id> \
  --cap 50000000000000000 \
  --signer 0xYourSigner \
  --out plan.json
```

Exit codes: `0` plan ready, `1` blocked, `2` invalid input or error. `--json` prints the plan
document instead of the summary; `--pinned-block` reproduces an earlier plan.

Read-only demonstration against the observed X Layer container
`0x25B2…F6b3` (fixture site; **not** an authorization to deploy to that container, and no
transaction was sent):

```
TapeCI plan (read-only — no transaction is sent)
  target      0x25b20d3ea6b207506340eab2eb0f45edc800f6b3
  owner       0x571d447f4f24688eC35Ccf07f1D6993655F6aF15
  release     r-0123456789ab-ee6afb44  commit 0123…4567
  pin         block 73625896 (okx + drpc)
  files       5 (write 5, unchanged 0, conflict 0), 5 chunk(s), 1154 byte(s)
  ...
  gas         1799264 @ 20000000 wei = 0.000035 OKB
  cap         estimate 0.000035 OKB, recommended 0.000043 OKB (+20.0%)
  budget      1.000000 OKB approved -> within budget
  status      PLAN_READY
```

With `--cap 1` the same plan exits `1` with `BLOCKED (FEE_OVER_BUDGET)`.

## 7. Limitations / carry-forward

- The gas model is conservative but still a model; mainnet base fees and calldata prices can
  differ. P1-06 records actual gas and P1-08/P0-07 will validate with real budgets.
- X Layer L2 data costs are assumed to be included in the gas price; this must be re-checked
  before P0-07.
- Operator authorization (`setOperator` TTL/revocation) cannot be enumerated from chain state,
  so a non-holder signer is only warned about here. The deployer must verify the delegation.
- Planning reads are cross-checked between operators, but planning is **not** a verification
  report; P1-07 owns the post-write byte-level report.
- The demo above targets a third-party container strictly as a read target; nothing in this
  repository authorizes writing to it.
