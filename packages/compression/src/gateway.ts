import { canonicalizeSitePath } from "../../shared/src/path.js";
import { sanitizePackContentType } from "./content-type.js";
import type { BrowserPack } from "./browser.js";

export interface PackGatewayOptions {
  readonly scopeUrl: string;
  readonly spaFallback?: boolean;
}

/** Integration hook: the host gateway retains ownership of its reserved paths and policy. */
export async function servePackRequest(pack: BrowserPack, request: Request, options: PackGatewayOptions): Promise<Response> {
  const scope = new URL(options.scopeUrl);
  if (!scope.pathname.endsWith("/") || scope.search || scope.hash) throw new Error("Pack scope must be a directory URL");
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const path = resolvePackPath(url.pathname.slice(scope.pathname.length), pack.index.entryPath);
  if (path === null) return new Response("Invalid path", { status: 400 });
  const file = await pack.readFile(path.filePath);
  const directory = file === null && path.extensionless && !path.filePath.endsWith("/index.html") ? await pack.readFile(`${path.filePath}/index.html`) : null;
  const matched = file ?? directory;
  const fallback = matched === null && options.spaFallback === true && request.mode === "navigate"
    && request.headers.get("accept")?.includes("text/html") === true && path.extensionless;
  const resolved = matched ?? (fallback ? await pack.readFile(pack.index.entryPath) : null);
  if (resolved === null) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(resolved.bytes).buffer, {
    status: 200,
    headers: {
      "content-type": sanitizePackContentType(resolved.contentType),
      "content-length": String(resolved.size),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-tapeci-file-sha256": resolved.sha256,
      "x-tapeci-index-sha256": pack.indexHash,
    },
  });
}

export function resolvePackPath(path: string, entryPath: string) {
  if (path === "") return { filePath: entryPath, extensionless: false };
  try {
    const filePath = canonicalizeSitePath(path);
    const basename = decodeURIComponent(path).replace(/\/+$/, "").split("/").at(-1) ?? "";
    return { filePath, extensionless: !basename.includes(".") };
  } catch {
    return null;
  }
}
