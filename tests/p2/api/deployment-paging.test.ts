import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  containers,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  deployments,
  githubInstallations,
  migrateUp,
  projectMembers,
  projects,
  users,
  type Database,
} from "@tapeci/database";
import type { Hex } from "@tapeci/shared";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

/**
 * `GET /v1/deployments` paging and sorting — `.superpowers/sdd/table-sort-pager/plan.md`
 * (scope item 1: sort allowlist, `page`/`pageSize`, `{ items, page, pageSize,
 * total, totalPages }`, and `limit` kept as an alias for `pageSize`).
 *
 * The database is the contract under test, so this file seeds real rows instead
 * of mocking the pool: a pager that pages over an already-truncated array is the
 * exact bug the plan exists to remove, and only a real `count(*)` can prove the
 * total is not `items.length`.
 *
 * Fixture shape (32 visible rows for the dev user, 4 more on a project they are
 * not a member of, so an unscoped count query returns 36 and fails loudly):
 *
 *   alpha  23 rows: LIVE 8, BUILD_FAILED 6, PLAN_READY 5, VALIDATING 4
 *   beta    9 rows: LIVE 3, BUILD_FAILED 6
 *   hidden  4 rows: LIVE 4, owned by another user, no membership row
 *
 * `requestedAt` decreases by one minute per seed, so the expected order is the
 * seed order and no two rows share a timestamp.
 *
 * Assumed contract (`plan.md` scope 1), as shipped by `apps/api/src/routes/deployments.ts`
 * when this file was written:
 *   - response `{ deployments, page, pageSize, total, totalPages }`. The plan
 *     names the array `items`; the route kept `deployments` so existing callers
 *     and `read.test.ts` keep working. Both names are accepted here — the point
 *     of the assertions is the numbers, not the envelope spelling.
 *   - `sort` allowlisted to `requestedAt | state | project`, `dir=asc|desc`;
 *     anything else is `400 INVALID_QUERY`.
 *   - `pageSize` (and the legacy `limit`) bounded to 1..200 by clamping, and
 *     `page` floored at 1.
 */

const available = await databaseAvailable();

const CONTAINER = "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3" as Hex;
const FACTORY = "0x1f09daefa827f02cbb40967cc91b259763760761";
const PROCESSOR = "0x839bdd6fa7a66416a609a735e11de5411b98574e";
const REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const BINDING = "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9";

/** Newest seed. Each later seed is one minute older. */
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const MINUTE = 60_000;

const DEV_USER_ID = 9_401;
const DEV_HEADERS = {
  "content-type": "application/json",
  "x-tapeci-github-login": "paging-user",
  "x-tapeci-github-user-id": String(DEV_USER_ID),
};
const OUTSIDER_USER_ID = 9_402;

const env: ApiEnv = {
  databaseUrl: "unused",
  redisUrl: "redis://127.0.0.1:56379",
  port: 0,
  host: "127.0.0.1",
  sessionSecret: "test-session-secret-123456",
  devAuth: true,
  objectStoreDir: ".tapeci/objects",
  artifactMaxBytes: 64 * 1024 * 1024,
  artifactTokenTtlSeconds: 900,
  githubAppId: null,
  githubAppPrivateKey: null,
  githubWebhookSecret: "test-webhook-secret",
  githubOidcAudience: "tapeci-artifact-upload",
  githubOidcIssuer: "https://token.actions.githubusercontent.com",
  operatorPrivateKey: null,
  writeRpcUrl: null,
  journalDir: ".tapeci/journal",
  githubAppSlug: null,
  githubOAuthClientId: null,
  githubOAuthClientSecret: null,
  githubOAuthBaseUrl: "https://github.com",
  githubApiBaseUrl: "https://api.github.com",
  publicApiUrl: "http://127.0.0.1:8787",
  webUrl: "http://127.0.0.1:3000",
  sessionTtlSeconds: 604_800,
};

/**
 * Seed plan. `member: false` keeps the rows out of the dev user's list, so the
 * difference between the real count and an unscoped count is observable.
 */
const PROJECT_PLAN = [
  {
    key: "alpha",
    repositoryId: 2_401,
    repoFullName: "acme/alpha",
    member: true,
    states: [
      ["LIVE", 8],
      ["BUILD_FAILED", 6],
      ["PLAN_READY", 5],
      ["VALIDATING", 4],
    ],
  },
  {
    key: "beta",
    repositoryId: 2_402,
    repoFullName: "acme/beta",
    member: true,
    states: [
      ["LIVE", 3],
      ["BUILD_FAILED", 6],
    ],
  },
  {
    key: "hidden",
    repositoryId: 2_403,
    repoFullName: "acme/hidden",
    member: false,
    states: [["LIVE", 4]],
  },
] as const;

const SEEDS = PROJECT_PLAN.flatMap((project) =>
  project.states.flatMap(([state, count]) =>
    Array.from({ length: count }, () => ({ project: project.key, state })),
  ),
).map((seed, index) => ({
  ...seed,
  requestedAt: new Date(T0 - index * MINUTE),
  commitSha: index.toString(16).padStart(40, "0"),
}));

/** The rows this user may see; `hidden` seeds sit at the end of `SEEDS`. */
const VISIBLE = SEEDS.filter((seed) => seed.project !== "hidden");
const TOTAL = VISIBLE.length;
const PAGE_SIZE = 10;
const TOTAL_PAGES = Math.ceil(TOTAL / PAGE_SIZE);
const LIVE = VISIBLE.filter((seed) => seed.state === "LIVE").length;
const ALPHA = VISIBLE.filter((seed) => seed.project === "alpha").length;
const ALPHA_LIVE = VISIBLE.filter(
  (seed) => seed.project === "alpha" && seed.state === "LIVE",
).length;

interface ListResult {
  readonly url: string;
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

interface PageView {
  readonly ids: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

describe.skipIf(!available)("GET /v1/deployments paging and sorting", () => {
  let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let projectId: Record<string, string> = {};
  let newestVisibleId = "";
  let oldestVisibleId = "";

  async function list(query = ""): Promise<ListResult> {
    const url = `/v1/deployments${query}`;
    const response = await app.inject({ method: "GET", url, headers: DEV_HEADERS });
    return {
      url,
      statusCode: response.statusCode,
      body: response.json() as Record<string, unknown>,
    };
  }

  /**
   * Normalize one list response. A missing numeric key fails with the payload
   * keys it did see, so a contract gap reads as a contract gap and not as an
   * `undefined` comparison.
   */
  function pageOf(result: ListResult): PageView {
    expect(
      result.statusCode,
      `${result.url} returned ${result.statusCode}: ${JSON.stringify(result.body)}`,
    ).toBe(200);
    const rows = result.body.items ?? result.body.deployments;
    if (!Array.isArray(rows)) {
      throw new Error(
        `${result.url} has no items array (payload keys: ${
          Object.keys(result.body).join(", ") || "none"
        }). plan.md scope 1 specifies { items, page, pageSize, total, totalPages }.`,
      );
    }
    const numeric = (key: string): number => {
      const value = result.body[key];
      if (value === undefined || value === null || !Number.isFinite(Number(value))) {
        throw new Error(
          `${result.url} has no numeric \`${key}\` (got ${JSON.stringify(value)}). ` +
            "plan.md scope 1 specifies { items, page, pageSize, total, totalPages }.",
        );
      }
      return Number(value);
    };
    return {
      rows: rows as readonly Record<string, unknown>[],
      ids: (rows as readonly Record<string, unknown>[]).map((row) => String(row.id)),
      page: numeric("page"),
      pageSize: numeric("pageSize"),
      total: numeric("total"),
      totalPages: numeric("totalPages"),
    };
  }

  async function pageOne(query = ""): Promise<PageView> {
    return pageOf(await list(query));
  }

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    await migrateUp(testDatabase.url);
    handle = createDatabase(testDatabase.url);
    db = handle.db;

    const [installation] = await db
      .insert(githubInstallations)
      .values({ installationId: 9_401, githubAccountId: 88, accountLogin: "acme" })
      .returning();
    if (installation === undefined) throw new Error("installation fixture missing");

    const [container] = await db
      .insert(containers)
      .values({
        chainId: 196,
        factoryAddress: FACTORY,
        processorIndex: 0,
        processorAddress: PROCESSOR,
        tokenId: "7",
        containerAddress: CONTAINER,
        registryAddress: REGISTRY,
        bindingAddress: BINDING,
      })
      .returning();
    if (container === undefined) throw new Error("container fixture missing");

    const [member] = await db
      .insert(users)
      .values({ githubUserId: DEV_USER_ID, githubLogin: "paging-user" })
      .returning();
    const [outsider] = await db
      .insert(users)
      .values({ githubUserId: OUTSIDER_USER_ID, githubLogin: "outsider" })
      .returning();
    if (member === undefined || outsider === undefined) throw new Error("user fixtures missing");

    for (const project of PROJECT_PLAN) {
      const [row] = await db
        .insert(projects)
        .values({
          ownerUserId: outsider.id,
          githubInstallationId: installation.id,
          githubRepositoryId: project.repositoryId,
          repoFullName: project.repoFullName,
          containerId: container.id,
        })
        .returning();
      if (row === undefined) throw new Error(`project fixture ${project.key} missing`);
      projectId = { ...projectId, [project.key]: row.id };
      if (project.member) {
        await db.insert(projectMembers).values({ projectId: row.id, userId: member.id, role: "owner" });
      }
    }

    await db.insert(deployments).values(
      SEEDS.map((seed) => {
        const id = projectId[seed.project];
        if (id === undefined) throw new Error(`seed names unknown project ${seed.project}`);
        return {
          projectId: id,
          containerId: container.id,
          triggerKind: "webhook" as const,
          commitSha: seed.commitSha,
          state: seed.state,
          registryAddress: REGISTRY,
          requestedAt: seed.requestedAt,
        };
      }),
    );

    // Read the order back instead of trusting INSERT ... RETURNING order.
    const stored = await db
      .select({ id: deployments.id, projectId: deployments.projectId, requestedAt: deployments.requestedAt })
      .from(deployments);
    const visible = stored
      .filter((row) => row.projectId !== projectId.hidden)
      .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime());
    newestVisibleId = visible[0]?.id ?? "";
    oldestVisibleId = visible[visible.length - 1]?.id ?? "";
    expect(visible).toHaveLength(TOTAL);
    expect(newestVisibleId).not.toBe("");
    expect(oldestVisibleId).not.toBe(newestVisibleId);

    const deps: ApiDeps = { db, env };
    app = buildApp(deps);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await testDatabase?.drop();
  }, 30_000);

  it("reports the real total, not the page length", async () => {
    const view = await pageOne(`?pageSize=${PAGE_SIZE}`);

    expect(view.rows).toHaveLength(PAGE_SIZE);
    expect(view.total).toBe(TOTAL);
    expect(view.total).not.toBe(view.rows.length);
    // 36 rows exist in the table; the 4 on the non-member project must not count.
    expect(view.total).toBe(SEEDS.length - 4);
    expect(view.page).toBe(1);
    expect(view.pageSize).toBe(PAGE_SIZE);
    expect(view.totalPages).toBe(TOTAL_PAGES);
  });

  it("returns disjoint page 1 and page 2 and pages the whole set exactly once", async () => {
    const first = await pageOne(`?pageSize=${PAGE_SIZE}&page=1`);
    const second = await pageOne(`?pageSize=${PAGE_SIZE}&page=2`);

    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(second.rows).toHaveLength(PAGE_SIZE);
    expect(second.page).toBe(2);
    expect(first.total).toBe(TOTAL);
    expect(second.total).toBe(TOTAL);
    expect(first.totalPages).toBe(TOTAL_PAGES);
    expect(second.totalPages).toBe(TOTAL_PAGES);

    const overlap = first.ids.filter((id) => second.ids.includes(id));
    expect(overlap, "page 1 and page 2 must not share a deployment").toEqual([]);

    // Every page together is the whole set: no row dropped, none repeated.
    const collected: string[] = [];
    for (let page = 1; page <= TOTAL_PAGES; page += 1) {
      const view = await pageOne(`?pageSize=${PAGE_SIZE}&page=${page}`);
      expect(view.page).toBe(page);
      collected.push(...view.ids);
    }
    expect(collected).toHaveLength(TOTAL);
    expect(new Set(collected).size).toBe(TOTAL);
  });

  it("returns an empty page past the end, with the real total and totalPages", async () => {
    const view = await pageOne(`?pageSize=${PAGE_SIZE}&page=999`);

    expect(view.rows).toEqual([]);
    expect(view.total).toBe(TOTAL);
    expect(view.totalPages).toBe(TOTAL_PAGES);
  });

  /**
   * plan.md scope 1 says "Bound `pageSize` to 1..200 like `limit` is today", and
   * the legacy route bounded with `Number(raw) || 50`, so out-of-range values
   * may be clamped *or* rejected. Both are acceptable; the invariant that is not
   * negotiable is that the response stays bounded (never 0, never unbounded) and
   * still reports a real total. The `console.info` lines record which the
   * shipped route does so the report can name it instead of guessing.
   */
  function expectBoundedPageSize(result: ListResult, requested: number): string {
    if (result.statusCode === 400) {
      expect(
        (result.body.error as { code?: string } | undefined)?.code,
        `pageSize=${requested}`,
      ).toBe("INVALID_QUERY");
      return "rejected 400";
    }
    const view = pageOf(result);
    expect(view.pageSize, `pageSize=${requested} must stay >= 1`).toBeGreaterThanOrEqual(1);
    expect(view.pageSize, `pageSize=${requested} must stay <= 200`).toBeLessThanOrEqual(200);
    expect(Number.isInteger(view.pageSize)).toBe(true);
    expect(view.rows.length, `pageSize=${requested} returned more rows than its page size`)
      .toBeLessThanOrEqual(view.pageSize);
    expect(view.total, `pageSize=${requested} must still count the real total`).toBe(TOTAL);
    return `clamped to ${view.pageSize}`;
  }

  it("bounds pageSize to 1..200, clamping or rejecting", async () => {
    const zero = expectBoundedPageSize(await list("?pageSize=0"), 0);
    const over = expectBoundedPageSize(await list("?pageSize=201"), 201);
    const junk = expectBoundedPageSize(await list("?pageSize=abc"), Number.NaN);
    console.info(`[observed] pageSize 0 -> ${zero}; 201 -> ${over}; abc -> ${junk}`);

    // 201 must land on the documented ceiling, not stay unbounded: 32 visible
    // rows fit inside 200, so a clamped request returns the whole set.
    const overPage = pageOf(await list("?pageSize=201"));
    expect(overPage.rows).toHaveLength(TOTAL);
  });

  it("rejects an unknown sort key with 400 INVALID_QUERY and never 500", async () => {
    for (const sort of ["commitSha", "requested_at", "id;drop table deployments", "nope"]) {
      const result = await list(`?sort=${encodeURIComponent(sort)}`);
      expect(
        result.statusCode,
        `sort=${JSON.stringify(sort)} returned ${result.statusCode}: ${JSON.stringify(result.body)}`,
      ).not.toBe(500);
      expect(result.statusCode, `sort=${JSON.stringify(sort)}`).toBe(400);
      expect((result.body.error as { code?: string } | undefined)?.code).toBe("INVALID_QUERY");
    }
  });

  it("sort=requestedAt&dir=asc truly reverses the default order", async () => {
    const descending = await pageOne("?pageSize=100");
    const ascending = await pageOne("?pageSize=100&sort=requestedAt&dir=asc");

    expect(descending.rows).toHaveLength(TOTAL);
    expect(ascending.rows).toHaveLength(TOTAL);
    expect(descending.ids[0]).toBe(newestVisibleId);
    expect(descending.ids[TOTAL - 1]).toBe(oldestVisibleId);
    expect(ascending.ids[0]).toBe(oldestVisibleId);
    expect(ascending.ids[TOTAL - 1]).toBe(newestVisibleId);
    expect(ascending.ids).toEqual([...descending.ids].reverse());

    const explicitDesc = await pageOne("?pageSize=100&sort=requestedAt&dir=desc");
    expect(explicitDesc.ids).toEqual(descending.ids);
  });

  it("keeps legacy limit=10 behaving like pageSize=10", async () => {
    const legacy = await pageOne("?limit=10");
    const modern = await pageOne("?pageSize=10");

    expect(legacy.ids).toEqual(modern.ids);
    expect(legacy.pageSize).toBe(10);
    expect(legacy.total).toBe(TOTAL);
    expect(legacy.totalPages).toBe(TOTAL_PAGES);
    expect(legacy.rows).toHaveLength(10);
  });

  it("narrows total as well as the page for state and projectId filters", async () => {
    const live = await pageOne("?state=LIVE");
    expect(live.total).toBe(LIVE);
    expect(live.rows).toHaveLength(LIVE);
    expect(live.totalPages).toBe(1);
    expect(live.rows.every((row) => row.state === "LIVE")).toBe(true);

    const livePage2 = await pageOne("?state=LIVE&pageSize=4&page=2");
    expect(livePage2.total).toBe(LIVE);
    expect(livePage2.totalPages).toBe(Math.ceil(LIVE / 4));
    expect(livePage2.rows).toHaveLength(4);
    expect(livePage2.ids.every((id) => live.ids.includes(id))).toBe(true);

    const alpha = projectId.alpha ?? "";
    const byProject = await pageOne(`?projectId=${alpha}&pageSize=100`);
    expect(byProject.total).toBe(ALPHA);
    expect(byProject.rows).toHaveLength(ALPHA);
    expect(byProject.rows.every((row) => row.projectId === alpha)).toBe(true);

    const alphaLive = await pageOne(`?projectId=${alpha}&state=LIVE`);
    expect(alphaLive.total).toBe(ALPHA_LIVE);
    expect(alphaLive.rows).toHaveLength(ALPHA_LIVE);
    expect(
      alphaLive.rows.every((row) => row.projectId === alpha && row.state === "LIVE"),
    ).toBe(true);

    // Filtered totals page too: 8 rows at 5 per page is 2 pages, second has 3.
    const alphaLivePage2 = await pageOne(`?projectId=${alpha}&state=LIVE&pageSize=5&page=2`);
    expect(alphaLivePage2.total).toBe(ALPHA_LIVE);
    expect(alphaLivePage2.totalPages).toBe(Math.ceil(ALPHA_LIVE / 5));
    expect(alphaLivePage2.rows).toHaveLength(ALPHA_LIVE - 5);
  });
});
