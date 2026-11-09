export const BOOLEAN_FLAGS = new Set([
  "repair-journal",
  "yes",
  "json",
  "force",
  "help",
  "no-install",
  "no-commit-check",
  "allow-single-operator",
]);

export interface ParsedArgs {
  readonly command: string | null;
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | null = null;
  let index = 0;
  if (argv[0] !== undefined && !argv[0].startsWith("-")) {
    command = argv[0];
    index = 1;
  }
  while (index < argv.length) {
    const raw = argv[index];
    if (raw === undefined) break;
    index += 1;
    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(raw);
    if (match === null) throw new Error(`unknown argument: ${raw}`);
    const name = match[1] as string;
    if (match[2] !== undefined) {
      flags.set(name, match[2]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { command, flags, positionals };
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

export function requireFlag(parsed: ParsedArgs, name: string, what = `--${name}`): string {
  const value = flagString(parsed, name);
  if (value === undefined || value.length === 0) throw new Error(`${what} is required`);
  return value;
}
