# P0-03 — ABI selector validation against the live X Layer contracts

Status: **complete for the read-only scope of P0-03**.
All evidence below was captured in one read-only run at a single pinned block. No transaction
was signed or broadcast; the write-path checks are `eth_call` simulations whose state changes
the node discards.

| Item | Value |
|---|---|
| Chain | X Layer mainnet, chainId `196` |
| Pinned block | `73,623,480` |
| Pinned block hash | `0x28ff5575e7f7aaab1535ff3380cc639eb7a7a1f6a683c5d1d5306846e15fbb6e` |
| Pinned block time | `2026-10-19T06:48:36Z` |
| `observedAt` | `2026-10-19T06:48:40.206Z` |
| Source pin | TapeKit `40994bd65baedbda4df72cb0985031a5f082f606`, SPEC v0.2 (BNB-first) — see [`docs/evidence/sources.md`](./evidence/sources.md) |
| Machine-readable evidence | [`docs/evidence/chain-probe.json`](./evidence/chain-probe.json) |
| Probe CLI | [`scripts/probe/probe.ts`](../scripts/probe/probe.ts) (`corepack pnpm probe`) |
| Read-only tests | [`tests/mainnet/probe.test.ts`](../tests/mainnet/probe.test.ts) (`corepack pnpm test:mainnet`) |
| Operators | **OKX** (`rpc.xlayer.tech`) + **dRPC** (`xlayer.drpc.org`); every fact re-read at the same pinned block from both, plus both remaining configured endpoints |
| Cross-check result | `AGREED` — 27/27 facts identical across all four endpoints; implementation bytecode `keccak256` included |

Relevant live addresses (from `packages/config`, re-read from chain at the pin):

| Role | Proxy / address | ERC-1967 implementation | Proxy code | Implementation code |
|---|---|---|---|---|
| Factory | `0x1f09daefa827f02cbb40967cc91b259763760761` | `0x74956236ab64ed143933040b4137e8a352e4d17b` (allowlisted ✓) | 130 B | 7,671 B |
| SiteRegistry | `0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6` | `0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f` (allowlisted ✓) | 176 B | 14,377 B |
| DomainBinding | `0x68809fd2fb343aa57d0aeb7f33defe477c9666f9` | `0x5ebf29b80789e548907c707530c3c7607c4347df` (allowlisted ✓) | 176 B | 9,603 B |
| Opener (not a proxy) | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` | — | — | 2,604 B |

ERC-1967 slot: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.

## Methodology (and its limits)

1. **Recompute** every selector with `viem.toFunctionSelector` (keccak256 of the canonical
   signature, first 4 bytes) and compare with TapeKit's hardcoded read selectors
   (`kernel/src/selectors.js`). All 19 TapeKit-hardcoded selectors matched — see the
   `tapekitHardcodedMatches` block in `chain-probe.json` (all `matches: true`).
2. **Bytecode presence**: each `PUSH4 <selector>` constant is searched in the exact code of the
   *implementation* (not the proxy) at the pinned block. Presence is necessary but not
   sufficient — a 4-byte value can occur by chance in push data.
3. **Semantic read evidence**: every read signature is exercised with a real `eth_call` at the
   pinned block and its decoded return value is recorded (`readCalls` in the JSON).
4. **Semantic write evidence**: each write signature is `eth_call`-simulated twice — once from
   the current container holder (expected to execute) and once from a non-editor address
   (expected to be rejected by `onlyEditor`). A revert with empty data is the baseline for an
   *unrecognised* selector, so a named custom error is evidence that the selector was decoded
   and dispatched.
5. **Not proven here**: that a write actually mutates state, costs the estimated gas, emits the
   documented events, or can be recovered after an interrupted transaction. That is P0-04/P0-05
   (Anvil fork transactions) and P0-07 (real mainnet smoke test, explicit authorization only).

**Normative-source caveat:** TapeKit `SPEC.md` v0.2 is BNB-first; its Appendix B.5 is normative
prose for the write ABI, and TapeKit's reference kernel implements **only reads**. Therefore
"X Layer matches the SPEC" for `putFile`/`appendChunk`/`removeFile`/`setFallback`/`setOperator`
is not inherited from TapeKit — it is established in this document from the deployed X Layer
bytecode and its live `eth_call` behaviour.

---

## 1. Selector table — SiteRegistry (implementation `0xa85c4143…ea45f`, 14,377 B)

Container used: `0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3` (site `2.2.0.tape`, processor 0,
tokenId 2). Path: `index.html`.

| # | Function | Canonical signature | Recomputed selector | TapeKit hardcoded | In X Layer impl bytecode | Semantic evidence (live `eth_call` at pin) |
|---|---|---|---|---|---|---|
| 1 | `fileInfo` | `fileInfo(address,string)` | `0x6c609107` | `0x6c609107` ✓ | **yes** | raw tuple decodes: size `26993`, contentType `text/html; charset=utf-8`, sha256 `0xe0f2…00f0`, updatedAt `1791624483`, chunkCount `2` |
| 2 | `read` | `read(address,string)` | `0xccaa7afb` | `0xccaa7afb` ✓ | **yes** | returns `26,993` bytes; SHA-256 matches declared hash (below) |
| 3 | `readRange` | `readRange(address,string,uint256,uint256)` | `0x15a4cae2` | `0x15a4cae2` ✓ | **yes** | `readRange(0,16)` = `0x3c21646f63747970652068746d6c3e0a` = first 16 bytes of `read`; `readRange(size,16)` = `0x` |
| 4 | `pathCount` | `pathCount(address)` | `0xb554782b` | `0xb554782b` ✓ | **yes** | `1` |
| 5 | `pathsRange` | `pathsRange(address,uint256,uint256)` | `0xb056072c` | `0xb056072c` ✓ | **yes** | not exercised directly; `paths()` returned the same one-entry list |
| 6 | `paths` | `paths(address)` | `0x599e4610` | — | **yes** | `["index.html"]` |
| 7 | `fallbackPath` | `fallbackPath(address)` | `0xa76c7713` | `0xa76c7713` ✓ | **yes** | `"index.html"` |
| 8 | `isOpenedContainer` | `isOpenedContainer(address)` | `0x8951bab2` | — | **yes** | `true` |
| 9 | `CHUNK_MAX` | `CHUNK_MAX()` | `0x9a8a305f` | — | **yes** | `24000` (matches SPEC §B.5) |
| 10 | `putFile` | `putFile(address,string,string,bytes32,bytes)` | `0xfab2ed82` | — | **yes** | simulation: accepted from holder; `NotOwner()` from non-editor; `TooLarge()` at 24,001 bytes |
| 11 | `appendChunk` | `appendChunk(address,string,uint256,bytes)` | `0xe2b51347` | — | **yes** | simulation: accepted with `expectIndex == chunkCount`; `BadIndex()` for stale/future index; `NoSuchFile()` for missing file; `TooLarge()` at 24,001 bytes |
| 12 | `removeFile` | `removeFile(address,string)` | `0x0a9c1871` | — | **yes** | simulation: `NoSuchFile()` from holder for an absent path; `NotOwner()` from non-editor |
| 13 | `setFallback` | `setFallback(address,string)` | `0x4dc21ad0` | — | **yes** | simulation: accepted from holder; `NotOwner()` from non-editor |
| 14 | `setOperator` | `setOperator(address,address,uint256)` | `0xc88cb026` | — | **yes** | simulation: accepted from holder; `NotOwner()` from non-editor |

## 2. Selector table — factory / opener / DomainBinding / account contracts

Factory implementation `0x74956236…4d17b` (7,671 B):

| Function | Signature | Selector | In factory impl bytecode | Semantic evidence at pin |
|---|---|---|---|---|
| `cpuCount` | `cpuCount()` | `0xa94da8a7` (TapeKit ✓) | **yes** | `369` |
| `cpuAt` | `cpuAt(uint256)` | `0x4bc7cbbd` (TapeKit ✓) | **yes** | `cpuAt(0)` = `0x839bdD6fa7A66416A609A735e11DE5411B98574e` |
| `cpus` | `cpus(uint256)` | `0xd2c26963` | **yes** | not exercised (alias of `cpuAt`; `cpuAt` is the documented accessor) |
| `isCPU` | `isCPU(address)` | `0x5f5a364f` (TapeKit ✓) | **yes** | `isCPU(0x839b…)` = `true` |
| `isSealed` | `isSealed()` | `0x631f9852` | **yes** | `false` → the protocol is still upgradeable; TapeCI must fail closed on implementation drift |

Opener `0x536add8f…50106` (2,604 B, not a proxy):

| Function | Signature | Selector | In opener bytecode | Semantic evidence at pin |
|---|---|---|---|---|
| `accountOf` | `accountOf(address,uint256)` | `0x0c1905e5` (TapeKit ✓) | **yes** | `accountOf(processor,2)` = `0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3` |
| `isOpened` | `isOpened(address,uint256)` | `0x8b508494` (TapeKit ✓) | **yes** | `true` |
| `isDeployed` | `isDeployed(address,uint256)` | `0xf13906b8` | **yes** | `true` |
| `open` | `open(address,uint256)` | `0x0a0e5c9d` | **yes** | not exercised (paid write path; covered by P0-04) |
| `FEE` | `FEE()` | `0xc57981b5` | **yes** | `80,000,000,000,000,000` wei = 0.08 OKB |

DomainBinding implementation `0x5ebf29b8…347df` (9,603 B):

| Function | Signature | Selector | In binding impl bytecode | Semantic evidence at pin |
|---|---|---|---|---|
| `isLive` | `isLive(string,address)` | `0xd6b062cd` (TapeKit ✓) | **yes** | `isLive("2.2.0.tape", container)` = `true` |
| `isContainerLive` | `isContainerLive(address)` | `0xdcca979e` (TapeKit ✓) | **yes** | `true` |
| `paidUntil` | `paidUntil(bytes32,address)` | `0x2110540f` (TapeKit ✓) | **yes** | `paidUntil(keccak256("2.2.0.tape"), container)` = `1822674611` (`2027-10-04T18:30:11Z`) |
| `containerPaidUntil` | `containerPaidUntil(address)` | `0x9ebfd859` (TapeKit ✓) | **yes** | `2102926150` (`2036-08-21T10:09:10Z`) |
| `monthlyFee` | `monthlyFee()` | `0x8cfd3e40` (TapeKit ✓) | **yes** | `0` wei at this block |

Account contracts (bytecode-level selector presence is **not** asserted — these are small
delegate proxies, 173 B and 295 B respectively; the semantic call is the evidence):

| Contract | Function | Selector | Evidence at pin |
|---|---|---|---|
| Container `0x25B20D3e…F6b3` | `token()` | `0xfc0c546a` | raw return decodes to `(196, 0x839b…574e, 2)` — i.e. `(chainId, processor, tokenId)` |
| Container `0x25B20D3e…F6b3` | `owner()` | `0x8da5cb5b` | `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` (same as `processor.ownerOf(2)`) |
| Processor `0x839bdD6f…574e` | `ownerOf(uint256)` | `0x6352211e` (TapeKit ✓) | `0x571d447f4f24688eC35Ccf07f1D6993655F6aF15` |

## 3. Raw `fileInfo` tuple and the SHA-256 check

`fileInfo(0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3, "index.html")` calldata
(`0x6c609107` + ABI args):

```text
0x6c609107
  00000000000000000000000025b20d3ea6b207506340eab2eb0f45edc800f6b3   container
  0000000000000000000000000000000000000000000000000000000000000040   offset to path
  000000000000000000000000000000000000000000000000000000000000000a   path length (10)
  696e6465782e68746d6c00000000000000000000000000000000000000000000   "index.html"
```

Raw return at block `73,623,480` (verbatim, from `chain-probe.json` → `readCalls.siteRegistry.fileInfoRaw`):

```text
0x
0000000000000000000000000000000000000000000000000000000000006971   word 0: size       = 0x6971 = 26,993
00000000000000000000000000000000000000000000000000000000000000a0   word 1: offset     = 0xa0 = 160
e0f21c08c2ad09d3818d39c802153d33b6931311300d7419228d98da0a8300f0   word 2: sha256Hash = 0xe0f2…00f0
0000000000000000000000000000000000000000000000000000000006aca0523   word 3: updatedAt  = 0x6aca0523 = 1,791,624,483 (2026-10-10T09:28:03Z)
0000000000000000000000000000000000000000000000000000000000000002   word 4: chunkCount = 2
0000000000000000000000000000000000000000000000000000000000000018   word 5 @0xa0: contentType length = 24
746578742f68746d6c3b20636861727365743d7574662d38…                "text/html; charset=utf-8"
```

Decoded tuple (viem, using the `siteRegistryAbi` transcribed from SPEC §B.5):

```json
{
  "size": 26993,
  "contentType": "text/html; charset=utf-8",
  "sha256": "0xe0f21c08c2ad09d3818d39c802153d33b6931311300d7419228d98da0a8300f0",
  "updatedAt": 1791624483,
  "chunkCount": 2
}
```

**Hash check (raw SHA-256 of the bytes, not Keccak-256):**

1. `read(container, "index.html")` via `eth_call` at the pinned block → 26,993 bytes
   (`readRange(0,16)` returns the same first 16 bytes; `readRange(size,16)` returns empty).
2. SHA-256 computed in Node over those exact bytes
   (`sha256Hex` in `packages/shared`) =
   `0xe0f21c08c2ad09d3818d39c802153d33b6931311300d7419228d98da0a8300f0`.
3. Equals the declared `fileInfo.sha256`, equals the bytes read independently through dRPC at
   the same block, and equals the observation captured in `packages/config`
   (`OBSERVED_XLAYER_SITE.sha256`, size 26,993, chunkCount 2).
4. `chunkCount * CHUNK_MAX` bound holds: `ceil(26993 / 24000) = 2`.

This is the only "hash proof" the chain supports: **the deployed contract does not recompute or
enforce** `sha256Hash`/`size` against the stored bytes — it stores them as declared metadata.
TapeCI must therefore always read the bytes back and hash them client-side (as done here).

## 4. Write ABI semantic evidence (`eth_call` simulations, nothing broadcast)

Method: `eth_call({from, to: SiteRegistry proxy, data})` at the pinned block. The proxy
delegates to the implementation, so revert payloads come from the live X Layer logic.
`msg.sender` was the current container holder
(`0x571d447f4f24688eC35Ccf07f1D6993655F6aF15`, `container.owner()` = `processor.ownerOf(2)`)
for positive cases and `0x000000000000000000000000000000000000bEEF` for negative cases.

Custom errors were identified by recomputing `keccak256` of candidate signatures with viem and
matching the observed 4-byte payload. The names are **inferred** (no published X Layer ABI);
the selectors themselves are exact:

| Observed revert data | Recomputed signature | Meaning in context |
|---|---|---|
| `0x30cd7471` | `NotOwner()` | the `onlyEditor` guard: caller is neither the holder nor a live operator |
| `0xef3ff4ae` | `BadIndex()` | `appendChunk.expectIndex` != current `chunkCount` (stale or future) |
| `0x2a9df442` | `NoSuchFile()` | path has no chunk 0 (`appendChunk`/`removeFile` on an absent path) |
| `0x218e0a07` | `TooLarge()` | chunk payload > `CHUNK_MAX` (24,000 bytes) |

Baseline discriminating check: an unknown selector `0xdeadbeef` reverts with **empty** data, so
the named errors above prove the selector was recognised and executed, not that the contract
has some catch-all fallback.

| # | Function | From | Simulation args | Expected | Observed at block 73,623,480 |
|---|---|---|---|---|---|
| 1 | `putFile` | non-editor | container, `probe/p0-03-abi.txt`, `text/plain`, sha256(`0x00`), `0x00` | reject | `NotOwner()` (`0x30cd7471`) |
| 2 | `appendChunk` | non-editor | container, `index.html`, `expectIndex=2`, `0x00` | reject | `NotOwner()` |
| 3 | `removeFile` | non-editor | container, `probe/p0-03-abi.txt` | reject | `NotOwner()` |
| 4 | `setFallback` | non-editor | container, `index.html` | reject | `NotOwner()` |
| 5 | `setOperator` | non-editor | container, `0x…bEEF`, `ttl=3600` | reject | `NotOwner()` |
| 6 | `putFile` | holder | 1-byte file on an unused path | accept | accepted (`0x`), no revert |
| 7 | `putFile` | holder | **exactly 24,000 bytes** (sha256 of those bytes) | accept | accepted (`0x`) |
| 8 | `putFile` | holder | 24,001 bytes | reject | `TooLarge()` (`0x218e0a07`) |
| 9 | `appendChunk` | holder | `index.html`, `expectIndex = chunkCount = 2`, `0x00` | accept | accepted (`0x`) |
| 10 | `appendChunk` | holder | `index.html`, `expectIndex = 1` (stale) | reject | `BadIndex()` (`0xef3ff4ae`) |
| 11 | `appendChunk` | holder | `index.html`, `expectIndex = 3` (future) | reject | `BadIndex()` (`0xef3ff4ae`) |
| 12 | `appendChunk` | holder | path with no chunk 0 (`probe/p0-03-abi.txt`) | reject | `NoSuchFile()` (`0x2a9df442`) |
| 13 | `appendChunk` | holder | `index.html`, valid index, 24,001 bytes | reject | `TooLarge()` (`0x218e0a07`) |
| 14 | `removeFile` | holder | absent path | reject | `NoSuchFile()` (`0x2a9df442`) |
| 15 | `setFallback` | holder | `index.html` | accept | accepted (`0x`) |
| 16 | `setOperator` | holder | `0x…bEEF`, `ttl=3600` | accept | accepted (`0x`) |
| 17 | `putFile` | holder | path `../escape.txt` (1-byte file) | — | **accepted** (`0x`): the contract does **not** canonicalize or reject `..`; path safety is a client duty (SPEC §6) |
| 18 | unknown `0xdeadbeef` | non-editor | — | reject | revert with **empty** data (baseline) |

Read-only `eth_estimateGas` from the holder at the pinned block (estimate, not a receipt):

| Call | Estimated gas | Note |
|---|---|---|
| `putFile` (1-byte file, new path) | `296,698` | first chunk also creates the chunk contract |
| `appendChunk` (`expectIndex=2`, 1 byte) | `166,903` | appends a 1-byte chunk |
| `setFallback` | `96,242` | storage write only |
| `setOperator` | `103,601` | storage write only |

What these simulations establish for the SPEC §B.5 write table:

- **Signatures decode**: all five write selectors are present in the implementation and route
  to real logic (named custom errors), not into a fallback.
- **`onlyEditor` semantics are real**: every write function rejects a non-editor with
  `NotOwner()`, and the current holder passes the same call. This matches SPEC §B.5
  ("`onlyEditor`: the holder or an operator set with `setOperator`").
- **`appendChunk.expectIndex` is the duplicate-append guard**: the call only executes when
  `expectIndex == fileInfo.chunkCount`, otherwise `BadIndex()`. This matches SPEC §B.5 and is
  the on-chain defence against replaying the same chunk.
- **`CHUNK_MAX = 24,000` is enforced by code**, not just by the spec: 24,000 bytes is accepted,
  24,001 reverts `TooLarge()`.
- **`putFile` replaces chunk 0** is stated by SPEC but is **not** proven by a single simulation
  (it needs a before/after state transition — P0-05).
- **`removeFile`/`setFallback`/`setOperator` execute for the holder**, but their state effects
  (file disappears from `pathCount`/`paths`, fallback changes, operator becomes effective for
  `ttl` seconds) need transactions — P0-05/P0-07.

## 5. UNVERIFIED until P0-04 / P0-05 / P0-07

> **Updated at the P0 gate:** items 1, 2, 4 and 6 below were subsequently resolved by actual
> Anvil-fork transactions; see §7 for the evidence and for the items that remain open.

The following items are explicitly **not** proven by this read-only evidence, and must not be
reported as verified:

1. **Actual state mutation and receipts** for all five write functions — requires Anvil-fork
   transactions (P0-04/P0-05) and, for real funds, an explicitly authorized mainnet smoke test
   (P0-07).
2. **Gas actually consumed** (vs `eth_estimateGas`) and the real fee cost of a multi-chunk file.
3. **Events**: `FileSet`/`FileRemoved`/`FallbackSet`/`OperatorSet` topics, ordering, and
   `updatedAt` values after a write (topics are recomputed in `tests/unit/selectors.test.ts`;
   emission is not yet observed).
4. **Interrupted-upload recovery**: whether a partially written file can be read back and
   resumed without duplicate `appendChunk` (SPEC §6; PRD P0-05) — the `expectIndex` guard was
   observed, but crash/recovery behaviour is a transaction-level property.
5. **`putFile` replacement semantics** for an existing path, `removeFile` effect on reads, and
   `setOperator` TTL expiry / revocation.
6. **`onlyEditor` operator branch**: the holder branch and the non-editor rejection are
   observed; a *valid, unexpired operator* is not part of this fixture, so the operator branch
   is unexercised until P0-04.
7. **Storage layout and upgrade compatibility**: no storage slots beyond the ERC-1967 slot were
   inspected; `isSealed() = false` means the implementation can change, and the ABI evidence is
   valid only for the pinned implementation above.
8. **Entry-file atomicity / single-transaction switch**: PRD §5.2's `index.html` ≤ 24,000-byte
   strategy is not proven on X Layer here; it needs the P0-05 upload matrix.
9. **TapeKit end-to-end compatibility**: TapeKit's kernel is read-only, so a green TapeKit
   render requires P0-06 (done separately) and a real site (P0-07) for write-to-UI coverage.

## 6. Reproduce

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

# Full probe at a fresh pin (writes docs/evidence/chain-probe.json)
corepack pnpm probe

# Re-read the exact snapshot used by this document (bypasses the 300-block freshness gate)
corepack pnpm probe --block 73623480 --allow-stale

# Offline: recompute all selectors and check TapeKit's hardcoded values
corepack pnpm test:unit

# Read-only mainnet: chainId, allowlisted implementations, selector presence,
# live fileInfo/read hash, two-operator agreement, write-selector dispatch
corepack pnpm test:mainnet
```

Evidence mapping:

| Claim | Evidence in `chain-probe.json` |
|---|---|
| Selector recomputation / TapeKit match | `selectors.recomputed`, `selectors.tapekitHardcodedMatches` |
| Bytecode presence | `selectors.presence.{siteRegistryImplementation,factoryImplementation,opener,domainBindingImplementation}` |
| Implementation slots + allowlist | `implementations`, `chainProbe.implementations` |
| Bytecode identity (`keccak256`) | `code`, and `crossCheck.facts[id^="codeKeccak"]` |
| Read return shapes | `readCalls`, `chainProbe.contracts` |
| Raw fileInfo + SHA-256 check | `readCalls.siteRegistry.fileInfoRaw`, `liveSite` |
| Write simulations + revert selectors + gas estimates | `writeSimulations` |
| Two-operator agreement | `crossCheck` (27 facts, `status: "AGREED"`) |

## 7. Confirmed by P0-04 / P0-05 fork transactions (added at the P0 gate)

The read-only evidence above was completed by two Anvil forks of X Layer 196. This section
records which §5 items are now resolved, and which remain open. Evidence:
[`fork-authorization.json`](./evidence/fork-authorization.json) (12/12 checks) and
[`fork-upload.json`](./evidence/fork-upload.json) (9/9 checks).

| §5 item | Status | Fork evidence |
|---|---|---|
| 1. Actual state mutation + receipts for writes | **Resolved for `putFile`/`appendChunk`/`setOperator`** | 1/24,000/24,001/65,000-byte uploads with successful tx hashes; `setOperator` grant/revoke/expiry transactions |
| 2. Real gas consumed (vs estimate) | **Measured — the simulated estimate is not a fee quote** | 24,000-byte `putFile` = **5,490,912 gas** on the fork (each chunk deploys code); the `writeSimulations.gasEstimates` values (296,698 for a 1-byte payload) exclude data-dependent chunk cost |
| 3. Events (`FileSet`, `OperatorSet`, …) | **Still UNVERIFIED** | receipts exist, but event topics/ordering were not decoded or asserted; do not use events for reconciliation until P1 adds a decoded-event test |
| 4. Interrupted-upload recovery | **Resolved for the pinned implementation** | `read()` returns the partially written 24,000-byte prefix; `uploadFile` appended only indices `[1,2]` (no duplicate `putFile`), final SHA-256 matched; `RECOVERY_REQUIRES_RESTART = false` |
| 5. `putFile` replacement of an existing path / `removeFile` effects | **Still UNVERIFIED** | uploads used fresh paths; replacing a live `index.html` and `removeFile` are not exercised |
| 6. `onlyEditor` operator branch + TTL | **Resolved** | holder and live operator write; random EOA, revoked operator, and TTL-expired operator all revert `0x30cd7471` (`NotOwner()`) with unchanged state |
| 7. Storage layout / upgrade compatibility | **Still UNVERIFIED** | no storage slots beyond ERC-1967 inspected; `isSealed() == false` means an upgrade can change behaviour — fail closed on slot drift |
| 8. Entry-file single-transaction switch | **Still UNVERIFIED** | requires replacing a real `index.html` at ≤24,000 bytes; scheduled for P1-08 / P0-07 |

Additional fork-measured facts:

- `appendChunk` with a consumed or out-of-range `expectIndex` reverts `0xef3ff4ae`
  (`BadIndex`), and the on-chain file bytes/chunk count are unchanged afterwards.
- The contract does **not** validate the declared `sha256Hash`/size and does **not** reject
  `..` path segments (`eth_call` accepted `putFile("../escape.txt")`). Client-side
  canonicalization and read-back hashing are therefore mandatory, not defensive extras.
- `setOperator(container, op, 0)` revoked the operator (until = current timestamp) on the
  pinned implementation.

**Evidence correction:** `chain-probe.json` was written before a `probeChain()` tidy-up, so
its `chainProbe.contracts.siteRegistry.codeSize` is the implementation size (14,377 B) while
the factory/binding entries are proxy sizes. The `code` section of that JSON is authoritative
per address; re-running `corepack pnpm probe` now reports the proxy size plus
`implementationCodeSize`.
