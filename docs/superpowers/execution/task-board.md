# Task board — wallet resource provisioning

Phases from SPEC §14. A task is `accepted` only when Product confirms the journey, Test
acceptance passes on real output, and no blocking issue remains. External dependencies stay
`blocked`, never `accepted`.

## P0 — baseline and contracts

| ID | Task | Owner | Status | Acceptance evidence |
| --- | --- | --- | --- | --- |
| T00-a | Shared DTOs (§5) | Dev | **accepted** | `packages/shared/src/{resources,provisioning}.ts`; lead re-ran typecheck+lint exit 0 |
| T00-b | Journey audit (§3) and the 15 issues | Product | **accepted** | `product-p0.md`: 0/5, 0/6, 0/6 steps exist; 15/15 issues still reproduce |
| T00-c | Test harness and §15.1 case map | Test | **accepted** | `test-p0.md`; smoke test green in both states; commands verified by execution |
| T00-d | Canonical `check` script | Lead | **accepted** | `npm run check` exit 0 (package.json) |

## P1 — foundational fixes (running)

| ID | Task | Owner | Status | Blocks |
| --- | --- | --- | --- | --- |
| T01-a | WalletConnect without `window.ethereum`; bind hash registered server-side; operator bind persists before waiting | Dev A | **accepted** | P3, P6 |
| T01-b | `inspectContainer` three-outcome read (`false` / `not_found` / `unavailable`) | Dev B | **accepted** | P2, P3 |
| T01-c | Fee precision: no `Number(BigInt)`, no sub-0.0001 rendered as zero | Dev C | **accepted** | P6 |
| T01-d | P1 acceptance pass | Lead | **accepted** | At the P1 boundary: bind suite 27/27, unit 436, p2 276, e2e 128 (1 skipped). Later phases grew these; the current figures are in the P7 acceptance record. |

## P2-P7 — in progress (status per row below)

| ID | Task | Status | Note |
| --- | --- | --- | --- |
| T02-a | `/resources` journey contract | **accepted** | `product-p2.md`: 31 acceptance items, 4-state precedence, 10 wording rules |
| T02-b | Discovery layer + public read API | **accepted** | 3 files; routes registered with an exact-path allowlist; p2 294 |
| T02-c | Resource index + preparation persistence | **accepted** | 8 tables + migration 0015 (applied/rolled back/re-applied); parity 4/4 |
| T02-d | Acceptance tests + fork proof (closed P1-11) | **accepted** | fork 9/9 on a real Anvil pin; `resources.test.ts` 18/18 |
| T02-e | `/resources` page | **accepted** | four states verified in the browser; 62 i18n keys by the lead |
| T02-f | `/resources` e2e | **accepted** | 14 cases (`resources.spec.ts`) incl. the §3.2.1 "empty vs partial vs unavailable" contradiction, null≠false, no purchase surface, zh, keyboard; `/resources` added to the axe page list |
| T03-a | Open journey + 37 acceptance items | **accepted** | `product-p3.md`; also proved the blocker (only `confirmations` in the tree is the hardcoded `binding.ts:207`) |
| T03-b | `open` quote / task / transaction services | **accepted** | `apps/api/src/provisioning/{quotes,tasks,transactions}.ts`; typecheck+lint green (counts at that boundary: unit 436, p2 294) |
| T03-c | Preparation HTTP routes (§7.3) | **accepted** | 9 routes, all authenticated (anonymous → 401), CAS via FOR UPDATE + version compare, `cancel`/`requote` refuse while a send is unresolved |
| T03-d | P3 acceptance tests | **accepted** | 47/47 (`open.test.ts` 32 + `persistence.test.ts` 15); all six money-critical negatives green; the double-charge backstop proven at the storage layer with raw inserts |
| T03-e | **Confirmation policy** | **blocked (human)** | P3-01: no depth configured anywhere; an `open` may reach `submitted` but must not be presented as `confirmed` |
| T04-a | Readiness contract (8 items, 3 gates) | **accepted** | `readiness.ts`; lead verified the 5 truth-table scenarios by execution (unknown doesn't block enable, blocks publish; root-without-ack fails; null≠false) |
| T04-b | Readiness acceptance tests | **accepted** | 68/68 (`project-readiness.test.ts`), incl. both traps, R5, null≠false, root-ack, 27 stage combinations and the `reason===null ⟺ pass` sweep |
| T04-c | Migration 0016 + draft lifecycle | **accepted** | `projects.build_enabled`+`config_version`, `project_drafts`, `build_attempts` (separate `commit_sha`/`workflow_commit_sha`); 41 lifecycle + 6 route assertions; migration rolled back and re-applied |
| T04-d | Build protocol (`/v1/builds/context`, `/events`, attempt model) | **accepted (server)** | `routes/build-context.ts`; but **nothing calls `/events` yet** — see P7-02 |
| T05 | Purchase source | **blocked (external)** | no supplier, no purchase ABI (P0-11) |
| T06 | Publication and UI integration | **accepted with gaps** | `publication.ts` + capability-gated console; the §12.2 reapproval→resume integration test is missing (P7-07) |
| T07 | Independent acceptance | **delivered as `p7-acceptance.md`; P3 not accepted** | The reviewer found P3 has no UI, the build failure edge is unwired, and P6 recovery has no tests |

## Parallelism rules

- P1's three tasks touch disjoint files: A owns bind/wallet files, B owns chain read, C owns
  formatting. They may run together.
- Shared files (`schema.ts`, migrations, `app.ts`, `i18n.ts`, `globals.css`, `package.json`) are
  integrated by the lead, serially, after the owning task reports.
- No two agents may edit the same file without the lead reassigning ownership first.

## Integration risks the lead is tracking

| Risk | Detail | Mitigation |
| --- | --- | --- |
| `inspectContainer` signature change | Three callers: `apps/api/src/container-resolver.ts:13`, `packages/deployer/src/release-plan.ts:312`, and an internal call at `packages/chain/src/container.ts:228`. A three-outcome return will break all three unless they are updated together. | T01-b must report every caller it touched; the lead diffs the call sites before accepting. |
| Shared-file collision | `packages/shared/src/index.ts` already carries the P0 export lines. Any later agent appending to it must append, never rewrite. | Only the lead edits shared barrels from P1 onward. |
| i18n keys | T01-c will need new strings for the sub-0.0001 label. `apps/web/lib/i18n.ts` is lead-owned. | T01-c lists the keys; the lead adds them in both locales in one edit. |
| Fork suites | Anvil is installed but not on PATH, so fork tests crash instead of skipping. | Every fork run uses `PATH="$HOME/.foundry/bin:$PATH"`. Recorded as P0-14. |
| Package-dir Vitest | §15.2's package-dir form changes cwd and breaks 16 assertions in 5 files. | All Vitest runs from the repo root. Recorded as P0-13. |

## P2 delegation (file ownership is disjoint)

| ID | Task | Owner | Files (exclusive) | Must NOT touch |
| --- | --- | --- | --- | --- |
| T02-a | `/resources` journey contract and P2 acceptance assertions | Product | `.superpowers/sdd/provisioning/product-p2.md` | any code |
| T02-b | Discovery layer + public read API | Dev-1 | `apps/api/src/resources.ts`, `apps/api/src/resource-index.ts`, `apps/api/src/routes/resources.ts` | `app.ts` (lead registers), `schema.ts`, migrations, `apps/web/**` |
| T02-c | Resource index + preparation persistence | Dev-2 | `packages/database/src/schema.ts`, `packages/database/migrations/0015_*` | `app.ts`, `apps/api/src/**`, `apps/web/**` |
| T02-d | Acceptance tests + fork proof for the chain read (closes P1-11) | Test | `tests/**` | `apps/**`, `packages/**` |

Integration order: Dev-2 lands schema → lead applies migration and reviews `schema.ts` → Dev-1 builds the reader on the real tables → lead registers routes in `app.ts` → Test runs acceptance.
