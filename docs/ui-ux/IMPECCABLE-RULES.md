# Impeccable design rules for TapeCI

Source: [pbakaus/impeccable](https://github.com/pbakaus/impeccable) — a design checker for AI-generated
frontends: 62 deterministic rules plus LLM-only critique checks. It is **not** a component library, so
the integration is a lint pass, not a dependency.

Run it before shipping any UI change:

```bash
npm_config_cache=/tmp/npm-cache-impeccable npx --yes impeccable@latest detect apps/web/app apps/web/components
```

A non-zero exit with a rule id means the change reintroduced an AI tell. The regex pass undercounts;
scan a running page (`detect http://127.0.0.1:3000/`) for the element/contrast rules when the browser
automation is available.

## What it found in TapeCI (2026-10-26) and what we did

| Rule | Where | Resolution |
|---|---|---|
| `side-tab` ×5 | `.notice`, `.mock-note`, `.warning-block`, `.error-summary`, a generic card | 4px coloured left bar removed; uniform 1px border + tinted surface |
| `border-accent-on-rounded` | `.legend-card` 3px top rule | Reduced to 1px; the in-card badge carries the state |

Rescan after the fix: **0 findings**.

## Rules we must keep honouring

### Layout and chrome

- No thick coloured border on one side of a card (`side-tab`). Use a full border plus a tinted surface,
  or an icon.
- No thick accent border on a rounded card (`border-accent-on-rounded`).
- No cards nested inside cards (`nested-cards`). If a panel needs sub-grouping, use a divider or a
  definition list, not another border.
- Cards must not sit flush against the viewport edge (`edge-flush-cards`).
- Avoid uniform spacing everywhere (`monotonous-spacing`): group related fields at 8px, separate
  sections at 24-32px.

### Type

- Do not use Inter/Roboto/system-UI as the *only* signal of "modern" (`overused-font`). TapeCI uses the
  platform sans stack plus a mono for hashes, which is the right call for an operator tool.
- Keep a real hierarchy (`flat-type-hierarchy`): page title > section title > label > body > meta.
  Current scale: 24 / 16 / 11.5 / 14 / 11.5-12px.
- No gradient text (`gradient-text`), no italic serif display (`italic-serif-display`).
- Do not letter-space body text (`wide-tracking`), do not justify text (`justified-text`).
- Keep line length under ~80 characters (`line-length`); body copy is capped by `max-width` on ledes.
- Do not go below 11px for UI text (`tiny-text`, `undersized-ui-text`). Meta labels are 11.5px.
- Do not set `text-transform: uppercase` on body copy (`all-caps-body`); only on short eyebrow labels.

### Colour

- No purple-to-blue gradient palette (`ai-color-palette`), no cream/beige page background
  (`cream-palette`).
- No grey text on a coloured surface (`gray-on-color`). Tone text uses a darker ink, the tone token is
  the border only.
- Every text pair must clear 4.5:1 (`low-contrast`). Verified pairs are recorded in
  `docs/real-integrations/verification-2026-10-26.md`.
- No radial halo or spotlight glow behind content (`radial-halo`, `radial-spotlight-glow`, `dark-glow`).

### Motion

- No bounce/overshoot easing (`bounce-easing`); TapeCI uses 120-150ms ease-out only.
- No pulsing dots or blinking cursors (`pulsing-dot`, `blinking-cursor`), no marquee (`marquee`).
- Every animation must be disabled under `prefers-reduced-motion: reduce` — there is a global rule in
  `globals.css`, and per-component guards where a transition matters.

### Depth

- Avoid a thin border paired with a wide shadow (`gpt-thin-border-wide-shadow`). Two shadow tokens only:
  `--shadow-1` for resting surfaces, `--shadow-2` for hover, and a surface may take `--shadow-2` only if
  it also lifts 1px.
- No hard offset shadows (`hard-offset-shadow`).
- Floating layers (menus, dialogs, notification panel) may use a heavier shadow — that is a real
  elevation, not decoration.

### Content

- No marketing buzzwords (`marketing-buzzword`), no aphoristic cadence (`aphoristic-cadence`), no
  theatre phrasing (`theater-slop-phrase`), no em-dash overuse (`em-dash-overuse`).
- No hero eyebrow chip or kicker above a heading on operational pages (`hero-eyebrow-chip`,
  `kicker-above-heading`). TapeCI's page header shows a small context label only on detail pages.
- No numbered section labels (`numbered-section-labels`) on settings-style pages.
- No oversized h1 (`oversized-h1`) — the page title is 24px.

### Data display

- Do not hide content at rest that the user needs to make a decision (`content-hidden-at-rest`).
  Secondary evidence may be revealed on hover/focus, as `Technical details` now is.
- No text occlusion or clipped overflow containers (`text-occlusion`, `clipped-overflow-container`,
  `text-overflow`). Long addresses truncate with an ellipsis and are shown in full elsewhere.
- No repeated container text (`repeated-container-text`) — do not repeat the panel title inside the
  panel body.
- Tables: sticky header, no zebra striping, row hover, 7-8px cell padding.

## Design tokens (single source of truth)

`apps/web/app/globals.css` `:root` holds the GitLab-derived tokens. Rules that matter:

| Token group | Use |
|---|---|
| `--gl-purple`, `--gl-purple-hover` | primary action only (one primary per view) |
| `--gl-border`, `--gl-border-strong` | hairlines and control outlines |
| `--gl-text`, `--gl-secondary`, `--gl-tertiary` | body, meta, faint — all AA on white |
| `--critical`, `--warning-ink`, `--success-ink` | tone text; never use the tone token itself for small text |
| `--radius`, `--radius-sm` | 8px surfaces, 4-6px controls |
| `--shadow-1`, `--shadow-2` | resting and hover elevation only |
| `--motion-fast` | 120-150ms |

## Review checklist for any UI change

1. `npx impeccable detect` is clean (or every remaining id is justified in the PR).
2. Contrast checked for any new colour pair; state the ratio in the PR.
3. Keyboard: every new control reachable and focus-visible; destructive actions confirm.
4. `prefers-reduced-motion` respected for any new animation.
5. `pnpm test:e2e` axe gate still green (13 page gates).
6. Mobile at 390px: no page-level horizontal overflow.
7. Both locales: no untranslated string, no layout break in Chinese (wider glyphs).
