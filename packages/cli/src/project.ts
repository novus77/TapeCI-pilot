import { dirname, resolve } from "node:path";
import { loadTapeCiConfig, type TapeCiProjectConfig } from "@tapeci/config";
import type { ParsedArgs } from "./args.js";
import { flagString } from "./args.js";

export interface Project {
  readonly configPath: string;
  readonly root: string;
  readonly config: TapeCiProjectConfig;
  readonly distDir: string;
}

export function loadProject(parsed: ParsedArgs): Project {
  const configPath = resolve(flagString(parsed, "config") ?? ".tapeci.json");
  const root = dirname(configPath);
  const config = loadTapeCiConfig(configPath);
  const distOverride = flagString(parsed, "dist");
  const distDir = distOverride === undefined ? resolve(root, config.build.outputDir) : resolve(distOverride);
  return { configPath, root, config, distDir };
}
