import { describe, expect, it } from "vitest";
import {
  AVATAR_COLORS,
  avatarColor,
  filterAndSortMembers,
  initials,
  isLastOwner,
  relativeTime,
  roleRank,
} from "../../apps/web/lib/members.js";

describe("initials", () => {
  it("takes the first letter of the first and last word", () => {
    expect(initials("novus77")).toBe("NO");
    expect(initials("reviewer-olga")).toBe("RO");
    expect(initials("tapeci bot")).toBe("TB");
  });

  it("keeps one grapheme per slot for non-ASCII logins", () => {
    expect(initials("张三")).toBe("张三");
    expect(initials("用户-名")).toBe("用名");
  });

  it("handles an empty login without throwing", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});

describe("avatarColor", () => {
  it("is deterministic and case-insensitive", () => {
    expect(avatarColor("novus77")).toBe(avatarColor("novus77"));
    expect(avatarColor("Novus77")).toBe(avatarColor("novus77"));
  });

  it("always returns a ramp colour", () => {
    for (const login of ["a", "novus77", "tapeci-bot", "reviewer-olga", "张三", ""]) {
      expect(AVATAR_COLORS).toContain(avatarColor(login));
    }
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const ago = (seconds: number): string =>
    new Date(now - seconds * 1000).toISOString();

  it("localizes relative activity in Chinese", () => {
    expect(relativeTime(ago(5), now, "zh")).toBe("刚刚");
    expect(relativeTime(ago(180), now, "zh")).toBe("3 分钟前");
    expect(relativeTime(ago(7200), now, "zh")).toBe("2 小时前");
    expect(relativeTime(ago(86400 * 3), now, "zh")).toBe("3 天前");
  });

  it("covers the coarse buckets", () => {
    expect(relativeTime(ago(5), now)).toBe("just now");
    expect(relativeTime(ago(90), now)).toBe("1 minute ago");
    expect(relativeTime(ago(180), now)).toBe("3 minutes ago");
    expect(relativeTime(ago(7200), now)).toBe("2 hours ago");
    expect(relativeTime(ago(86400 * 3), now)).toBe("3 days ago");
  });

  it("falls back to a date beyond 30 days and handles null", () => {
    expect(relativeTime(ago(86400 * 60), now)).toBe("2026-08-27");
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime("not-a-date", now)).toBeNull();
  });
});

describe("filterAndSortMembers", () => {
  const members = [
    { userId: "1", githubLogin: "novus77", role: "owner", createdAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-26T00:00:00Z" },
    { userId: "2", githubLogin: "tapeci-bot", role: "admin", createdAt: "2026-10-05T00:00:00Z", lastActivityAt: "2026-10-25T00:00:00Z" },
    { userId: "3", githubLogin: "reviewer-olga", role: "member", createdAt: "2026-10-12T00:00:00Z", lastActivityAt: null },
  ];

  it("filters by login substring, case-insensitively", () => {
    expect(filterAndSortMembers(members, { query: "OLGA" }).map((m) => m.userId)).toEqual(["3"]);
  });

  it("filters by role", () => {
    expect(filterAndSortMembers(members, { role: "admin" }).map((m) => m.userId)).toEqual(["2"]);
  });

  it("sorts by role order by default", () => {
    expect(filterAndSortMembers(members, {}).map((m) => m.role)).toEqual(["owner", "admin", "member"]);
  });

  it("sorts by newest and by activity", () => {
    expect(filterAndSortMembers(members, { sort: "newest" }).map((m) => m.userId)).toEqual(["3", "2", "1"]);
    expect(filterAndSortMembers(members, { sort: "active" }).map((m) => m.userId)).toEqual(["1", "2", "3"]);
  });

  it("does not mutate the input", () => {
    const before = members.map((m) => m.userId);
    filterAndSortMembers(members, { sort: "newest" });
    expect(members.map((m) => m.userId)).toEqual(before);
  });

  it("sorts inherited maintainers between owners and members", () => {
    const projectMembers = [...members.filter((member) => member.role !== "admin"),
      { userId: "4", githubLogin: "maintainer", role: "maintainer", createdAt: "2026-10-01T00:00:00Z", lastActivityAt: null }];
    expect(filterAndSortMembers(projectMembers, {}).map((member) => member.role)).toEqual(["owner", "maintainer", "member"]);
  });

  it("ranks unknown roles last", () => {
    expect(roleRank("owner")).toBeLessThan(roleRank("member"));
    expect(roleRank("ghost")).toBe(3);
  });
});

describe("isLastOwner", () => {
  it("is true only for the sole owner", () => {
    const members = [
      { userId: "1", role: "owner" },
      { userId: "2", role: "member" },
    ];
    expect(isLastOwner(members, "1")).toBe(true);
    expect(isLastOwner(members, "2")).toBe(false);
  });

  it("is false when there are two owners", () => {
    const members = [
      { userId: "1", role: "owner" },
      { userId: "2", role: "owner" },
    ];
    expect(isLastOwner(members, "1")).toBe(false);
  });
});
