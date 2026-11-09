import { keccak256, toBytes, toFunctionSelector, type Hex } from "viem";

/**
 * Canonical signatures from TapeKit SPEC Appendix B.5 (reads) and README §3
 * (writes). Selectors are recomputed with viem and checked against live
 * bytecode in scripts/probe and tests/mainnet.
 */
export const READ_SIGNATURES = {
  cpuCount: "cpuCount()",
  cpuAt: "cpuAt(uint256)",
  cpus: "cpus(uint256)",
  isCPU: "isCPU(address)",
  accountOf: "accountOf(address,uint256)",
  isOpened: "isOpened(address,uint256)",
  isDeployed: "isDeployed(address,uint256)",
  open: "open(address,uint256)",
  token: "token()",
  ownerOf: "ownerOf(uint256)",
  name: "name()",
  fileInfo: "fileInfo(address,string)",
  read: "read(address,string)",
  readRange: "readRange(address,string,uint256,uint256)",
  pathCount: "pathCount(address)",
  pathsRange: "pathsRange(address,uint256,uint256)",
  paths: "paths(address)",
  fallbackPath: "fallbackPath(address)",
  isOpenedContainer: "isOpenedContainer(address)",
  isLive: "isLive(string,address)",
  isContainerLive: "isContainerLive(address)",
  paidUntil: "paidUntil(bytes32,address)",
  containerPaidUntil: "containerPaidUntil(address)",
  monthlyFee: "monthlyFee()",
  chunkMax: "CHUNK_MAX()",
} as const;

export const WRITE_SIGNATURES = {
  putFile: "putFile(address,string,string,bytes32,bytes)",
  appendChunk: "appendChunk(address,string,uint256,bytes)",
  removeFile: "removeFile(address,string)",
  setFallback: "setFallback(address,string)",
  setOperator: "setOperator(address,address,uint256)",
  bind: "bind(string,address,uint256)",
  syncContainer: "syncContainer(string,address)",
} as const;

export const ALL_SIGNATURES = { ...READ_SIGNATURES, ...WRITE_SIGNATURES } as const;

export type FunctionName = keyof typeof ALL_SIGNATURES;

export const SELECTORS: Readonly<Record<FunctionName, Hex>> = Object.fromEntries(
  Object.entries(ALL_SIGNATURES).map(([name, signature]) => [
    name,
    toFunctionSelector(signature),
  ]),
) as Record<FunctionName, Hex>;

/**
 * Selectors hard-coded by TapeKit's reference kernel (kernel/src/selectors.js at
 * commit 40994bd6…). P0-03 recomputes every signature and compares both sets, so a
 * signature drift in either direction becomes visible.
 */
export const TAPEKIT_KNOWN_SELECTORS: Readonly<Record<string, Hex>> = {
  cpuCount: "0xa94da8a7",
  cpuAt: "0x4bc7cbbd",
  isCPU: "0x5f5a364f",
  accountOf: "0x0c1905e5",
  isOpened: "0x8b508494",
  token: "0xfc0c546a",
  ownerOf: "0x6352211e",
  name: "0x06fdde03",
  fileInfo: "0x6c609107",
  read: "0xccaa7afb",
  readRange: "0x15a4cae2",
  pathCount: "0xb554782b",
  pathsRange: "0xb056072c",
  fallbackPath: "0xa76c7713",
  isLive: "0xd6b062cd",
  paidUntil: "0x2110540f",
  monthlyFee: "0x8cfd3e40",
  containerPaidUntil: "0x9ebfd859",
  isContainerLive: "0xdcca979e",
  // Write surface observed in the live X Layer binding implementation
  // 0x5ebf29b8…347df (PUSH4 presence checked 2026-10-25; semantics covered by the
  // plan's eth_call simulation + fork test).
  bind: "0x69e292ce",
  syncContainer: "0xe35e5ba6",
};

export function selectorOf(signature: string): Hex {
  return toFunctionSelector(signature);
}

/** keccak256 of a UTF-8 string (used for event topics and nameHash). */
export function keccakHex(value: string): Hex {
  return keccak256(toBytes(value));
}

/**
 * Function selectors appear in the dispatcher as PUSH4 <selector> constants.
 * A byte-level search is evidence of presence, not proof of semantics; P0-03 also
 * calls the function and checks a decodable return value.
 */
export function bytecodeContainsSelector(code: Hex, selector: Hex): boolean {
  return code.toLowerCase().includes(selector.slice(2).toLowerCase());
}

export interface SelectorPresence {
  readonly name: string;
  readonly signature: string;
  readonly selector: Hex;
  readonly present: boolean;
}

export function checkSelectorsInBytecode(
  code: Hex,
  signatures: Readonly<Record<string, string>>,
): SelectorPresence[] {
  return Object.entries(signatures).map(([name, signature]) => {
    const selector = selectorOf(signature);
    return { name, signature, selector, present: bytecodeContainsSelector(code, selector) };
  });
}
