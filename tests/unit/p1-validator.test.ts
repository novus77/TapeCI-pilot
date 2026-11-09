import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  CHUNK_MAX,
  MAX_FILE_BYTES,
  TapeCiError,
  compareUtf8,
  sha256Hex,
  utf8,
} from "@tapeci/shared";
import {
  contentTypeForPath,
  isExternalUrl,
  scanArtifactDirectory,
  scanArtifactFiles,
  scanCssReferences,
  scanHtmlReferences,
  type ScanInputFile,
  type ScanOptions,
  type ScanResult,
} from "@tapeci/validator";

const CLEAN_HTML = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>tapeci demo</title>',
  '<link rel="stylesheet" href="/assets/app.css">',
  '<script src="/assets/app.js" defer></script>',
  "</head><body>",
  '<img src="assets/logo.svg" srcset="/assets/logo.png 1x, /assets/logo@2x.png 2x" alt="logo">',
  '<a href="#top">top</a><a href="mailto:ci@example.com">mail</a>',
  "</body></html>",
].join("");

function cleanSiteFiles(): ScanInputFile[] {
  return [
    { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
    { relativePath: "assets/app.css", bytes: utf8("body{background:url('/assets/bg.png')}") },
    { relativePath: "assets/app.js", bytes: utf8("console.log('tapeci')") },
    { relativePath: "assets/logo.svg", bytes: utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
    { relativePath: "assets/logo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    { relativePath: "assets/logo@2x.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]) },
    { relativePath: "assets/bg.png", bytes: new Uint8Array([0x89, 0x50]) },
  ];
}

function scanHtml(html: string, options?: ScanOptions): ScanResult {
  return scanArtifactFiles([{ relativePath: "index.html", bytes: utf8(html) }], options);
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

async function captureRejection(fn: () => Promise<unknown>): Promise<TapeCiError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TapeCiError) return error;
    throw error;
  }
  throw new Error("expected function to reject with a TapeCiError");
}

async function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = nodePath.join(root, ...relativePath.split("/"));
    await fs.mkdir(nodePath.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "tapeci-scan-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function expectCode(result: TapeCiError, code: string): void {
  expect(result.code).toBe(code);
}

function sortedPaths(paths: readonly string[]): string[] {
  return [...paths].sort(compareUtf8);
}

describe("contentTypeForPath", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["index.html", "text/html; charset=utf-8"],
    ["INDEX.HTML", "text/html; charset=utf-8"],
    ["about.htm", "text/html; charset=utf-8"],
    ["assets/app.css", "text/css; charset=utf-8"],
    ["assets/app.js", "text/javascript; charset=utf-8"],
    ["assets/app.mjs", "text/javascript; charset=utf-8"],
    ["robots.txt", "text/plain; charset=utf-8"],
    ["data.json", "application/json"],
    ["assets/logo.svg", "image/svg+xml"],
    ["assets/logo.png", "image/png"],
    ["assets/photo.jpeg", "image/jpeg"],
    ["fonts/inter.woff2", "font/woff2"],
    ["assets/app.wasm", "application/wasm"],
    ["site.webmanifest", "application/manifest+json"],
    ["assets/app.bin", "application/octet-stream"],
    ["assets/no-extension", "application/octet-stream"],
    [".hiddenfile", "application/octet-stream"],
  ];

  it.each(cases)("maps %s to %s", (path, expected) => {
    expect(contentTypeForPath(path)).toBe(expected);
  });
});

describe("isExternalUrl", () => {
  it.each([
    "https://cdn.example.com/a.js",
    "http://cdn.example.com/a.js",
    "HTTPS://CDN.EXAMPLE.COM/A.JS",
    "  https://cdn.example.com/a.js  ",
    "//cdn.example.com/a.js",
    "//host",
  ])("treats %j as external", (url) => {
    expect(isExternalUrl(url)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "#top",
    "/assets/app.js",
    "./assets/app.js",
    "../assets/app.js",
    "assets/app.js",
    "mailto:ci@example.com",
    "tel:+15551234567",
    "data:image/png;base64,AAAA",
    "blob:https://example.com/abc",
    "javascript:void(0)",
    "?query=1",
  ])("does not treat %j as external", (url) => {
    expect(isExternalUrl(url)).toBe(false);
  });
});

describe("scanHtmlReferences / scanCssReferences", () => {
  it("reports HTML attributes and srcset with their origin", () => {
    const references = scanHtmlReferences(
      [
        '<script src="https://cdn.example.com/a.js"></script>',
        '<img srcset="//cdn.example.com/a.png 2x, /local.png 1x">',
        '<a href="https://example.com/x">x</a>',
      ].join(""),
      "index.html",
    );
    expect(references).toEqual([
      {
        filePath: "index.html",
        kind: "html-attribute",
        attribute: "src",
        url: "https://cdn.example.com/a.js",
      },
      {
        filePath: "index.html",
        kind: "html-attribute",
        attribute: "href",
        url: "https://example.com/x",
      },
      {
        filePath: "index.html",
        kind: "html-attribute",
        attribute: "srcset",
        url: "//cdn.example.com/a.png",
      },
    ]);
  });

  it("reports meta refresh targets", () => {
    const references = scanHtmlReferences(
      '<meta http-equiv="refresh" content="0; url=https://evil.example.com/">',
      "index.html",
    );
    expect(references).toEqual([
      {
        filePath: "index.html",
        kind: "html-meta-refresh",
        attribute: "meta-refresh",
        url: "https://evil.example.com/",
      },
    ]);
  });

  it("reports external references inside inline <style> blocks", () => {
    const references = scanHtmlReferences(
      '<style>@import "https://fonts.example.com/x.css"; body{background:url(//cdn.example.com/bg.png)}</style>',
      "index.html",
    );
    expect(references.map((reference) => reference.url)).toEqual([
      "https://fonts.example.com/x.css",
      "//cdn.example.com/bg.png",
    ]);
  });

  it("reports CSS url() and @import references once each", () => {
    const references = scanCssReferences(
      [
        '@import url("https://fonts.example.com/x.css");',
        "@import 'https://cdn.example.com/y.css';",
        ".a{background:url(//cdn.example.com/bg.png)}",
        ".b{background:url(data:image/png;base64,AAAA)}",
        ".c{background:url(/local.png)}",
      ].join("\n"),
      "assets/app.css",
    );
    expect(references).toEqual([
      {
        filePath: "assets/app.css",
        kind: "css-import",
        attribute: "@import",
        url: "https://fonts.example.com/x.css",
      },
      {
        filePath: "assets/app.css",
        kind: "css-import",
        attribute: "@import",
        url: "https://cdn.example.com/y.css",
      },
      {
        filePath: "assets/app.css",
        kind: "css-url",
        attribute: "url",
        url: "//cdn.example.com/bg.png",
      },
    ]);
  });

  it("deduplicates repeated identical references", () => {
    const references = scanHtmlReferences(
      '<script src="https://cdn.example.com/a.js"></script><script src="https://cdn.example.com/a.js"></script>',
      "index.html",
    );
    expect(references).toHaveLength(1);
  });

  it("does not treat data-* attributes as src/href references", () => {
    const references = scanHtmlReferences(
      '<div data-href="https://cdn.example.com/x" data-src="https://cdn.example.com/y"></div>',
      "index.html",
    );
    expect(references).toEqual([]);
  });
});

describe("scanArtifactFiles: legal artifact", () => {
  it("scans a clean static site deterministically", () => {
    const result = scanArtifactFiles(cleanSiteFiles());
    expect(result.entryPath).toBe("index.html");
    expect(result.entry.path).toBe("index.html");
    expect(result.entry.contentType).toBe("text/html; charset=utf-8");
    expect(result.entry.size).toBe(utf8(CLEAN_HTML).length);
    expect(result.entry.sha256).toBe(sha256Hex(utf8(CLEAN_HTML)));
    expect(result.files.map((file) => file.path)).toEqual([
      "assets/app.css",
      "assets/app.js",
      "assets/bg.png",
      "assets/logo.png",
      "assets/logo.svg",
      "assets/logo@2x.png",
      "index.html",
    ]);
    expect(result.files.map((file) => file.path)).toEqual(sortedPaths(result.files.map((file) => file.path)));
    expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.size, 0));
    expect(result.externalReferences).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fullyOnChain).toBe(true);
  });

  it("is independent of input order", () => {
    const forward = scanArtifactFiles(cleanSiteFiles());
    const shuffled = scanArtifactFiles([...cleanSiteFiles()].reverse());
    expect(shuffled.files.map((file) => file.path)).toEqual(forward.files.map((file) => file.path));
    expect(shuffled.files.map((file) => [file.path, file.size, file.sha256])).toEqual(
      forward.files.map((file) => [file.path, file.size, file.sha256]),
    );
    expect(shuffled.totalBytes).toBe(forward.totalBytes);
  });

  it("normalizes a lone NFD path to NFC", () => {
    const result = scanArtifactFiles([
      { relativePath: "cafe\u0301.html", bytes: utf8("<p>cafe</p>") },
      { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
    ]);
    expect(result.files.map((file) => file.path)).toContain("caf\u00e9.html");
    expect(result.files.every((file) => file.path === file.path.normalize("NFC"))).toBe(true);
  });
});

describe("scanArtifactFiles: path safety", () => {
  const badPaths: readonly string[] = [
    "../private.json",
    "assets/../../private.json",
    "%2e%2e/secret.txt",
    "/etc/passwd",
    "//server/share.js",
    "C:/windows/system32/x.js",
    "path\\with\\backslashes.js",
    "assets/./app.js",
    "nul\u0000byte.js",
    "control\u0007byte.js",
    "",
    "trailing-slash/",
  ];

  it.each(badPaths)("rejects illegal path %j", (relativePath) => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath, bytes: utf8("x") },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });

  it("rejects exact duplicate canonical paths", () => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "assets/app.js", bytes: utf8("a") },
        { relativePath: "assets/app.js", bytes: utf8("b") },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain("duplicate canonical artifact path");
  });

  it("rejects NFC collisions between two different spellings", () => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "assets/caf\u00e9.js", bytes: utf8("a") },
        { relativePath: "assets/cafe\u0301.js", bytes: utf8("b") },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain("duplicate canonical artifact path");
  });

  it("honours the ignore prefix list", () => {
    const result = scanArtifactFiles(
      [
        ...cleanSiteFiles(),
        { relativePath: "node_modules/pkg/index.js", bytes: utf8("module") },
        { relativePath: "assets/skip.js", bytes: utf8("skip") },
      ],
      { ignore: ["node_modules/", "assets/skip.js"] },
    );
    const paths = result.files.map((file) => file.path);
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("assets/skip.js");
    expect(paths).toContain("assets/app.js");
  });
});

describe("scanArtifactFiles: size and entry limits", () => {
  it("rejects a file above 8,400,000 bytes (UT-03)", () => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "assets/big.bin", bytes: new Uint8Array(MAX_FILE_BYTES + 1) },
      ]),
    );
    expectCode(error, "FILE_TOO_LARGE");
  });

  it("rejects a file above the hard cap even when maxFileBytes asks for more", () => {
    const error = captureError(() =>
      scanArtifactFiles(
        [
          { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
          { relativePath: "assets/big.bin", bytes: new Uint8Array(MAX_FILE_BYTES + 1) },
        ],
        { maxFileBytes: MAX_FILE_BYTES * 2 },
      ),
    );
    expectCode(error, "FILE_TOO_LARGE");
  });

  it("accepts a file at exactly 8,400,000 bytes", () => {
    const result = scanArtifactFiles([
      { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
      { relativePath: "assets/big.bin", bytes: new Uint8Array(MAX_FILE_BYTES) },
    ]);
    expect(result.files).toHaveLength(2);
  });

  it("rejects a file above a custom maxFileBytes", () => {
    const error = captureError(() =>
      scanArtifactFiles([{ relativePath: "index.html", bytes: utf8("<p>hello</p>") }], {
        maxFileBytes: 4,
      }),
    );
    expectCode(error, "FILE_TOO_LARGE");
  });

  it("accepts an entry of exactly 24,000 bytes (UT-01/UT-08 boundary)", () => {
    const result = scanHtml("a".repeat(CHUNK_MAX));
    expect(result.entry.size).toBe(CHUNK_MAX);
  });

  it("rejects an entry of 24,001 bytes (UT-08)", () => {
    const error = captureError(() => scanHtml("a".repeat(CHUNK_MAX + 1)));
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain("single transaction");
  });
});

describe("scanArtifactFiles: entry validation", () => {
  it("rejects a missing entry file", () => {
    const error = captureError(() =>
      scanArtifactFiles([{ relativePath: "assets/app.js", bytes: utf8("x") }]),
    );
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain("missing");
  });

  it("rejects an entry that is not HTML", () => {
    const error = captureError(() =>
      scanArtifactFiles([{ relativePath: "index.css", bytes: utf8("body{}") }], {
        entryPath: "index.css",
      }),
    );
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain("must be HTML");
  });

  it("supports a nested custom entry path", () => {
    const result = scanArtifactFiles(
      [
        { relativePath: "site/index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "site/app.js", bytes: utf8("x") },
      ],
      { entryPath: "site/index.html" },
    );
    expect(result.entryPath).toBe("site/index.html");
    expect(result.entry.path).toBe("site/index.html");
  });

  it("rejects invalid UTF-8 in an HTML file", () => {
    const error = captureError(() =>
      scanArtifactFiles([{ relativePath: "index.html", bytes: new Uint8Array([0xff, 0xfe, 0x00]) }]),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });
});

describe("scanArtifactFiles: external reference policy (UT-06)", () => {
  interface ExternalCase {
    readonly name: string;
    readonly html: string;
    readonly urls: readonly string[];
  }

  const cases: readonly ExternalCase[] = [
    {
      name: "external script src",
      html: '<script src="https://cdn.example.com/app.js"></script>',
      urls: ["https://cdn.example.com/app.js"],
    },
    {
      name: "protocol-relative stylesheet",
      html: '<link rel="stylesheet" href="//cdn.example.com/app.css">',
      urls: ["//cdn.example.com/app.css"],
    },
    {
      name: "external form action",
      html: '<form action="http://api.example.com/submit"></form>',
      urls: ["http://api.example.com/submit"],
    },
    {
      name: "external video poster",
      html: '<video poster="https://cdn.example.com/poster.jpg"></video>',
      urls: ["https://cdn.example.com/poster.jpg"],
    },
    {
      name: "external srcset candidate",
      html: '<img srcset="https://cdn.example.com/a.png 1x, /assets/a.png 2x">',
      urls: ["https://cdn.example.com/a.png"],
    },
    {
      name: "meta refresh redirect",
      html: '<meta http-equiv="refresh" content="5;URL=\'https://evil.example.com/\'">',
      urls: ["https://evil.example.com/"],
    },
    {
      name: "inline style import",
      html: '<style>@import "https://fonts.example.com/x.css";</style>',
      urls: ["https://fonts.example.com/x.css"],
    },
    {
      name: "external anchor",
      html: '<a href="https://example.com/away">away</a>',
      urls: ["https://example.com/away"],
    },
  ];

  it.each(cases)("strict mode rejects $name", ({ html, urls }) => {
    const error = captureError(() => scanHtml(html));
    expectCode(error, "INVALID_ARTIFACT");
    expect(error.message).toContain(urls[0] ?? "");
  });

  it.each(cases)("non-strict mode reports $name as a warning", ({ html, urls }) => {
    const result = scanHtml(html, { strictOnChain: false });
    expect(result.externalReferences.map((reference) => reference.url)).toEqual(urls);
    expect(result.warnings).toHaveLength(urls.length);
    expect(result.warnings[0]?.code).toBe("EXTERNAL_REFERENCE");
    expect(result.fullyOnChain).toBe(false);
  });

  const allowedHtml = [
    '<a href="#top">top</a>',
    '<a href="mailto:ci@example.com">mail</a>',
    '<a href="tel:+15551234567">call</a>',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="blob:https://example.com/abc">',
    '<a href="javascript:void(0)">noop</a>',
    '<script src="/assets/app.js"></script>',
    '<img src="assets/logo.png">',
    '<a href="relative/page.html">relative</a>',
    '<a href="?query=1">query</a>',
  ];

  it.each(allowedHtml)("does not treat %j as external", (html) => {
    const result = scanHtml(html);
    expect(result.externalReferences).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fullyOnChain).toBe(true);
  });

  it("rejects external references inside CSS files in strict mode", () => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        {
          relativePath: "assets/app.css",
          bytes: utf8('@import url("https://fonts.example.com/x.css"); .a{background:url(//cdn.example.com/b.png)}'),
        },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });

  it("reports CSS references with warnings in non-strict mode", () => {
    const result = scanArtifactFiles(
      [
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        {
          relativePath: "assets/app.css",
          bytes: utf8('@import "https://fonts.example.com/x.css"; .a{background:url(//cdn.example.com/b.png)}'),
        },
      ],
      { strictOnChain: false },
    );
    expect(result.externalReferences.map((reference) => reference.url)).toEqual([
      "https://fonts.example.com/x.css",
      "//cdn.example.com/b.png",
    ]);
    expect(result.externalReferences.map((reference) => reference.kind)).toEqual([
      "css-import",
      "css-url",
    ]);
    expect(result.fullyOnChain).toBe(false);
  });

  it("does not certify a non-strict scan as fully on chain even without references", () => {
    const result = scanArtifactFiles(cleanSiteFiles(), { strictOnChain: false });
    expect(result.externalReferences).toEqual([]);
    expect(result.fullyOnChain).toBe(false);
  });
});

describe("scanArtifactFiles: unsupported server extensions", () => {
  const defaultExtensions = [
    ".php",
    ".php3",
    ".php4",
    ".php5",
    ".phtml",
    ".jsp",
    ".jspx",
    ".asp",
    ".aspx",
    ".cgi",
    ".pl",
    ".py",
    ".rb",
  ];

  it.each(defaultExtensions)("rejects %s files", (extension) => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: `api/handler${extension}`, bytes: utf8("<?php ?>") },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });

  it("matches extensions case-insensitively", () => {
    const error = captureError(() =>
      scanArtifactFiles([
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "api/handler.PHP", bytes: utf8("<?php ?>") },
      ]),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });

  it("uses a custom unsupported extension list instead of the defaults", () => {
    const accepted = scanArtifactFiles(
      [
        { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
        { relativePath: "api/handler.cfm", bytes: utf8("x") },
      ],
      { unsupportedServerExtensions: [".php"] },
    );
    expect(accepted.files.map((file) => file.path)).toContain("api/handler.cfm");

    const error = captureError(() =>
      scanArtifactFiles(
        [
          { relativePath: "index.html", bytes: utf8(CLEAN_HTML) },
          { relativePath: "api/handler.cfm", bytes: utf8("x") },
        ],
        { unsupportedServerExtensions: [".cfm"] },
      ),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });
});

describe("scanArtifactDirectory", () => {
  it("walks a directory deterministically", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        "index.html": CLEAN_HTML,
        "assets/app.js": "console.log(1)",
        "assets/nested/app.css": "body{color:red}",
      });
      const result = await scanArtifactDirectory(root);
      expect(result.files.map((file) => file.path)).toEqual([
        "assets/app.js",
        "assets/nested/app.css",
        "index.html",
      ]);
      expect(result.entry.sha256).toBe(sha256Hex(utf8(CLEAN_HTML)));
      expect(result.fullyOnChain).toBe(true);
    });
  });

  it("rejects symlinks (lstat, not stat)", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, {
        "index.html": CLEAN_HTML,
        "assets/app.js": "console.log(1)",
      });
      await fs.symlink(
        nodePath.join(root, "assets", "app.js"),
        nodePath.join(root, "assets", "linked.js"),
      );
      const error = await captureRejection(() => scanArtifactDirectory(root));
      expectCode(error, "INVALID_ARTIFACT");
      expect(error.message).toContain("symbolic links");
    });
  });

  it("rejects a symlinked directory", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { "index.html": CLEAN_HTML });
      const outside = await fs.mkdtemp(nodePath.join(os.tmpdir(), "tapeci-scan-outside-"));
      try {
        await fs.writeFile(nodePath.join(outside, "app.js"), "x");
        await fs.symlink(outside, nodePath.join(root, "assets"));
        const error = await captureRejection(() => scanArtifactDirectory(root));
        expectCode(error, "INVALID_ARTIFACT");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("skips ignored prefixes before lstat (ignored symlinks do not fail the scan)", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { "index.html": CLEAN_HTML, "assets/app.js": "x" });
      const outside = await fs.mkdtemp(nodePath.join(os.tmpdir(), "tapeci-scan-outside-"));
      try {
        await fs.writeFile(nodePath.join(outside, "module.js"), "x");
        await fs.symlink(outside, nodePath.join(root, "node_modules"));
        const result = await scanArtifactDirectory(root, { ignore: ["node_modules"] });
        expect(result.files.map((file) => file.path)).toEqual(["assets/app.js", "index.html"]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects a directory with a server-side extension", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { "index.html": CLEAN_HTML, "api/handler.php": "<?php ?>" });
      const error = await captureRejection(() => scanArtifactDirectory(root));
      expectCode(error, "INVALID_ARTIFACT");
    });
  });

  it("rejects a non-existent root", async () => {
    const error = await captureRejection(() =>
      scanArtifactDirectory(nodePath.join(os.tmpdir(), "tapeci-does-not-exist-4f1c2b")),
    );
    expectCode(error, "INVALID_ARTIFACT");
  });

  it("rejects a root that is a symbolic link", async () => {
    await withTempDir(async (root) => {
      await writeFiles(root, { "index.html": CLEAN_HTML });
      const link = `${root}-link`;
      await fs.symlink(root, link);
      try {
        const error = await captureRejection(() => scanArtifactDirectory(link));
        expectCode(error, "INVALID_ARTIFACT");
        expect(error.message).toContain("symbolic link");
      } finally {
        await fs.rm(link, { force: true });
      }
    });
  });
});
