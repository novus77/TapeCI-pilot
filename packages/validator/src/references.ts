import { canonicalizeArtifactPath } from "@tapeci/shared";
import type { ExternalReference } from "./types.js";

/** Schemes that make a reference non-self-contained for TapeOut's on-chain site policy. */
const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

const HTML_ATTRIBUTES = ["src", "href", "action", "poster", "srcset"] as const;

const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_REFRESH_URL_RE = /url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"';]+))/i;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

/**
 * CSS `url(...)` and `@import` references, in one alternation so the same URL is
 * not reported twice (groups 1-3: `@import url(...)`, 4-6: `url(...)`,
 * 7-8: `@import "..."`).
 */
const CSS_REFERENCE_PATTERN =
  "@import\\s+url\\(\\s*(?:\"([^\"]*)\"|'([^']*)'|([^'\")]*))\\s*\\)" +
  "|url\\(\\s*(?:\"([^\"]*)\"|'([^']*)'|([^'\")]*))\\s*\\)" +
  "|@import\\s+(?:\"([^\"]*)\"|'([^']*)')";

/**
 * True when a URL points outside the artifact (TapeKit SPEC §8 strict policy).
 * Protocol-relative (`//host/...`) and `http(s)` URLs are external. Fragments,
 * relative paths/query-only strings, and non-network schemes (`data:`, `blob:`,
 * `mailto:`, `tel:`, `javascript:`, …) are not treated as external.
 */
export function isExternalUrl(raw: string): boolean {
  const url = raw.trim();
  if (url.length === 0 || url.startsWith("#")) return false;
  if (url.startsWith("//")) return true;
  if (url.startsWith("/") || url.startsWith("\\")) return false;
  const match = SCHEME_RE.exec(url);
  if (match === null) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  return EXTERNAL_SCHEMES.has(scheme);
}

function attributeRegex(attribute: string): RegExp {
  return new RegExp(
    `(?:^|[\\s<])${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`,
    "gi",
  );
}

function attributeValue(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function attributeValues(source: string, attribute: string): string[] {
  const values: string[] = [];
  const regex = attributeRegex(attribute);
  let match = regex.exec(source);
  while (match !== null) {
    values.push(attributeValue(match));
    match = regex.exec(source);
  }
  return values;
}

function readAttribute(element: string, attribute: string): string | undefined {
  const match = attributeRegex(attribute).exec(element);
  if (match === null) return undefined;
  return attributeValue(match);
}

function splitSrcset(value: string): string[] {
  const urls: string[] = [];
  for (const candidate of value.split(",")) {
    const url = candidate.trim().split(/\s+/)[0] ?? "";
    if (url.length > 0) urls.push(url);
  }
  return urls;
}

function metaRefreshUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(META_TAG_RE)) {
    const tag = match[0] ?? "";
    const httpEquiv = readAttribute(tag, "http-equiv");
    if (httpEquiv === undefined || httpEquiv.trim().toLowerCase() !== "refresh") continue;
    const content = readAttribute(tag, "content");
    if (content === undefined) continue;
    const urlMatch = META_REFRESH_URL_RE.exec(content);
    if (urlMatch === null) continue;
    const url = (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? "").trim();
    if (url.length > 0) urls.push(url);
  }
  return urls;
}

function inlineStyleBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(STYLE_BLOCK_RE)) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function dedupe(references: readonly ExternalReference[]): ExternalReference[] {
  const seen = new Set<string>();
  const out: ExternalReference[] = [];
  for (const reference of references) {
    const key = `${reference.kind}\u0000${reference.attribute}\u0000${reference.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reference);
  }
  return out;
}

/** Extract external references from CSS (`url(...)`, `@import`). */
export function scanCssReferences(css: string, filePath: string): ExternalReference[] {
  const path = canonicalizeArtifactPath(filePath);
  const references: ExternalReference[] = [];
  const regex = new RegExp(CSS_REFERENCE_PATTERN, "gi");
  let match = regex.exec(css);
  while (match !== null) {
    const importUrl = match[1] ?? match[2] ?? match[3];
    const genericUrl = match[4] ?? match[5] ?? match[6];
    const importString = match[7] ?? match[8];
    const raw = importUrl ?? genericUrl ?? importString;
    if (raw !== undefined) {
      const url = raw.trim();
      if (isExternalUrl(url)) {
        const isImport = importUrl !== undefined || importString !== undefined;
        references.push({
          filePath: path,
          kind: isImport ? "css-import" : "css-url",
          attribute: isImport ? "@import" : "url",
          url,
        });
      }
    }
    match = regex.exec(css);
  }
  return dedupe(references);
}

/**
 * Extract external references from an HTML document: `src`/`href`/`action`/
 * `poster`/`srcset` attributes, `<meta http-equiv="refresh">` targets, and
 * `url(...)`/`@import` inside inline `<style>` blocks.
 */
export function scanHtmlReferences(html: string, filePath: string): ExternalReference[] {
  const path = canonicalizeArtifactPath(filePath);
  const references: ExternalReference[] = [];
  for (const attribute of HTML_ATTRIBUTES) {
    for (const value of attributeValues(html, attribute)) {
      if (attribute === "srcset") {
        for (const candidate of splitSrcset(value)) {
          if (isExternalUrl(candidate)) {
            references.push({
              filePath: path,
              kind: "html-attribute",
              attribute,
              url: candidate,
            });
          }
        }
        continue;
      }
      const url = value.trim();
      if (isExternalUrl(url)) {
        references.push({ filePath: path, kind: "html-attribute", attribute, url });
      }
    }
  }
  for (const url of metaRefreshUrls(html)) {
    references.push({ filePath: path, kind: "html-meta-refresh", attribute: "meta-refresh", url });
  }
  for (const css of inlineStyleBlocks(html)) {
    references.push(...scanCssReferences(css, path));
  }
  return dedupe(references);
}
