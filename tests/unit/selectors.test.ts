import { describe, expect, it } from "vitest";
import {
  ALL_SIGNATURES,
  SELECTORS,
  TAPEKIT_KNOWN_SELECTORS,
  bytecodeContainsSelector,
  checkSelectorsInBytecode,
  keccakHex,
  selectorOf,
} from "@tapeci/chain";

describe("ABI selectors (P0-03)", () => {
  it("recomputes the selectors TapeKit hard-codes", () => {
    for (const [name, selector] of Object.entries(TAPEKIT_KNOWN_SELECTORS)) {
      const signature = ALL_SIGNATURES[name as keyof typeof ALL_SIGNATURES];
      expect(signature, `missing signature for ${name}`).toBeDefined();
      expect(selectorOf(signature), name).toBe(selector);
    }
  });

  it("derives write selectors from SPEC Appendix B.5 signatures", () => {
    expect(selectorOf("putFile(address,string,string,bytes32,bytes)")).toBe(SELECTORS.putFile);
    expect(selectorOf("appendChunk(address,string,uint256,bytes)")).toBe(SELECTORS.appendChunk);
    expect(selectorOf("setOperator(address,address,uint256)")).toBe(SELECTORS.setOperator);
    expect(SELECTORS.putFile).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("computes event topics with keccak256", () => {
    expect(keccakHex("FileSet(address,string,uint32,bytes32,string)")).toBe(
      "0x13b9b0f05b22c496a9d9a29e7041c56c04670dc98ab327448870f18eb07b6773",
    );
  });

  it("detects selectors in bytecode", () => {
    const selector = SELECTORS.fileInfo;
    expect(bytecodeContainsSelector(`0x60806040${selector.slice(2)}00`, selector)).toBe(true);
    expect(bytecodeContainsSelector("0x60806040", selector)).toBe(false);
  });

  it("returns structured presence rows", () => {
    const rows = checkSelectorsInBytecode("0x00", { fileInfo: "fileInfo(address,string)" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.present).toBe(false);
  });
});
