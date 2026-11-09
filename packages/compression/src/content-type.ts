/** TapeKit's MIT-licensed safeContentType policy at pinned commit 37c617e7, kept browser-safe. */
export function sanitizePackContentType(contentType: string): string {
  const safe = contentType.replace(/[^\w.+/;=\- ]/g, "").slice(0, 100);
  return /^[\w.+-]+\/[\w.+-]+/.test(safe) ? safe : "application/octet-stream";
}
