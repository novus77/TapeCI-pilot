# P2-10 mainnet RC — authorization packet

TapeCI has **not** written to X Layer mainnet. Every mainnet write stays blocked until the
operator (the repository owner) fills in and signs this packet. This file is a template, not an
authorization record.

## 1. Required inputs

| Input | Value | Notes |
|---|---|---|
| Budget tier | A / B / C | A canary **0.001 OKB**, B recommended **0.05 OKB** (cap 0.015), C large **0.2 OKB** (cap 0.06); see `P2-10_BUDGET.md` |
| Target container | `0x…` | Must be opened by its holder; TapeCI cannot open or transfer it |
| Owner / approval signer | `0x…` | Current on-chain owner; signs the EIP-712 approval |
| Operator wallet | `0x…` | Key stays in the operator secret manager, never in TapeCI |
| Execution window | start / end (UTC) | No writes outside the window |
| Queue attempts policy | default / explicit | Failed writes stop the deployment; retries never double-append chunks |
| Rollback target | release id or "current" | Must exist and be verified |

## 2. Preflight (read-only, no signature)

```bash
# chain-level only (no container yet)
pnpm preflight:p2 -- --budget-tier A

# full container + signer preflight (read-only; never signs/sends)
pnpm preflight:p2 -- --container 0x... --budget-tier A --signer 0x...
```

The script reports chainId, gas price, `Opener.FEE()`, container owner/opened/derivation and the
signer balance. `Opener.FEE()` is currently **0.08 OKB**; tier A (0.001 OKB) can only be used with
an **already-opened** container. Opening a new container requires at least the fee plus gas, so use
tier B/C or an existing container.

### Where does the container address come from?

A container is a TapeOut on-chain object created by `Opener.open(processor, tokenId)` by the
processor NFT holder. Build the exact transaction with your own wallet:

```bash
pnpm container:open-calldata -- --processor-index 0 --token-id <id>
```

It prints `{to, data, valueWei, valueOkb, owner}` for the holder to send; it never signs or sends.
 If you already have a TapeOut site/container, its address is in the TapeOut
console or the `Opened`/`accountOf` event. If you do not, you must hold a processor NFT and pay the
opener fee; TapeCI cannot create or transfer a container.

Run before asking for the write window and attach the output:

```bash
pnpm probe                 # chainId 196, implementations, isSealed, RPC agreement
pnpm verify -- --address <container>   # if a site already exists
```

Confirm:

- chainId is 196 and both RPC operators agree at the pinned block;
- every proxy implementation is on the TapeKit allowlist and `isSealed=false`;
- the container is opened and the signer is still the owner;
- the estimated cost (from a `PLAN_READY` deployment) is below the approved cap;
- gas price is below `TAPECI_MAX_GAS_PRICE_WEI`;
- no other deployment is in flight for the container (per-container lock).

## 3. Authorization statement (fill and return)

> I authorize TapeCI to publish to X Layer 196 with budget tier **__**, target container
> **__**, owner signer **__**, operator **__**, execution window **__ to __ UTC**, approval cap
> **__ OKB**, rollback target **__**. I understand this spends real OKB and that a successful
> receipt alone is not Live; Live requires the entry switch and read-back verification.

## 4. Execution order (only after the statement above)

1. Create the project and deploy with a `PLAN_READY` deployment; review the plan and fees.
2. Sign the EIP-712 approval with the owner wallet; verify the digest in the console.
3. Execute; the worker holds the per-container lock and writes chunks.
4. Verify through two independent RPC operators at a pinned block; entry must be switched last.
5. Record block numbers, tx hashes, artifact/manifest SHA-256 and the verification report in
   `docs/evidence/`.
6. Roll back by creating a new deployment from a verified release — never by mutating history.

**No step above may be automated past the authorization statement.** A missing budget, an RPC
disagreement, a changed implementation, a revoked owner or an over-cap estimate is a hard stop.
