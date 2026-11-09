# P1-07 — verifier integrated into the release report

**Date:** 2026-10-19 · **Scope:** read-only release verification. No transaction is signed or sent.
**Code:** [`packages/verifier/src/release.ts`](../packages/verifier/src/release.ts),
CLI [`scripts/verify/release.ts`](../scripts/verify/release.ts).
**Tests:** [`tests/unit/p1-release-verification.test.ts`](../tests/unit/p1-release-verification.test.ts) (7),
[`tests/fork/release-verification.test.ts`](../tests/fork/release-verification.test.ts) (1),
[`tests/mainnet/release-verification.test.ts`](../tests/mainnet/release-verification.test.ts) (1 live).
**Evidence log:** [`docs/evidence/logs/p1-release-verification.log`](./evidence/logs/p1-release-verification.log).

---

## 1. What it does

`verifyRelease()` produces a **release-aware** verification report by combining:

1. **The approved manifest** (P1-04) — the authority for expected paths, sizes and raw SHA-256s.
2. **The chain** (P0/P1-06 verifier) — two independent operators, one pinned block, ERC-1967
   allowlist, byte-level reads (`read` ≤96 KiB / `readRange` above).
3. **The deployment journal** (P1-06, optional) — write/cutover ordering, mined blocks, gas.

The chain's own `fileInfo` declaration is **not** trusted as the expectation: the contract does
not enforce content hashes (P0-03 finding), so a report only passes when the bytes read from both
operators match the **manifest**.

## 2. Report shape

The report extends the PRD §6.4 `VerificationReport` (`status`, `checks`, `pin`,
`nodeOperators`, implementations) with:

| Field | Meaning |
|---|---|
| `releaseStatus` | `VERIFIED` / `MISMATCH` / `DISAGREEMENT` / `UNSUPPORTED_IMPLEMENTATION` / `INCOMPLETE` |
| `releaseMatch` | true only when `releaseStatus === "VERIFIED"` |
| `manifest` | commit, releaseId, entry/fallback, artifact/manifest hashes, file count, entry ≤24 KiB eligibility |
| `files[]` | per path: expected vs actual sha/size, per-operator values, chain declaration, `operatorsAgree`, `matched` |
| `journal` | `complete`, `verifiedFilesMatch`, `transactionsOk`, `allMinedBeforePin`, `entryWrittenLast`, tx count, total gas units, `issues[]` |
| `finality` | pinned block vs live `safe` / `finalized` block tags (never a fixed minute estimate) |
| `warnings[]` | e.g. single operator, no journal, legacy entry >24 KiB |

Status mapping: chain `UNSUPPORTED_IMPLEMENTATION` / `DISAGREEMENT` / `INCOMPLETE` propagate;
`VERIFIED` + all manifest files matched + no journal issues → `VERIFIED`; otherwise `MISMATCH`.

## 3. Journal checks

When a P1-06 journal is supplied:

- journal must be `complete`;
- every manifest path must have a `file_verified` event with the same raw SHA-256 and size;
- every transaction must be `mined` (no failed/unresolved);
- every mined block must be **≤ the verification pin** (the report covers the release);
- the entry transaction must not be mined before any asset transaction;
- total gas is summed and reported.

`journalEvidenceFromState()` converts the deployer journal state without importing the deployer
package (structural typing), so verification stays independent of execution.

## 4. Evidence

**Live X Layer (two operators, real chain):** a manifest built from the site's current declared
content at a pinned block verifies `VERIFIED` through OKX + dRPC; tampering with the expected
entry hash keeps the raw chain report `VERIFIED` but flips the release report to `MISMATCH`. The
observed site predates the 24,000-byte entry rule, so the report warns
`entrySingleTransactionEligible=false` — verification still works for legacy/external content.

**Anvil fork:** a release executed by P1-06 is verified together with its journal evidence:
chain `VERIFIED`, `releaseMatch=true`, all files matched, journal complete/transactions OK/
entry-written-last, finality pin recorded. A tampered manifest is rejected as `MISMATCH`.

**CLI:** `corepack pnpm verify:release ...` prints the summary and exits `0` only when the
release matches; a fixture manifest aimed at the observed live container exits `1`
(fail-closed) because its versioned paths do not exist there.

## 5. CLI

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

corepack pnpm verify:release \
  --config .tapeci.json \
  --commit <40-hex> \
  --repository-id <numeric-id> \
  --journal .tapeci/dep-....jsonl \
  --out release-verification.json
```

Exit codes: `0` release verified, `1` not verified (mismatch/incomplete/disagreement), `2`
invalid input or error. Read-only RPC only.

## 6. Limitations / carry-forward

- `VERIFIED` is a statement about **one pinned block**, not L2 finality; the `finality` block
  only tells whether that pin was at/behind the node's `safe`/`finalized` tag at observation time.
- Finality tags are read from the primary operator; operator disagreement on `safe` is not
  asserted separately (P1-07 scope).
- A single-operator report is possible only via an explicit test-only flag
  (`allowSingleOperator`); production verification stays two-operator.
- Entry cutover rollback and reference consistency are P1-08; this report verifies the manifest
  files and journal order, not the HTML reference graph.
- Still no mainnet writes; P0-07 remains gated on explicit budget authorization.
