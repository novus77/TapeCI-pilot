# P0 Decision — TapeCI on X Layer 196

**Date:** 2026-10-19
**Scope executed:** P0-01 … P0-06 (P0-07 deliberately **not** executed)
**Source baseline:** TapeKit `40994bd65baedbda4df72cb0985031a5f082f606` (2026-10-11)
**Repository state:** Node 22+ / pnpm 9.15.4 / TypeScript strict / viem 2.57.7 / Vitest 3.2.7 / Anvil 1.7.1

---

## 1. Decision

### GO for P1

P1 (local CLI + deploy engine, no real-money writes) may start. The X Layer write path is real,
dispatchable, and behaves as the delivery package expects on a local fork:

- all candidate proxy implementations are on TapeKit's allowlist;
- the five write selectors exist and are enforced by the deployed `SiteRegistry`;
- 24,000-byte chunk semantics, the `expectIndex` replay guard, and interrupted-upload resume
  were proven with actual fork transactions;
- a live X Layer site was verified byte-for-byte through two independent RPC operators at one
  pinned block, and independently confirmed by TapeKit's own kernel.

### NO-GO for real publishing (P0-07 / mainnet) until explicitly authorized

TapeCI has **not** published a site to X Layer mainnet, has not spent real funds, and has no
user-approved fee cap. The live site used in P0-06 is a third-party site, not a TapeCI release.
P0-07 remains a hard gate with the conditions in §6.

---

## 2. Evidence matrix

| Task | Deliverable | Result |
|---|---|---|
| P0-01 | [`docs/evidence/sources.md`](./evidence/sources.md) | **PASS** — TapeKit commit, commit date, clone date, file SHA-256s, X Layer config snapshot, operator mapping, reproduce commands |
| P0-02 | [`docs/evidence/chain-probe.json`](./evidence/chain-probe.json) | **PASS** — chainId 196 at pinned block `73,623,480`; three proxies' ERC-1967 implementations match the allowlist; `cpuCount=369`; `isSealed=false`; `CHUNK_MAX=24000`; 27/27 facts identical across OKX + dRPC + two same-operator endpoints |
| P0-03 | [`docs/abi-validation.md`](./abi-validation.md) | **PASS** — all 14 `SiteRegistry` selectors (9 read + 5 write) present in implementation bytecode; all 19 TapeKit selectors recompute-match; live `fileInfo`/`read`/`readRange` shapes; write dispatch proven by `NotOwner()` vs unknown-selector baseline; custom errors `NotOwner 0x30cd7471`, `BadIndex 0xef3ff4ae`, `NoSuchFile 0x2a9df442`, `TooLarge 0x218e0a07` |
| P0-04 | [`docs/evidence/fork-authorization.json`](./evidence/fork-authorization.json) | **PASS 12/12** — container opened on fork (processor 0, token #3, container `0x5f71…2628`); holder writes succeed; random EOA, revoked operator, TTL-expired operator all revert `0x30cd7471` with unchanged state; TTL honouring observed |
| P0-05 | [`docs/evidence/fork-upload.json`](./evidence/fork-upload.json) | **PASS 9/9** — chunk counts 1/1/2/3 for 1/24,000/24,001/65,000 B; read-back raw SHA-256 + size match at a fixed block; duplicate and future `expectIndex` revert `0xef3ff4ae` with bytes unchanged; interrupted 50,000 B upload resumed without duplicate appends; 8,400,001 B rejected before any tx |
| P0-06 | [`docs/evidence/verification-evidence.json`](./evidence/verification-evidence.json) | **VERIFIED** at pinned block `73,623,612` (OKX head 73,623,614 = dRPC head 73,623,614); `index.html` 26,993 B, declared = actual SHA-256 `0xe0f21c…00f0`; implementations allowlisted at the pin; TapeKit kernel `40994bd6…` independently resolved `2.2.0.tape` → same container/hash |
| P0-07 | — | **NOT RUN** — requires explicit user authorization and a fee cap |

### Executed acceptance commands

Full log: [`docs/evidence/logs/final-checks.log`](./evidence/logs/final-checks.log)

| Command | Result |
|---|---|
| `corepack pnpm typecheck` | **PASS** (exit 0) |
| `corepack pnpm lint` | **PASS** (exit 0) |
| `corepack pnpm test` | **PASS 77/77 tests, 6 files** (unit + read-only mainnet + fork) |
| `corepack pnpm test:fork` | **PASS 38/38** (2 files, ~61 s; regenerates both fork evidence JSONs) |
| `corepack pnpm test:mainnet` | **PASS 16/16** (probe + verifier, read-only) |
| `corepack pnpm probe` | **PASS** (exit 0, cross-operator `AGREED`) |
| `corepack pnpm verify` | **PASS** (exit 0, status `VERIFIED`, evidence written) |
| `node scripts/verify/tapekit-kernel-crosscheck.mjs` | **PASS** (independent TapeKit kernel read) |

Fork evidence pins (last regenerated run): P0-04 fork block `73,623,950`; P0-05 fork block
`73,623,918`, fixed read block `73,623,926`. Both JSONs record block hash, timestamp, RPC source
and per-transaction hashes.

---

## 3. What was actually confirmed on X Layer

1. **Contract identity / upgrade posture.** Factory proxy `0x1f09…0761` → impl `0x7495…d17b`;
   `SiteRegistry` proxy `0xd6ef…adb6` → impl `0xa85c…a45f`; `DomainBinding` proxy
   `0x6880…66f9` → impl `0x5ebf…47df`; `Opener` `0x536a…0106` is not a proxy. All three
   implementations are on TapeKit's published allowlist. `isSealed() = false`: the protocol is
   still upgradeable, so every deployment must re-read the ERC-1967 slot and fail closed.
2. **Write authorization is enforced on chain** (`onlyEditor`): the current circuit holder and a
   non-expired `setOperator` delegate may write; everyone else reverts `NotOwner()`. A successful
   transaction receipt is still not sufficient — reads at a pinned block are required.
3. **Chunk model.** `CHUNK_MAX = 24,000` is enforced in code (24,001 B reverts `TooLarge()`).
   Chunk counts: 1 B → 1, 24,000 B → 1, 24,001 B → 2, 65,000 B → 3. `appendChunk` rejects a
   consumed (`expectIndex < chunkCount`) or future (`expectIndex > chunkCount`) index with
   `BadIndex()`, so a retried transaction cannot append the same chunk twice.
4. **Recovery.** For the pinned implementation, `read()` returns the bytes already written for
   a partially written path. The deploy engine's prefix reconciliation resumed a 50,000 B file
   by appending only indices `[1,2]`, with no duplicate `putFile` and no duplicate appends.
   `RECOVERY_REQUIRES_RESTART` is therefore **false for this implementation**; the code must
   still detect implementation drift and fall back to restart if a future upgrade changes this.
5. **Verification.** A live site was read at one pinned block from two independent operators
   (OKX and dRPC). Both returned identical `fileInfo` and identical bytes; size and raw SHA-256
   matched the chain declaration. A third-party read through TapeKit's reference kernel returned
   the same container and hash.
6. **Fees/limits are dynamic.** `Opener.FEE()` was 0.08 OKB; `DomainBinding.monthlyFee()` was
   `0` at the probe block (do not hard-code it); `factory.deployFee()` 0.0066 OKB; gas price
   ~0.02 gwei. **Gas is data-dependent**: a 24,000-byte `putFile` consumed 5,490,912 gas on the
   fork, while a 1-byte payload estimated 296,698. Any fee quote must estimate with the real
   chunk payload, not a fixed per-call number.

---

## 4. Security-relevant findings (carry into P1)

1. **The chain does not validate content hashes or sizes.** `putFile` accepted a declared
   SHA-256/size that did not match the data. Client-side read-back hashing is the only integrity
   control; never trust a receipt or the declared hash alone.
2. **The chain does not canonicalize paths.** `putFile` accepted `"../escape.txt"`. All paths
   must be canonicalized before submission (NFC, percent-decode, reject `.`/`..`, strip
   query/fragment) — implemented in `packages/shared/src/path.ts`.
3. **RPC disagreement must stay fail-closed.** The verifier requires exactly two operator votes
   and rejects on any byte/field disagreement; there is no majority vote. X Layer has only two
   independent operators (OKX and dRPC); thirdweb's node is counted as OKX and is never a second
   vote.
4. **Upgradeability is live.** `isSealed=false`; allowlist matching is the only guard. A slot
   change must abort uploads (`IMPLEMENTATION_CHANGED`), and the allowlist is a TapeKit
   publication, not an independent audit.
5. **No key material exists in this repository.** All fork writes used Anvil impersonation of
   an existing holder. The production Operator design (KMS, TTL, fee cap, approval binding) is
   still P1/P2 work.

---

## 5. Remaining unverified facts and known risks

| Item | Status / impact |
|---|---|
| P0-07 mainnet publication | **Not run.** No real x Layer transaction, no real user site, no fee spend. Hard blocker for "LIVE". |
| `removeFile` effect on reads | Not exercised. Not required for the MVP deploy path; deletion remains out of scope. |
| `putFile` replacement of an existing live entry | Not exercised (uploads used fresh paths). Required before P1-08 entry switching; must be tested on fork. |
| Event decoding (`FileSet`, `OperatorSet`) | Not asserted. Do not use events for reconciliation until P1 adds decoded-event tests. |
| Mainnet gas | Fork gas is an upper-bound rehearsal; mainnet gas price/base fee may differ. Fee caps must use live `eth_estimateGas` with real payloads. |
| `chain-probe.json` registry `codeSize` | Historical field semantics (implementation size) documented in `docs/abi-validation.md` §7; `code` section is authoritative. Fixed in `probeChain()` after the artifact was generated. |
| `packages/deployer` client generics | Under `exactOptionalPropertyTypes`, the bare `PublicClient`/`WalletClient` types reject the fork client without a cast; fork tests use a documented cast. **P1 action:** type the upload options against the concrete viem generics. |
| RPC rate limits | dRPC caps batches at 3; OKX may rate-limit. The verifier reports `INCOMPLETE` rather than guessing; a retry/backoff policy is P1 work. |

---

## 6. Conditions to start real publishing (P0-07)

All of the following must be true, and the user must explicitly authorize the spend and a fee cap:

1. P1 deploy engine complete: journal/nonce lock, approval digest binding, dry-run plan, resume,
   and the entry-switch path tested on fork (`putFile` replacement of `index.html`).
2. Implementation allowlist and all fees re-read live at the exact deployment block; abort on
   `IMPLEMENTATION_CHANGED`.
3. Two independent operators agree on the pre- and post-write pinned reads.
4. A test container owned by the user, with an Operator whose TTL and fee cap are shown and
   approved; no main-wallet key handled by TapeCI.
5. An explicit OKB budget (opener fee + gas × chunks + buffer), recorded as
   `approved_cost_cap_wei`, with a small first upload (≤ 24,000 B) before a full site.
6. Evidence receipt: tx hashes, block numbers, both operators, byte-level verification report,
   and a reproducible access path (viewer/gateway) — without calling it "cryptographically
   provable" or "deployed" before the pinned read matches.

---

## 7. How to reproduce

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"
corepack pnpm install
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test            # unit + read-only mainnet + Anvil fork
corepack pnpm probe           # P0-01/02/03 evidence
corepack pnpm verify          # P0-06 evidence
corepack pnpm fork:authorization
corepack pnpm fork:upload
```

Read-only source pin: `https://github.com/TapeOutProtocol/TapeKit` at
`40994bd65baedbda4df72cb0985031a5f082f606`. Anvil forks use the public X Layer RPC only for
state; no mainnet transaction is ever sent by these commands.
