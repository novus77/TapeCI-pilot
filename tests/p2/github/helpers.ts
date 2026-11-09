/**
 * Shared fixtures for the P2 GitHub tests.
 *
 * - tar helpers: `tar.c` (loaded from the @tapeci/github dependency so tests do
 *   not need their own `tar` install) for well-formed archives, plus a raw
 *   ustar builder for malicious entries (`../`, absolute, links, devices…).
 * - database helpers: ephemeral database + migrations + a fully seeded project.
 * - webhook helpers: signed push requests (no network).
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  artifactUploads,
  buildTokens,
  containers,
  createDatabase,
  createTestDatabase,
  deploymentEvents,
  deployments,
  githubInstallations,
  migrateUp,
  operatorSessions,
  projectMembers,
  projects,
  users,
  webhookDeliveries,
  type Database,
} from "@tapeci/database";
import { computeWebhookSignature } from "@tapeci/github";

// ---------------------------------------------------------------------------
// Test identities
// ---------------------------------------------------------------------------

export const TEST_GITHUB_USER_ID = 424_242;
export const TEST_GITHUB_LOGIN = "octocat";
export const TEST_ACCOUNT_ID = 424_242;
export const TEST_INSTALLATION_ID = 555_001;
export const TEST_REPOSITORY_ID = 987_001;
export const TEST_REPO_FULL_NAME = "octocat/site";
export const TEST_DEFAULT_BRANCH = "main";
export const TEST_COMMIT_SHA = "a".repeat(40);
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-do-not-use-in-prod";

export function hexAddress(prefix: string): string {
  return `0x${prefix.repeat(40).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// In-memory tar fixtures
// ---------------------------------------------------------------------------

const requireFromGitHubPackage = createRequire(
  new URL("../../../packages/github/package.json", import.meta.url),
);

interface TarCreateOptions {
  readonly cwd?: string;
  readonly portable?: boolean;
  readonly noMtime?: boolean;
  readonly gzip?: boolean;
}

interface TarCreateModule {
  readonly c: (
    options: TarCreateOptions,
    entries: readonly string[],
  ) => NodeJS.ReadableStream;
}

const tarCreateModule = requireFromGitHubPackage("tar") as TarCreateModule;

/** Collect a tar stream into a Buffer. */
export function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    stream.on("data", (...args: unknown[]) => {
      const chunk = args[0];
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else rejectPromise(new Error("tar stream emitted a non-byte chunk"));
    });
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
    stream.on("error", (...args: unknown[]) => {
      const error = args[0];
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Build a real tar archive from a path→content map using `tar.c`.
 * Only top-level path components are passed to tar, which recurses into them.
 */
export async function buildTarFromFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<Buffer> {
  const root = await fs.mkdtemp(join(tmpdir(), "tapeci-tar-fixture-"));
  try {
    const topLevel = new Set<string>();
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(root, ...relativePath.split("/"));
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, typeof content === "string" ? Buffer.from(content, "utf8") : content);
      const [first] = relativePath.split("/");
      if (first !== undefined) topLevel.add(first);
    }
    const stream = tarCreateModule.c(
      { cwd: root, portable: true, noMtime: true, gzip: false },
      [...topLevel].sort(),
    );
    return await collectStream(stream);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export type RawTarEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "fifo"
  | "chardev";

export interface RawTarEntry {
  readonly path: string;
  readonly type?: RawTarEntryType;
  readonly body?: string | Uint8Array;
  readonly linkpath?: string;
  /** Overrides the size field without providing the body (header-only fixtures). */
  readonly declaredSize?: number;
}

const TYPEFLAGS: Record<RawTarEntryType, string> = {
  file: "0",
  directory: "5",
  symlink: "2",
  hardlink: "1",
  fifo: "6",
  chardev: "3",
};

function octalField(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function rawTarHeader(
  path: string,
  typeflag: string,
  size: number,
  linkpath: string,
): Buffer {
  const header = Buffer.alloc(512, 0);
  const name = Buffer.from(path, "utf8");
  if (name.length > 100) throw new Error(`tar fixture name too long: ${path}`);
  name.copy(header, 0);
  header.write(octalField(0o644, 8), 100, "ascii");
  header.write(octalField(0, 8), 108, "ascii");
  header.write(octalField(0, 8), 116, "ascii");
  header.write(octalField(size, 12), 124, "ascii");
  header.write(octalField(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(typeflag, 156, "ascii");
  Buffer.from(linkpath, "utf8").copy(header, 157);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write("root", 265, "ascii");
  header.write("root", 297, "ascii");
  header.write(octalField(0, 8), 329, "ascii");
  header.write(octalField(0, 8), 337, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Build a raw ustar archive (full control over paths/types for attack tests). */
export function buildRawTar(entries: readonly RawTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const typeflag = TYPEFLAGS[type];
    const body =
      entry.body === undefined
        ? Buffer.alloc(0)
        : typeof entry.body === "string"
          ? Buffer.from(entry.body, "utf8")
          : Buffer.from(entry.body);
    const declaredSize = entry.declaredSize ?? body.length;
    blocks.push(rawTarHeader(entry.path, typeflag, declaredSize, entry.linkpath ?? ""));
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
      body.copy(padded, 0);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------

export interface TestDatabaseHandle {
  readonly db: Database;
  readonly pool: ReturnType<typeof createDatabase>["pool"];
  drop(): Promise<void>;
}

/** Create an ephemeral database, apply all migrations, return a Drizzle handle. */
export async function createMigratedTestDatabase(): Promise<TestDatabaseHandle> {
  const testDatabase = await createTestDatabase();
  try {
    await migrateUp(testDatabase.url);
  } catch (error) {
    await testDatabase.drop().catch(() => undefined);
    throw error;
  }
  const { db, pool } = createDatabase(testDatabase.url);
  return {
    db,
    pool,
    drop: async () => {
      await pool.end();
      await testDatabase.drop();
    },
  };
}

export interface SeededProject {
  readonly ownerUserId: string;
  readonly installationRowId: string;
  readonly containerId: string;
  readonly projectId: string;
  readonly registryAddress: string;
}

export interface SeedProjectOverrides {
  readonly repositoryId?: number;
  readonly defaultBranch?: string;
  readonly repoFullName?: string;
  readonly installationId?: number;
}

/** Seed user + installation + container + project for webhook/buid-token tests. */
export async function seedProject(
  db: Database,
  overrides: SeedProjectOverrides = {},
): Promise<SeededProject> {
  const repositoryId = overrides.repositoryId ?? TEST_REPOSITORY_ID;
  const defaultBranch = overrides.defaultBranch ?? TEST_DEFAULT_BRANCH;
  const repoFullName = overrides.repoFullName ?? TEST_REPO_FULL_NAME;
  const installationId = overrides.installationId ?? TEST_INSTALLATION_ID;
  const [user] = await db
    .insert(users)
    .values({ githubUserId: TEST_GITHUB_USER_ID, githubLogin: TEST_GITHUB_LOGIN })
    .returning();
  if (user === undefined) throw new Error("failed to seed user");
  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId,
      githubAccountId: TEST_ACCOUNT_ID,
      accountLogin: TEST_GITHUB_LOGIN,
    })
    .returning();
  if (installation === undefined) throw new Error("failed to seed installation");
  const registryAddress = hexAddress("ab");
  const [container] = await db
    .insert(containers)
    .values({
      chainId: 196,
      factoryAddress: hexAddress("11"),
      processorIndex: 1,
      processorAddress: hexAddress("22"),
      tokenId: "1",
      containerAddress: hexAddress("33"),
      registryAddress,
      bindingAddress: hexAddress("44"),
    })
    .returning();
  if (container === undefined) throw new Error("failed to seed container");
  const [project] = await db
    .insert(projects)
    .values({
      ownerUserId: user.id,
      githubInstallationId: installation.id,
      githubRepositoryId: repositoryId,
      repoFullName,
      defaultBranch,
      containerId: container.id,
      // §11.2 admission: a seeded project exists to have pushes build, so it must be
      // enabled. Migration 0016 only backfilled rows that existed then; new rows
      // default to false, and leaving that alone would make every happy-path webhook
      // test skip with BUILD_DISABLED.
      buildEnabled: true,
    })
    .returning();
  if (project === undefined) throw new Error("failed to seed project");
  return {
    ownerUserId: user.id,
    installationRowId: installation.id,
    containerId: container.id,
    projectId: project.id,
    registryAddress,
  };
}

/** Insert a deployment directly (for build-token tests). */
export async function seedDeployment(
  db: Database,
  seeded: SeededProject,
  commitSha = TEST_COMMIT_SHA,
): Promise<string> {
  const [deployment] = await db
    .insert(deployments)
    .values({
      projectId: seeded.projectId,
      containerId: seeded.containerId,
      createdByUserId: seeded.ownerUserId,
      triggerKind: "manual",
      commitSha,
      state: "RECEIVED",
      registryAddress: seeded.registryAddress,
    })
    .returning({ id: deployments.id });
  if (deployment === undefined) throw new Error("failed to seed deployment");
  return deployment.id;
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

export interface MakePushPayloadOptions {
  readonly ref?: string;
  readonly after?: string;
  readonly deleted?: boolean;
  readonly repositoryId?: number;
  readonly fullName?: string;
  readonly ownerLogin?: string;
  readonly installationId?: number;
}

export function makePushPayload(options: MakePushPayloadOptions = {}): Record<string, unknown> {
  const fullName = options.fullName ?? TEST_REPO_FULL_NAME;
  return {
    ref: options.ref ?? `refs/heads/${TEST_DEFAULT_BRANCH}`,
    before: "0".repeat(40),
    after: options.after ?? TEST_COMMIT_SHA,
    created: false,
    deleted: options.deleted ?? false,
    forced: false,
    repository: {
      id: options.repositoryId ?? TEST_REPOSITORY_ID,
      name: "site",
      full_name: fullName,
      owner: {
        login: options.ownerLogin ?? TEST_GITHUB_LOGIN,
        id: TEST_ACCOUNT_ID,
      },
      default_branch: TEST_DEFAULT_BRANCH,
    },
    installation: {
      id: options.installationId ?? TEST_INSTALLATION_ID,
      node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNTU1MDAx",
    },
    pusher: { name: TEST_GITHUB_LOGIN, email: "octocat@example.com" },
  };
}

export interface SignedPushRequest {
  readonly rawBody: string;
  readonly headers: Record<string, string>;
}

/** Serialize and sign a push payload exactly as GitHub would. */
export function signPushRequest(
  payload: unknown,
  options: {
    readonly deliveryId: string;
    readonly secret?: string;
    readonly event?: string;
    readonly rawBody?: string;
  },
): SignedPushRequest {
  const secret = options.secret ?? TEST_WEBHOOK_SECRET;
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": computeWebhookSignature(secret, rawBody),
      "x-github-delivery": options.deliveryId,
      "x-github-event": options.event ?? "push",
    },
  };
}

/** Delete all rows created by these helpers (children first). */
export async function resetDatabase(db: Database): Promise<void> {
  await db.delete(deploymentEvents);
  await db.delete(buildTokens);
  await db.delete(artifactUploads);
  await db.delete(operatorSessions);
  await db.delete(deployments);
  await db.delete(webhookDeliveries);
  await db.delete(projectMembers);
  await db.delete(projects);
  await db.delete(containers);
  await db.delete(githubInstallations);
  await db.delete(users);
}
