# GitLab benchmark — where TapeCI still differs

Reference: GitLab group members and group settings (`/-/group_members`, `/-/settings/*`), read through
GitLab's public documentation because the live page sits behind an authenticated Cloudflare challenge.
Our screens: `/organizations`, `/organizations/:id`, `/projects/:id/settings`.

Status legend: **done** = matches GitLab closely enough that a user would not notice; **gap** = visible
difference worth doing; **deferred** = difference we accept and document.

## 1. Member management

| Concern | GitLab | TapeCI today | Status |
|---|---|---|---|
| Member list | Table: avatar + name + username, access level, source (direct/inherited), 2FA, created, last activity | Initials avatar, login, joined date, access source (direct/inherited + retained-access hint), last activity | **done** — no 2FA column (we have no 2FA) |
| Role model | Guest / Planner / Reporter / Developer / Maintainer / Owner (five levels) | `owner` / `member` for orgs, `owner` / `member` for projects | **deferred** — our RBAC is deliberately smaller; see §6 |
| Role change | Inline dropdown per row, saved immediately | Inline select per row, saved immediately | **done** |
| Invite flow | "Invite members" panel: search by name, pick role, optional expiry | Login picker backed by `GET /v1/users?q=` (substring, min 2 chars), role select, optional expiry date | **done** |
| Expiring access | Optional `Expires at` per member, shown as a badge and auto-revoked | Optional `expires_at` (migration 0014), shown next to the joined date, enforced at read time so an expired grant stops granting immediately | **done** — no background sweeper by design |
| Pending invitations | Separate "Invitations" tab with resend/revoke | None (membership is immediate) | **deferred** — we add by login, so there is no pending state |
| Bulk actions | Multi-select, bulk role change, bulk remove | None | **deferred** |
| Filtering | Search by name/username, filter by role, sort by created/last activity | Filter by login, filter by role, sort by role/newest/activity, with an honest "within N fetched members" note | **done** |
| Empty state | Illustration + "No members found" + clear action | Inline line illustration plus distinct copy for "no members at all" vs "none match these filters", with a clear-filters action | **done** |
| Danger zone | "Remove member" confirmation naming the member and the effect | Confirmation dialog naming the member, the effect, and any retained inherited access | **done** |

## 2. Settings page structure

| Concern | GitLab | TapeCI today | Status |
|---|---|---|---|
| Section nav | Left rail with in-page anchors, current section highlighted | Left rail, sticky, tracks the section in view via scroll position | **done** |
| Field layout | Label + control + help text, 2-column on wide screens, consistent 16px rhythm | Two columns at >=1080px, help text and buttons span the row, single column below | **done** |
| Save model | Explicit "Save changes" per section, unsaved-changes guard on navigation | One form per section plus a beforeunload guard armed on first edit | **done** |
| Advanced/Collapsed | Advanced settings collapsed by default | Path mode shown inline | **deferred** |
| Danger zone | Bottom, red-bordered, separate confirm | Archive moved to its own red-bordered section with a separate save | **done** |

## 3. Tables and lists (already improved this round)

| Concern | GitLab | TapeCI after this round | Status |
|---|---|---|---|
| Row height | 40-48px | ~59px | **close** |
| Cell padding | 8-10px | 7/8px | **done** |
| Secondary row actions | Revealed on hover/focus | `Technical details` now does this | **done** |
| Sticky header | Yes | Yes | **done** |
| Column sorting | Click headers | Click headers on project/state/requested, aria-sort on the th, choice kept in the URL | **done** |
| Pagination | Numbered + per-page selector | Server-side paging with first/prev/next/last, "Page N of M" and the real total; `limit` doubles as the page size | **done** |
| Bulk selection | Checkbox column | None | **deferred** |

## 4. Status and empty states

| Concern | GitLab | TapeCI after this round | Status |
|---|---|---|---|
| Status pill | Rounded, tinted background, icon + label | Shape-distinct badge (dashed/solid/bar/ring) | **done** — deliberately more distinct than GitLab so stages survive greyscale |
| Empty state | Illustration, headline, one sentence, primary action | Line illustration, headline, sentence, and a clear action where one applies | **done** |
| Loading | Skeleton rows matching final layout | Route-level skeletons mirror the real layout (title, KPI cards, table); one polite live region announces the wait and the placeholders are aria-hidden | **done** |
| Error state | Inline alert with retry | `ErrorNotice` always renders a retry that re-runs the server render via `router.refresh()`, disabled while in flight | **done** |

## 5. Navigation and chrome

| Concern | GitLab | TapeCI today | Status |
|---|---|---|---|
| Top bar | Search left, context switcher, avatar menu right | Search, locale, notifications, chain chip, new project, avatar | **done** |
| Sidebar | Collapsible groups, counts, pinning | Flat list with counts on projects/deployments/organizations | **done** — no collapsible groups or pinning, which we do not need with seven entries |
| Breadcrumbs | Full path with group/project context | Present on detail pages | **done** |
| Keyboard | `/` focuses search, `?` opens shortcuts | `/` focuses the top-bar search and selects it; Escape blurs | **done** — no `?` shortcut sheet, which we accept |
| Mobile | Collapsible sidebar drawer | Drawer from a top-bar menu button, with focus management and scroll lock; the horizontal strip stays so navigation is still visible | **done** |
| Sidebar counts | Counts next to group entries | Counts loaded in the layout in parallel with the user, omitted rather than shown as 0 when unavailable, `aria-hidden` so they stay out of the link name | **done** |

## 6. Deliberate differences (do not "fix")

1. **Smaller role set.** GitLab has five access levels; TapeCI has owner/member at org level and
   owner/maintainer/member at project level, because the product only needs "can approve" and "can
   administer". Adding Guest/Reporter would imply permissions we do not enforce.
2. **No invitation acceptance.** Membership is added by exact GitHub login and takes effect
   immediately; there is no email round-trip, so a pending state would be fiction.
3. **Stage badges are shape-coded.** GitLab relies on colour; TapeCI encodes Build/Uploaded/Verified/
   Live in the border and dot as well, because a chain release must never be misread in greyscale.
4. **Every destructive action is server-checked.** Role changes and removals re-verify owner status
   server-side; the UI never becomes the authority.

## 7. Priority for the next UI round

1. Member table: avatar, access source, last activity, in-place role change, filter + sort.
2. Destructive actions: confirmation naming the member for remove, and archive moved to a danger zone.
3. Settings: in-page anchor rail, unsaved-changes guard, two-column fields on wide screens.
4. Tables: sortable headers and a real pager for deployments.
5. ~~Chrome: sidebar counts, `/` to focus search, mobile navigation drawer.~~ Done except
   sidebar counts, which is deferred with the reason recorded above.
6. ~~States: skeleton rows while loading, retry on every error notice.~~ Done.
