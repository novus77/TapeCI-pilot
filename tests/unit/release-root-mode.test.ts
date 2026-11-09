import { describe, expect, it } from "vitest";
import { prepareVersionedRelease } from "@tapeci/release";
import { utf8, type Hex } from "@tapeci/shared";

const REGISTRY = `0x${"11".repeat(20)}` as Hex;
const CONTAINER = `0x${"22".repeat(20)}` as Hex;
const COMMIT = "a".repeat(40);

function artifact(path: string, bytes: Uint8Array, contentType: string) {
  return { path, sourcePath: path, bytes, size: bytes.length, sha256: `0x${"00".repeat(32)}` as Hex, contentType } as never;
}

function files() {
  return [
    artifact(
      "index.html",
      utf8('<!doctype html><html><head><link rel=stylesheet href="./assets.css"></head><body><a href="./chapter1/page.html">c1</a><script src="./app.js"></script></body></html>'),
      "text/html; charset=utf-8",
    ),
    artifact("assets.css", utf8("body{color:#fff}"), "text/css; charset=utf-8"),
    artifact("app.js", utf8("console.log('app');"), "text/javascript; charset=utf-8"),
    artifact("chapter1/page.html", utf8("<html><body>chapter</body></html>"), "text/html; charset=utf-8"),
  ];
}

function prepare(pathPrefix: string) {
  return prepareVersionedRelease({
    files: files(),
    chainId: 196,
    siteRegistry: REGISTRY,
    container: CONTAINER,
    repositoryId: 1,
    commitSha: COMMIT,
    entryPath: "index.html",
    fallbackPath: "index.html",
    pathPrefix,
  });
}

describe("release path modes", () => {
  it("versioned mode keeps assets under /releases/<id>/ and rewrites the entry", () => {
    const prepared = prepare("releases");
    const paths = prepared.manifest.files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths.some((p) => p.startsWith(`releases/${prepared.releaseId}/`))).toBe(true);
    expect(prepared.entryHtml).toContain(`/releases/${prepared.releaseId}/app.js`);
    expect(prepared.entryHtml).toContain(`/releases/${prepared.releaseId}/assets.css`);
  });

  it("root mode publishes files at their own paths and leaves the entry untouched", () => {
    const prepared = prepare("");
    const paths = prepared.manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual(["app.js", "assets.css", "chapter1/page.html", "index.html"]);
    // Root mode must not invent a release prefix, and relative links keep working.
    expect(prepared.entryHtml).toContain("./assets.css");
    expect(prepared.entryHtml).toContain("./chapter1/page.html");
    expect(prepared.entryHtml).not.toContain("/releases/");
    expect(prepared.manifest.releaseId.length).toBeGreaterThan(0);
  });

  it("both modes produce a deterministic release id for identical input", () => {
    expect(prepare("").releaseId).toBe(prepare("").releaseId);
    expect(prepare("releases").releaseId).toBe(prepare("releases").releaseId);
  });
});
