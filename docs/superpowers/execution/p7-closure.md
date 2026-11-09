# P7 — closure

**Status: P7 is closed as accepted-with-gaps.** All development work is complete; what
remains is external (no supplier, no GitHub App, no CI runner) or explicitly deferred. This
document says what was delivered, what was proven, and what is still owed — so a future
reader does not have to reconstruct it from twelve PRs and two audits.

## What P7 actually was

P7 was never a feature phase. It was the **independent acceptance** §15.3 asks for: a
reviewer who did not write the code, checking whether the claims were true. It ran twice.

Both rounds found the same thing, and it is worth stating plainly because it is the one
lesson this repository should keep:

> The implementation was mostly present. The **evidence** was not.

Round 1 checked 61 rows marked `fixed` and found 48 verified, 11 partial, and two stating a
false fact. Round 2 checked the fixes and found the dishonesty had *moved* — into the
citations — while also finding two regressions the fixes themselves introduced.

## Rounds

| | Round 1 | Round 2 |
| --- | --- | --- |
| Verdict | P3 refused, P7 not signed | not signed, 3 blockers |
| Gates | fork suite **red** (2 failed) | all five green |
| Most serious | P3 had no UI; the fork suite was broken for two phases and unlogged | `main` could not be installed; the reorg guard was **inverted on the money path** |

Both audit records are kept: [`p7-acceptance.md`](p7-acceptance.md) and
[`p7-acceptance-r2.md`](p7-acceptance-r2.md). They are the most valuable documents in this
directory, because they are the only places that record what was *wrong* rather than what
was intended.

## Defects the audits caught that testing never would

These are the reason P7 existed:

| Defect | Why the suite missed it |
| --- | --- |
| **The reorg guard demoted confirmed payments on an RPC outage.** `isCanonical` returned `false` for an unreadable node, so "could not check" became "the payment vanished" — on a paid path | every block-change test started at `submitted`; nothing exercised `confirmed → reorg` |
| **`main` could not be installed or typechecked.** A package was committed without its lockfile entry or its own source files | every local run had the untracked files present |
| **The fork suite was red for two phases.** The only test driving webhook → LIVE against a real fork was refused by the admission gate | phase gates ran `tests/p2` + e2e, never `tests/fork` as a whole |
| **The replacement test passed for the wrong reason.** It asserted `pending`, which held whether or not the right row was read | it did not pin *which* attempt was authoritative |
| **P7-19's fix did not work.** The replay path refused before the repair ran, leaving a crashed continuation permanently broken | the claim was written; no test was |
| **The re-verify control never compared the owner.** A transferred circuit is still "opened", so it reported "nothing changed" about a circuit that was no longer yours | the rule was inline in a client component, unreachable by tests |

## What is proven, and how

| Claim | Evidence |
| --- | --- |
| A second `open` reverts and does **not** re-charge `FEE()` | Anvil fork of X Layer 196, holder impersonated, real `opener.open`: `0x0`, 55,163 gas, `chargedFeeAgain: false`, reproduced independently by the round-2 auditor |
| X Layer 196 exposes `finalized` (≈1,500 blocks behind head) | probe; the confirmation policy accepts it instead of a guessed depth |
| `tokenId` starts at 1 on chain | `ownerOf(0)` reverts, `ownerOf(1)` returns the holder — so the DB constraint encodes a fact, not a floor |
| Committed evidence is immutable | `docs/evidence/fork-upload.json` sha256 identical before and after a full 56-test fork run |
| The sweep runs | the auditor booted `apps/api/src/worker.ts` and observed five `provisioning_sweep` lines |
| `main` installs and typechecks from a clean checkout | `git archive HEAD` → `install --frozen-lockfile` → `Done in 24–31s`; `check` exit 0; unit 576, p2 407 in that clean tree |

## Final gate state

Run on a clean checkout of the final merge, not the working tree:

| Check | Result |
| --- | --- |
| `npm run check` (lint + typecheck + web) | exit 0 |
| unit | **576** |
| p2 (real Postgres) | **407** |
| e2e | **147 passed / 1 skipped** |
| full fork suite | **56 passed** |

The one e2e skip is a remove-confirmation control that the read-only mock organisation does
not render by design. It is a **skip, never a pass**, and is reported that way everywhere.

## What is still owed

Eight items, none of them development work on this codebase:

| ID | Item | Who can close it |
| --- | --- | --- |
| P0-11 / P7-04 / P7-05 | P5 needs a real supplier: `listOffers` / `quoteAcquisition` / `verifyDelivery` and a purchase ABI do not exist. `offers` answering `available:false` is the honest output, not a stub to replace with a mock | external |
| P4-13 | No real GitHub App token exists, so the dispatch path has never run against GitHub; whether Actions omits `workflow_sha` is unknown (the code fails closed if it does) | external |
| BL-01 | `origin/dev` does not exist; all work is on `main` | a decision |
| CI | GitHub Actions has not allocated a runner since PR #17 — `runner_name` empty, `steps: 0`, jobs "complete" in 2–3 s. This is why every merge since then rests on local evidence | external |
| P4-18 | The dispatch trigger is inline in the webhook (no dispatch job type); acceptable because the attempt is saved first, so an interrupted trigger is recoverable | deferrable |
| P7-13 | A draft's skip reason cannot be expressed (`isDraft` is hardcoded `false`); the gate itself is correct — a draft is still not admitted | deferrable |
| P7-15 | An unsupported `finalized` tag fails closed but without a named reason, so an operator cannot tell "unsupported" from "not deep enough" | deferrable |

## Deployment prerequisites

Two settings must exist before this can be run for real, and neither has a default on
purpose:

| Variable | Why it has no default |
| --- | --- |
| `TAPECI_PROVISIONING_CONFIRMATIONS` | §9.2 forbids inventing a confirmation depth. Unset means every paid `open` stops at `submitted` with `CONFIRMATION_POLICY_UNCONFIGURED` — the honest state, and the tests assert that negative. Set it to `finalized` (X Layer supports the tag) or an explicit block count |
| `TAPECI_PROVISIONING_SWEEP_INTERVAL_MS` | Defaults to 60 s; `0` disables the sweep. Without it a payment that mined while nobody watched stays unverified until a user presses "check again" |

## What this phase does not claim

- It does not claim the build is cryptographically reproducible. §11.3's mechanism proves
  **association** (workflow identity + authorised commit), not reproducibility, and the
  wording says so everywhere.
- It does not claim P5 works. It does not.
- It does not claim any real integration has been exercised: no mainnet write this round, no
  real GitHub App, no real supplier.
- Two evidence files under `docs/evidence/provisioning/` are still hand-authored with
  round-hour timestamps. P7-12's test now reproduces the second-open numbers exactly, which
  is the strongest available check, but the files themselves are not machine-produced.
