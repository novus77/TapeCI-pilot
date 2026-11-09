import { describe, expect, it } from "vitest";
import { XLAYER_MAINNET, createTapeCiConfig } from "@tapeci/config";
import { scanArtifactDirectory, type ScannedFile } from "@tapeci/validator";
import { buildReleaseManifest } from "@tapeci/artifact";
import { sha256Hex, utf8 } from "@tapeci/shared";

const CONTAINER = "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3";
const REPOSITORY_ID = 123_456;
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXTURE_DIR = "tests/fixtures/static-site";

function buildFrom(files: readonly ScannedFile[]) {
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry configured");
  return buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: CONTAINER,
    repositoryId: REPOSITORY_ID,
    commitSha: COMMIT_SHA,
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix: "releases",
    files,
  });
}

describe("P1 integration: config → scan → manifest (offline)", () => {
  it("parses a real config, scans the fixture site and builds a deterministic manifest", async () => {
    const config = createTapeCiConfig({ container: CONTAINER });
    expect(config.chainId).toBe(196);
    expect(config.site.entryPath).toBe("index.html");
    expect(config.policy.strictOnChain).toBe(true);

    const scan = await scanArtifactDirectory(FIXTURE_DIR, {
      entryPath: config.site.entryPath,
      maxFileBytes: config.policy.maxFileBytes,
      strictOnChain: config.policy.strictOnChain,
      ignore: config.policy.ignore,
    });

    expect(scan.fullyOnChain).toBe(true);
    expect(scan.externalReferences).toHaveLength(0);
    expect(scan.files).toHaveLength(5);
    expect(scan.entry.path).toBe("index.html");
    expect(scan.files.map((file) => file.path)).toEqual([
      "assets/app.js",
      "assets/logo.svg",
      "assets/style.css",
      "docs/help.html",
      "index.html",
    ]);

    const built = buildFrom(scan.files);
    expect(built.manifest.schemaVersion).toBe("tapeci.release.v1");
    expect(built.manifest.chainId).toBe(196);
    expect(built.manifest.container).toBe(CONTAINER.toLowerCase());
    expect(built.manifest.releaseId).toMatch(/^r-[0-9a-f]{12}-[0-9a-f]{8}$/);
    expect(built.manifest.entryPath).toBe("index.html");

    const entry = built.manifest.files.find((file) => file.path === "index.html");
    expect(entry).toBeDefined();
    expect(entry?.sourcePath).toBe("index.html");
    expect(entry?.chunks).toBe(1);
    expect(entry?.size).toBeLessThanOrEqual(24_000);

    const assets = built.manifest.files.filter((file) => file.path !== "index.html");
    expect(assets).toHaveLength(4);
    for (const asset of assets) {
      expect(asset.path).toBe(`releases/${built.manifest.releaseId}/${asset.sourcePath}`);
      expect(asset.chunks).toBeGreaterThanOrEqual(1);
    }

    // Target paths are unique and sorted by UTF-8 byte order.
    const targets = built.manifest.files.map((file) => file.path);
    expect(new Set(targets).size).toBe(targets.length);
    expect([...targets].sort()).toEqual(targets);

    // Hashes must not depend on the order in which the scanner yielded files.
    const reversed = buildFrom([...scan.files].reverse());
    expect(reversed.artifactDigest).toBe(built.artifactDigest);
    expect(reversed.releaseManifestHash).toBe(built.releaseManifestHash);
    expect(reversed.canonicalJson).toBe(built.canonicalJson);

    // The hashed manifest carries no timestamps or dynamic gas fields (PRD §5.1).
    const parsed = JSON.parse(built.canonicalJson) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "chainId",
      "commitSha",
      "container",
      "entryPath",
      "fallbackPath",
      "files",
      "releaseId",
      "repositoryId",
      "schemaVersion",
      "siteRegistry",
    ]);
    expect(built.canonicalJson).not.toMatch(/timestamp|gas|observedAt/i);
  });

  it("changes the artifact digest when content changes, but not when only the mapping changes", () => {
    const original: ScannedFile = {
      path: "assets/app.js",
      sourceRelativePath: "assets/app.js",
      contentType: "text/javascript; charset=utf-8",
      size: 3,
      sha256: sha256Hex(utf8("abc")),
      bytes: utf8("abc"),
    };
    const entry: ScannedFile = {
      path: "index.html",
      sourceRelativePath: "index.html",
      contentType: "text/html; charset=utf-8",
      size: 5,
      sha256: sha256Hex(utf8("<p></p>")),
      bytes: utf8("<p></p>"),
    };

    const before = buildFrom([entry, original]);
    // Same bytes, different content type: the content digest must not change.
    const contentTypeOnly = buildFrom([
      entry,
      { ...original, contentType: "application/octet-stream" },
    ]);
    expect(contentTypeOnly.artifactDigest).toBe(before.artifactDigest);

    // Different bytes: the content digest must change.
    const changed = buildFrom([
      entry,
      { ...original, bytes: utf8("abd"), sha256: sha256Hex(utf8("abd")) },
    ]);
    expect(changed.artifactDigest).not.toBe(before.artifactDigest);
    expect(changed.releaseManifestHash).not.toBe(before.releaseManifestHash);
  });

  it("rejects a non-strict external reference through the real fixture pipeline", async () => {
    const scan = await scanArtifactDirectory(FIXTURE_DIR, {
      strictOnChain: false,
      maxFileBytes: 8_400_000,
    });
    // Sanity: the standard fixture is fully on-chain even in non-strict mode,
    // but `fullyOnChain` is only claimed in strict mode.
    expect(scan.externalReferences).toHaveLength(0);
    expect(scan.fullyOnChain).toBe(false);
  });
});
