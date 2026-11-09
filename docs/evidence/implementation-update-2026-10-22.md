# X Layer factory implementation update — 2026-10-22 freeze

TapeKit's `kernel/src/config.js` `XLAYER_MAINNET.factorySeal.implementation` changed on the
2026-10-22 processor freeze:

- previous: `0x74956236ab64ed143933040b4137e8a352e4d17b` (2026-09-19)
- current:  `0xb41c1e7602eb5734be2430b72178ccb814a5293d` (2026-10-22)

Read-only confirmation (2026-10-24, `rpc.xlayer.tech`, ERC-1967 slot
`0x360894…2bbc`):

| proxy | implementation | code bytes |
|---|---|---|
| factory `0x1f09…0761` | `0xb41c1e7602eb5734be2430b72178ccb814a5293d` | 15,470 |
| SiteRegistry `0xd6ef…adb6` | `0xa85c4143d1d4a77f54b8e4ecc9e6d1418afea45f` | 28,756 |
| DomainBinding `0x6880…66f9` | `0x5ebf29b80789e548907c707530c3c7607c4347df` | 19,208 |

TapeCI now allowlists both factory implementations. SiteRegistry and DomainBinding are unchanged.
This is a fail-closed read change only; no transaction was sent.
