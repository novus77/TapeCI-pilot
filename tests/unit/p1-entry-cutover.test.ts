import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactFile } from "@tapeci/shared";
import { TapeCiError, sha256Hex, utf8, type Hex } from "@tapeci/shared";
import {
  ReleaseStore,
  collectEntryReferences,
  prepareVersionedRelease,
  rewriteEntryReferences,
  verifyEntryReferences,
} from "@tapeci/release";
import type { ReleaseManifest } from "@tapeci/artifact";

const CONTAINER = `0x${"11".repeat(20)}` as Hex;
const REGISTRY = `0x${"22".repeat(20)}` as Hex;
const COMMIT = "a".repeat(40);

function artifact(path: string, bytes: Uint8Array, contentType: string): ArtifactFile {
  return {
    path,
    sourceRelativePath: path,
    contentType,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    bytes,
  };
}

function siteFiles(): ArtifactFile[] {
  return [
    artifact(
      "index.html",
      utf8(
        `<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head>` +
          `<body><img src="/assets/logo.svg" srcset="./assets/logo.svg 1x, /assets/logo.svg 2x">` +
          `<div style="background:url(./assets/bg.png)"></div>` +
          `<script type="module" src="assets/app.js"></script><a href="/docs/help">help</a></body></html>`,
      ),
      "text/html; charset=utf-8",
    ),
    artifact("assets/app.js", utf8("console.log('app');"), "text/javascript; charset=utf-8"),
    artifact("assets/app.css", utf8("body{color:#fff}"), "text/css; charset=utf-8"),
    artifact("assets/logo.svg", utf8("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml"),
    artifact("assets/bg.png", new Uint8Array([1, 2, 3, 4]), "image/png"),
  ];
}

function prepare(files = siteFiles(), commitSha = COMMIT) {
  return prepareVersionedRelease({
    files,
    chainId: 196,
    siteRegistry: REGISTRY,
    container: CONTAINER,
    repositoryId: 42,
    commitSha,
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix: "releases",
  });
}

const temporaryDirectories: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tapeci-release-store-"));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("P1-08 entry reference rewriting", () => {
  it("rewrites relative, root-relative, srcset and inline-style references to versioned paths", () => {
    const result = rewriteEntryReferences({
      html: new TextDecoder().decode(siteFiles()[0]!.bytes),
      entryPath: "index.html",
      releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
      pathPrefix: "releases",
      sourcePaths: siteFiles().map((file) => file.path),
    });
    expect(result.unresolved).toEqual([]);
    expect(result.html).toContain('href="/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.css"');
    expect(result.html).toContain('src="/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js"');
    expect(result.html).toContain('src="/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/logo.svg"');
    expect(result.html).toContain('srcset="/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/logo.svg 1x, /releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/logo.svg 2x"');
    expect(result.html).toContain("url(/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/bg.png)");
    // navigation anchors are preserved
    expect(result.html).toContain('<a href="/docs/help">help</a>');
  });

  it("leaves external/data URLs untouched and fails verification for unrewritten entries", () => {
    const html = '<img src="https://cdn.example.com/x.png"><img src="./assets/logo.svg">';
    const rewritten = rewriteEntryReferences({
      html,
      entryPath: "index.html",
      releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
      pathPrefix: "releases",
      sourcePaths: ["index.html", "assets/logo.svg"],
    });
    expect(rewritten.html).toContain('https://cdn.example.com/x.png');
    expect(rewritten.references.some((reference) => reference.external)).toBe(true);

    const prepared = prepare();
    const unrewritten = verifyEntryReferences(html, prepared.manifest);
    expect(unrewritten.ok).toBe(false);
    expect(unrewritten.missing).toContain("assets/logo.svg");
    expect(unrewritten.external).toContain("https://cdn.example.com/x.png");
  });

  it("collects references without rewriting", () => {
    const html = '<link href="./assets/app.css"><a href="./docs/help">help</a>';
    const collected = collectEntryReferences(html, "index.html");
    expect(collected.references.some((reference) => reference.attribute === "href")).toBe(true);
    expect(collected.missing).toContain("assets/app.css");
  });
});

describe("P1-08 versioned release preparation", () => {
  it("rewrites the entry, versions assets, and produces a verifiable deterministic manifest", () => {
    const prepared = prepare();
    expect(prepared.manifest.entryPath).toBe("index.html");
    expect(prepared.manifest.releaseId).toMatch(/^r-[0-9a-f]{12}-[0-9a-f]{8}$/);
    expect(prepared.entryBytes.length).toBeLessThanOrEqual(24_000);
    expect(prepared.manifest.files.find((file) => file.path === "index.html")?.chunks).toBe(1);

    const asset = prepared.manifest.files.find((file) => file.sourcePath === "assets/app.js");
    expect(asset?.path).toBe(`releases/${prepared.manifest.releaseId}/assets/app.js`);

    const verification = verifyEntryReferences(prepared.entryHtml, prepared.manifest);
    expect(verification.ok).toBe(true);
    expect(verification.missing).toEqual([]);

    const again = prepare();
    expect(again.releaseId).toBe(prepared.releaseId);
    expect(again.releaseManifestHash).toBe(prepared.releaseManifestHash);
    expect(again.artifactDigest).toBe(prepared.artifactDigest);
    expect(again.entryHtml).toBe(prepared.entryHtml);

    // Changing content changes the release id and the manifest hash.
    const changedFiles = siteFiles().map((file) =>
      file.path === "assets/app.js" ? artifact("assets/app.js", utf8("changed"), file.contentType) : file,
    );
    const changed = prepare(changedFiles);
    expect(changed.releaseId).not.toBe(prepared.releaseId);
    expect(changed.releaseManifestHash).not.toBe(prepared.releaseManifestHash);
  });

  it("rejects an entry that exceeds the single-transaction size after rewriting", () => {
    const big = artifact(
      "index.html",
      utf8(`<!doctype html>${"x".repeat(24_500)}`),
      "text/html; charset=utf-8",
    );
    expect(() => prepare([big])).toThrowError(TapeCiError);
  });
});

describe("P1-08 release store", () => {
  it("round-trips a release with exact entry bytes and lists it", async () => {
    const prepared = prepare();
    const store = new ReleaseStore(await tempDir());
    await store.save({
      manifest: prepared.manifest,
      artifactDigest: prepared.artifactDigest,
      releaseManifestHash: prepared.releaseManifestHash,
      entryBytes: prepared.entryBytes,
    });
    const loaded = await store.load(prepared.releaseId);
    expect(loaded.record.releaseId).toBe(prepared.releaseId);
    expect(sha256Hex(loaded.entryBytes)).toBe(prepared.manifest.files.find((file) => file.path === "index.html")?.sha256);
    expect(await store.list()).toEqual([
      { releaseId: prepared.releaseId, commitSha: prepared.manifest.commitSha, fileCount: prepared.manifest.files.length },
    ]);
  });

  it("rejects a tampered stored entry and a bad manifest hash", async () => {
    const prepared = prepare();
    const dir = await tempDir();
    const store = new ReleaseStore(dir);
    await store.save({
      manifest: prepared.manifest,
      artifactDigest: prepared.artifactDigest,
      releaseManifestHash: prepared.releaseManifestHash,
      entryBytes: prepared.entryBytes,
    });
    const file = join(dir, `${prepared.releaseId}.json`);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw.entryBase64 = Buffer.from(utf8("tampered")).toString("base64");
    await writeFile(file, JSON.stringify(raw));
    await expect(store.load(prepared.releaseId)).rejects.toThrowError(TapeCiError);

    const good = prepare().manifest as ReleaseManifest;
    await expect(
      store.save({
        manifest: good,
        artifactDigest: prepared.artifactDigest,
        releaseManifestHash: `0x${"00".repeat(32)}`,
        entryBytes: prepared.entryBytes,
      }),
    ).rejects.toThrowError(TapeCiError);
  });
});
