# P2-10 RC + rollback runbook (X Layer mainnet)

**Status:** tooling + procedure only. Nothing in this runbook signs or broadcasts by itself; the
owner approval and the execute step stay manual. P2-10 mainnet canary already ran on
2026-10-25 (`docs/evidence/p2-10-mainnet-canary.json`); this document covers the **RC release**
and the **rollback drill** on the same container.

- Network: X Layer mainnet, chainId **196**
- Container: `0xC0B4900262d0Bc13F2C67C0Fc4CF92c04E0aB814` (project `8c784556-477a-4c7b-bb1b-51c8732c1d18`)
- SiteRegistry: `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6`
- Canary release (rollback target): `r-147c0d8533c8-0ad76bec`, commit
  `147c0d8533c82c3f9ac5922a44122f5ce77080f7`
- Budget/caps: [`P2-10_BUDGET.md`](./P2-10_BUDGET.md); authorization packet:
  [`P2-10_AUTHORIZATION.md`](./P2-10_AUTHORIZATION.md)

> **Red lines.** No transaction is signed by these tools. A `receipt.status = success` is **not**
> LIVE: only the entry switch plus two-operator read-back verification marks a release LIVE.
> Never raise `--cap-wei` mid-run, and never continue when RPC operators disagree, the
> implementation changes, ownership moves or the estimate exceeds the cap.

---

## 0. Caps and evidence paths

| Item | Value / path |
|---|---|
| Per-deployment approval cap | from `recommendedCapWei` in `plan_json` (20 % margin over the estimate) |
| Hard gas-price guard | `TAPECI_MAX_GAS_PRICE_WEI=30000000` (0.03 gwei); above it the plan writes `PLAN_REJECTED` / `FEE_OVER_BUDGET` |
| Local tool guard | `--cap-wei` on both tools; non-zero exit when `recommendedCapWei > --cap-wei` |
| Canary evidence | `docs/evidence/p2-10-mainnet-canary.json` |
| Preflight evidence | `docs/evidence/p2-10-preflight.json` |
| Budget snapshot | `docs/evidence/p2-10-budget-snapshot.json` |
| RC release evidence | `docs/evidence/p2-10-rc-release.json` (write the tool output here) |
| Rollback evidence | `docs/evidence/p2-10-rc-rollback.json` (write the tool output here) |
| Journals (worker) | `.tapeci/journal/<deploymentId>.jsonl` |

Tier A (0.001 OKB total) covers a small RC plus one rollback on an **already-opened** container.
Tier B (0.05 OKB, per-deployment cap 0.015 OKB) is the recommended RC budget.

---

## 1. Preflight (read-only)

```bash
corepack pnpm db:up && corepack pnpm db:migrate
corepack pnpm api:dev          # terminal 1: API on http://127.0.0.1:8787
corepack pnpm worker:dev       # terminal 2: plan/deploy/verify workers

# chain identity, RPC agreement, implementations, container owner/opened state
corepack pnpm preflight:p2 -- --container 0xC0B4900262d0Bc13F2C67C0Fc4CF92c04E0aB814 \
  --budget-tier A --signer <owner-address> --out docs/evidence/p2-10-preflight.json

# budget snapshot at the current gas price
corepack pnpm budget:p2 > docs/evidence/p2-10-budget-snapshot.json
```

Go / no-go before any write:

- [ ] `chainId = 196` on every operator, and the operators **agree** at the pinned block.
- [ ] Factory / SiteRegistry / DomainBinding implementations are on the TapeKit allowlist.
- [ ] Container is opened and `lastObservedOwner` equals the wallet that will sign.
- [ ] `TAPECI_MAX_GAS_PRICE_WEI` is set (worker env) and the current gas price is below it.
- [ ] No other deployment for this container is in `APPROVED`/`UPLOADING_ASSETS`/
      `VERIFYING_ASSETS`/`SWITCHING_ENTRY`/`VERIFYING_RELEASE` (one chain writer per container).
- [ ] The rollback target release (`r-147c0d8533c8-0ad76bec`) still exists and verified.
- [ ] Authorization packet signed with tier, cap and execution window.

```bash
# no in-flight chain writer for this container
docker exec tapeci-postgres psql -U tapeci -d tapeci -c \
  "select id, state, trigger_kind from deployments where state in
   ('APPROVED','UPLOADING_ASSETS','VERIFYING_ASSETS','SWITCHING_ENTRY','VERIFYING_RELEASE');"
```

---

## 2. RC release (prepare `PLAN_READY` only)

Build the RC output first, then run the release tool. It tars `--dist` safely (no `./` root entry,
no AppleDouble `._*`, no `.DS_Store`, no symlinks), stores the tar content-addressed, inserts the
`BUILT` deployment, enqueues the **plan** job (read-only chain reads) and polls to `PLAN_READY`.

```bash
corepack pnpm build     # or your project's build command; output in ./dist

export TAPECI_DEV_GITHUB_LOGIN=novus77
export TAPECI_DEV_GITHUB_USER_ID=87079346

npx tsx scripts/p2/mainnet-release.ts \
  --project 8c784556-477a-4c7b-bb1b-51c8732c1d18 \
  --dist ./dist \
  --commit <40-hex-rc-commit> \
  --cap-wei 300000000000000 \
  > docs/evidence/p2-10-rc-release.json
```

The tool prints one JSON object (also on stdout) with:

| Field | Meaning |
|---|---|
| `deploymentId` | the deployment to approve |
| `artifactSha256` / `artifactStorageKey` | content-addressed tar (`sha256/<hex>.tar`) |
| `manifestSha256` | release manifest hash bound into the approval |
| `estimatedCostWei` / `recommendedCapWei` / `gasPriceWei` | plan fees |
| `capGuard` | `{capWei, ok, overByWei}` from `--cap-wei` |
| `approvalPayload` | EIP-712 domain/types/message the owner must sign |
| `skipped` | excluded paths (macOS metadata, symlinks) |

Exit codes: `0` = `PLAN_READY` within the cap guard, `1` = terminal state / timeout / cap
exceeded, `2` = usage or configuration error.

**Stop** if the state is not `PLAN_READY`, if `capGuard.ok` is false, if `plan.blocked` is true, or
if the printed `manifestSha256` differs from what the console shows for the same deployment.

---

## 3. Owner EIP-712 approval (manual, owner wallet)

The approval binds `deploymentId`, `manifestHash`, `container`, `costCapWei`, `nonce` and
`expiresAt`. Domain: `{name: "TapeCI", version: "1", chainId: 196, verifyingContract: <SiteRegistry>}`.

1. Open the deployment in the console (`/deployments/<id>`) or take `approvalPayload` from
   `docs/evidence/p2-10-rc-release.json`.
2. Connect the **owner wallet** on chain 196 and verify on screen:
   - `container` = `0xC0B4900262d0Bc13F2C67C0Fc4CF92c04E0aB814`
   - `costCapWei` = `recommendedCapWei` from step 2 (never higher)
   - `manifestHash` = `manifestSha256` from step 2
   - `expiresAt` is within the next 15 minutes
3. Sign with `eth_signTypedData_v4`. The API verifies owner, digest, cap, nonce and expiry, moves
   the deployment to `APPROVED` and creates a 1-hour operator session.

`GET /v1/deployments/:id/approval-payload` mints a fresh nonce each call, so sign the payload you
just fetched — not an older copy.

---

## 4. Execute (manual)

```bash
# once, after the state is APPROVED and inside the authorized window
curl -s -X POST -H "x-tapeci-github-login: novus77" -H "x-tapeci-github-user-id: 87079346" \
  http://127.0.0.1:8787/v1/deployments/<deploymentId>/execute
```

The deploy worker holds the per-container lock, re-plans, enforces `estimatedCostWei <=
approvedCostCapWei` and the gas-price guard, writes chunks (`putFile` + `appendChunk`, 24,000-byte
chunks), switches the entry **last**, then enqueues `verify`. Watch the deployment state reach
`LIVE`; `SWITCH_FAILED`, `VERIFY_FAILED`, `RPC_DISAGREEMENT`, `FEE_OVER_BUDGET` and
`OWNERSHIP_CHANGED` are fail-closed stops.

```bash
# follow state + events
curl -s -H "x-tapeci-github-login: novus77" -H "x-tapeci-github-user-id: 87079346" \
  http://127.0.0.1:8787/v1/deployments/<deploymentId> | jq '.deployment.state'
```

---

## 5. Dual-RPC verification

```bash
corepack pnpm verify:release -- \
  --config .tapeci.json \
  --commit <40-hex-rc-commit> \
  --repository-id 1426358946 \
  --dist ./dist \
  --journal .tapeci/journal/<deploymentId>.jsonl \
  --pinned-block <block> \
  --out docs/evidence/p2-10-rc-verify.json

# release-level report recorded by the verify worker
curl -s -H "x-tapeci-github-login: novus77" -H "x-tapeci-github-user-id: 87079346" \
  http://127.0.0.1:8787/v1/deployments/<deploymentId>/verification
```

Accept the RC only when, for **both** OKX and dRPC at the pinned block:

- [ ] every manifest path returns the expected size and raw SHA-256 on both operators;
- [ ] `operatorsAgree = true` for every file and `releaseMatch = true`;
- [ ] the journal is complete, every tx mined before the pin, and `entryWrittenLast = true`;
- [ ] the entry document (`index.html`) matches the new release (not the canary);
- [ ] implementations are unchanged and still allowlisted;
- [ ] deployment state is `LIVE` and the release is the project's `is_current` row.

Record `pinnedBlockNumber`, both tx hashes, `actualFeeWei` and the report path. If any operator
disagrees, stop and roll back — do not retry the write.

---

## 6. Rollback to the canary release

Rollback creates a **new deployment** that restores a stored release; history is never mutated.
`scripts/p2/mainnet-rollback.ts` mirrors `POST /v1/projects/:id/rollback`: `triggerKind =
"rollback"`, state `PLAN_READY`, `rollbackTargetReleaseId` = the release row, artifact key copied
from the target deployment, `sourceEventKey = rollback:<releaseRowId>` (idempotent).

```bash
export TAPECI_DEV_GITHUB_LOGIN=novus77
export TAPECI_DEV_GITHUB_USER_ID=87079346

npx tsx scripts/p2/mainnet-rollback.ts \
  --project 8c784556-477a-4c7b-bb1b-51c8732c1d18 \
  --release r-147c0d8533c8-0ad76bec \
  --cap-wei 300000000000000 \
  > docs/evidence/p2-10-rc-rollback.json
```

The rollback worker (`deployRollback`) needs **no chunk upload**: it re-derives the target
manifest, verifies the assets already on chain via `switchEntryToRelease`, writes only the entry
document, then runs the normal verify step.

Notes:

- The rollback fee block is copied from the target deployment, so it **over-estimates** the
  entry-only write. A `feeEstimateAvailable: false` result means the stored plan was the route's
  zero placeholder and `--cap-wei` cannot bound anything — treat the approval payload's
  `costCapWei = 0` accordingly and rely on the gas-price guard.
- Re-running the same `--release` reuses the existing rollback row (`sourceEventKey`), so a repeat
  run reports `ALREADY_APPLIED` instead of creating a second deployment.
- A rollback deployment needs its **own** EIP-712 approval and execute call (steps 3–4). The
  rollback tool never approves.

Then repeat step 5 for the rollback deployment: both operators must show the canary's
`index.html` (142 bytes, `0x567962bd…`) and the canary release id.

---

## 7. Rollback to an empty site is NOT the rollback API

The rollback route restores a **stored release**. It cannot delete a release that has no
predecessor, and there is no "release zero" to target. To remove published content you must call
the registry write directly:

```
removeFile(address container, string path)
```

on `SiteRegistry 0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6`, from the container owner (or an
authorized operator set with `setOperator`), once per path — `index.html` and every
`releases/<releaseId>/…` file. The ABI is in `packages/chain/src/abis.ts`
(`siteRegistryAbi`, `removeFile`); it emits `FileRemoved(container, path)`.
TapeCI does **not** ship a tool for this: it is a raw owner write, it is not covered by the
approval/cap flow, and it leaves no release row. If a "back to empty" state is ever required:

1. get explicit, separate authorization (it is a destructive write);
2. call `removeFile` for the entry **last**, after the assets;
3. verify through both operators that the paths report `exists = false`;
4. record the tx hashes in `docs/evidence/` — the deployment table will not show them.

Never present `removeFile` as a rollback: `POST /v1/projects/:id/rollback` with a missing release
returns `404 RELEASE_NOT_FOUND`, and an archived project returns `409 PROJECT_ARCHIVED`.

---

## 8. Abort criteria

Stop (do not approve, do not execute, do not retry) when any of these is true:

| Signal | Action |
|---|---|
| `recommendedCapWei > --cap-wei` or plan `withinBudget = false` | re-budget; do not raise the cap mid-run |
| `gasPriceWei > TAPECI_MAX_GAS_PRICE_WEI` | wait for the market; planning writes `PLAN_REJECTED` |
| `plan.blocked` / `blockedReasons` non-empty | inspect `UPLOAD_CONFLICT` / `FEE_OVER_BUDGET` |
| RPC operators disagree at the pin | stop; `RPC_DISAGREEMENT` is fail-closed |
| Implementation slot changed | stop; `IMPLEMENTATION_CHANGED` needs a new authorization |
| Container owner changed | stop; re-run preflight, re-issue the approval |
| Any terminal state other than `LIVE` | roll back (step 6) and record the evidence |

---

## 9. Checklist

- [ ] Preflight report written and green (step 1).
- [ ] RC `PLAN_READY` with `capGuard.ok = true`; evidence JSON saved (step 2).
- [ ] Owner signed the exact payload (`manifestHash`, `container`, `costCapWei`) (step 3).
- [ ] Execute called once, state reached `LIVE` (step 4).
- [ ] Dual-RPC verification at one pinned block, `releaseMatch = true` (step 5).
- [ ] Rollback deployment created, approved, executed, verified (step 6).
- [ ] Evidence paths and tx hashes recorded; caps unchanged from the authorization packet.
- [ ] No `removeFile` was used unless separately authorized (step 7).

## Approval without a browser wallet

If the console cannot reach an injected wallet, sign the same EIP-712 payload locally:

```bash
cp .tapeci/owner.env.example .tapeci/owner.env && chmod 600 .tapeci/owner.env
# fill TAPECI_OWNER_PRIVATE_KEY locally
pnpm approve:sign -- --deployment <deploymentId>          # prints signer + signature
pnpm approve:sign -- --deployment <deploymentId> --post   # signs and submits
```

The CLI checks that the key derives the payload's `expectedSigner` (the current container owner),
signs `Approval` on chainId 196, and never prints the key. This path is equivalent to the wallet
path: the API verifies the signature against the owner and the approved cap.

## Path mode (versioned vs root)

`versioned` (default) stores every release under `/releases/<id>/...` and never overwrites; the entry
HTML's asset references are rewritten to that prefix. It is the safe default, but it breaks sites
that load files at runtime (Docsify, SPAs) or link across pages with relative paths.

`root` publishes files at their own paths and does not rewrite the entry. Use it for multi-page
static sites and SPA builds. Trade-off: a new release overwrites the previous one in place, so there
is no immutable history per release.

Set it per project (Settings → Asset paths) or through the API: `PATCH /v1/projects/:id {"pathMode":"root"}`.
