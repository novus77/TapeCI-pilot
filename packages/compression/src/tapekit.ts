import { createBrowserPack, hashPackBytes } from "./browser.js";
import { parsePackEntry } from "./entry.js";
import { sanitizePackContentType } from "./content-type.js";
import { resolvePackPath } from "./gateway.js";

export interface TapeKitFile {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly size?: number;
  readonly sha256?: string;
  readonly contentType?: string;
  readonly verified: boolean;
  readonly status: string;
  readonly compression?: {
    readonly schemaVersion: "tapeci.pack-proof.v1";
    readonly entrySha256: string;
    readonly indexSha256: string;
    readonly indexPath: string;
    readonly objectSha256: string;
    readonly objectPath: string;
  };
}
export interface TapeKitReadOptions {
  readonly navigation?: boolean;
  readonly accept?: string | null;
}
export interface TapeKitSite {
  readonly manifest: { readonly pathSet: ReadonlySet<string> };
  get(path: string, options?: TapeKitReadOptions): Promise<TapeKitFile | null>;
}

export class PackIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PackIntegrityError";
  }
}

/** Wrap one upstream same-snapshot handle, never a global cross-release file cache. */
export async function openPackedSite<T extends TapeKitSite>(site: T, policy: { safeContentType?: (contentType: string) => string } = {}): Promise<Omit<T, "get"> & TapeKitSite> {
  if (!site.manifest.pathSet.has("index.html")) return site;
  const entryFile = await site.get("index.html");
  if (!entryFile?.bytes) return site;
  try {
    const descriptor = parsePackEntry(entryFile.bytes);
    if (descriptor === null) return site;
    await verifyPhysical("index.html", entryFile);
    const indexFile = await readPhysical(descriptor.indexPath);
    if (indexFile.size !== descriptor.indexBytes) throw new Error("Packed index size mismatch");
    const pack = await createBrowserPack({
      indexBytes: indexFile.bytes!, expectedIndexHash: descriptor.indexSha256,
      loadObject: async object => {
        const physical = await readPhysical(object.path);
        return new Response(new Uint8Array(physical.bytes!).buffer);
      },
    });
    if (pack.index.entryPath !== "index.html") throw new Error("Unsupported compressed entry path");
    return {
      ...site,
      async get(path, options = {}) {
        try {
          const resolved = resolvePackPath(path.replace(/^\//, ""), pack.index.entryPath);
          if (resolved === null) throw new Error("Invalid packed request path");
          const file = await pack.readFile(resolved.filePath);
          const directory = file === null && resolved.extensionless && !resolved.filePath.endsWith("/index.html") ? await pack.readFile(`${resolved.filePath}/index.html`) : null;
          const matched = file ?? directory;
          const fallback = matched === null && descriptor.spaFallback && options.navigation === true
            && options.accept?.includes("text/html") === true && resolved.extensionless;
          const selected = matched ?? (fallback ? await pack.readFile(pack.index.entryPath) : null);
          if (selected === null) return null;
          const object = pack.index.objects.find(object => object.path === selected.objectPath)!;
          return {
            path: selected.path, size: selected.size, bytes: selected.bytes, contentType: (policy.safeContentType ?? sanitizePackContentType)(selected.contentType),
            sha256: selected.sha256, status: "ok", verified: true,
            compression: { schemaVersion: "tapeci.pack-proof.v1", entrySha256: entryFile.sha256!, indexSha256: descriptor.indexSha256, indexPath: descriptor.indexPath, objectSha256: object.sha256, objectPath: object.path },
          };
        } catch (error) {
          throw integrityError(error);
        }
      },
    };
  } catch (error) {
    throw integrityError(error);
  }

  async function readPhysical(path: string) {
    // Upstream get() may return the fallback entry for absent paths; membership is mandatory.
    if (!site.manifest.pathSet.has(path)) throw new Error(`Missing packed physical file: ${path}`);
    const file = await site.get(path).catch((error: unknown) => { throw new PhysicalReadFailure(error); });
    if (!file) throw new Error(`Missing packed physical file: ${path}`);
    await verifyPhysical(path, file);
    return file;
  }
}

async function verifyPhysical(path: string, file: TapeKitFile) {
  if (file.path !== path) throw new Error(`Packed physical path mismatch: ${path}`);
  if (file.status !== "ok" || file.verified !== true || !file.bytes) throw new Error(`Packed physical file is not verified: ${path}`);
  if (file.size !== file.bytes.length) throw new Error(`Packed physical size mismatch: ${path}`);
  if (await hashPackBytes(file.bytes) !== file.sha256) throw new Error(`Packed physical hash mismatch: ${path}`);
}

class PhysicalReadFailure {
  constructor(readonly original: unknown) {}
}

function integrityError(error: unknown) {
  if (error instanceof PhysicalReadFailure) return error.original;
  return error instanceof PackIntegrityError ? error : new PackIntegrityError(error instanceof Error ? error.message : "Packed file verification failed", error);
}
