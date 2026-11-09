import { startCompressionPreview } from "./preview.js";

async function main() {
  const flags = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let position = 0; position < args.length; position += 2) {
    const flag = args[position]!;
    const value = args[position + 1];
    if (!["--candidate", "--index-hash", "--port", "--spa-fallback"].includes(flag) || flags.has(flag) || !value || value.startsWith("--")) throw new Error("Invalid preview arguments");
    flags.set(flag, value);
  }
  const candidateDir = flags.get("--candidate");
  const expectedIndexHash = flags.get("--index-hash");
  if (!candidateDir || !expectedIndexHash) throw new Error("Usage: --candidate DIR --index-hash HASH [--port PORT] [--spa-fallback true|false]");
  const fallback = flags.get("--spa-fallback") ?? "false";
  if (fallback !== "true" && fallback !== "false") throw new Error("Invalid SPA fallback setting");
  const preview = await startCompressionPreview({ candidateDir, expectedIndexHash, spaFallback: fallback === "true", port: Number(flags.get("--port") ?? 0) });
  console.log(JSON.stringify({ url: preview.url, runtimeBytes: preview.runtimeBytes, localOnly: true, chainVerified: false }));
  process.once("SIGINT", () => { void preview.close(); });
  process.once("SIGTERM", () => { void preview.close(); });
}
main().catch((error: unknown) => {
  console.error(`Compression preview failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
