import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTapeCiConfig } from "@tapeci/config";
import { parseArgs, runCli } from "@tapeci/cli";

const temporaryDirectories: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tapeci-cli-"));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const CONTAINER = "0x25B20D3eA6b207506340eab2Eb0f45Edc800F6b3";

describe("P1-09 CLI argument parsing", () => {
  it("parses commands, flags, boolean flags and positionals", () => {
    const parsed = parseArgs([
      "deploy",
      "--config",
      ".tapeci.json",
      "--yes",
      "--cap=100",
      "--commit",
      "a".repeat(40),
      "extra",
    ]);
    expect(parsed.command).toBe("deploy");
    expect(parsed.flags.get("config")).toBe(".tapeci.json");
    expect(parsed.flags.get("yes")).toBe(true);
    expect(parsed.flags.get("cap")).toBe("100");
    expect(parsed.positionals).toEqual(["extra"]);
  });

  it("rejects a missing flag value", () => {
    expect(() => parseArgs(["plan", "--config"])).toThrowError(/missing value/);
  });
});

describe("P1-09 CLI init / validate / help", () => {
  it("writes a valid .tapeci.json and refuses to overwrite without --force", async () => {
    const dir = await tempDir();
    const configPath = join(dir, ".tapeci.json");
    expect(await runCli(["init", "--config", configPath, "--container", CONTAINER])).toBe(0);
    const config = loadTapeCiConfig(configPath);
    expect(config.site.container).toBe(CONTAINER.toLowerCase());
    expect(config.chainId).toBe(196);

    expect(await runCli(["init", "--config", configPath, "--container", CONTAINER])).toBe(2);
    expect(await runCli(["init", "--config", configPath, "--container", CONTAINER, "--force"])).toBe(0);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe("tapeci.config.v1");
  });

  it("validates the fixture site offline", async () => {
    const dir = await tempDir();
    const configPath = join(dir, ".tapeci.json");
    await runCli(["init", "--config", configPath, "--container", CONTAINER]);
    expect(
      await runCli([
        "validate",
        "--config",
        configPath,
        "--dist",
        "tests/fixtures/static-site",
      ]),
    ).toBe(0);
  });

  it("prints help and rejects unknown commands", async () => {
    expect(await runCli([])).toBe(0);
    expect(await runCli(["nope"])).toBe(2);
  });
});

describe("P1-09 CLI build", () => {
  it("runs config build commands in the project root and scans the output", async () => {
    const dir = await tempDir();
    const configPath = join(dir, ".tapeci.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "tapeci.config.v1",
        chainId: 196,
        site: { container: CONTAINER },
        build: {
          installCommand: "true",
          buildCommand:
            "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<!doctype html><title>cli</title>')\"",
          outputDir: "dist",
          timeoutSeconds: 60,
        },
      }),
      "utf8",
    );
    expect(await runCli(["build", "--config", configPath, "--no-install", "--no-commit-check"])).toBe(0);
  }, 60_000);
});
