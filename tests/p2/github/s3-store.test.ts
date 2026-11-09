import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore, objectKeyForSha256 } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";

const BUCKET = "tapeci-test";
const PREFIX = "tapeci";
const objects = new Map<string, Buffer>();

function objectKeyFromUrl(url: string): string {
  const pathname = new URL(url, "http://fake").pathname;
  return decodeURIComponent(pathname.replace(`/${BUCKET}/`, ""));
}

describe("S3ObjectStore (fake S3 endpoint)", () => {
  let server: Server;
  let store: S3ObjectStore;
  let endpoint = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      const key = objectKeyFromUrl(request.url ?? "/");
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200, { etag: '"fake"' });
          response.end();
        });
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const body = objects.get(key);
        if (body === undefined) {
          response.writeHead(404, { "content-type": "application/xml" });
          response.end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        response.writeHead(200, {
          "content-length": String(body.length),
          "content-type": "application/x-tar",
          "x-amz-meta-sha256": "fake",
        });
        response.end(request.method === "GET" ? body : undefined);
        return;
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(405);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    endpoint = `http://127.0.0.1:${address.port}`;
    store = new S3ObjectStore({
      bucket: BUCKET,
      region: "auto",
      endpoint,
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      prefix: PREFIX,
      forcePathStyle: true,
    });
  });

  afterAll(async () => {
    store?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("puts, heads, gets and deletes a content-addressed object", async () => {
    const bytes = new TextEncoder().encode("tar-bytes");
    const key = objectKeyForSha256(sha256Hex(bytes));
    await store.put(key, bytes);
    expect(objects.has(`${PREFIX}/${key}`)).toBe(true);
    expect(await store.has(key)).toBe(true);
    expect(Buffer.from(await store.get(key)).toString("utf8")).toBe("tar-bytes");

    await store.delete(key);
    expect(await store.has(key)).toBe(false);
    await expect(store.get(key)).rejects.toMatchObject({ code: "OBJECT_STORE_NOT_FOUND" });
    await store.delete(key); // idempotent
  });

  it("rejects bytes that do not match the key", async () => {
    const bytes = new TextEncoder().encode("one");
    const other = new TextEncoder().encode("two");
    const key = objectKeyForSha256(sha256Hex(bytes));
    await expect(store.put(key, other)).rejects.toMatchObject({
      code: "OBJECT_STORE_CONTENT_MISMATCH",
    });
  });

  it("rejects corrupted remote content", async () => {
    const bytes = new TextEncoder().encode("expected");
    const key = objectKeyForSha256(sha256Hex(bytes));
    objects.set(`${PREFIX}/${key}`, Buffer.from("tampered"));
    await expect(store.get(key)).rejects.toMatchObject({
      code: "OBJECT_STORE_CONTENT_MISMATCH",
    });
  });

  it("uses the configured prefix and leaves other keys untouched", async () => {
    const bytes = new TextEncoder().encode("prefixed");
    const key = objectKeyForSha256(sha256Hex(bytes));
    await store.put(key, bytes);
    for (const stored of objects.keys()) {
      expect(stored.startsWith(`${PREFIX}/sha256/`)).toBe(true);
    }
  });
});
