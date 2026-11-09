import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX,
  MAX_FILE_BYTES,
  TapeCiError,
  compareUtf8,
  sha256Hex,
  sha256HexOfString,
  utf8,
  type Hex,
} from "@tapeci/shared";
import {
  MANIFEST_SCHEMA_VERSION,
  buildManifestFiles,
  buildReleaseManifest,
  computeArtifactDigest,
  deriveReleaseId,
  releaseManifestHash,
  type BuildReleaseManifestInput,
  type ManifestSourceFile,
  type ReleaseManifest,
} from "@tapeci/artifact";
import { scanArtifactFiles } from "@tapeci/validator";

const SITE_REGISTRY = "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6";
const CONTAINER = "0x536add8f30f03b69f6fbf29d425a816a0dc50106";
const COMMIT_SHA = "40994bd65baedbda4df72cb0985031a5f082f606";
const REPOSITORY_ID = 123_456;

const ENTRY_HTML = "<!doctype html><html><body><h1>tapeci</h1></body></html>";

function sourceFile(path: string, content: string, contentType: string): ManifestSourceFile {
  const bytes = utf8(content);
  return { path, size: bytes.length, sha256: sha256Hex(bytes), contentType };
}

/** Metadata-only file: the manifest hashes declared metadata, never file bytes. */
function declaredFile(path: string, size: number, contentType: string): ManifestSourceFile {
  return { path, size, sha256: sha256HexOfString(`${path}:${size}:${contentType}`), contentType };
}

function baseFiles(): ManifestSourceFile[] {
  return [
    sourceFile("index.html", ENTRY_HTML, "text/html; charset=utf-8"),
    sourceFile("assets/app.js", "console.log('tapeci')", "text/javascript; charset=utf-8"),
    sourceFile("assets/style.css", "body{margin:0}", "text/css; charset=utf-8"),
    sourceFile("assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image/svg+xml"),
  ];
}

interface Overrides {
  readonly chainId?: number;
  readonly siteRegistry?: string;
  readonly container?: string;
  readonly repositoryId?: number;
  readonly commitSha?: string;
  readonly entryPath?: string;
  readonly fallbackPath?: string;
  readonly files?: readonly ManifestSourceFile[];
  readonly releaseId?: string;
  readonly pathPrefix?: string;
}

function makeInput(overrides: Overrides = {}): BuildReleaseManifestInput {
  return {
    chainId: overrides.chainId ?? 196,
    siteRegistry: (overrides.siteRegistry ?? SITE_REGISTRY) as Hex,
    container: (overrides.container ?? CONTAINER) as Hex,
    repositoryId: overrides.repositoryId ?? REPOSITORY_ID,
    commitSha: overrides.commitSha ?? COMMIT_SHA,
    files: overrides.files ?? baseFiles(),
    ...(overrides.entryPath === undefined ? {} : { entryPath: overrides.entryPath }),
    ...(overrides.fallbackPath === undefined ? {} : { fallbackPath: overrides.fallbackPath }),
    ...(overrides.releaseId === undefined ? {} : { releaseId: overrides.releaseId }),
    ...(overrides.pathPrefix === undefined ? {} : { pathPrefix: overrides.pathPrefix }),
  };
}

function captureError(fn: () => unknown): TapeCiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TapeCiError) return error;
    throw error;
  }
  throw new Error("expected function to throw a TapeCiError");
}

function expectCode(error: TapeCiError, code: string): void {
  expect(error.code).toBe(code);
}

function utf8Sorted(paths: readonly string[]): string[] {
  return [...paths].sort(compareUtf8);
}

describe("buildReleaseManifest", () => {
  it("builds a deterministic manifest v1 (PRD §5.1)", () => {
    const result = buildReleaseManifest(makeInput());
    const { manifest } = result;
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.chainId).toBe(196);
    expect(manifest.siteRegistry).toBe(SITE_REGISTRY);
    expect(manifest.container).toBe(CONTAINER);
    expect(manifest.repositoryId).toBe(REPOSITORY_ID);
    expect(manifest.commitSha).toBe(COMMIT_SHA);
    expect(manifest.entryPath).toBe("index.html");
    expect(manifest.fallbackPath).toBe("index.html");
    expect(manifest.releaseId).toMatch(/^r-[0-9a-f]{12}-[0-9a-f]{8}$/);
    expect(manifest.releaseId).toBe(deriveReleaseId(COMMIT_SHA, result.artifactDigest));
    expect(result.artifactDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.releaseManifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.releaseManifestHash).toBe(releaseManifestHash(manifest));
  });

  it("keeps the entry unversioned and versions every other asset", () => {
    const result = buildReleaseManifest(makeInput());
    const entry = result.manifest.files.find((file) => file.path === "index.html");
    expect(entry).toEqual({
      path: "index.html",
      sourcePath: "index.html",
      size: utf8(ENTRY_HTML).length,
      sha256: sha256Hex(utf8(ENTRY_HTML)),
      contentType: "text/html; charset=utf-8",
      chunks: 1,
    });
    const prefix = `releases/${result.manifest.releaseId}/`;
    const assets = result.manifest.files.filter((file) => file.path !== "index.html");
    expect(assets).toHaveLength(baseFiles().length - 1);
    for (const asset of assets) {
      expect(asset.path).toBe(`${prefix}${asset.sourcePath}`);
    }
  });

  it("sorts manifest rows by target path in UTF-8 order", () => {
    const result = buildReleaseManifest(makeInput());
    const paths = result.manifest.files.map((file) => file.path);
    expect(paths).toEqual(utf8Sorted(paths));
  });

  it("is deterministic under shuffled input (UT-05)", () => {
    const forward = buildReleaseManifest(makeInput());
    const shuffled = buildReleaseManifest(makeInput({ files: [...baseFiles()].reverse() }));
    expect(shuffled.artifactDigest).toBe(forward.artifactDigest);
    expect(shuffled.releaseManifestHash).toBe(forward.releaseManifestHash);
    expect(shuffled.manifest.releaseId).toBe(forward.manifest.releaseId);
    expect(shuffled.canonicalJson).toBe(forward.canonicalJson);
    expect(shuffled.manifest).toEqual(forward.manifest);
  });

  it("treats NFD and NFC file names as the same artifact", () => {
    const nfc = sourceFile("assets/caf\u00e9.js", "x", "text/javascript; charset=utf-8");
    const nfd = sourceFile("assets/cafe\u0301.js", "x", "text/javascript; charset=utf-8");
    const nfcRelease = buildReleaseManifest(makeInput({ files: [...baseFiles(), nfc] }));
    const nfdRelease = buildReleaseManifest(makeInput({ files: [...baseFiles(), nfd] }));
    expect(nfdRelease.artifactDigest).toBe(nfcRelease.artifactDigest);
    expect(nfdRelease.releaseManifestHash).toBe(nfcRelease.releaseManifestHash);
    expect(nfdRelease.manifest.releaseId).toBe(nfcRelease.manifest.releaseId);
    const row = nfdRelease.manifest.files.find((file) => file.sourcePath.includes("caf"));
    expect(row?.sourcePath).toBe("assets/caf\u00e9.js");
    expect(row?.path).toBe(`releases/${nfdRelease.manifest.releaseId}/assets/caf\u00e9.js`);
  });

  it("supports custom entry and pathPrefix", () => {
    const result = buildReleaseManifest(
      makeInput({
        entryPath: "site/index.html",
        pathPrefix: "static/releases",
        files: [
          sourceFile("site/index.html", ENTRY_HTML, "text/html; charset=utf-8"),
          sourceFile("site/app.js", "x", "text/javascript; charset=utf-8"),
        ],
      }),
    );
    expect(result.manifest.entryPath).toBe("site/index.html");
    const entry = result.manifest.files.find((file) => file.path === "site/index.html");
    expect(entry?.sourcePath).toBe("site/index.html");
    const asset = result.manifest.files.find((file) => file.sourcePath === "site/app.js");
    expect(asset?.path).toBe(
      `static/releases/${result.manifest.releaseId}/site/app.js`,
    );
  });

  it("hashes only v1 fields: no timestamps or gas estimates", () => {
    const result = buildReleaseManifest(makeInput());
    expect(Object.keys(result.manifest).sort()).toEqual(
      [
        "schemaVersion",
        "chainId",
        "siteRegistry",
        "container",
        "repositoryId",
        "commitSha",
        "releaseId",
        "entryPath",
        "fallbackPath",
        "files",
      ].sort(),
    );
    for (const row of result.manifest.files) {
      expect(Object.keys(row).sort()).toEqual(
        ["path", "sourcePath", "size", "sha256", "contentType", "chunks"].sort(),
      );
    }
    expect(result.canonicalJson).not.toMatch(/timestamp|gas|createdAt|updatedAt|nonce/i);
    expect(JSON.parse(result.canonicalJson)).toEqual(result.manifest);
  });

  it("changes the manifest hash when only the fallback path changes", () => {
    const plain = buildReleaseManifest(makeInput());
    const withFallback = buildReleaseManifest(makeInput({ fallbackPath: "help.html" }));
    expect(withFallback.manifest.fallbackPath).toBe("help.html");
    expect(withFallback.artifactDigest).toBe(plain.artifactDigest);
    expect(withFallback.releaseManifestHash).not.toBe(plain.releaseManifestHash);
  });

  it("integrates with the P1-03 scanner output", () => {
    const scanned = scanArtifactFiles([
      { relativePath: "index.html", bytes: utf8(ENTRY_HTML) },
      { relativePath: "assets/app.js", bytes: utf8("console.log(1)") },
      { relativePath: "assets/style.css", bytes: utf8("body{color:red}") },
      { relativePath: "docs/help.html", bytes: utf8("<!doctype html><p>help</p>") },
    ]);
    const result = buildReleaseManifest(makeInput({ files: scanned.files }));
    expect(result.manifest.files).toHaveLength(scanned.files.length);
    expect(result.artifactDigest).toBe(computeArtifactDigest(scanned.files));
    expect(result.manifest.files.find((file) => file.path === "index.html")?.contentType).toBe(
      "text/html; charset=utf-8",
    );
    expect(
      result.manifest.files.find((file) => file.sourcePath === "docs/help.html")?.path,
    ).toBe(`releases/${result.manifest.releaseId}/docs/help.html`);
  });
});

describe("deriveReleaseId", () => {
  it("derives a stable id from commit + artifact digest", () => {
    const digest = sha256HexOfString("artifact content");
    expect(deriveReleaseId(COMMIT_SHA, digest)).toBe(
      `r-${COMMIT_SHA.slice(0, 12)}-${digest.slice(2, 10)}`,
    );
    expect(buildReleaseManifest(makeInput()).manifest.releaseId).toBe(
      deriveReleaseId(COMMIT_SHA, computeArtifactDigest(baseFiles())),
    );
  });

  it.each([
    ["uppercase commit", COMMIT_SHA.toUpperCase()],
    ["short commit", COMMIT_SHA.slice(0, 12)],
    ["non-hex commit", "z".repeat(40)],
  ])("rejects a bad commit sha (%s)", (_name, commitSha) => {
    const digest = sha256HexOfString("artifact");
    expectCode(captureError(() => deriveReleaseId(commitSha, digest)), "INVALID_ARTIFACT");
  });

  it.each(["0x1234", "not-a-digest", sha256HexOfString("x").slice(0, -2)])(
    "rejects a bad artifact digest %j",
    (digest) => {
      expectCode(captureError(() => deriveReleaseId(COMMIT_SHA, digest)), "INVALID_ARTIFACT");
    },
  );

  it("honours a supplied releaseId and rejects invalid ones", () => {
    const releaseId = "r-aaaaaaaaaaaa-bbbbbbbb";
    expect(buildReleaseManifest(makeInput({ releaseId })).manifest.releaseId).toBe(releaseId);
    for (const invalid of ["r-AAAA", "release-1", "", "r-aaaaaaaaaaaa-bbbbbbbbg"]) {
      expectCode(
        captureError(() => buildReleaseManifest(makeInput({ releaseId: invalid }))),
        "INVALID_ARTIFACT",
      );
    }
  });
});

describe("computeArtifactDigest", () => {
  it("ignores order and contentType (UT-05)", () => {
    const files = baseFiles();
    const digest = computeArtifactDigest(files);
    const reordered = [...files].reverse().map((file) => ({
      ...file,
      contentType: "application/octet-stream",
    }));
    expect(computeArtifactDigest(reordered)).toBe(digest);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when file content changes", () => {
    const before = computeArtifactDigest(baseFiles());
    const changed = baseFiles().map((file) =>
      file.path === "assets/app.js" ? sourceFile("assets/app.js", "console.log('changed')", "text/javascript; charset=utf-8") : file,
    );
    expect(computeArtifactDigest(changed)).not.toBe(before);
  });

  it("does not change when only contentType changes", () => {
    const before = computeArtifactDigest(baseFiles());
    const retyped = baseFiles().map((file) =>
      file.path === "assets/app.js" ? { ...file, contentType: "application/javascript" } : file,
    );
    expect(computeArtifactDigest(retyped)).toBe(before);
  });

  it("rejects empty and duplicate inputs", () => {
    expectCode(captureError(() => computeArtifactDigest([])), "INVALID_ARTIFACT");
    const duplicate = [...baseFiles(), sourceFile("index.html", ENTRY_HTML, "text/html")];
    expectCode(captureError(() => computeArtifactDigest(duplicate)), "INVALID_ARTIFACT");
  });
});

describe("buildManifestFiles", () => {
  it("maps entry and asset targets and computes chunks", () => {
    const rows = buildManifestFiles(baseFiles(), { releaseId: "r-aaaaaaaaaaaa-bbbbbbbb" });
    expect(rows.map((row) => row.path)).toEqual(utf8Sorted(rows.map((row) => row.path)));
    const entry = rows.find((row) => row.path === "index.html");
    expect(entry?.sourcePath).toBe("index.html");
    expect(entry?.chunks).toBe(1);
    const asset = rows.find((row) => row.sourcePath === "assets/app.js");
    expect(asset?.path).toBe("releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js");
    expect(rows.every((row) => row.chunks === Math.max(1, Math.ceil(row.size / CHUNK_MAX)))).toBe(
      true,
    );
  });

  it("supports a custom pathPrefix", () => {
    const rows = buildManifestFiles(baseFiles(), {
      releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
      pathPrefix: "static/releases",
    });
    expect(
      rows.some((row) => row.path === "static/releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js"),
    ).toBe(true);
  });

  it("rejects a missing or non-HTML entry", () => {
    expectCode(
      captureError(() =>
        buildManifestFiles([sourceFile("app.js", "x", "text/javascript")], {
          releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
        }),
      ),
      "INVALID_ARTIFACT",
    );
    expectCode(
      captureError(() =>
        buildManifestFiles([sourceFile("index.css", "body{}", "text/css")], {
          entryPath: "index.css",
          releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
        }),
      ),
      "INVALID_ARTIFACT",
    );
  });

  it("rejects an invalid releaseId", () => {
    expectCode(
      captureError(() => buildManifestFiles(baseFiles(), { releaseId: "r-bad" })),
      "INVALID_ARTIFACT",
    );
  });
});

describe("chunk counts and size limits (UT-01/UT-02/UT-03/UT-08)", () => {
  it("computes 1 and 2 chunks across the 24,000-byte boundary", () => {
    const result = buildReleaseManifest(
      makeInput({
        files: [
          declaredFile("index.html", CHUNK_MAX, "text/html; charset=utf-8"),
          declaredFile("assets/edge.bin", CHUNK_MAX + 1, "application/octet-stream"),
          declaredFile("assets/max.bin", MAX_FILE_BYTES, "application/octet-stream"),
        ],
      }),
    );
    const chunks = new Map(result.manifest.files.map((file) => [file.sourcePath, file.chunks]));
    expect(chunks.get("index.html")).toBe(1);
    expect(chunks.get("assets/edge.bin")).toBe(2);
    expect(chunks.get("assets/max.bin")).toBe(350);
  });

  it("accepts an entry of exactly 24,000 bytes", () => {
    const result = buildReleaseManifest(
      makeInput({
        files: [
          declaredFile("index.html", CHUNK_MAX, "text/html; charset=utf-8"),
          sourceFile("assets/app.js", "x", "text/javascript; charset=utf-8"),
        ],
      }),
    );
    expect(result.manifest.files.find((file) => file.path === "index.html")?.size).toBe(CHUNK_MAX);
  });

  it("rejects an entry of 24,001 bytes (UT-08)", () => {
    expectCode(
      captureError(() =>
        buildReleaseManifest(
          makeInput({
            files: [
              declaredFile("index.html", CHUNK_MAX + 1, "text/html; charset=utf-8"),
              sourceFile("assets/app.js", "x", "text/javascript; charset=utf-8"),
            ],
          }),
        ),
      ),
      "INVALID_ARTIFACT",
    );
  });

  it("rejects a file above 8,400,000 bytes (UT-03)", () => {
    expectCode(
      captureError(() =>
        buildReleaseManifest(
          makeInput({
            files: [
              sourceFile("index.html", ENTRY_HTML, "text/html; charset=utf-8"),
              declaredFile("assets/too-big.bin", MAX_FILE_BYTES + 1, "application/octet-stream"),
            ],
          }),
        ),
      ),
      "FILE_TOO_LARGE",
    );
  });
});

describe("input validation", () => {
  it.each([1, 56, 0, 1960])("rejects chainId %s", (chainId) => {
    expectCode(captureError(() => buildReleaseManifest(makeInput({ chainId }))), "INVALID_ARTIFACT");
  });

  it.each(["0x123", "not-an-address", "0x" + "g".repeat(40)])(
    "rejects container %j",
    (container) => {
      expectCode(
        captureError(() => buildReleaseManifest(makeInput({ container }))),
        "INVALID_ARTIFACT",
      );
    },
  );

  it.each(["0x123", "not-an-address"])("rejects siteRegistry %j", (siteRegistry) => {
    expectCode(
      captureError(() => buildReleaseManifest(makeInput({ siteRegistry }))),
      "INVALID_ARTIFACT",
    );
  });

  it("normalizes checksummed addresses to lowercase for determinism", () => {
    const checksummed = "0xD6EFb7adCc9C83dC4924Ad56f6a8E4e969b9ADB6";
    const result = buildReleaseManifest(makeInput({ siteRegistry: checksummed }));
    expect(result.manifest.siteRegistry).toBe(SITE_REGISTRY);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects repositoryId %s", (repositoryId) => {
    expectCode(
      captureError(() => buildReleaseManifest(makeInput({ repositoryId }))),
      "INVALID_ARTIFACT",
    );
  });

  it.each([
    ["uppercase", COMMIT_SHA.toUpperCase()],
    ["short", COMMIT_SHA.slice(0, 39)],
    ["non-hex", "g".repeat(40)],
  ])("rejects commitSha (%s)", (_name, commitSha) => {
    expectCode(
      captureError(() => buildReleaseManifest(makeInput({ commitSha }))),
      "INVALID_ARTIFACT",
    );
  });

  it("rejects duplicate source paths and duplicate targets", () => {
    expectCode(
      captureError(() =>
        buildReleaseManifest(
          makeInput({ files: [...baseFiles(), sourceFile("assets/app.js", "x", "text/javascript")] }),
        ),
      ),
      "INVALID_ARTIFACT",
    );
  });

  it("rejects a missing entry file", () => {
    expectCode(
      captureError(() =>
        buildReleaseManifest(
          makeInput({ files: [sourceFile("assets/app.js", "x", "text/javascript")] }),
        ),
      ),
      "INVALID_ARTIFACT",
    );
  });
});

describe("releaseManifestHash", () => {
  it("is stable and independent of input row order", () => {
    const result = buildReleaseManifest(makeInput());
    const reversed: ReleaseManifest = {
      ...result.manifest,
      files: [...result.manifest.files].reverse(),
    };
    expect(releaseManifestHash(reversed)).toBe(result.releaseManifestHash);
  });

  it.each([
    ["top-level timestamp", { timestamp: "2026-10-19T00:00:00Z" }],
    ["top-level gas", { gasLimitWei: "0" }],
  ])("rejects a manifest with %s", (_name, extra) => {
    const result = buildReleaseManifest(makeInput());
    const withDynamic = { ...result.manifest, ...extra } as unknown as ReleaseManifest;
    expectCode(captureError(() => releaseManifestHash(withDynamic)), "INVALID_ARTIFACT");
  });

  it("rejects a file row with extra dynamic fields", () => {
    const result = buildReleaseManifest(makeInput());
    const files = result.manifest.files.map((file) => ({ ...file, gasEstimate: "1000" }));
    const withDynamic = { ...result.manifest, files } as unknown as ReleaseManifest;
    expectCode(captureError(() => releaseManifestHash(withDynamic)), "INVALID_ARTIFACT");
  });

  it("rejects inconsistent chunk counts", () => {
    const result = buildReleaseManifest(makeInput());
    const files = result.manifest.files.map((file) => ({ ...file, chunks: 2 }));
    const corrupt = { ...result.manifest, files };
    expectCode(captureError(() => releaseManifestHash(corrupt)), "INVALID_ARTIFACT");
  });

  it("rejects a duplicate target path, including one colliding with the entry", () => {
    const result = buildReleaseManifest(makeInput());
    const entryRow = result.manifest.files.find((file) => file.path === "index.html");
    if (entryRow === undefined) throw new Error("expected an index.html row");
    const duplicatedEntry = { ...entryRow, sourcePath: "assets/fake.js" };
    const corrupt = {
      ...result.manifest,
      files: [...result.manifest.files, duplicatedEntry],
    } as unknown as ReleaseManifest;
    expectCode(captureError(() => releaseManifestHash(corrupt)), "INVALID_ARTIFACT");
  });
});
