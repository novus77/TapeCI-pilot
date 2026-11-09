import { resolve } from "node:path";
import { runCompressionForkMeasurement } from "./fork-measurement.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") throw new Error("Usage: --source PINNED_TAPEKIT_REPO --output NEW_JSON_FILE (local Anvil writes only)");
  const report = await runCompressionForkMeasurement({ sourceDir: args[1]!, outputPath: resolve(args[3]!) });
  console.log(JSON.stringify({ scope: report.scope, mainnetWritesPerformed: report.mainnetWritesPerformed, output: resolve(args[3]!), strategies: report.measurements.map(row => ({ strategy: row.strategy, transactions: row.accounting.transactions, gasUsed: row.accounting.gasUsed.toString() })) }, null, 2));
}
main().catch((error: unknown) => {
  console.error(`Local compression measurement failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
