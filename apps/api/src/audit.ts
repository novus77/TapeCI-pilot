/**
 * Structured mutation audit log.
 *
 * Written as one JSON line per mutating request to stdout (ship to your SIEM/log
 * store). Bodies, query strings, cookies, tokens and signatures are never logged.
 *
 * Each row also carries the project/organization the request mutated so the
 * console can filter by scope instead of inferring it from actor membership.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { auditEvents, deployments, organizations, projects, type Database } from "@tapeci/database";
import { isPublicReadMethodAndPath } from "./resources.js";

export interface AuditScope {
  readonly projectId: string | null;
  readonly organizationId: string | null;
}

let scopeResolveFailures = 0;

/** Monotonic counter exposed by /metrics; resolver failures are otherwise silent. */
export function auditScopeResolveFailureCount(): number {
  return scopeResolveFailures;
}

export interface AuditRecord extends AuditScope {
  readonly event: "http_mutation";
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly actorUserId: string | null;
  readonly githubLogin: string | null;
  readonly ip: string;
  readonly userAgent: string | null;
}

export function createAuditRecord(input: {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly actorUserId: string | null;
  readonly githubLogin: string | null;
  readonly ip: string;
  readonly userAgent: string | null;
  readonly projectId: string | null;
  readonly organizationId: string | null;
}): AuditRecord {
  return { event: "http_mutation", ...input };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMPTY_SCOPE: AuditScope = { projectId: null, organizationId: null };

/** Collections whose first path segment is a resource id we bind audit rows to. */
type ScopedCollection = "projects" | "deployments" | "organizations";

const SCOPED_COLLECTIONS: readonly ScopedCollection[] = ["projects", "deployments", "organizations"];

/**
 * Identify the collection and resource id from the concrete request path, e.g.
 * `/v1/organizations/<uuid>/members` -> { collection: "organizations", id }.
 * The collection must come from the path: every route names its parameter `id`,
 * so `request.params.id` alone cannot tell a project from an organization.
 */
function scopedResource(url: string): { collection: ScopedCollection; id: string } | undefined {
  const path = url.split("?")[0] ?? url;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 3 || segments[0] !== "v1") return undefined;
  const collection = segments[1];
  const id = segments[2];
  if (collection === undefined || id === undefined) return undefined;
  if (!SCOPED_COLLECTIONS.includes(collection as ScopedCollection)) return undefined;
  if (!UUID_PATTERN.test(id)) return undefined;
  return { collection: collection as ScopedCollection, id };
}

/**
 * Resolve the project/organization a mutation belongs to. Never throws: an
 * unknown or unreadable id simply records no scope, because audit persistence
 * must not be able to fail the request it is describing.
 */
export async function resolveAuditScope(
  db: Database,
  url: string,
  onError?: (error: unknown) => void,
): Promise<AuditScope> {
  try {
    const resource = scopedResource(url);
    if (resource === undefined) return EMPTY_SCOPE;

    if (resource.collection === "projects") {
      const [row] = await db
        .select({ id: projects.id, organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, resource.id))
        .limit(1);
      return row === undefined
        ? EMPTY_SCOPE
        : { projectId: row.id, organizationId: row.organizationId };
    }

    if (resource.collection === "deployments") {
      const [row] = await db
        .select({ projectId: deployments.projectId, organizationId: projects.organizationId })
        .from(deployments)
        .innerJoin(projects, eq(projects.id, deployments.projectId))
        .where(eq(deployments.id, resource.id))
        .limit(1);
      return row === undefined ? EMPTY_SCOPE : row;
    }

    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, resource.id))
      .limit(1);
    return row === undefined ? EMPTY_SCOPE : { projectId: null, organizationId: row.id };
  } catch (error) {
    scopeResolveFailures += 1;
    onError?.(error);
    return EMPTY_SCOPE;
  }
}

export async function persistAudit(db: Database, record: AuditRecord): Promise<void> {
  await db.insert(auditEvents).values({
    event: record.event,
    actorUserId: record.actorUserId,
    githubLogin: record.githubLogin,
    method: record.method,
    route: record.route,
    path: record.path,
    status: record.status,
    ip: record.ip,
    userAgent: record.userAgent,
    requestId: record.requestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    metadata: {},
  });
}

export function registerAudit(
  app: FastifyInstance,
  options: { readonly disabled: boolean; readonly db: Database },
): void {
  if (options.disabled) return;

  // `onResponse` runs after the response has been handed to the client, so the
  // write is detached from the request lifecycle. Track it so `app.close()`
  // drains the queue instead of racing the pool shutdown (which would drop
  // audit rows for the last requests a process ever serves).
  const inFlight = new Set<Promise<void>>();
  app.addHook("onClose", async () => {
    await Promise.allSettled([...inFlight]);
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    // An unmatched URL is not a mutation we served. Resolving its scope from the
    // raw path would let anyone forge rows carrying a victim project/org id.
    if (request.is404) return;
    // The route template is also what we persist, so an undefined one means
    // there is no served route to attribute the row to; never fall back to the
    // raw URL (that would record attacker-chosen text as a route).
    const route = request.routeOptions.url;
    if (route === undefined) return;
    const userAgent = request.headers["user-agent"];
    const path = request.url.split("?")[0] ?? request.url;
    // Anonymous read endpoints use POST only because they carry a JSON body. They
    // are not mutations, so auditing them would fill audit_events with
    // `actorUserId: null` rows on every page view (SPEC §7.2, ruling P2-R6).
    if (isPublicReadMethodAndPath(request.method, path)) return;
    const write = (async (): Promise<void> => {
      const scope = await resolveAuditScope(options.db, request.url, (error) => {
        console.error(
          JSON.stringify({
            event: "audit_scope_resolve_failed",
            requestId: request.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      const record = createAuditRecord({
        requestId: request.id,
        method: request.method,
        route,
        path,
        status: reply.statusCode,
        actorUserId: request.user?.id ?? null,
        githubLogin: request.user?.githubLogin ?? null,
        ip: request.ip,
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, 200) : null,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
      });
      console.log(JSON.stringify({ audit: record }));
      try {
        await persistAudit(options.db, record);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "audit_persist_failed",
            requestId: record.requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
    inFlight.add(write);
    try {
      await write;
    } finally {
      inFlight.delete(write);
    }
  });
}
