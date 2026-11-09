import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCompressionForkMeasurement } from "../../scripts/compression/fork-measurement.js";

it.skipIf(process.env.TAPECI_COMPRESSION_MEASURE !== "1")("executes all strategies from one restored baseline and decodes actual chain bytes with TapeKit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tapeci-measure-test-"));
  try {
    const report = await runCompressionForkMeasurement({ sourceDir: process.env.TAPECI_TAPEKIT_SOURCE!, outputPath: process.env.TAPECI_COMPRESSION_MEASURE_EVIDENCE ?? join(root, "evidence.json") });
    expect(report.mainnetWritesPerformed).toBe(false);
    expect(report.measurements.map(row => row.strategy)).toEqual(["original", "gzip-individual", "gzip-whole", "gzip-grouped"]);
    expect(new Set(report.measurements.map(row => row.baselineBlockHash)).size).toBe(1);
    expect(report.measurements.every(row => row.gateway.verifiedPhysicalFiles > 0 && row.accounting.transactions > 0 && row.gateway.logicalFilesMatched === report.source.files)).toBe(true);
    expect(report.measurements.every(row => row.accounting.gasUsed === row.receipts.reduce((sum, receipt) => sum + receipt.gasUsed, 0n))).toBe(true);
    expect(report.automaticSelection).toBe("original");
    const stored = JSON.parse(await readFile(process.env.TAPECI_COMPRESSION_MEASURE_EVIDENCE ?? join(root, "evidence.json"), "utf8"));
    expect(stored.schemaVersion).toBe("tapeci.compression-measurement.v1");
    expect(stored.complete).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 600_000);
