# @tapeci/compression

Offline Stage A analyzer for static TapeOut artifacts. It does not change the
production publisher, execute application scripts, query chain state or send transactions.

From the repository root:

```bash
corepack pnpm --filter @tapeci/compression analyze \
  --input /absolute/path/to/dist --output /tmp/compression-first

corepack pnpm --filter @tapeci/compression analyze \
  --input /absolute/path/to/new-dist --output /tmp/compression-next \
  --previous /tmp/compression-first/report.json
```

Output must be a new directory with an existing parent and outside the input tree.
The input must remain immutable during analysis. Strict external-reference checks
are enabled by default; `--allow-external` explicitly relaxes them. `--entry` selects
a non-default entry file.

Each candidate directory contains its canonical `index.json` and actual binary
`objects/`. `report.json` is written last, after all candidate bytes have passed
bounded decode and integrity verification. An incomplete directory without a report
is not a completed analysis; use a new output directory for retries.

Strategies: original, gzip-individual, gzip-whole, gzip-grouped. The current group
policy is intentionally coarse: HTML/CSS, JS/MJS and other files. Compression that
would increase a unit's bytes falls back to explicitly labeled identity storage.
Identical physical objects are deduplicated. Oversized stored objects make that
candidate unavailable rather than silently omitting source files.

`original` is a content reference in the same experimental analysis representation;
it is not the existing publisher's exact physical plan. All strategies include an
analysis index. Its size is measured; production loader, gateway operations and final
Manifest overhead are not. `payloadChunks` excludes index/entry/loader operations.
History reuse is local comparison only, not verified current chain state.

The format `tapeci.pack-index.v1` is experimental. `candidateId` hashes the canonical
index bytes, which transitively reference stored object hashes and logical file
hashes. `decodeCandidate` checks integrity and bounds but does not authenticate an
unsigned index; the future publisher must anchor it in the approved Manifest.

Limits: 4,096 logical files, 64 MiB logical decoded bytes, 8,400,000 bytes per source
file/stored object. CLI metadata preflight enforces source budgets before reading
contents. Browser memory and runtime compatibility have not been qualified.

Run tests from this package:

```bash
corepack pnpm test
```

Full design and milestone gates:
[development specification](../../docs/superpowers/specs/2026-10-28-compression-development-spec.md).

## Experimental browser resolver and local preview (Stage B)

The browser entry point is `@tapeci/compression/browser`. It contains no Node codec,
filesystem or server runtime. `createBrowserPack` accepts exact index bytes, an
independently obtained expected index hash, and an object-response loader. It verifies
the index/source metadata and checks stored and decoded hashes before returning any
requested file. It supports native gzip plus identity, bounds stream output, coalesces
concurrent object requests, and permits a fresh verified attempt after a failed load.
No fallback decoder or CDN script is injected; native gzip absence is unsupported.

`servePackRequest` is an integration hook for a gateway that already owns routing and
policy. It serves original logical paths/MIME, directory indexes, GET/HEAD and opt-in
navigation-only extensionless SPA fallback. Missing assets remain 404, including encoded
extensions. The host gateway must retain reserved path dispatch and apply its own CSP,
chain verification, approved index pin and lifecycle rules. This is **not** an installed
TapeKit integration or production publication support.

Preview an existing candidate on a fresh loopback origin:

```bash
corepack pnpm --filter @tapeci/compression preview \
  --candidate /tmp/compression-first/gzip-grouped \
  --index-hash 0x...64_hex_characters... \
  --spa-fallback true
```

Use the candidateId from the independently retained analysis report as the local pin;
do not derive a production trust pin from an untrusted fetched index. Preview prints a
local URL and measured minified runtime bytes. It requires the locally installed Bun
CLI to bundle the browser module. It binds only 127.0.0.1, reserves `/__tapeci_preview/`,
and registers its prototype worker only on that newly allocated origin. Its `/` scope
preserves unchanged application root-relative URLs. Never install this worker on a live
TapeKit origin. The preview has a strict local CSP, not a complete copy of TapeKit policy.

Run browser tests from packages/compression:

```bash
corepack pnpm test:browser --project chromium
corepack pnpm test:browser
```

The chromium project uses installed Google Chrome. Firefox and WebKit require the
matching Playwright runtimes. The normal fixtures test CSS/font/image, lazy import,
fetch, Worker, WASM, deep-route refresh and corrupt index/object rejection. Optional
`TAPECI_COMPRESSION_REAL_DIST` supplies the historical CircuitGuard Vite fixture
(commit 9f9d8f1) for a static UI smoke; external requests are blocked in that test.
It does not exercise wallet signing, live API behavior or transactions.

## TapeKit source integration and physical releases (Stage C1)

`openPackedSite` wraps a single same-snapshot TapeKit site handle. Ordinary sites
pass through unchanged. A recognized `index.html` descriptor must be verified by the
original reader; it commits to `tapeci-packs/<index-hash>.json`, which commits to
physical objects and logical source files. Missing physical files must be present in
manifest.pathSet and return the exact requested path, never the upstream fallback.
The wrapper rechecks bytes, sizes and hashes. No-hash files cannot satisfy compressed
trust dependencies. Native RPC/Kernel errors retain their identity for gateway handling.

Only `get` is virtualized. Manifest, info, prefetch and other original members remain
physical storage views; other kernel consumers require their own explicit integration.
Logical MIME follows TapeKit's sanitizer and decoded HTML/CSS continues through the
original gateway purity scanner and CSP/response function. Additional compression proof
fields identify the entry, pack index and object supporting a logical file.

Create a separate source overlay from the exact supported official commit:

```bash
node --import tsx scripts/compression/tapekit-overlay-cli.ts \
  --source /absolute/path/to/pinned-TapeKit \
  --output /tmp/new-tapekit-compression-overlay
```

Run this command from the TapeCI repository root. The source HEAD must be
`37c617e7e332787c8a32a81e4d7d05a28a06c156`. The tool checks source hashes, exports only
tracked committed files, patches both gateway modes and build/dev-server routing,
bundles the adapter with MIT notices, syntax-checks patched scripts and builds
`dist/gateway`. It writes `tapeci-overlay.json` last as the completion record.
It does not modify the input checkout or install/deploy anything. Existing output and
source/output overlap are rejected. Use a new output directory after a failed run.

`prepareCompressedRelease` from `@tapeci/release` produces exact physical files,
Manifest v1, entry bytes, source digest and physical digest without RPC access. Its
release ID is derived from final physical bytes; fallback/encoding changes produce a
new identity. It requires logical index.html and rejects gateway-reserved sw.js/.tape/
source paths. It does not change the API worker or enable automatic publication.

Additional local source tests, from packages/compression:

```bash
TAPECI_TAPEKIT_SOURCE=/absolute/path/to/pinned-TapeKit \
../../node_modules/.bin/vitest run --root ../.. tests/compression-tapekit/overlay.test.ts

TAPECI_TAPEKIT_SOURCE=/absolute/path/to/pinned-TapeKit \
corepack pnpm test:browser
```

These test actual source modules against local physical fixtures. They do not attest
independent live RPC operators, installed gateway behavior or mainnet transaction fees.

## Approved artifact persistence (Stage C2)

The API Worker can prepare original or explicitly configured gzip releases, freeze their
exact physical bytes in a content-addressed tar, and reuse that snapshot through
planning, execution, verification, reapproval and rollback. Missing/corrupt snapshots
fail without source rebuild. Migration 0020 adds nullable `preparation_request` and
`prepared_artifact_key`; apply it through the normal deployment migration workflow
before running the updated Worker on persistent data.

Original mode stays the default. No public compression control is exposed. Compressed
requests require an operator-provided matching `compressionGateways` runtime profile;
the default list is empty. Profile configuration does not prove live gateway support.
Nonzero gateway service fees are blocked pending explicit approval support.
`compareReleaseCosts` reports complete same-context model estimates, with automatic
selection fixed to original until production simulation and gateway gates are met.

See `docs/research/compression/stage-c2-2026-10-28.md` for fresh PostgreSQL/fork evidence,
reproduction commands and remaining production gates. No live gateway or mainnet
compression deployment is enabled by these changes.

## Explicit selection and approval review (Stage C3)

C3 supersedes the historical C2 note about the missing public control. Deployment
Overview now displays recorded preparation strategy/snapshot identity and offers
maintainers an explicit strategy-plan form. A selection creates a separate BUILT
deployment from retained raw build bytes, queues planning only, and requires a new
plan/signature. Existing approvals and frozen artifacts are never changed by selection.

Set `TAPECI_COMPRESSION_GATEWAYS_JSON` identically in API and Worker to opt into
operator-configured target profiles. Absent configuration keeps gzip choices disabled;
original remains default. Configuration is not independent proof of live compatibility.
Only zero-service-fee profiles are selectable. New plans require a preapproval source,
current project target and retained raw archive; matching retries recover the same
attempt without bypassing current requeue permissions.

See `docs/research/compression/stage-c3-2026-10-28.md` for the REST contract, configuration
format, exact tests, screenshots and production gates. No mainnet deployment is enabled
automatically and no byte-only savings figure is presented as a gas quote.

## Actual fork costs and TapeKit chain reads (Stage C4)

`node --import tsx scripts/compression/fork-measurement-cli.ts --source PINNED_TAPEKIT --output NEW_JSON`
starts an independent local Anvil fork, restores identical initial state for original
and all gzip strategies, publishes complete physical releases and records unique
successful receipts. The actual pinned TapeKit chain kernel reads each release at its
postpublication block; the built adapter verifies logical bytes and native response
MIME/hash/security/cache headers. No reader or RPC is mocked.

This is direct fixture-container/quorum1 local validation, not deployed HTTP/Cloudflare,
paid-name, independent-operator or mainnet validation. Actual mined fees and measured
gas normalized to a common quote price are separate. Setup and L2-specific fees are
excluded. Automatic selection remains original. See the C4 report/evidence for the
four-strategy measured fixture and remaining production gates.
