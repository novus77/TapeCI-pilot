import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const FILES = [
  "scripts/real-integrations/chain/cli.ts",
  "scripts/real-integrations/chain/readers.ts",
  "scripts/real-integrations/chain/preflight.ts",
  "scripts/real-integrations/chain/transaction.ts",
  "scripts/real-integrations/chain/gateway.ts",
  "scripts/real-integrations/chain/common.ts",
  "scripts/real-integrations/chain/evidence.ts",
] as const;

describe("real integration write boundary", () => {
  it("contains no signing, transaction broadcast, or DNS mutation APIs", async () => {
    const forbidden = [
      /\bprivateKeyToAccount\b/u,
      /\bcreateWalletClient\b/u,
      /\bsignTransaction\b/u,
      /\bsendTransaction\b/u,
      /\bsendRawTransaction\b/u,
      /\bwriteContract\b/u,
      /\bchangeResourceRecordSets\b/u,
      /\bcreateChangeBatch\b/u,
    ];
    for (const path of FILES) {
      const source = await readFile(path, "utf8");
      for (const pattern of forbidden) expect(source, `${path} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
