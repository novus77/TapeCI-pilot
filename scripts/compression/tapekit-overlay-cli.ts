import { prepareTapeKitOverlay } from "./tapekit-overlay.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") throw new Error("Usage: --source PINNED_TAPEKIT_REPO --output NEW_DIRECTORY");
  console.log(JSON.stringify(await prepareTapeKitOverlay({ sourceDir: args[1]!, outputDir: args[3]! }), null, 2));
}
main().catch((error: unknown) => {
  console.error(`TapeKit overlay failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
