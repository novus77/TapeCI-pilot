import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { scanArtifactFiles } from "@tapeci/validator";
import { analyzeCompression, decodeCandidate, parsePreviousAnalysis, writeAnalysis } from "../../packages/compression/src/index.js";

const execute = promisify(execFile);
const workspaces: string[] = [];
const cli = fileURLToPath(new URL("../../packages/compression/src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tapeci-compression-test-"));
  workspaces.push(root);
  const input = join(root, "input");
  await mkdir(input);
  await writeFile(join(input, "index.html"), '<html><script src="app.js"></script></html>');
  await writeFile(join(input, "app.js"), 'console.log("hello");'.repeat(400));
  return { root, input, output: join(root, "result") };
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("compression CLI", () => {
  it("persists actual decodable objects and compares a prior report without a chain connection", async () => {
    const f = await fixture();
    await execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output]);
    const report = JSON.parse(await readFile(join(f.output, "report.json"), "utf8"));
    expect(report.compatibility).toBe("unverified");
    expect(report.strictOnChain).toBe(true);
    for (const strategy of ["original", "gzip-individual", "gzip-whole", "gzip-grouped"]) {
      const folder = join(f.output, strategy);
      const index = JSON.parse(await readFile(join(folder, "index.json"), "utf8"));
      const paths = await readdir(join(folder, "objects"));
      const objects = new Map(await Promise.all(paths.map(async name => [`objects/${name}`, await readFile(join(folder, "objects", name))] as const)));
      const files = decodeCandidate(index, objects);
      expect(files.find(file => file.path === "app.js")?.bytes).toEqual(await readFile(join(f.input, "app.js")));
    }
    const second = join(f.root, "second");
    await execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", second, "--previous", join(f.output, "report.json")]);
    const after = parsePreviousAnalysis(JSON.parse(await readFile(join(second, "report.json"), "utf8")));
    expect(after.candidates).toHaveLength(4);
    const secondReport = JSON.parse(await readFile(join(second, "report.json"), "utf8"));
    expect(secondReport.candidates.every((candidate: { changedObjectBytes: number }) => candidate.changedObjectBytes === 0)).toBe(true);
  });

  it("refuses existing output and preserves its contents", async () => {
    const f = await fixture();
    await mkdir(f.output);
    await writeFile(join(f.output, "keep.txt"), "keep");
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output])).rejects.toThrow(/EEXIST/);
    expect(await readFile(join(f.output, "keep.txt"), "utf8")).toBe("keep");
    expect(await readdir(f.output)).toEqual(["keep.txt"]);
  });

  it("rejects nested input/output even through a symlink", async () => {
    const f = await fixture();
    await symlink(f.input, join(f.root, "alias"));
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", join(f.root, "alias", "result")])).rejects.toThrow(/must not contain/);
    expect((await readdir(f.input)).sort()).toEqual(["app.js", "index.html"]);
  });

  it("rejects malformed previous analysis and invalid flags before producing a report", async () => {
    const f = await fixture();
    const previous = join(f.root, "previous.json");
    await writeFile(previous, JSON.stringify({ schemaVersion: "unknown", candidates: [] }));
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output, "--previous", previous])).rejects.toThrow(/Unsupported previous/);
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output, "--unknown"])).rejects.toThrow(/Unknown/);
    expect(await readdir(f.root)).not.toContain("result");
  });

  it("enforces strict scanning unless external resources are explicitly permitted", async () => {
    const f = await fixture();
    await writeFile(join(f.input, "index.html"), '<html><img src="https://example.com/image.png"></html>');
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output])).rejects.toThrow();
    await execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output, "--allow-external"]);
    expect(JSON.parse(await readFile(join(f.output, "report.json"), "utf8")).strictOnChain).toBe(false);
  });
});

describe("previous report boundary", () => {
  it("rejects invalid stored object metadata instead of claiming reuse", () => {
    expect(() => parsePreviousAnalysis({ schemaVersion: "tapeci.compression-analysis.v1", candidates: [{ strategy: "gzip-whole", available: true, objects: [{ path: "../wrong", sha256: "bad", encoding: "gzip", storedBytes: 1, decodedBytes: 1 }] }] })).toThrow();
    expect(() => parsePreviousAnalysis({ schemaVersion: "tapeci.compression-analysis.v1", candidates: [{ strategy: "unknown", available: true, objects: [] }] })).toThrow();
  });
});


describe("analysis persistence boundaries", () => {
  it("rejects changed index bytes and candidate IDs before creating an output directory", async () => {
    const f = await fixture();
    const files = scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from("hello") }]).files;
    const analysis = analyzeCompression(files);
    analysis.candidates[0]!.indexBytes[0] = 0;
    await expect(writeAnalysis(f.output, analysis)).rejects.toThrow(/index|identity/i);
    expect(await readdir(f.root)).not.toContain("result");
    const fresh = analyzeCompression(files);
    const bad = { ...fresh, candidates: fresh.candidates.map(candidate => ({ ...candidate, candidateId: `0x${"0".repeat(64)}` as const })) };
    await expect(writeAnalysis(f.output, bad)).rejects.toThrow(/index|identity/i);
  });

  it("rejects source limits during metadata preflight before reading oversized files", async () => {
    const f = await fixture();
    const path = join(f.input, "huge.bin");
    await writeFile(path, "");
    await truncate(path, 8_400_001);
    await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output])).rejects.toThrow(/source.*limit/i);
    expect(await readdir(f.root)).not.toContain("result");
  });
});


it("preflights the total decoded source budget across individually valid files", async () => {
  const f = await fixture();
  for (let i = 0; i < 9; i += 1) {
    const path = join(f.input, `media-${i}.bin`);
    await writeFile(path, "");
    await truncate(path, 8 * 1024 * 1024);
  }
  await expect(execute(process.execPath, ["--import", tsx, cli, "--input", f.input, "--output", f.output])).rejects.toThrow(/Source metadata limit/);
  expect(await readdir(f.root)).not.toContain("result");
});
