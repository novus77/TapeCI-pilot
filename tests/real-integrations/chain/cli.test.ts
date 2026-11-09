import { describe, expect, it } from "vitest";
import {
  parseRealIntegrationArgs,
  runRealIntegrationCommand,
  type RealIntegrationIo,
} from "../../../scripts/real-integrations/chain/cli.js";
import { TapeCiError } from "@tapeci/shared";

function memoryIo(): RealIntegrationIo & {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly files: Map<string, string>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>();
  return {
    stdout,
    stderr,
    files,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
    writeFile: async (path, value) => {
      files.set(path, value);
    },
  };
}

describe("real integration CLI", () => {
  it("refuses network execution without the exact opt-in", async () => {
    const io = memoryIo();
    const status = await runRealIntegrationCommand(
      ["preflight", "--container", "0xc0b4900262d0bc13f2c67c0fc4cf92c04e0ab814"],
      { env: {}, io },
    );
    expect(status).toBe(2);
    expect(io.stderr.join("")).toContain("TAPECI_REAL_INTEGRATION=1");
    expect(io.files.size).toBe(0);
  });

  it("rejects send, sign, transfer, and DNS mutation flags before any I/O", () => {
    for (const forbidden of ["--send", "--sign", "--transfer", "--write-dns"]) {
      expect(() =>
        parseRealIntegrationArgs([
          "transaction",
          "--hash",
          `0x${"ab".repeat(32)}`,
          "--from",
          "0x25063c2210a0bccce3e15d250573179483275f22",
          "--to",
          "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
          forbidden,
        ]),
      ).toThrow(TapeCiError);
    }
  });

  it("requires transaction fee cap and confirmation expectations", () => {
    expect(() =>
      parseRealIntegrationArgs([
        "transaction",
        "--hash",
        `0x${"ab".repeat(32)}`,
        "--from",
        "0x25063c2210a0bccce3e15d250573179483275f22",
        "--to",
        "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
      ]),
    ).toThrow(/--max-fee-wei is required/u);
  });

  it("accepts a documented read-only transaction command", () => {
    const parsed = parseRealIntegrationArgs([
      "transaction",
      "--hash",
      `0x${"ab".repeat(32)}`,
      "--from",
      "0x25063c2210a0bccce3e15d250573179483275f22",
      "--to",
      "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
      "--max-fee-wei",
      "30000000000000",
      "--min-confirmations",
      "2",
      "--balance-before-block",
      "74152000",
    ]);
    expect(parsed.command).toBe("transaction");
    expect(parsed.writeActionsPerformed).toBe(false);
  });
});
