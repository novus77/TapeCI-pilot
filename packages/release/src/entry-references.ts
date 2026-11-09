import { posix } from "node:path";
import {
  TapeCiError,
  canonicalizeArtifactPath,
  utf8Decode,
  utf8,
} from "@tapeci/shared";
import type { ReleaseManifest } from "@tapeci/artifact";

export type EntryReferenceKind = "attribute" | "srcset" | "css";

export interface EntryReference {
  readonly raw: string;
  readonly kind: EntryReferenceKind;
  readonly tag: string | null;
  readonly attribute: string | null;
  /** Navigation links (`<a href>`) do not have to exist as on-chain files. */
  readonly optional: boolean;
  readonly external: boolean;
  readonly resolvedPath: string | null;
  readonly rewritten: string | null;
}

export interface RewriteEntryResult {
  readonly html: string;
  readonly references: readonly EntryReference[];
  /** Internal references that could not be mapped to a published path. */
  readonly unresolved: readonly string[];
}

export interface VerifyEntryResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly external: readonly string[];
  readonly references: readonly EntryReference[];
}

const EXTERNAL_PREFIXES = [
  "http://",
  "https://",
  "//",
  "data:",
  "blob:",
  "mailto:",
  "tel:",
  "javascript:",
] as const;

function splitSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  if (index < 0) return { path: value, suffix: "" };
  return { path: value.slice(0, index), suffix: value.slice(index) };
}

function decodePercent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Resolve an entry-relative/root-relative URL to a canonical artifact path, or null. */
export function resolveEntryUrl(raw: string, entryPath: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const lower = trimmed.toLowerCase();
  if (EXTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  const { path } = splitSuffix(trimmed);
  const decoded = decodePercent(path);
  if (decoded === null) return null;
  const candidate = decoded.startsWith("/")
    ? decoded.replace(/^\/+/, "")
    : posix.join(posix.dirname(entryPath), decoded);
  try {
    return canonicalizeArtifactPath(candidate);
  } catch {
    return null;
  }
}

function isExternal(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return EXTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

interface RewriteContext {
  readonly entryPath: string;
  readonly sourceToTarget: ReadonlyMap<string, string>;
  readonly targetPaths: ReadonlySet<string>;
  readonly references: EntryReference[];
  readonly unresolved: string[];
}

function rewriteUrl(
  raw: string,
  context: RewriteContext,
  kind: EntryReferenceKind,
  tag: string | null,
  attribute: string | null,
  optional: boolean,
): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    context.references.push({
      raw,
      kind,
      tag,
      attribute,
      optional,
      external: false,
      resolvedPath: null,
      rewritten: null,
    });
    return raw;
  }
  if (isExternal(trimmed)) {
    context.references.push({
      raw,
      kind,
      tag,
      attribute,
      optional,
      external: true,
      resolvedPath: null,
      rewritten: null,
    });
    return raw;
  }
  const { suffix } = splitSuffix(trimmed);
  const resolved = resolveEntryUrl(trimmed, context.entryPath);
  if (resolved === null) {
    context.unresolved.push(trimmed);
    context.references.push({
      raw,
      kind,
      tag,
      attribute,
      optional,
      external: false,
      resolvedPath: null,
      rewritten: null,
    });
    return raw;
  }
  const mapped = context.sourceToTarget.get(resolved);
  if (mapped !== undefined) {
    const rewritten = `/${mapped}${suffix}`;
    context.references.push({
      raw,
      kind,
      tag,
      attribute,
      optional,
      external: false,
      resolvedPath: resolved,
      rewritten,
    });
    return rewritten;
  }
  const found = context.targetPaths.has(resolved);
  if (!found && !optional) context.unresolved.push(trimmed);
  context.references.push({
    raw,
    kind,
    tag,
    attribute,
    optional,
    external: false,
    resolvedPath: resolved,
    rewritten: null,
  });
  return raw;
}

function rewriteSrcset(value: string, context: RewriteContext, tag: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === "") return candidate;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (url === undefined) return candidate;
      const rewritten = rewriteUrl(url, context, "srcset", tag, "srcset", false);
      return [rewritten, ...descriptor].join(" ");
    })
    .join(", ");
}

const TAG_RE = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE_RE = /(\s)(src|href|action|poster|srcset|style)(\s*=\s*)("([^"]*)"|'([^']*)')/gi;

function rewriteAttributes(html: string, context: RewriteContext): string {
  return html.replace(TAG_RE, (_tagMatch, tagName: string, body: string) => {
    const tag = tagName.toLowerCase();
    const rewrittenBody = body.replace(
      ATTRIBUTE_RE,
      (_attributeMatch, space: string, name: string, equals: string, _quoted: string, double: string, single: string) => {
        const attribute = name.toLowerCase();
        const quote = double !== undefined ? `"` : `'`;
        const value = double ?? single ?? "";
        const optional = tag === "a" && attribute === "href";
        const rewritten =
          attribute === "style"
            ? rewriteCss(value, context, tag)
            : attribute === "srcset"
              ? rewriteSrcset(value, context, tag)
              : rewriteUrl(value, context, "attribute", tag, attribute, optional);
        return `${space}${name}${equals}${quote}${rewritten}${quote}`;
      },
    );
    return `<${tagName}${rewrittenBody}>`;
  });
}

const STYLE_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const CSS_URL_RE = /\burl\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

function rewriteCss(css: string, context: RewriteContext, tag: string | null): string {
  let result = css.replace(CSS_URL_RE, (match, quote: string, value: string) => {
    const rewritten = rewriteUrl(value, context, "css", tag, "url", false);
    if (rewritten === value) return match;
    return `url(${quote}${rewritten}${quote})`;
  });
  result = result.replace(CSS_IMPORT_RE, (match, quote: string, value: string) => {
    const rewritten = rewriteUrl(value, context, "css", tag, "@import", false);
    if (rewritten === value) return match;
    return `@import ${quote}${rewritten}${quote}`;
  });
  return result;
}

function rewriteInlineStyles(html: string, context: RewriteContext): string {
  return html.replace(STYLE_RE, (match, open: string, css: string, close: string) => {
    const rewritten = rewriteCss(css, context, "style");
    return rewritten === css ? match : `${open}${rewritten}${close}`;
  });
}

function makeContext(
  entryPath: string,
  sourceToTarget: ReadonlyMap<string, string>,
): RewriteContext {
  const targetPaths = new Set<string>([entryPath, ...sourceToTarget.values()]);
  return { entryPath, sourceToTarget, targetPaths, references: [], unresolved: [] };
}

/**
 * Rewrite an entry document so that every internal asset reference points at the
 * versioned on-chain path (`/${pathPrefix}/${releaseId}/${sourcePath}`), while
 * external/data/anchor URLs and the entry itself are left untouched.
 */
export function rewriteEntryReferences(input: {
  readonly html: string;
  readonly entryPath: string;
  readonly releaseId: string;
  readonly pathPrefix: string;
  readonly sourcePaths: readonly string[];
}): RewriteEntryResult {
  const entryPath = canonicalizeArtifactPath(input.entryPath);
  const sourceToTarget = new Map<string, string>();
  for (const sourcePath of input.sourcePaths) {
    if (sourcePath === entryPath) continue;
    sourceToTarget.set(
      sourcePath,
      canonicalizeArtifactPath(`${input.pathPrefix}/${input.releaseId}/${sourcePath}`),
    );
  }
  const context = makeContext(entryPath, sourceToTarget);
  let html = rewriteAttributes(input.html, context);
  html = rewriteInlineStyles(html, context);
  return { html, references: context.references, unresolved: [...new Set(context.unresolved)] };
}

/** Collect internal references without changing the document (used by cutover checks). */
export function collectEntryReferences(
  html: string,
  entryPath: string,
): { references: EntryReference[]; missing: string[]; external: string[] } {
  const canonicalEntry = canonicalizeArtifactPath(entryPath);
  const context = makeContext(canonicalEntry, new Map());
  rewriteAttributes(html, context);
  rewriteInlineStyles(html, context);
  const missing: string[] = [];
  const external: string[] = [];
  for (const reference of context.references) {
    if (reference.external) {
      external.push(reference.raw);
      continue;
    }
    if (reference.optional || reference.resolvedPath === null) continue;
    if (!context.targetPaths.has(reference.resolvedPath)) {
      missing.push(reference.resolvedPath);
    }
  }
  return { references: context.references, missing: [...new Set(missing)], external };
}

/**
 * Verify that an entry document only references files present in the approved
 * manifest (navigation anchors are exempt; external URLs are reported separately).
 */
export function verifyEntryReferences(
  html: string,
  manifest: ReleaseManifest,
): VerifyEntryResult {
  const targetPaths = new Set(manifest.files.map((file) => file.path));
  const context = makeContext(manifest.entryPath, new Map());
  const body = rewriteAttributes(html, context);
  rewriteInlineStyles(body, context);
  const missing: string[] = [];
  const external: string[] = [];
  for (const reference of context.references) {
    if (reference.external) {
      external.push(reference.raw);
      continue;
    }
    if (reference.optional || reference.resolvedPath === null) continue;
    if (!targetPaths.has(reference.resolvedPath)) missing.push(reference.resolvedPath);
  }
  return {
    ok: missing.length === 0,
    missing: [...new Set(missing)],
    external: [...new Set(external)],
    references: context.references,
  };
}

/** Decode entry bytes as UTF-8 and fail with a typed error on invalid input. */
export function decodeEntryHtml(bytes: Uint8Array): string {
  try {
    return utf8Decode(bytes);
  } catch (error) {
    throw new TapeCiError("INVALID_ARTIFACT", "entry HTML must be valid UTF-8", { cause: error });
  }
}

export function encodeEntryHtml(html: string): Uint8Array {
  return utf8(html);
}
