import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX,
  MAX_CHUNKS,
  MAX_FILE_BYTES,
  TapeCiError,
  canonicalJson,
  canonicalJsonSha256Hex,
  canonicalizeArtifactPath,
  canonicalizeSitePath,
  chunkBytes,
  chunkCountFor,
  sha256Hex,
  utf8,
} from "@tapeci/shared";

describe("chunking (TapeOut limits)", () => {
  it("UT-01: a 1-byte file is one chunk", () => {
    expect(chunkBytes(new Uint8Array([1]))).toHaveLength(1);
  });

  it("UT-01b: exactly 24,000 bytes is one full chunk", () => {
    const chunks = chunkBytes(new Uint8Array(CHUNK_MAX));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.length).toBe(24_000);
  });

  it("UT-02: 24,001 bytes is two chunks (24,000 + 1)", () => {
    const chunks = chunkBytes(new Uint8Array(24_001));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.length).toBe(24_000);
    expect(chunks[1]?.length).toBe(1);
  });

  it("65,000 bytes is three chunks", () => {
    const chunks = chunkBytes(new Uint8Array(65_000));
    expect(chunks.map((chunk) => chunk.length)).toEqual([24_000, 24_000, 17_000]);
  });

  it("UT-03: 8,400,001 bytes is rejected", () => {
    expect(() => chunkBytes(new Uint8Array(MAX_FILE_BYTES + 1))).toThrowError(TapeCiError);
    try {
      chunkBytes(new Uint8Array(MAX_FILE_BYTES + 1));
    } catch (error) {
      expect((error as TapeCiError).code).toBe("FILE_TOO_LARGE");
    }
  });

  it("exactly 8,400,000 bytes uses all 350 chunks", () => {
    expect(chunkBytes(new Uint8Array(MAX_FILE_BYTES))).toHaveLength(MAX_CHUNKS);
  });

  it("empty file still needs one putFile chunk", () => {
    const chunks = chunkBytes(new Uint8Array(0));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.length).toBe(0);
  });

  it("chunkCountFor matches chunkBytes", () => {
    for (const size of [0, 1, 23_999, 24_000, 24_001, 65_000, MAX_FILE_BYTES]) {
      expect(chunkCountFor(size)).toBe(chunkBytes(new Uint8Array(size)).length);
    }
  });
});

describe("path canonicalization (TapeKit SPEC §6)", () => {
  it("UT-04: rejects dot-dot segments", () => {
    expect(() => canonicalizeSitePath("../private.json")).toThrowError(TapeCiError);
    expect(() => canonicalizeSitePath("assets/../../private.json")).toThrowError(TapeCiError);
    expect(() => canonicalizeSitePath("%2e%2e/secret")).toThrowError(TapeCiError);
  });

  it("rejects control characters and backslashes", () => {
    expect(() => canonicalizeSitePath("a\u0000b")).toThrowError(TapeCiError);
    expect(() => canonicalizeSitePath("a\\b")).toThrowError(TapeCiError);
  });

  it("strips query/fragment, decodes percent escapes and collapses slashes", () => {
    expect(canonicalizeSitePath("/a//b.html?x=1#frag")).toBe("a/b.html");
    expect(canonicalizeSitePath("a%20b.html")).toBe("a b.html");
  });

  it("maps empty and directory paths to index.html", () => {
    expect(canonicalizeSitePath("")).toBe("index.html");
    expect(canonicalizeSitePath("/")).toBe("index.html");
    expect(canonicalizeSitePath("/docs/")).toBe("docs/index.html");
  });

  it("normalizes NFD (macOS) file names to NFC", () => {
    const nfd = "\u0065\u0301.html"; // e + combining acute
    const nfc = "\u00e9.html";
    expect(canonicalizeSitePath(nfd)).toBe(nfc);
  });

  it("rejects malformed percent escapes", () => {
    expect(() => canonicalizeSitePath("%zz")).toThrowError(TapeCiError);
  });

  it("artifact paths reject directories and traversal", () => {
    expect(canonicalizeArtifactPath("assets/app.js")).toBe("assets/app.js");
    expect(canonicalizeArtifactPath("a//b.js")).toBe("a/b.js");
    expect(() => canonicalizeArtifactPath("../x.js")).toThrowError(TapeCiError);
    expect(() => canonicalizeArtifactPath("")).toThrowError(TapeCiError);
    expect(() => canonicalizeArtifactPath("assets/")).toThrowError(TapeCiError);
  });
});

describe("hashing", () => {
  it("uses raw SHA-256, not Keccak-256", () => {
    expect(sha256Hex(utf8("hello"))).toBe(
      "0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("canonical JSON is key-order independent and NFC-normalized", () => {
    const a = canonicalJson({ b: 2, a: 1 });
    const b = canonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ name: "\u0065\u0301" })).toBe('{"name":"\u00e9"}');
  });

  it("canonical manifest hash is stable", () => {
    const manifest = {
      schemaVersion: "tapeci.release.v1",
      files: [
        { path: "index.html", size: 3, sha256: sha256Hex(utf8("abc")) },
      ],
    };
    expect(canonicalJsonSha256Hex(manifest)).toBe(canonicalJsonSha256Hex(manifest));
  });
});
