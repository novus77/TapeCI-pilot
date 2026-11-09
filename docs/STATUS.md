# TapeCI status — 2026-10-24

## Done

| Area | State |
|---|---|
| P0 chain feasibility | GO; X Layer 196 probes, implementations, chunk/authorization evidence |
| P1 CLI/deploy engine | done; plan, upload, journal/resume, entry-last, verification |
| P2-01…P2-09 | done: API, DB, GitHub App/OAuth/install/webhook, OIDC/build token, artifact ingest, S3/local store, BullMQ worker, approvals (EIP-712/1271), console |
| Governance | project members, organizations + inherited roles, budgets, approval policy, Slack/email channels, notification read state, audit scope/backfill, webhook deliveries, release compare, SSE, evidence export |
| Real GitHub verification | App created via Manifest, OAuth, installation, 43 repos, webhook HMAC, real Actions OIDC → build token → artifact → PLAN_READY |
| Deployment baseline | non-root API/worker/web images (CI built + web smoke), compose, split K8s + kustomization/kubeconform, Prometheus/Grafana, security gates |
| Chain update | 2026-10-22 factory implementation allowlisted; mainnet 20/20, fork 43/45 (2 skipped) |
| **Mainnet canary** | 2026-10-25 container `0xC0B4…B814`: 2 real putFile txs, fee 0.00001088 OKB, dual-RPC VERIFIED at block 74093811, LIVE |
| **RC + rollback** | RC commit `d695898` → LIVE (2 txs); rollback to canary release `r-147c0d…` → LIVE, rollback tx `0x9f61…699e` block 74096780, VERIFIED at 74096788. Evidence: `p2-10-rollback-drill.json` |

## Real mainnet release (2026-10-25)

| Item | Value |
|---|---|
| Site | **https://10-2-4.tapekit.org/** (`10.2.4.tape`) |
| Container | `0xC0B4…B814`, owner `0x2506…5F22` |
| Final deployment | `17d33c2a-…` — 21 files, 21 txs, dual-RPC VERIFIED, LIVE |
| Domain bind | `0x613438ce…190b2` block 74,152,054, paid to 2026-11-24, **cost 0.0000037 OKB** (monthlyFee is 0 on X Layer) |
| Total spend | ≈ 0.0039 OKB across 4 releases + 1 bind |
| Evidence | `docs/evidence/p2-10-mainnet-final.json` |

Two product gaps were found by that release and fixed:
- the gateway only serves a name after `DomainBinding.bind`, so TapeCI now binds (chain/API/UI/CLI)
- versioned `/releases/<id>/` paths break runtime-loading sites, so projects can now use **root path mode**

## Blocked (needs you)

1. ~~Opened X Layer container~~ — canary container supplied (`0xC0B4…B814`) and used.
   RC (larger artifact/rollback) still needs an execution window and rollback target.
2. **Budget tier** A/B/C and the exact cap.
3. **Owner/operator wallets**, execution window, rollback target, signed authorization.
4. Production-only verification: real S3/R2 bucket, WalletConnect relay/device, live Safe EIP-1271,
   real K8s cluster apply, private MinIO image.

## Next when unblocked

preflight → create project → plan → EIP-712 approval → execute → dual-RPC verify → LIVE → evidence.
No mainnet write before the authorization packet is signed.
