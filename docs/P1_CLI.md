# P1-09 — end-to-end CLI

**Date:** 2026-10-19 · **Scope:** CLI wiring of P1-01…P1-08. Builds run locally; deploy/rollback
verified on an Anvil fork. **No mainnet writes.**
**Code:** [`packages/cli`](../packages/cli) (`tapeci` bin + `runCli`).
**Tests:** [`tests/unit/p1-cli.test.ts`](../tests/unit/p1-cli.test.ts) (6),
[`tests/fork/cli.test.ts`](../tests/fork/cli.test.ts) (1 end-to-end).
**Evidence log:** [`docs/evidence/logs/p1-cli.log`](./evidence/logs/p1-cli.log).

---

## 1. Commands

| Command | What it does | Exit |
|---|---|---|
| `tapeci init --container 0x…` | writes a validated `.tapeci.json` (defaults for build/policy/release) | 0 |
| `tapeci build` | git HEAD check → install/build commands → scan the output | 0 / 1 build failed |
| `tapeci validate` | offline static scan against the config policy | 0 / 2 |
| `tapeci plan` | read-only diff/chunks/gas/cost/budget plan | 0 ready / 1 blocked |
| `tapeci deploy` | prepare versioned release → plan → journaled execute → store → verify | 0 / 1 |
| `tapeci verify` | verify a release (chain bytes + optional journal) | 0 / 1 |
| `tapeci rollback --release <id>` | verify old assets, then single-transaction entry restore | 0 / 1 |
| `tapeci releases` | list the local release store | 0 |

Global options: `--config`, `--dist`, `--json`, `--help`; release options: `--commit`,
`--repository-id`; plan/deploy: `--cap`, `--signer`, `--out`, `--report-out`; storage:
`--journal`, `--journal-dir`, `--store`.

## 2. End-to-end example

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

# 1. project config
corepack pnpm tapeci -- init --container 0xYourContainer

# 2. build + scan
corepack pnpm tapeci -- build

# 3. review plan (read-only, two operators)
corepack pnpm tapeci -- plan \
  --commit <40-hex> --repository-id <id> --cap 50000000000000000

# 4. deploy (journaled; requires explicit --yes and cap)
TAPECI_PRIVATE_KEY=... corepack pnpm tapeci -- deploy \
  --commit <40-hex> --repository-id <id> --cap 50000000000000000 --yes

# 5. verify (journal makes the write/cutover order checkable)
corepack pnpm tapeci -- verify --commit <40-hex> --repository-id <id> \
  --journal .tapeci/journal/dep-….jsonl

# 6. roll back to an earlier stored release
corepack pnpm tapeci -- rollback --release r-… 
```

Local fork rehearsal (impersonation, no key):

```bash
corepack pnpm tapeci -- deploy --fork-url http://127.0.0.1:8545 \
  --signer 0xExistingHolder --commit <sha> --repository-id 1 \
  --cap 1000000000000000000 --yes
```

## 3. Signing and safety

- Mainnet signing reads `TAPECI_PRIVATE_KEY` **from the environment only**; it is never logged,
  stored, or written into a journal. Use a low-balance, dedicated operator wallet.
- `--fork-url` + `--signer <address>` uses Anvil impersonation; it is only meaningful on a local
  fork (Anvil is started with `--auto-impersonate` by the test harness).
- `deploy` refuses to run without an explicit `--cap` and `--yes`.
- `plan`/`deploy` fail closed on implementation drift, operator disagreement, conflicts,
  budget overflow and insufficient balance.
- `build` executes the project's configured install/build commands **on the local machine**.
  Never point it at an untrusted repository/PR in CI; PR builds belong to the P2 GitHub App
  isolation design.
- `verify`/`rollback` read two independent operators by default; `--fork-url` allows one
  operator only for a local rehearsal and records the single-operator warning.

## 4. End-to-end fork evidence

`tests/fork/cli.test.ts` runs the real CLI through the full lifecycle on one Anvil fork:

1. deploy release **A** (3 files, 3 transactions, journal + store + verification report) → exit 0,
   `releaseMatch=true`;
2. deploy release **B** with different content → exit 0, entry hash changes;
3. `tapeci verify` for B with its journal → exit 0; the report shows journal complete, entry
   written last and `releaseMatch=true`;
4. `tapeci releases` lists both releases;
5. `tapeci rollback --release A` → exit 0, one transaction, entry hash returns to A;
6. The store's stored entry hash for A equals the on-chain entry after rollback.

## 5. Limitations / carry-forward

- `deploy` is fully journaled (assets first, entry last). `rollback`/standalone cutover remain a
  single direct `putFile` and are **not** journaled yet; the transaction is still verified by
  read-back. P2 can wrap rollback in the same journal.
- `build` requires a git repository unless `--no-commit-check`; it has no sandboxing (local CLI
  only). The P2 GitHub App runner is the isolated execution path.
- No GitHub App, database, queue, or web console yet (P2); release history is a local directory.
- Mainnet deploy remains gated by P0-07 (explicit budget authorization) and has not been run.
