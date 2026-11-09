# TapeCI UI specification

The console is a GitLab-inspired operator tool: dark top bar, light content surface, dense tables,
state-coded badges. This directory is the reference for anyone changing the UI.

## Read in this order

| Document | What it answers |
|---|---|
| **README.md** (this file) | What the UI is, the design principles, the token contract, and the current state |
| [GITLAB-BENCHMARK.md](./GITLAB-BENCHMARK.md) | Exactly where we still differ from GitLab, per screen, with a priority list |
| [IMPECCABLE-RULES.md](./IMPECCABLE-RULES.md) | The 62-rule design lint we run, what it caught, and the rules we must keep honouring |
| [FEATURE_PARITY.md](./FEATURE_PARITY.md) | Feature-by-feature inventory of the redesign (which entry point replaced which) |
| [IMPLEMENTATION.md](./IMPLEMENTATION.md) | How the redesign was implemented |
| [VERIFICATION.md](./VERIFICATION.md) | What was verified, with commands and results |
| `screenshots/` | Reference captures at 390 / 768 / 1280 widths |

## Design principles

1. **A build is not a deployment.** The four stages (Build Success → Uploaded → Verified → Live) are
   milestones, never synonyms. The UI must never let a passed build look published.
2. **Density over decoration.** This is an operator tool. A deployment list should show as many rows as
   fit without hiding meaning; secondary evidence appears on hover/focus, not as a permanent second line.
3. **State is legible without colour.** Stage badges encode state in border shape and dot as well as
   hue, so a greyscale screenshot or a colour-blind operator still reads them.
4. **Machine values stay machine values.** Raw enums (`PLAN_READY`), hashes and addresses are shown
   verbatim next to their human label. Never round, never prettify a hash.
5. **Destructive actions confirm and are re-checked server-side.** The UI is never the authority.
6. **Nothing is claimed that is not proven.** Empty means empty; a missing report says so instead of
   rendering zero.

## Layout

```
┌ top bar ─────────────────────────────────────────────────────────────┐
│ brand │ context │ search │ locale │ notifications │ chain │ + new     │
├ sidebar ─┬ content ─────────────────────────────────────────────────┤
│ groups   │ page header (eyebrow, title, lede, actions)              │
│ nav      │ sections: panels, tables, disclosures                    │
│ chain    │ footer: safety statements                                │
└──────────┴──────────────────────────────────────────────────────────┘
```

- Top bar is `--gl-header` (near-black) and 48px tall; it never wraps.
- Sidebar is 248px on desktop, hidden below 900px (navigation moves into the page header there).
- Content max-width is 1180px with 32px gutters; page title 24px, section title 16px, body 14px.

## Token contract

All values live in `apps/web/app/globals.css` `:root`. Do not hard-code a hex outside that block.

| Token | Role |
|---|---|
| `--gl-purple` / `--gl-purple-hover` | the single primary action per view |
| `--gl-border` / `--gl-border-strong` | hairlines, control outlines |
| `--gl-text` / `--gl-secondary` / `--gl-tertiary` | body / meta / faint, all AA on white |
| `--critical` / `--warning-ink` / `--success-ink` | tone **text**; the tone token itself is border-only |
| `--radius` (8px) / `--radius-sm` (4-6px) | surfaces / controls |
| `--shadow-1` / `--shadow-2` | resting / hover elevation; `--shadow-2` only with a 1px lift |
| `--motion-fast` | 120-150ms; always guarded by `prefers-reduced-motion` |

## Component conventions

| Component | Rule |
|---|---|
| `.button` | 32px tall, 6px radius, 14px/600. One `.button-primary` per view. Disabled uses neutral tokens, never a faded brand colour (the old disabled primary was 2.25:1). |
| `.panel` | White surface, 1px border, `--shadow-1`. Never lifts (not always interactive). |
| `.kpi` / `.project-card` | May lift 1px with `--shadow-2` on hover; the lift is `transform`, never margin. |
| `.notice` | Full 1px border plus a tinted surface. **No 4px side bar** (impeccable `side-tab`). |
| `.badge` | Shape-coded: dashed+hollow = in progress, solid+filled = build, left bar = uploaded, double rule = verified, squared ring = live, hatched = failed. |
| `.table` | Sticky header, 7/8px cell padding, no zebra, row hover reveals secondary actions. |
| `.state-chip` | Raw enum, mono, always next to the human label. |
| `.field` | Label above control, 8px gap, help text below; ring focus via `box-shadow` so it survives scrolling containers. |

## What changed in the 2026-10-26 polish round

Removed the AI-generated tells that impeccable flagged (five 4px side bars, one thick top rule on a
rounded card), then tightened density against GitLab:

| Metric | Before | After |
|---|---|---|
| Deployment filter block | 240px, two rows | **120px, one row**, actions pinned right |
| Deployment row height | ~80px | **~59px** |
| Rows visible at 1440x1000 | 6 | **9** |
| Meta label size | 10.5px | **11.5px** |
| Secondary row action | permanent second line | revealed on hover/focus (always on touch) |

## Gates any UI change must pass

```bash
corepack pnpm typecheck           # root
npx tsc --noEmit -p apps/web/tsconfig.json
corepack pnpm lint
corepack pnpm test:e2e            # 84 tests incl. 13 axe page gates
npm_config_cache=/tmp/npm-cache-impeccable npx --yes impeccable@latest detect apps/web/app apps/web/components
```

Plus: mobile 390px has no horizontal overflow, both locales render without an untranslated string, and
every new colour pair states its contrast ratio.

## Known gaps (tracked in GITLAB-BENCHMARK.md §7)

1. Member table lacks avatar, access source, last activity, in-place role change, filter and sort.
2. Remove-member and archive need confirmation / a danger zone.
3. Settings page needs an anchor rail, unsaved-changes guard, and two-column fields.
4. Deployments table needs sortable headers and a real pager.
5. Chrome needs sidebar counts, `/` to focus search, and a mobile navigation drawer.
6. Loading should use skeleton rows; every error notice should offer retry.
