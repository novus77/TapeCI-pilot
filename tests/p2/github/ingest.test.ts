import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, TapeCiError, sha256Hex } from "@tapeci/shared";
import {
  DEFAULT_ARTIFACT_LIMITS,
  GithubError,
  LocalObjectStore,
  MAX_ARTIFACT_ENTRIES,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  ingestArtifactTar,
  objectKeyForSha256,
} from "@tapeci/github";
import {
  buildRawTar,
  buildTarFromFiles,
  type RawTarEntry,
} from "./helpers.js";

const CLEAN_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>tapeci</title></head><body>hello</body></html>';
const EXTERNAL_HTML =
  '<!doctype html><html><head><script src="https://cdn.example.com/app.js"></script></head><body>x</body></html>';

let root: string;
let destinationDir: string;
let store: LocalObjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "tapeci-ingest-test-"));
  destinationDir = join(root, "workspace");
  store = new LocalObjectStore(join(root, "objects"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function expectIngestError(
  promise: Promise<unknown>,
  code: string,
): Promise<GithubError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).code).toBe(code);
    return error as GithubError;
  }
  throw new Error(`expected ingest to reject with ${code}`);
}

async function objectsOnDisk(): Promise<string[]> {
  try {
    return await fs.readdir(join(root, "objects"));
  } catch {
    return [];
  }
}

describe("artifact limits", () => {
  it("exposes the documented defaults and hard caps", () => {
    expect(MAX_ARTIFACT_FILE_BYTES).toBe(MAX_FILE_BYTES);
    expect(MAX_ARTIFACT_FILE_BYTES).toBe(8_400_000);
    expect(MAX_ARTIFACT_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_ARTIFACT_ENTRIES).toBe(5_000);
    expect(DEFAULT_ARTIFACT_LIMITS).toEqual({
      maxFileBytes: 8_400_000,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntries: 5_000,
    });
  });
});

describe("ingestArtifactTar — happy path", () => {
  it("validates, scans and stores a well-formed tar content-addressed", async () => {
    const tarBytes = await buildTarFromFiles({
      "index.html": CLEAN_HTML,
      "assets/app.js": "console.log('tapeci');",
      "assets/style.css": "body{color:#000}",
    });
    const result = await ingestArtifactTar({
      bytes: tarBytes,
      destinationDir,
      objectStore: store,
    });

    const expectedSha = sha256Hex(tarBytes);
    expect(result.sha256).toBe(expectedSha);
    expect(result.objectKey).toBe(objectKeyForSha256(expectedSha));
    expect(result.objectKey).toMatch(/^sha256\/[0-9a-f]{64}\.tar$/);
    expect(result.sizeBytes).toBe(tarBytes.length);
    expect(result.entryCount).toBe(4); // one assets/ directory + 3 files
    expect(result.fileCount).toBe(3);
    expect(result.files.map((file) => file.path)).toEqual([
      "assets/app.js",
      "assets/style.css",
      "index.html",
    ]);
    expect(result.scan.fullyOnChain).toBe(true);
    expect(result.scan.entryPath).toBe("index.html");
    expect(result.totalBytes).toBe(
      result.files.reduce((sum, file) => sum + file.size, 0),
    );
    expect(result.files).toEqual(result.scan.files);

    expect(await store.has(result.objectKey)).toBe(true);
    const stored = await store.get(result.objectKey);
    expect(Buffer.from(stored).equals(tarBytes)).toBe(true);

    // The temp extraction workspace is removed; the caller's directory remains.
    await expect(fs.readdir(destinationDir)).resolves.toEqual([]);
  });

  it("accepts a streaming tar upload", async () => {
    const tarBytes = await buildTarFromFiles({ "index.html": CLEAN_HTML });
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield tarBytes.subarray(0, 100);
      yield tarBytes.subarray(100);
    }
    const result = await ingestArtifactTar({
      stream: chunks(),
      destinationDir,
      objectStore: store,
    });
    expect(result.sha256).toBe(sha256Hex(tarBytes));
    expect(await store.has(result.objectKey)).toBe(true);
  });

  it("rejects both bytes and stream at once", async () => {
    const tarBytes = await buildTarFromFiles({ "index.html": CLEAN_HTML });
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield tarBytes;
    }
    await expectIngestError(
      ingestArtifactTar({
        bytes: tarBytes,
        stream: chunks(),
        destinationDir,
        objectStore: store,
      }),
      "TAR_INVALID",
    );
  });

  it("rejects an empty stream", async () => {
    async function* empty(): AsyncGenerator<Uint8Array> {
      // no chunks
    }
    await expectIngestError(
      ingestArtifactTar({ stream: empty(), destinationDir, objectStore: store }),
      "TAR_INVALID",
    );
  });
});

describe("ingestArtifactTar — artifact policy", () => {
  it("propagates the validator error for a missing index.html", async () => {
    const tarBytes = await buildTarFromFiles({ "other.html": CLEAN_HTML });
    const error = await ingestArtifactTar({
      bytes: tarBytes,
      destinationDir,
      objectStore: store,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TapeCiError);
    expect((error as TapeCiError).code).toBe("INVALID_ARTIFACT");
    expect(await objectsOnDisk()).toEqual([]);
  });

  it("rejects external references under the strict on-chain policy by default", async () => {
    const tarBytes = await buildTarFromFiles({ "index.html": EXTERNAL_HTML });
    const error = await ingestArtifactTar({
      bytes: tarBytes,
      destinationDir,
      objectStore: store,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TapeCiError);
    expect((error as TapeCiError).code).toBe("INVALID_ARTIFACT");
  });

  it("reports external references as warnings when strictOnChain=false", async () => {
    const tarBytes = await buildTarFromFiles({ "index.html": EXTERNAL_HTML });
    const result = await ingestArtifactTar({
      bytes: tarBytes,
      destinationDir,
      objectStore: store,
      strictOnChain: false,
    });
    expect(result.scan.fullyOnChain).toBe(false);
    expect(result.scan.warnings).toHaveLength(1);
    expect(result.scan.externalReferences[0]?.url).toBe("https://cdn.example.com/app.js");
  });
});

describe("ingestArtifactTar — malicious archives", () => {
  const unsafeTars: ReadonlyArray<readonly [string, readonly RawTarEntry[], string]> = [
    ["absolute path", [{ path: "/etc/passwd", body: "root:x" }], "TAR_PATH_UNSAFE"],
    ["dot-dot traversal", [{ path: "../evil.txt", body: "pwned" }], "TAR_PATH_UNSAFE"],
    ["nested dot-dot traversal", [{ path: "assets/../../evil.txt", body: "pwned" }], "TAR_PATH_UNSAFE"],
    ["backslash path", [{ path: "assets\\evil.txt", body: "pwned" }], "TAR_PATH_UNSAFE"],
    ["current-dir segment", [{ path: "./index.html", body: CLEAN_HTML }], "TAR_PATH_UNSAFE"],
    ["symlink", [{ path: "link", type: "symlink", linkpath: "/etc/passwd" }], "TAR_LINK_FORBIDDEN"],
    ["hardlink", [{ path: "hard", type: "hardlink", linkpath: "index.html" }], "TAR_LINK_FORBIDDEN"],
    ["fifo", [{ path: "fifo", type: "fifo" }], "TAR_SPECIAL_FILE_FORBIDDEN"],
    ["character device", [{ path: "dev", type: "chardev" }], "TAR_SPECIAL_FILE_FORBIDDEN"],
  ];

  it.each(unsafeTars)("rejects %s", async (_name, entries, code) => {
    const tarBytes = buildRawTar(entries);
    await expectIngestError(
      ingestArtifactTar({ bytes: tarBytes, destinationDir, objectStore: store }),
      code,
    );
    expect(await objectsOnDisk()).toEqual([]);
    // Nothing was extracted into the caller's workspace either.
    const leftovers = await fs.readdir(destinationDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it("rejects a file larger than the 8.4 MB hard cap", async () => {
    const tarBytes = buildRawTar([
      { path: "index.html", declaredSize: MAX_ARTIFACT_FILE_BYTES + 1 },
    ]);
    const error = await expectIngestError(
      ingestArtifactTar({ bytes: tarBytes, destinationDir, objectStore: store }),
      "TAR_FILE_TOO_LARGE",
    );
    expect(error.details.max).toBe(MAX_ARTIFACT_FILE_BYTES);
  });

  it("rejects a file larger than a tightened per-file limit", async () => {
    const tarBytes = await buildTarFromFiles({
      "index.html": CLEAN_HTML,
      "assets/big.js": "x".repeat(200),
    });
    await expectIngestError(
      ingestArtifactTar({
        bytes: tarBytes,
        destinationDir,
        objectStore: store,
        limits: { maxFileBytes: 100 },
      }),
      "TAR_FILE_TOO_LARGE",
    );
  });

  it("rejects an archive larger than the total limit", async () => {
    const tarBytes = await buildTarFromFiles({
      "index.html": CLEAN_HTML,
      "a.txt": "a".repeat(60),
      "b.txt": "b".repeat(60),
    });
    await expectIngestError(
      ingestArtifactTar({
        bytes: tarBytes,
        destinationDir,
        objectStore: store,
        limits: { maxTotalBytes: 100 },
      }),
      "TAR_ARCHIVE_TOO_LARGE",
    );
  });

  it("rejects an archive with too many entries", async () => {
    const tarBytes = await buildTarFromFiles({
      "index.html": CLEAN_HTML,
      "a.txt": "a",
      "b.txt": "b",
      "c.txt": "c",
    });
    await expectIngestError(
      ingestArtifactTar({
        bytes: tarBytes,
        destinationDir,
        objectStore: store,
        limits: { maxEntries: 2 },
      }),
      "TAR_TOO_MANY_ENTRIES",
    );
  });

  it("rejects duplicate paths", async () => {
    const tarBytes = buildRawTar([
      { path: "index.html", body: CLEAN_HTML },
      { path: "index.html", body: "<html></html>" },
    ]);
    await expectIngestError(
      ingestArtifactTar({ bytes: tarBytes, destinationDir, objectStore: store }),
      "TAR_DUPLICATE_PATH",
    );
  });

  it("rejects a stream that exceeds the maximum archive size", async () => {
    const chunk = new Uint8Array(1024);
    const maxArchiveBytes =
      DEFAULT_ARTIFACT_LIMITS.maxTotalBytes + DEFAULT_ARTIFACT_LIMITS.maxEntries * 4096 + 1024;
    async function* oversized(): AsyncGenerator<Uint8Array> {
      const yields = Math.ceil(maxArchiveBytes / chunk.length) + 1;
      for (let index = 0; index < yields; index += 1) yield chunk;
    }
    await expectIngestError(
      ingestArtifactTar({ stream: oversized(), destinationDir, objectStore: store }),
      "TAR_ARCHIVE_TOO_LARGE",
    );
  });
});

describe("LocalObjectStore", () => {
  it("stores, verifies and deletes content-addressed objects", async () => {
    const key = objectKeyForSha256(sha256Hex(new TextEncoder().encode("tapeci")));
    await store.put(key, new TextEncoder().encode("tapeci"));
    expect(await store.has(key)).toBe(true);
    expect(Buffer.from(await store.get(key)).toString("utf8")).toBe("tapeci");
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
    await expect(store.get(key)).rejects.toMatchObject({ code: "OBJECT_STORE_NOT_FOUND" });
  });

  it("rejects bytes that do not match the key", async () => {
    const key = objectKeyForSha256(sha256Hex(new TextEncoder().encode("expected")));
    await expect(
      store.put(key, new TextEncoder().encode("different")),
    ).rejects.toMatchObject({ code: "OBJECT_STORE_CONTENT_MISMATCH" });
  });

  it("rejects keys that are not content addressed", async () => {
    for (const key of ["../escape.tar", "sha256/not-a-hash.tar", `sha256/${"a".repeat(64)}.zip`]) {
      await expect(store.has(key)).rejects.toMatchObject({ code: "OBJECT_STORE_KEY_INVALID" });
    }
  });
});
