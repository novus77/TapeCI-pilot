# P2-10 budget plan (mainnet release candidate)

**Status: PLAN ONLY — no mainnet transaction was signed or sent.** P2-10 remains blocked until
the authorization below is granted. Snapshot and recompute:

```bash
corepack pnpm budget:p2 > docs/evidence/p2-10-budget-snapshot.json
```

Read-only snapshot: [`docs/evidence/p2-10-budget-snapshot.json`](evidence/p2-10-budget-snapshot.json).

## 1. Snapshot (2026-10-19T10:57:47Z, chain 196)

| Operator | Endpoint | Block | Gas price |
|---|---|---|---|
| OKX | `https://rpc.xlayer.tech` | 73,638,431 | 0.020000001 gwei |
| dRPC | `https://xlayer.drpc.org` | 73,638,430 | 0.021 gwei |

The budget uses the **lower** observed price (0.020000001 gwei) and the P1 observed gas model:
`putFile` base 310,000 gas, `appendChunk` base 180,000 gas, 216 gas/byte
(code-deposit + calldata), 20% cap margin, 24,000-byte chunks. This is a model, not a receipt:
actual gas is reconciled after each release.

## 2. Scenario costs (all files written)

| Profile | Files / bytes | Chunks | Estimated gas | Est. cost (OKB) | Recommended cap (OKB) | Envelope* (OKB) |
|---|---|---|---|---|---|---|
| Canary 2 files / 40 KB | 2 / 40,096 | 3 | 9,460,736 | 0.000189215 | 0.000227058 | 0.000701361 |
| Small site 5 files / 120 KB | 5 / 119,512 | 9 | 28,084,592 | 0.000561692 | 0.000674030 | 0.002042279 |
| Medium site 20 files / 2 MB | 20 / 1,995,512 | 96 | 450,910,592 | 0.009018212 | 0.010821855 | 0.032485753 |
| Large site 100 files / 8 MB | 100 / 8,316,512 | 397 | 1,880,826,592 | 0.037616534 | 0.045139840 | 0.135439710 |

`*` Envelope = 3 × release cap (BullMQ default attempts) + 2 × rollback-entry cap. Rollback entry
cap is **0.000010094 OKB** (one `putFile` of the entry document).

At the snapshot gas price the expected canary + medium release + rollback spend is about
**0.0092 OKB**; the envelope covers two extra release attempts and a rollback.

## 3. Authorization request (choose one tier)

| Tier | Contents | Total cap requested | Per-deployment cap | Gas-price guard |
|---|---|---|---|---|
| **A. Canary only** | one 2-file site, verify + rollback | **0.001 OKB** | 0.0003 OKB | 0.03 gwei |
| **B. Recommended** | canary, medium site RC, verify, rollback drill | **0.05 OKB** | 0.015 OKB | 0.03 gwei |
| **C. Large site** | canary, large site RC, verify, rollback drill | **0.2 OKB** | 0.06 OKB | 0.03 gwei |

The guard is enforced in code: `TAPECI_MAX_GAS_PRICE_WEI=30000000` (0.03 gwei). Planning above that
price writes `PLAN_REJECTED` (`FEE_OVER_BUDGET`); deploy throws `FEE_OVER_BUDGET` before any chain
write. If the market moves above the guard, the release pauses and a **new** authorization is
required — no silent overspend.

## 4. Controls already enforced by the implementation

- **EIP-712 approval** binds deployment id, manifest hash, container, cost cap, nonce and expiry.
- The worker recomputes the plan and refuses if `estimatedCostWei > approvedCostCapWei`.
- **Gas-price guard** as above (new in this change).
- **One chain writer per container** (Redis lock + partial unique index), so two releases cannot
  race.
- Balance check in the planner; insufficient balance blocks the plan.
- Fail-closed states: RPC disagreement, implementation change, ownership change, auth revocation,
  fee over budget, upload conflict never continue writes.
- Rollback is a separate approved deployment that restores a stored release's entry.

## 5. Runbook (after authorization)

1. **Freeze:** record `pnpm budget:p2` output, target container, site size, wallet address and the
   total cap in the release ticket. Re-run the fork E2E (`pnpm test:p2:fork`) as a preflight.
2. **Preflight reads:** container owner = expected owner; implementations pinned; two operators
   agree on one block; operator wallet balance ≥ cap + gas reserve; `TAPECI_MAX_GAS_PRICE_WEI`
   set.
3. **Canary:** approve and execute the 2-file canary (cap 0.0003 OKB). Verify `LIVE`, compare
   actual gas/receipts with the estimate, and record tx hashes.
4. **RC release:** approve the medium site with cap 0.015 OKB; watch events through
   `VERIFYING_RELEASE → LIVE`; require `releaseMatch=true`.
5. **Rollback drill:** roll back to the previous release, verify the entry SHA and `LIVE`, then
   optionally roll forward to the RC.
6. **Reconcile:** update the budget snapshot with actual gas; any overrun beyond the envelope is
   an incident.
7. **Stop conditions:** gas price > guard, estimate > cap, RPC disagreement, implementation or
   owner change, balance below cap, or any verification mismatch.

## 6. Decisions needed from the owner

1. **Tier A/B/C** and the exact total OKB cap.
2. **Target site/container** (address) and whether canary uses a separate container (recommended
   for first run).
3. **Operator wallet**: address, funding amount, and who holds the private key (must not be the
   user's main wallet).
4. **Approval signer** (container owner wallet) and the approval window (expiry ≤ 1 hour).
5. **Execution window** and acceptable OKB/USD volatility (budget is denominated in OKB; gas
   price guard is the only automatic market control).
6. Whether the deploy queue should keep 3 attempts or be limited to 1 for the first mainnet run
   (the envelope assumes 3).

## 7. Risks / open issues

- Gas price and OKB/USD can move; the guard and cap are hard stops, not hedges.
- Actual gas may exceed the model on a busy block; the 20% margin covers normal variance only.
- The owner can transfer the container NFT or revoke the operator between approval and execution;
  the worker re-checks authorization, ownership and implementation before writing.
- P2-10 is the first real-money run: no automated mainnet test in CI, no retry-by-default beyond
  the approved envelope.
- No mainnet write has happened in this phase; `isSealed`/mainnet state is unchanged by this plan.
