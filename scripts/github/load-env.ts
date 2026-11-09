/**
 * Load `.tapeci/github-app.env` (dotenv, real newlines) into the current process.
 *
 *   corepack pnpm github:load-env -- print     # print shell exports (never values)
 *   eval "$(corepack pnpm github:load-env -- export)" ... not supported for PEM
 *
 * For running processes use `tsx --env-file=.tapeci/github-app.env`, or import
 * `loadGithubAppEnv()` from this module in local scripts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadGithubAppEnv(path = join(process.cwd(), ".tapeci/github-app.env")): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value) as string;
    }
    env[key] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const env = await loadGithubAppEnv();
  const mode = process.argv[2] ?? "keys";
  if (mode === "keys") {
    console.log(Object.keys(env).join("\n"));
    return;
  }
  if (mode === "shell") {
    // Values are not printed; emit export names only as a hint.
    for (const key of Object.keys(env)) console.log(`export ${key}=<from .tapeci/github-app.env>`);
    return;
  }
  console.log(JSON.stringify(Object.fromEntries(Object.keys(env).map((key) => [key, "***"])), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
