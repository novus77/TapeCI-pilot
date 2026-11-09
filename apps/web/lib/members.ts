/**
 * Pure helpers for the member tables. Kept free of React and `window` so the
 * avatar colour, initials and relative time are unit-testable and identical on
 * the server and the client (no hydration mismatch).
 */

/** White-on-colour ramp; every pair clears 4.5:1 (see docs/ui-ux README). */
export const AVATAR_COLORS = [
  "#4b3f8f",
  "#1f6f5c",
  "#8a4b00",
  "#8a1f3d",
  "#1b5e8a",
  "#4a4a52",
] as const;

/** FNV-1a: small, stable, and independent of the platform's hash seed. */
function hashLogin(login: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < login.length; index += 1) {
    hash ^= login.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const AVATAR_FALLBACK = "#4a4a52";

export function avatarColor(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (normalized.length === 0) return AVATAR_FALLBACK;
  const index = hashLogin(normalized) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index] ?? AVATAR_FALLBACK;
}

/**
 * Two letters when the login has two or more words, otherwise the first two
 * characters. Uses code points so a CJK or emoji login yields one grapheme per
 * slot instead of half a surrogate pair.
 */
export function initials(login: string): string {
  const words = login.trim().split(/[\s._-]+/).filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const first = [...(words[0] as string)][0] ?? "?";
  if (words.length === 1) {
    const chars = [...(words[0] as string)];
    return (chars.slice(0, 2).join("") || "?").toUpperCase();
  }
  const last = [...(words[words.length - 1] as string)][0] ?? "";
  return `${first}${last}`.toUpperCase();
}

/** Coarse relative time; `null` stays null so callers can render "no activity". */
export function relativeTime(
  iso: string | null,
  now: number = Date.now(),
  locale: "en" | "zh" = "en",
): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return locale === "zh" ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return locale === "zh" ? `${minutes} 分钟前` : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === "zh" ? `${hours} 小时前` : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return locale === "zh" ? `${days} 天前` : `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export const ROLE_ORDER = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof ROLE_ORDER)[number];

export function roleRank(role: string): number {
  if (role === "maintainer") return 1;
  const index = ROLE_ORDER.indexOf(role as MemberRole);
  return index === -1 ? ROLE_ORDER.length : index;
}

export interface MemberLike {
  readonly githubLogin: string;
  readonly role: string;
  readonly createdAt: string;
  readonly lastActivityAt?: string | null;
}

export type MemberSort = "role" | "newest" | "active";

/** Client-side filter + sort over the members already fetched for this page. */
export function filterAndSortMembers<T extends MemberLike>(
  members: readonly T[],
  options: { readonly query?: string; readonly role?: string; readonly sort?: MemberSort },
): readonly T[] {
  const needle = (options.query ?? "").trim().toLowerCase();
  const role = options.role ?? "";
  const filtered = members.filter((member) => {
    if (role.length > 0 && member.role !== role) return false;
    if (needle.length === 0) return true;
    return member.githubLogin.toLowerCase().includes(needle);
  });
  const sorted = [...filtered];
  const sort = options.sort ?? "role";
  sorted.sort((left, right) => {
    if (sort === "newest") return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (sort === "active") {
      const l = left.lastActivityAt == null ? 0 : Date.parse(left.lastActivityAt);
      const r = right.lastActivityAt == null ? 0 : Date.parse(right.lastActivityAt);
      return r - l;
    }
    const byRole = roleRank(left.role) - roleRank(right.role);
    return byRole !== 0 ? byRole : left.githubLogin.localeCompare(right.githubLogin);
  });
  return sorted;
}

/** The owner row must stay an owner; the select explains the rule instead of failing. */
export function isLastOwner(
  members: readonly { readonly role: string; readonly userId: string }[],
  userId: string,
): boolean {
  const owners = members.filter((member) => member.role === "owner");
  return owners.length <= 1 && owners.some((member) => member.userId === userId);
}
