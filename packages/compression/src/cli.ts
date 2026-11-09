import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scanCompressionDirectory } from "./input.js";
import { analyzeCompression } from "./analyze.js";
import { parsePreviousAnalysis } from "./decode.js";
import { writeAnalysis } from "./storage.js";

async function main() {
  const flags = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let position = 0; position < args.length; position += 1) {
    const flag = args[position]!;
    if (!["--input", "--output", "--previous", "--entry", "--allow-external"].includes(flag) || flags.has(flag)) throw new Error(`Unknown or duplicate flag: ${flag}`);
    if (flag === "--allow-external") {
      flags.set(flag, "true");
      continue;
    }
    const value = args[position + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    flags.set(flag, value);
    position += 1;
  }
  const input = flags.get("--input");
  const output = flags.get("--output");
  if (!input || !output) throw new Error("Usage: --input DIR --output NEW_DIR [--previous REPORT_JSON] [--entry PATH] [--allow-external]");
  const source = await realpath(resolve(input));
  const destination = join(await realpath(dirname(resolve(output))), relative(dirname(resolve(output)), resolve(output)));
  if (contains(source, destination) || contains(destination, source)) throw new Error("Input and output directories must not contain each other");
  const previousPath = flags.get("--previous");
  const previous = previousPath === undefined ? undefined : parsePreviousAnalysis(JSON.parse(await readFile(previousPath, "utf8")));
  const entryPath = flags.get("--entry") ?? "index.html";
  const strictOnChain = !flags.has("--allow-external");
  const scanned = await scanCompressionDirectory(source, { entryPath, strictOnChain });
  const analysis = analyzeCompression(scanned.files, { entryPath, strictOnChain, ...(previous === undefined ? {} : { previous }) });
  await writeAnalysis(destination, analysis);
  console.log(JSON.stringify({ report: join(destination, "report.json"), ...analysis.report }, null, 2));
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

main().catch((error: unknown) => {
  console.error(`Compression analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
