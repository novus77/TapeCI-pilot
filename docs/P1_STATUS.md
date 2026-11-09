# P1 status — complete (P1-01 … P1-09)

**Date:** 2026-10-19
**Baseline:** P0 gate `1fb7471` (`docs/P0_DECISION.md`: GO for P1, NO-GO for mainnet until P0-07)
**Scope of this round:** P1-01 reproducible CI, P1-02 `.tapeci.json`, P1-03 safe artifact scanning,
P1-04 deterministic release manifest, P1-05 read-only chain diff/fee plan, P1-06 crash-tolerant
journaled execution, P1-07 release-aware verification reports, P1-08 entry cutover/rollback, and
P1-09 end-to-end CLI. **No mainnet writes, no funds, no secrets.**

---

## 1. Delivered

| Task | Deliverable | Verification |
|---|---|---|
| P1-01 | [.github/workflows/ci.yml](../.github/workflows/ci.yml), [network.yml](../.github/workflows/network.yml), [docs/P1_CI.md](./P1_CI.md) | YAML syntax/structure validated locally with PyYAML; **not executed on GitHub in this session** |
| P1-02 | [packages/config/src/project-config.ts](../packages/config/src/project-config.ts), 31 tests | `pnpm test:unit` PASS |
| P1-03 | [packages/validator](../packages/validator) — safe static scanning, 121 tests | `pnpm test:unit` PASS |
| P1-04 | [packages/artifact](../packages/artifact) — deterministic manifest v1, 54 tests | `pnpm test:unit` PASS |
| P1-05 | [packages/deployer/src/release-plan.ts](../packages/deployer/src/release-plan.ts), [cost.ts](../packages/deployer/src/cost.ts), [scripts/plan/plan.ts](../scripts/plan/plan.ts), [docs/P1_PLAN.md](./P1_PLAN.md) | 5 unit + 3 live read-only tests; CLI exit 0/1 evidence |
| P1-06 | [journal.ts](../packages/deployer/src/journal.ts), [nonce.ts](../packages/deployer/src/nonce.ts), [execute-release.ts](../packages/deployer/src/execute-release.ts), [docs/P1_JOURNAL.md](./P1_JOURNAL.md) | 9 unit + 2 fork tests: interruption → resume, no duplicate append, entry last, 0-tx replay |
| P1-07 | [packages/verifier/src/release.ts](../packages/verifier/src/release.ts), [scripts/verify/release.ts](../scripts/verify/release.ts), [docs/P1_RELEASE_VERIFICATION.md](./P1_RELEASE_VERIFICATION.md) | 7 unit + 1 fork + 1 live two-operator test; CLI exits 0/1 |
| P1-08 | [packages/release](../packages/release), [docs/P1_ENTRY_CUTOVER.md](./P1_ENTRY_CUTOVER.md) | 7 unit + 1 fork scenario: versioned entry rewrite, one-tx switch, old assets readable, rollback, missing-asset refusal |
| P1-09 | [packages/cli](../packages/cli), [docs/P1_CLI.md](./P1_CLI.md) | 6 unit + 1 full fork lifecycle (deploy A/B, verify, releases, rollback) |
| integration | [tests/unit/p1-integration.test.ts](../tests/unit/p1-integration.test.ts), [tests/fixtures/static-site](../tests/fixtures/static-site) | config → scan → manifest, 3 tests |

Unit suite: **266 tests / 11 files**; fork suite: **43 tests**; read-only mainnet suite: **20 tests**.
Typecheck (strict) and lint are clean.

## 2. Public APIs (P2 consumes these)

### `@tapeci/config` (`.tapeci.json`)

```ts
TAPECI_CONFIG_SCHEMA_VERSION = "tapeci.config.v1"
parseTapeCiConfig(unknown): TapeCiProjectConfig   // zod strict, INVALID_CONFIG with details.issues
loadTapeCiConfig(path): TapeCiProjectConfig       // reads JSON, BOM-tolerant, 1 MB cap
createTapeCiConfig({ container, ...overrides }): TapeCiProjectConfig
DEFAULT_TAPECI_CONFIG                              // container "" is intentionally invalid
```

Shape: `{ schemaVersion, chainId: 196, site{container, entryPath:"index.html", fallbackPath},
build{installCommand, buildCommand, outputDir, timeoutSeconds},
policy{strictOnChain, maxFileBytes, ignore[]}, release{pathPrefix, keepVersions} }`.

### `@tapeci/validator`

```ts
scanArtifactDirectory(rootDir, options?): Promise<ScanResult>
scanArtifactFiles(input, options?): ScanResult
contentTypeForPath, scanHtmlReferences, scanCssReferences, isExternalUrl
```

`ScanResult` = `{ files: ScannedFile[], entry, totalBytes, externalReferences, warnings, fullyOnChain }`.
Rejects symlinks/non-regular files, traversal/absolute paths, duplicates (NFC), server-side
extensions, files > 8.4 MB, entry > 24,000 B; strict mode rejects off-chain `src/href/action/
poster/srcset`, meta-refresh and CSS `url()`/`@import` references.

### `@tapeci/artifact`

```ts
buildReleaseManifest(input): { manifest, artifactDigest, releaseManifestHash, canonicalJson }
computeArtifactDigest(files): Hex        // sorted {path,size,sha256} canonical JSON
releaseManifestHash(manifest): Hex       // canonical manifest, no timestamps/gas
deriveReleaseId(commitSha, artifactDigest): string  // r-<12 commit>-<8 digest>
buildManifestFiles(files, {entryPath, pathPrefix, releaseId}): ManifestFile[]
```

Manifest v1: entry stays `index.html`; other files target
`${pathPrefix}/${releaseId}/${sourcePath}`; rows sorted by UTF-8 target path; entry must be
≤24,000 B and exactly one chunk; unknown/dynamic fields (timestamp, gas, plan) are rejected
from the hashed manifest — keep plan/cost outside it.

### `@tapeci/deployer` (P1-05 planning)

```ts
planRelease({ manifest, files, operators, signer?, costCapWei?, gasPriceWei?,
              pinnedBlockNumber?, marginBps?, gasModel? }): Promise<ReleasePlan>
diffReleasePlan({ manifest, onChain, gasModel? }): { files, totals }
estimatePlanFees({ estimatedGas, gasPriceWei, marginBps, costCapWei?, signerBalanceWei? })
estimateFileGas(size, model?), estimateTotalGas(sizes, model?)
recommendedCapWei(cost, bps), formatOkb(wei), planToJson(plan)
```

`ReleasePlan` is `tapeci.plan.v1`: pinned block/hash, operators, container owner/opened,
per-file diff + chunks + gas, totals, cost/cap/recommended cap, signer balance, blocked
reasons and warnings. See [P1_PLAN.md](./P1_PLAN.md) for the schema and gas model.

### `@tapeci/deployer` (P1-06 execution)

```ts
executeRelease({ plan, manifest, files, client, wallet, config, journalPath, signer,
                 maxTransactions?, onEvent? }): Promise<ExecuteReleaseResult>
reconcileJournalTransactions(journal, client): Promise<void>
DeploymentJournal.open(path, options?) / readJournalState(path)
deriveDeploymentId(plan), planFingerprint(plan), operationFingerprint(request)
NonceLock({ client, signer, journal }).allocate()
```

Journal events: `plan`, `tx_intent`, `tx_sent`, `tx_mined`, `tx_failed`, `file_verified`,
`deployment_complete`, `note`. See [P1_JOURNAL.md](./P1_JOURNAL.md).

### `@tapeci/verifier` (P1-07 release report)

```ts
verifyRelease({ manifest, journal?, pinnedBlock?, operators?, config?, allowSingleOperator? })
journalEvidenceFromState(journalState): ReleaseJournalEvidence
matchReleaseFiles(manifest, checks), checkJournalEvidence(manifest, journal, pin)
deriveReleaseStatus(chainStatus, allFilesMatched, journalCheck)
```

`ReleaseVerificationReport` = PRD §6.4 report + `releaseStatus`, `releaseMatch`, `files[]`
(expected vs per-operator actual), `journal` checks, `finality` (safe/finalized tags), warnings.
See [P1_RELEASE_VERIFICATION.md](./P1_RELEASE_VERIFICATION.md).

### `@tapeci/release` (P1-08 cutover/rollback)

```ts
prepareVersionedRelease({ files, chainId, siteRegistry, container, repositoryId, commitSha,
                          entryPath?, fallbackPath?, pathPrefix? })
rewriteEntryReferences(...), verifyEntryReferences(html, manifest), collectEntryReferences(...)
new ReleaseStore(dir).save(...) / .load(releaseId) / .list()
switchEntryToRelease({ manifest, entryBytes, client, wallet, config, operators, pinnedBlock? })
rollbackToStoredRelease({ store, releaseId, client, wallet, config, operators, pinnedBlock? })
```

See [P1_ENTRY_CUTOVER.md](./P1_ENTRY_CUTOVER.md): one `putFile` transaction, assets verified
first, previous entry restored on failure, rollback refused when old assets are missing.

### `@tapeci/cli` (P1-09)

```bash
tapeci init | build | validate | plan | deploy | verify | rollback | releases
```

`runCli(argv)` is importable for tests/tooling; the `tapeci` bin wires it to `process.exitCode`.
See [P1_CLI.md](./P1_CLI.md) for options, signing model and exit codes.

## 3. Executed checks

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck        # PASS
corepack pnpm lint             # PASS
corepack pnpm test:unit        # PASS 266/266 (11 files)
corepack pnpm test:fork        # PASS 43/43 (6 files; journal, verification, cutover, CLI e2e)
corepack pnpm test:mainnet     # PASS 20/20 (read-only; includes live plan + release tests)
corepack pnpm tapeci -- --help
corepack pnpm verify:release --config <path> --commit <sha> --repository-id <id> --journal <file>
corepack pnpm plan --config <path> --commit <sha> --repository-id <id> --cap <wei>  # read-only plan
```

The fork suite was **not** re-run this round: P1-01..04 add offline packages only and changing
`docs/evidence/fork-*.json` would invalidate the P0 evidence hashes. Run
`corepack pnpm test:fork` when the deployer/chain packages change.

## 4. Decisions / deviations worth knowing

1. **Strict mode rejects external anchors too.** TapeKit SPEC §8 lists `href` in the static
   scan, so `<a href="https://…">` fails strict builds. This matches "100% on-chain" semantics;
   if navigation should be allowed, add an explicit policy switch rather than silently relaxing.
2. **Symlinked artifact roots are rejected.** Fail closed; the CLI should pass the resolved
   `realpath` of the build output directory.
3. **`fullyOnChain` is only claimed in strict mode** with zero references; non-strict scans
   report references and `fullyOnChain=false`.
4. **Manifest hashing is whitelisted.** `releaseManifestHash` rejects unknown fields including
   `plan`, `gas`, timestamps. Cost estimation and approval digests stay in P1-05/deployer.
5. **Config `entryPath` is literal `index.html`** because the cutover assumes a single
   root-entry replacement transaction.
6. **CI uses action version tags (`@v4`), not commit SHAs.** Pinning action SHAs is part of the
   P2 GitHub App guide; recorded as a residual risk in `docs/P1_CI.md`.
7. **CI was syntax-validated, not executed on GitHub.** The first push to a GitHub repository is
   the first real CI evidence; no fabricated run IDs.
8. **Planning never overwrites versioned assets.** A same-path/different-hash asset is a
   `CONFLICT`; only the root entry may be replaced (controlled cutover, written last in P1-08).
9. **Planning fails closed on disagreement.** The block hash, ERC-1967 implementations and every
   `fileInfo` must agree across operators; budget overflow and insufficient signer balance block
   the plan. `plan` never signs or sends.
10. **Execution is journaled and fail-closed.** Journal events are fsynced before broadcast;
    an unresolved sent transaction aborts a resume instead of guessing a nonce, and assets are
    always written before the controlled entry cutover.
11. **The manifest is the verification authority.** A chain declaration that agrees with the
    bytes is not enough if it disagrees with the approved manifest. A single-operator report is
    only possible with an explicit test-only flag; production reports require two operators.
12. **Cutover is entry-only and reversible.** Assets are verified before the single entry
    transaction; a failed post-check restores the previous entry, and a previous entry larger
    than one chunk is refused because it could not be restored atomically.
13. **CLI signing never touches the journal.** Mainnet keys come from `TAPECI_PRIVATE_KEY` in the
    environment only; local rehearsals use Anvil impersonation. `deploy` requires both a cost cap
    and `--yes`, and `build` executes project commands only on the operator's machine.

## 5. P1 complete — next steps

- **P2**: GitHub App + OIDC artifact ingest, PostgreSQL/Drizzle schema, BullMQ workers, console
  pages (PRD §12).
- **P0-07**: real X Layer small-value smoke test and a real published site — requires explicit
  user authorization and a fee budget; nothing in P1 authorizes mainnet writes.
- Follow-ups recorded in P1 docs: journal the standalone rollback, root-absolute CSS/JS rewriting,
  GitHub Action SHA pinning, event-based reconciliation.
