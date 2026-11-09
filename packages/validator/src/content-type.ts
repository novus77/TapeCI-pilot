/**
 * Static content-type mapping for the MIME types TapeCI may publish.
 * Text types always carry an explicit UTF-8 charset because the scanner (and the
 * manifest) treat HTML/CSS as UTF-8.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Lowercase extension including the leading dot, or "" when the path has none. */
export function extensionOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return "";
  return path.slice(dot).toLowerCase();
}

/** MIME type for a static artifact path. Unknown extensions are `application/octet-stream`. */
export function contentTypeForPath(path: string): string {
  const base = CONTENT_TYPES[extensionOfPath(path)] ?? "application/octet-stream";
  return base.startsWith("text/") ? `${base}; charset=utf-8` : base;
}

export function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().trimStart().startsWith("text/html");
}

export function isCssContentType(contentType: string): boolean {
  return contentType.toLowerCase().trimStart().startsWith("text/css");
}
