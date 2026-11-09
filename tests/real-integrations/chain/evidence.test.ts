import { describe, expect, it } from "vitest";
import {
  findSecretPaths,
  stableEvidenceJson,
} from "../../../scripts/real-integrations/chain/evidence.js";

describe("evidence serialization", () => {
  it("serializes bigint values deterministically and rejects secret-like keys", () => {
    const json = stableEvidenceJson({
      block: 1n,
      nested: { value: 2n },
      rpcHost: "rpc.example.test",
    });
    expect(json).toContain('"block": "1"');
    expect(json).toContain('"value": "2"');
    expect(() =>
      stableEvidenceJson({
        nested: { privateKey: "must-not-be-written" },
      }),
    ).toThrow(/sensitive field/u);
  });

  it("detects secret-like keys before writing evidence", () => {
    expect(
      findSecretPaths({
        rpc: { authorization: "redacted", host: "rpc.example.test" },
        mnemonic: "redacted",
      }),
    ).toEqual(["$.mnemonic", "$.rpc.authorization"]);
  });
});
