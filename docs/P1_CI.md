# P1-01 / P1-02 — CI workflows and `.tapeci.json`

Status: implemented (2026-10-19). All local static checks pass (`install
--frozen-lockfile`, `typecheck`, `lint`, `test:unit`, YAML validation). The GitHub
Actions workflows were **not executed on GitHub in this session**; they were validated
locally for YAML syntax and workflow structure only (§3).

Reference: `TapeCI_PRD_Technical_Design.md` §4.2 (GitHub Actions policy), §5.2
(single-transaction `index.html` switch), §11 (repo layout), §12 P1-01/P1-02, §13.1 (UT).

---

## 1. Workflows

### 1.1 `.github/workflows/ci.yml` — static CI (push + pull request)

| # | Step | Detail |
|---|---|---|
| 1 | `actions/checkout@v7` | `persist-credentials: false` — the job never pushes |
| 2 | `pnpm/action-setup@v6` | `version: 9.15.4` (matches root `packageManager`) |
| 3 | `actions/setup-node@v7` | Node `22`, `cache: pnpm` |
| 4 | `pnpm install --frozen-lockfile` | lockfile drift fails the build |
| 5 | `pnpm typecheck` | `tsc --noEmit`, TypeScript strict |
| 6 | `pnpm lint` | ESLint 9 flat config |
| 7 | `pnpm test:unit` | Vitest, offline (`tests/unit` only) |

- Triggers: every `push` and `pull_request`.
- `permissions: contents: read` (workflow-level, least privilege).
- `concurrency: ci-<workflow>-<ref>`, `cancel-in-progress: true`.
- `timeout-minutes: 15`.
- No secrets, no network calls, no Foundry install. Reproducible by construction:
  `--frozen-lockfile` + pinned Node/pnpm.

The Action references use version tags (`@v4`) as specified for this task. PRD §4.2
requires SHA-pinned actions for the *user-repo* workflow generated in P2; that is a P2
deliverable, not this internal CI file (see §5).

### 1.2 `.github/workflows/network.yml` — scheduled network suite

Triggers: **nightly schedule only** (`cron: "17 3 * * *"`) **+ `workflow_dispatch`**.
There is deliberately **no `pull_request` and no `push` trigger**: untrusted PR code
must not consume public X Layer RPC quota, inherit secrets, or start Anvil forks
(PRD §4.2/§7).

| Job | Timeout | What it does |
|---|---|---|
| `mainnet-read-only` | 20 min | checkout → pnpm 9.15.4 → Node 22 (pnpm cache) → `pnpm install --frozen-lockfile` → `pnpm test:mainnet` |
| `fork` | 30 min | checkout → `foundry-rs/foundry-toolchain@v1.9.1` (`version: v1.7.1`, the version recorded in `docs/evidence/`) → pnpm/Node setup → frozen install → `pnpm test:fork` |

- `permissions: contents: read`; `concurrency` with `cancel-in-progress: false` so a
  mid-flight read is not cancelled into a misleading failure.
- Optional `TAPECI_RPC_OKX` / `TAPECI_RPC_DRPC` repository secrets are passed through;
  when unset they expand to `""`, and `resolveRpcEndpoints` keeps the public defaults.
- Neither job sends a transaction. `test:mainnet` is read-only; `test:fork` runs a
  local Anvil fork of X Layer and never broadcasts.
- **Honest failure:** no `continue-on-error` at job or step level (asserted by the
  local validation in §2). A red nightly run is a real signal — public RPC outage,
  rate limit, or implementation drift — and must not be masked as green.

---

## 2. Local validation executed in this session

Environment:

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"
```

| Command | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | PASS — `Lockfile is up to date, resolution step is skipped` / `Already up to date` |
| `corepack pnpm typecheck` | PASS — no output (clean) |
| `corepack pnpm exec vitest run tests/unit/p1-config.test.ts` | PASS — 31/31 tests |
| `corepack pnpm test:unit` (repo-wide at handoff) | PASS — 5 files, 229/229 tests (31 are the new config tests) |
| `corepack pnpm exec eslint packages/config/src/project-config.ts tests/unit/p1-config.test.ts` | PASS — exit 0, no findings |
| `corepack pnpm lint` (repo-wide) | PASS — no findings |
| YAML syntax + structure validation (below) | PASS — `ALL LOCAL YAML CHECKS PASSED` |

### YAML validation command

`python3` with PyYAML 6.0.3 parses both workflows and asserts the security-relevant
structure (triggers, permissions, pinned versions, no `continue-on-error`). Saving this
as a file is unnecessary; it is reproduced here verbatim:

```bash
python3 - <<'PY'
import pathlib
import yaml

def load(path: str) -> dict:
    doc = yaml.safe_load(pathlib.Path(path).read_text(encoding="utf-8"))
    assert isinstance(doc, dict), f"{path}: top level must be a mapping"
    print(f"YAML syntax OK: {path}")
    return doc

def triggers(doc: dict) -> dict:
    # PyYAML implements YAML 1.1, where the bare key `on` loads as boolean True.
    # GitHub Actions uses YAML 1.2 (string "on"); accept either key.
    found = doc.get("on", doc.get(True))
    assert isinstance(found, dict), "workflow has no trigger mapping"
    return found

ci = load(".github/workflows/ci.yml")
net = load(".github/workflows/network.yml")

assert set(triggers(ci)) == {"push", "pull_request"}
assert ci["permissions"] == {"contents": "read"}
assert ci["concurrency"]["cancel-in-progress"] is True
static = ci["jobs"]["static"]
assert static["timeout-minutes"] == 15
steps = static["steps"]
uses = {s["uses"]: s.get("with") for s in steps if "uses" in s}
assert uses["actions/checkout@v7"]["persist-credentials"] is False
assert uses["pnpm/action-setup@v6"]["version"] == "9.15.4"
assert uses["actions/setup-node@v7"]["node-version"] == 22
assert uses["actions/setup-node@v7"]["cache"] == "pnpm"
runs = [s["run"] for s in steps if "run" in s]
for command in ("pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm test:unit"):
    assert command in runs, f"ci.yml missing step: {command}"
print("ci.yml OK: push/PR, contents:read, concurrency, timeout 15, Node 22, pnpm 9.15.4, cache pnpm, frozen install + typecheck + lint + test:unit")

assert set(triggers(net)) == {"schedule", "workflow_dispatch"}
assert triggers(net)["schedule"] == [{"cron": "17 3 * * *"}]
assert "pull_request" not in triggers(net) and "push" not in triggers(net)
assert net["permissions"] == {"contents": "read"}
assert net["concurrency"]["cancel-in-progress"] is False
assert set(net["jobs"]) == {"mainnet-read-only", "fork"}
mainnet_steps = net["jobs"]["mainnet-read-only"]["steps"]
fork_steps = net["jobs"]["fork"]["steps"]
assert "pnpm test:mainnet" in [s["run"] for s in mainnet_steps if "run" in s]
assert "pnpm test:fork" in [s["run"] for s in fork_steps if "run" in s]
foundry = [s for s in fork_steps if s.get("uses") == "foundry-rs/foundry-toolchain@v1"]
assert len(foundry) == 1 and foundry[0]["with"]["version"] == "v1.7.1"
assert net["jobs"]["mainnet-read-only"]["timeout-minutes"] == 20
assert net["jobs"]["fork"]["timeout-minutes"] == 30

def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)

assert "continue-on-error" not in set(walk(net)), "network.yml must not mask failures"
print("network.yml OK: schedule + workflow_dispatch only, Foundry v1.7.1, test:mainnet, test:fork, no continue-on-error")
print("ALL LOCAL YAML CHECKS PASSED")
PY
```

Output:

```text
YAML syntax OK: .github/workflows/ci.yml
YAML syntax OK: .github/workflows/network.yml
ci.yml OK: push/PR, contents:read, concurrency, timeout 15, Node 22, pnpm 9.15.4, cache pnpm, frozen install + typecheck + lint + test:unit
network.yml OK: schedule + workflow_dispatch only, Foundry v1.7.1, test:mainnet, test:fork, no continue-on-error
ALL LOCAL YAML CHECKS PASSED
```

Note: PyYAML is a YAML 1.1 parser, so the `on:` key loads as boolean `True`; the script
handles that explicitly. It does not change the fact that GitHub parses the file as
YAML 1.2 with the string key `on`.

---

## 3. What was NOT executed (explicit limitation)

**GitHub Actions were not executed on GitHub in this session.** No runner was started,
no run IDs or run URLs exist, and no `act`/Docker emulation was used. The workflows are
validated only as YAML plus the structural assertions above.

Therefore the following cannot be claimed as verified yet:

- that `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`, and
  `foundry-rs/foundry-toolchain@v1.9.1` resolve and behave as expected on a GitHub runner;
- that `setup-node`'s `cache: pnpm` actually restores the pnpm store;
- that `pnpm install --frozen-lockfile` is byte-identical on Linux/Node 22 (it was
  verified on this macOS/Node 24 host, which is not the CI environment);
- that the nightly `schedule` fires and the Fork job downloads Foundry v1.7.1;
- that `pnpm test:mainnet` / `pnpm test:fork` pass on a GitHub runner (they were
  exercised during P0 locally; they are network-dependent and subject to public RPC
  rate limits, which is exactly why scheduled failures are left visible and red).

First real evidence will be the first pushed run; record the run URL/ID in
`docs/evidence/` at that time.

---

## 4. `.tapeci.json` (P1-02)

The project config lives at the repository root as `.tapeci.json` and is parsed by
`packages/config/src/project-config.ts` (exported from `@tapeci/config`).

```json
{
  "schemaVersion": "tapeci.config.v1",
  "chainId": 196,
  "site": {
    "container": "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3"
  },
  "build": {
    "installCommand": "npm ci",
    "buildCommand": "npm run build",
    "outputDir": "dist",
    "timeoutSeconds": 900
  },
  "policy": {
    "strictOnChain": true,
    "maxFileBytes": 8400000,
    "ignore": ["assets/maps"]
  },
  "release": {
    "pathPrefix": "releases",
    "keepVersions": 5
  }
}
```

`build`, `policy`, `release`, `site.entryPath` and `site.fallbackPath` may be omitted;
their defaults are merged in and the loader always returns a fully populated object.
`schemaVersion`, `chainId`, `site.container` are required — there is no safe default for
`chainId`/`container`, and a wrong network must never be silently assumed.

### Defaults

| Field | Default | Notes |
|---|---|---|
| `schemaVersion` | — (required) | must be exactly `tapeci.config.v1` |
| `chainId` | — (required) | must be exactly `196` (X Layer) |
| `site.container` | — (required) | `0x` + 40 hex; normalized to lowercase |
| `site.entryPath` | `"index.html"` | literal only; single-transaction cutover (PRD §5.2) |
| `site.fallbackPath` | `"index.html"` | canonical relative path |
| `build.installCommand` | `"npm ci"` | 1–500 chars, non-blank, no NUL |
| `build.buildCommand` | `"npm run build"` | 1–500 chars, non-blank, no NUL |
| `build.outputDir` | `"dist"` | canonical relative directory |
| `build.timeoutSeconds` | `900` | integer 1–3600 |
| `policy.strictOnChain` | `true` | fail the build on off-chain references (P1-03) |
| `policy.maxFileBytes` | `8400000` | integer 1–8,400,000 (350 × 24,000 hard cap) |
| `policy.ignore` | `[]` | ≤ 100 canonical relative path prefixes/globs |
| `release.pathPrefix` | `"releases"` | canonical relative directory |
| `release.keepVersions` | `5` | integer 1–50; PRD §5.2 keeps ≥ 5 recoverable versions |

### Validation rules

- Strict objects at **every** level: unknown keys are rejected (typos fail loudly).
- `schemaVersion` must be `tapeci.config.v1`; `chainId` must be `196`.
- `site.container` must match `^0x[0-9a-fA-F]{40}$` and is **normalized to lowercase**.
- `site.entryPath` must be exactly `index.html` (the entry file is cut over in one
  transaction; any other value would break the PRD §5.2 safety model).
- `site.fallbackPath`, `build.outputDir`, `policy.ignore[]`, `release.pathPrefix` are
  canonical relative paths: NFC-normalized, `/` separators, no leading `/`, no Windows
  drive, no `.`/`..` segments, no control characters. Absolute/traversal paths are
  rejected, so a compromised config cannot escape the build output root.
- Numeric bounds as in the defaults table; integers only.
- Errors are `TapeCiError` with code `INVALID_CONFIG`; the message names every failing
  path and `details.issues` is `[{ "path": [...], "message": "..." }]`. `loadTapeCiConfig`
  additionally puts the file path in `details.filePath` and converts `ENOENT`, read
  errors and JSON syntax errors into `INVALID_CONFIG` (never a raw `SyntaxError`).

### API (`@tapeci/config`)

```ts
export const TAPECI_CONFIG_SCHEMA_VERSION = "tapeci.config.v1";
export interface TapeCiProjectConfig { /* shape above */ }
export type TapeCiConfigOverrides = { container: string; /* partial site/build/policy/release */ };
export const DEFAULT_TAPECI_CONFIG: Readonly<TapeCiProjectConfig>; // full defaults; container = "" (invalid)
export function parseTapeCiConfig(input: unknown): TapeCiProjectConfig;
export function loadTapeCiConfig(filePath: string): TapeCiProjectConfig;
export function createTapeCiConfig(overrides: TapeCiConfigOverrides): TapeCiProjectConfig;
```

`DEFAULT_TAPECI_CONFIG.site.container` is the empty string on purpose: there is no valid
default container address, and `parseTapeCiConfig(DEFAULT_TAPECI_CONFIG)` therefore
throws `INVALID_CONFIG`. P1-05 and later use `loadTapeCiConfig`/`parseTapeCiConfig`;
`createTapeCiConfig` is the `tapeci init` helper and validates the same way.

### Local validation method

```bash
# validate a project config file (prints the normalized, fully-populated config)
corepack pnpm exec tsx -e "import { loadTapeCiConfig } from '@tapeci/config'; \
  console.log(JSON.stringify(loadTapeCiConfig('.tapeci.json'), null, 2));"

# config unit tests (31 cases: defaults, every documented rejection, round-trip, I/O errors)
corepack pnpm exec vitest run tests/unit/p1-config.test.ts
```

---

## 5. Known deviations / residual risks

- Action references use tags (`@v4`), not commit SHAs, because P1-01 explicitly pins
  those action versions. SHA pinning of workflow actions for *user repositories* is a
  P2 requirement (PRD §4.2) and will be generated there.
- The workflows target `ubuntu-24.04`; if GitHub retires that image label the
  `runs-on` value must be updated.
- `network.yml` passes optional RPC override **secrets**. Until those secrets are
  configured, the jobs use the public endpoints from `packages/config`, which are
  rate-limited; a red nightly run may therefore indicate an RPC quota problem rather
  than a TapeCI bug. This is reported honestly, not masked.
- The nightly schedule only runs the default branch; `workflow_dispatch` allows a
  manual run on any branch (including a fork test branch) without touching PRs.

## 6. Repo-wide lint note

During this session `corepack pnpm lint` briefly failed on
`tests/fixtures/static-site/assets/app.js` created by the P1-03 work (`no-undef` for
`document`). That file and `eslint.config.js` are outside P1-01/P1-02's write scope, so it
was reported to the Lead and P1-03 owner; the fix (ignoring `tests/fixtures/**` in the
root ESLint config) landed outside this task. The final repo-wide lint result is PASS,
and the P1-01/P1-02 files themselves lint clean either way.
