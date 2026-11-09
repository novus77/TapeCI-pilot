import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "@tapeci/cli";
import { XLAYER_MAINNET } from "@tapeci/config";
import { readFileBytesAt } from "@tapeci/chain";
import { ReleaseStore } from "@tapeci/release";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  ONE_OKB,
  clientsFor,
  fundAndImpersonate,
  openNewContainer,
} from "../../scripts/fork/support.js";

const OPENER_EOA = "0x1000000000000000000000000000000000000005" as Hex;
let fork: AnvilFork;
let client: ReturnType<typeof clientsFor>["publicClient"];
let signer: Hex;
let container: Hex;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  fork = await startAnvilFork({ offset: 50 });
  const clients = clientsFor(fork);
  client = clients.publicClient;
  const opened = await openNewContainer({
    fork,
    client,
    testClient: clients.testClient,
    opener: OPENER_EOA,
  });
  container = opened.container;
  signer = opened.owner;
  await fundAndImpersonate(clients.testClient, signer, 100n * ONE_OKB);
}, 180_000);

afterAll(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (fork !== undefined) await fork.stop();
}, 120_000);

interface Project {
  readonly root: string;
  readonly configPath: string;
  readonly distDir: string;
  readonly journalPath: string;
  readonly reportPath: string;
}

async function project(seed: number): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "tapeci-cli-fork-"));
  temporaryDirectories.push(root);
  const configPath = join(root, ".tapeci.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "tapeci.config.v1",
        chainId: 196,
        site: { container },
        build: { outputDir: "dist" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const distDir = join(root, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(
    join(distDir, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="./assets/style.css"></head>` +
      `<body>cli release ${String(seed)}<img src="./assets/logo.svg"></body></html>`,
    "utf8",
  );
  await writeFile(join(distDir, "assets", "style.css"), `body{content:"${String(seed)}"}`, "utf8");
  await writeFile(
    join(distDir, "assets", "logo.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg"><text>${String(seed)}</text></svg>`,
    "utf8",
  );
  return {
    root,
    configPath,
    distDir,
    journalPath: join(root, "deploy.jsonl"),
    reportPath: join(root, "report.json"),
  };
}

async function deploy(projectDir: Project, commitSha: string, storeDir: string): Promise<number> {
  return runCli([
    "deploy",
    "--config",
    projectDir.configPath,
    "--dist",
    projectDir.distDir,
    "--commit",
    commitSha,
    "--repository-id",
    "7",
    "--fork-url",
    fork.url,
    "--signer",
    signer,
    "--cap",
    (10n * ONE_OKB).toString(),
    "--yes",
    "--journal",
    projectDir.journalPath,
    "--store",
    storeDir,
    "--report-out",
    projectDir.reportPath,
  ]);
}

async function entrySha(): Promise<Hex> {
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new Error("no registry");
  const read = await readFileBytesAt(client, registry, container, "index.html");
  return sha256Hex(read.bytes);
}

describe("P1-09 CLI end-to-end on an Anvil fork", () => {
  it("deploys two releases, verifies one, lists the store and rolls back", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tapeci-cli-store-"));
    temporaryDirectories.push(storeDir);

    const projectA = await project(1);
    expect(await deploy(projectA, "a".repeat(40), storeDir)).toBe(0);
    const reportA = JSON.parse(await readFile(projectA.reportPath, "utf8")) as {
      releaseMatch: boolean;
    };
    expect(reportA.releaseMatch).toBe(true);
    const entryA = await entrySha();

    const projectB = await project(2);
    expect(await deploy(projectB, "b".repeat(40), storeDir)).toBe(0);
    const reportB = JSON.parse(await readFile(projectB.reportPath, "utf8")) as {
      releaseMatch: boolean;
    };
    expect(reportB.releaseMatch).toBe(true);
    const entryB = await entrySha();
    expect(entryB).not.toBe(entryA);

    const store = new ReleaseStore(storeDir);
    const releases = await store.list();
    expect(releases).toHaveLength(2);
    const releaseA = releases.find((release) => release.commitSha === "a".repeat(40));
    if (releaseA === undefined) throw new Error("release A missing from store");
    const storedA = await store.load(releaseA.releaseId);
    expect(storedA.record.entrySha256).toBe(entryA);

    // verify B through the CLI using its journal
    expect(
      await runCli([
        "verify",
        "--config",
        projectB.configPath,
        "--dist",
        projectB.distDir,
        "--commit",
        "b".repeat(40),
        "--repository-id",
        "7",
        "--fork-url",
        fork.url,
        "--journal",
        projectB.journalPath,
        "--allow-single-operator",
      ]),
    ).toBe(0);

    // rollback to A
    expect(
      await runCli([
        "rollback",
        "--config",
        projectA.configPath,
        "--store",
        storeDir,
        "--release",
        releaseA.releaseId,
        "--fork-url",
        fork.url,
        "--signer",
        signer,
      ]),
    ).toBe(0);
    expect(await entrySha()).toBe(entryA);

    expect(
      await runCli(["releases", "--config", projectA.configPath, "--store", storeDir]),
    ).toBe(0);
  }, 300_000);
});
