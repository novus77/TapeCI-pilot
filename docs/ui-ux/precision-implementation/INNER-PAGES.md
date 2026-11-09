# Precision Console — remaining page interiors

Date: 2026-10-29

This extends the first implementation report. The remaining route interiors now use the approved direction 02 presentation. The implementation preserves the existing data loaders, forms, server actions, wallet ownership checks, fee disclosures, deployment states and evidence tabs. No runtime dependency or backend API was added. No subagents were used; no commit, push or external deployment was performed.

## Page coverage

| Route | Applied composition |
| --- | --- |
| `/` | Existing Precision workbench, pending approval and wallet rail retained |
| `/projects` | Repository identity rows with aligned current release, latest deployment, container and strict-mode facts |
| `/projects/new` | Build wizard with a secondary explanation rail; existing validation and submission retained |
| `/projects/[id]` | Current release and publication facts grouped above configuration and release history |
| `/projects/[id]/settings` | Section navigation plus one readable content column; all six sections, including notification channels, remain accessible |
| `/projects/[id]/compare` | Balanced revision selectors and scrollable evidence comparison |
| `/deployments` | Compact filters, consistent table surfaces and existing paging/sorting |
| `/deployments/[id]` | Existing Precision review layout and five evidence tabs retained |
| `/resources` | Connected-wallet discovery before manual address lookup; all partial/unavailable/empty states retained |
| `/resources/mint` | Processor list/detail presentation, visible cost/risk disclosures and native selection buttons; one main landmark |
| `/resources/prepare` | Resource facts and guarded opening quote in the shared workflow style |
| `/preparations/[id]` | Consistent progress and task evidence presentation |
| `/containers/[address]` | Ownership, roles, binding and session evidence; addresses/timestamps remain readable inside horizontal table scrollers |
| `/organizations` | Organization list with a secondary creation form |
| `/organizations/[id]` | Members and budget hierarchy above audit and associated projects |
| `/audit` | Compact filter surface and event table; inline links have persistent underlines |
| `/webhooks` | Shared delivery-table rhythm and explicit empty/error states |
| `/wallet-check` | Clear connection facts and grouped acceptance actions |
| `/login` | Focused sign-in composition using the selected TapeCI logo; OAuth and demo states retained |

Loading, render-error and not-found views also use the updated visual hierarchy. The context breadcrumb distinguishes settings, comparison, mint and preparation routes.

## Implementation choices

- Settings remain anchored sections, rather than hidden panes. This preserves existing forms, unsaved changes handling and direct section links. The old 99-row grid span was removed, eliminating artificial empty space.
- No new purchase API was invented. Mint/open controls continue to use the existing quote and wallet workflow.
- Mint selection uses a native list of buttons with `aria-pressed`. The previous listbox/option nesting did not satisfy accessibility semantics or supply the full listbox keyboard model.
- Only non-responsive evidence tables retain minimum column widths. Deployment tables keep their existing mobile card presentation. Table scrolling does not widen the document.
- Mobile settings anchors leave room for the sticky header and section navigation; mobile actions use 44px minimum targets.

## Verification

- Focused layout regression: 4 passed, covering settings width/spacing/navigation, repository identity/facts, wallet-before-address order, one mint main landmark, and mobile anchor clearance.
- Existing workflow checks were retained. The page matrix now includes resource discovery, mint, prepare, progress and wallet acceptance pages in both locales and four viewport sizes.
- Accessibility coverage now also includes the mint, prepare, progress and wallet acceptance routes.
- Full Playwright suite: **167 passed, 1 skipped, 0 failed** in 3.7 minutes on a freshly started demonstration server. The existing skipped case requires a remove-member control absent from the read-only mock organization.
- `pnpm run check`: passed, covering repository ESLint and both configured type checks.
- Final resource/layout follow-up after the font-token correction: 18 passed.
- `git diff --check`: passed.
- Four viewport page matrices now cover 23 concrete page examples spanning all 19 route templates, plus the existing deployment view/state matrices and 19-width header sweep.

## Evidence and limits

Screenshots are actual Next.js application captures. The standard page matrix is saved under `docs/ui-ux/screenshots/`; selected Chinese views are beside this document as `inner-*.png`.

Validation uses deterministic demonstration data and a browser without a connected wallet. It establishes UI behavior and existing guarded workflow regressions; it does not establish live wallet, hardware device, paid mainnet transaction, GitHub callback or production persistence acceptance. Each route has been adapted to the shared design, but this is not a claim of pixel-identical reproduction of every static prototype state.
