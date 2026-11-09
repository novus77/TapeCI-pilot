# P0-01 — TapeKit source pin and X Layer configuration snapshot

Status: **complete for P0-01** (source pin + configuration snapshot), with the on-chain half
re-verified by `docs/evidence/chain-probe.json` (P0-02) and `docs/abi-validation.md` (P0-03).
Read-only work only: no transaction was signed or broadcast, no secret was used.

- Evidence collector: [`scripts/probe/probe.ts`](../../scripts/probe/probe.ts)
- Machine-readable chain evidence: [`docs/evidence/chain-probe.json`](./chain-probe.json)
- ABI report: [`docs/abi-validation.md`](../abi-validation.md)
- Read-only tests: [`tests/mainnet/probe.test.ts`](../../tests/mainnet/probe.test.ts)

---

## 1. Pinned TapeKit source

| Field | Value |
|---|---|
| Repository | <https://github.com/TapeOutProtocol/TapeKit> |
| Git remote observed in clone | `origin https://github.com/TapeOutProtocol/TapeKit.git` |
| Pinned commit | `40994bd65baedbda4df72cb0985031a5f082f606` |
| Commit date (`%cI`) | `2026-10-11T11:08:10+04:00` |
| Commit author date (`%aI`) | `2026-10-11T11:08:10+04:00` |
| Commit subject | `App 内置浏览器也能打开链上网站：装不上 Service Worker 就换服务端读链那一档` |
| Clone used for inspection | `/tmp/TapeKit_inspect` (scratch, not committed to this repo) |
| Clone date (filesystem birth of `.git`) | `2026-10-19T14:36:44+08:00` = `2026-10-19T06:36:44Z` |
| Working tree at inspection | clean (`git status --porcelain` empty) |
| Normative spec | `SPEC.md`, **"On-Chain Website Specification v0.2 (Draft)"**, status draft v0.2, 2026-09-13 |
| Spec's declared chain | BNB Smart Chain mainnet (chainId 56) — **the normative text is BNB-first** |
| Multichain config | `kernel/src/config.js` (`XLAYER_MAINNET`, `L2_CONTRACTS`) |
| Reference kernel selectors | `kernel/src/selectors.js` (`SIG` / `SEL`) — **read selectors only** |

### Pinned file hashes (SHA-256 of the file bytes at the pinned commit)

| File | SHA-256 |
|---|---|
| `SPEC.md` | `a3f03c377551601b11e769d8273b26902a2b38367071ea7a6c1edf3a486f8778` |
| `kernel/src/config.js` | `2c374b1a3e28d2fe615e8f94a3ebd428d17564bb91036dfedfab04030691ee9c` |
| `kernel/src/selectors.js` | `0b798418fb9eb29aad0d0be7caa01bca0439bc61fa833ac9c1f4c41155527ede` |
| `README.md` | `ece7d4e6261ab45b6830947585f8a53e21279b2d2a6c75c454c1de8f0101a274` |

These hashes are what make the pin checkable without trusting the clone path. A different
`config.js`/`SPEC.md` hash means the source moved and the X Layer snapshot below must be
re-derived.

### Reference points inside the pinned commit

| Reference | Location | What it establishes |
|---|---|---|
| SPEC Appendix B.5 | `SPEC.md` §B.5, lines 403–431 | `SiteRegistry` read table, write table, `onlyEditor` rule, events, `CHUNK_MAX = 24,000`, 350 chunks / 8,400,000 bytes |
| SPEC Appendix B.1–B.4/B.6 | `SPEC.md` lines 371–448 | factory/opener/processor/container/DomainBinding interfaces |
| X Layer addresses | `kernel/src/config.js` lines 76–126 | `L2_CONTRACTS`, `XLAYER_MAINNET`, RPC list, per-URL operator and batch limits |
| Factory seal pin | `kernel/src/config.js` lines 85–89 | `factorySeal.implementation = 0x74956236…` |
| Read selectors | `kernel/src/selectors.js` lines 4–47 | 19 read signatures and their 4-byte selectors (recomputed and matched — see `docs/abi-validation.md`) |

**Important pin boundary:** the TapeKit reference kernel only **reads** the chain. There is no
TapeKit implementation of `putFile` / `appendChunk` / `removeFile` / `setFallback` /
`setOperator`; those five signatures exist only as normative prose in SPEC Appendix B.5. The
X Layer write ABI is therefore established separately in P0-03 by live bytecode and
`eth_call` behaviour, and remains subject to the fork transaction tests of P0-04/P0-05.

---

## 2. X Layer configuration snapshot (TapeKit config at the pinned commit)

All values below are copied from `kernel/src/config.js` at
`40994bd65baedbda4df72cb0985031a5f082f606`, then re-read from X Layer at pinned block
`73,623,480` by `corepack pnpm probe`.

| Field | TapeKit config value | config.js line | On-chain re-read at block 73,623,480 |
|---|---|---|---|
| Chain ID | `196` | 102 | `eth_chainId` = `196` on all four configured endpoints |
| Name / key | `X Layer` / `xlayer` | 103–104 | n/a (label) |
| Native currency | `OKB` | 105 | n/a (label) |
| Area code | `2` (names like `2.2.0.tape`) | 106 | n/a (naming rule, not a contract value) |
| Factory | `0x1f09daefa827f02cbb40967cc91b259763760761` | 77 | code present, 130-byte proxy |
| Opener | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` | 78 | code present, 2,604-byte contract, **not a proxy** |
| SiteRegistry (registries[0]) | `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` | 79 | code present, 176-byte proxy |
| DomainBinding | `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` | 80 | code present, 176-byte proxy |
| Factory implementation (`factorySeal.implementation`) | `0x74956236ab64ed143933040b4137e8a352e4d17b` | 86 | ERC-1967 slot = `0x74956236ab64ed143933040b4137e8a352e4d17b`; allowlisted ✓ |
| SiteRegistry known implementation | `0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f` | 82 | ERC-1967 slot = `0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f`; allowlisted ✓ |
| DomainBinding known implementation | `0x5ebf29b80789e548907c707530c3c7607c4347df` | 83 | ERC-1967 slot = `0x5ebf29b80789e548907c707530c3c7607c4347df`; allowlisted ✓ |
| ERC-1967 implementation slot | `IMPL_SLOT` in spec §4.3 / kernel | config.js 8 | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| Pin policy | `pin: 'latest'`, `finality: 'safe'`, `maxPinLagBlocks: 300`, `maxBlockAgeSeconds: 300` | 96–98, 103 | probe pins `min(operator head) − 2` = 73,623,480; lag 2 blocks (within 300) |
| RPCs | 4 URLs (2× OKX, 1× dRPC, 1× thirdweb) | 113–118 | all four answered at the pin; only **2 independent operators** |
| `CHUNK_MAX` (spec constant) | `24,000` bytes per chunk; 350 chunks ⇒ 8,400,000 bytes | SPEC §B.5 line 431 | `CHUNK_MAX()` on SiteRegistry returns `24000` ✓ |
| Container/site used as live fixture | `2.2.0.tape`, container `0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3` | `OBSERVED_XLAYER_SITE` in `packages/config` | `opener.accountOf(cpuAt(0), 2)` = that container; `fileInfo("index.html")` decodes; `read` bytes hash to declared SHA-256 ✓ |

Contract-level values at the pin (recorded in `chain-probe.json` → `chainProbe`, `readCalls`):

| Value | Observation at block 73,623,480 |
|---|---|
| `factory.cpuCount()` | `369` (append-only; the Lead's earlier observation of 368 is consistent with a newer processor having been added) |
| `factory.isSealed()` | `false` — protocol contracts are still upgradeable; fail closed on implementation drift |
| `factory.deployFee()` | `6,600,000,000,000,000` wei = 0.0066 OKB |
| `factory.protocolFee()` | `660,000,000,000,000` wei = 0.00066 OKB |
| `opener.FEE()` | `80,000,000,000,000,000` wei = 0.08 OKB |
| `DomainBinding.monthlyFee()` | `0` wei at this block |
| `eth_gasPrice` (not pinned) | `20,000,001` wei |
| SiteRegistry proxy code | 176 bytes; implementation code 14,377 bytes |
| factory proxy code | 130 bytes; implementation code 7,671 bytes |
| DomainBinding proxy code | 176 bytes; implementation code 9,603 bytes |
| Opener code | 2,604 bytes (plain contract, no ERC-1967 slot read) |

Bytecode hashes (`keccak256` of the exact code returned at the pinned block) are recorded in
`chain-probe.json` → `code` and are re-read from both operators in the cross-check facts, so a
silent implementation swap at the same address is detectable.

Reading the probe JSON: `pin.pinnedBlock` is the authoritative snapshot; the nested
`chainProbe` object is the verbatim `probeChain()` return value (useful for auditing the shared
helper). Two quirks of that helper are worth knowing: `chainProbe.latestBlock` is the head at
call time, not the pin, and `chainProbe.contracts.*.codeSize` mixes proxy and implementation
sizes (`contracts.siteRegistry.codeSize` is the *implementation* size). The unambiguous
per-address sizes are in `code` (with `kind: proxy | implementation | contract`).

---

## 3. RPC operator mapping

TapeKit treats endpoints by **operator**, not by domain: several URLs of the same operator
count as one vote. The mapping below is the pinned `config.js` `rpcLimits`, and the observed
head is what our probe saw during the evidence run (all four answered at 73,623,482).

| Endpoint | Operator vote | `maxBatch` | `callerKeys` | Observed head | Role in this evidence |
|---|---|---|---|---|---|
| `https://rpc.xlayer.tech` | `okx` | 10 | no | 73,623,482 | **primary**: `probeChain()`, raw calls, write simulations |
| `https://xlayerrpc.okx.com` | `okx` | 10 | no | 73,623,482 | same-operator cross-check (not an extra vote) |
| `https://xlayer.drpc.org` | `drpc` | 3 | yes | 73,623,482 | **independent second operator** for every asserted fact |
| `https://196.rpc.thirdweb.com` | `okx` | 10 | yes | 73,623,482 | same-operator cross-check; TapeKit counts thirdweb as OKX (it answers like OKX) |

Consequence: TapeCI may claim "two independent operators agreed" only for **OKX + dRPC**.
thirdweb and the second OKX domain are corroboration of the OKX vote, never a second vote.
The probe records every endpoint's value per fact and computes agreement per operator
(`chain-probe.json` → `crossCheck`), so a same-operator disagreement would also be visible.

Environment overrides supported by `packages/config`: `TAPECI_RPC_OKX`, `TAPECI_RPC_DRPC`
(after override the operator labels stay the same; the override is a trust decision for the
operator).

---

## 4. Reproduce

```bash
# 1. Source pin (network access required once)
git clone https://github.com/TapeOutProtocol/TapeKit.git /tmp/TapeKit_inspect
git -C /tmp/TapeKit_inspect checkout 40994bd65baedbda4df72cb0985031a5f082f606
git -C /tmp/TapeKit_inspect log -1 --format='%H %cI'
git -C /tmp/TapeKit_inspect status --porcelain        # expect empty
shasum -a 256 /tmp/TapeKit_inspect/SPEC.md \
              /tmp/TapeKit_inspect/kernel/src/config.js \
              /tmp/TapeKit_inspect/kernel/src/selectors.js
# hashes must equal section 1 above

# 2. Toolchain
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"
corepack pnpm install

# 3. Read-only chain probe (pins min(head over operators) - 2, writes docs/evidence/chain-probe.json)
corepack pnpm probe

# 4. Re-read the exact snapshot captured in chain-probe.json (must bypass the 300-block freshness gate)
corepack pnpm probe --block 73623480 --allow-stale

# 5. Read-only mainnet test suite (chainId, implementations, selectors, live fileInfo/read hash, 2 operators)
corepack pnpm test:mainnet

# 6. Offline selector recomputation tests
corepack pnpm test:unit
```

Expected probe summary at the captured run (all values also in `chain-probe.json`):

```text
pinned block 73623480 (mode=latest, lag=2, stale=false)
chainId=196 cpuCount=369 isSealed=false
implementations: factory=0x7495…4d17b allowlisted=true | siteRegistry=0xa85c…ea45f allowlisted=true | domainBinding=0x5eBF…347Df allowlisted=true
fees: gasPriceWei=20000001 openFeeWei=80000000000000000 monthlyFeeWei=0 deployFeeWei=6600000000000000
CHUNK_MAX=24000
siteRegistry selectors missing (of 14): none; missing writes: none
fileInfo index.html: size=26993 type=text/html; charset=utf-8 chunkCount=2
read(index.html) 26993 bytes sha256=0xe0f21c08c2ad09d3818d39c802153d33b6931311300d7419228d98da0a8300f0 matchesDeclared=true
write simulations: 6 accepted, 11 reverted (eth_call only)
cross-operator: AGREED over operators okx + drpc
evidence written to …/docs/evidence/chain-probe.json
```

Recorded snapshot: `observedAt = 2026-10-19T06:48:40.206Z`, pinned block
`73,623,480` = `2026-10-19T06:48:36Z`, block hash
`0x28ff5575e7f7aaab1535ff3380cc639eb7a7a1f6a683c5d1d5306846e15fbb6e`, 27 cross-check
facts agreed across all four endpoints. A second run with `--block 73623480 --allow-stale`
(lag 222 blocks at that time, still under the 300-block gate) reproduced the same pinned
block, implementations, fees, `fileInfo` tuple, byte-for-byte read hash and 27/27 agreed
cross-check facts, so the snapshot is re-readable while the public RPCs retain the block.

---

## 5. Evidence limitations (P0-01 scope)

1. **The normative spec is BNB-first.** `SPEC.md` v0.2 declares chainId 56 as its chain;
   X Layer 196 is configured in `kernel/src/config.js` but is not the subject of the normative
   text. Byte values, fees and ABI behaviour cited here are for X Layer and were verified
   against X Layer, not inferred from BNB.
2. **The TapeKit kernel has no write implementation.** Only read selectors are hardcoded in
   `kernel/src/selectors.js`. The five write signatures are SPEC Appendix B.5 prose only, so
   "TapeKit compatibility" for writes cannot be demonstrated by running TapeKit; it must be
   established from the live contract (P0-03 bytecode + `eth_call`) and from fork transactions
   (P0-04/P0-05).
3. **Pins are checkable, the clone location is not authoritative.** `/tmp/TapeKit_inspect` is
   scratch state; the authoritative pin is the commit plus the file hashes in section 1.
4. **The on-chain snapshot is not final.** X Layer is an L2; the pin is a consistent snapshot,
   not finality. `factory.isSealed() = false` means the three proxies can be upgraded, and
   every TapeCI run must re-read the ERC-1967 slot and fail closed on drift (it does:
   `assertImplementationsAllowlisted` / `checkAllImplementations`).
5. **Operator identity is a TapeKit assertion, not an independently proven fact.** We can read
   the same data from four endpoints, but "okx" vs "drpc" labelling (and thirdweb proxying
   OKX) comes from TapeKit's 2026-09-19 observations in `config.js` lines 109–112. TapeCI's
   verifier treats the labels as configured and demonstrates agreement, not corporate
   independence.
6. **Public RPC limits.** dRPC caps JSON-RPC batches at 3 and may throttle; the probe reads
   facts in groups of three and records per-endpoint failures, so a missing endpoint cannot
   silently shrink the quorum. `gasPriceWei` is an `eth_gasPrice` call at probe time, not
   pinned to the block.
7. **The capture is a moment in time.** The live site fixture (`index.html`) is mutable by its
   holder; the read-only test suite compares the chain to the declared on-chain hash and to
   the captured observation, so it fails closed if the holder changes the file later.
