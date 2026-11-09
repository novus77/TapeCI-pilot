/** EIP-1271 contract signature verification (Safe/multisig container owners). */
import { createReadClient } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { TapeCiError, type Hex } from "@tapeci/shared";

const EIP1271_MAGIC = "0x1626ba7e";

const EIP1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magic", type: "bytes4" }],
  },
] as const;

export interface VerifyEip1271Input {
  readonly signerAddress: Hex;
  readonly digest: Hex;
  readonly signature: Hex;
  /** Injectable client for tests (defaults to the first pinned X Layer operator). */
  readonly client?: ReturnType<typeof createReadClient>;
}

/**
 * Returns true only when `signerAddress` is a contract that implements EIP-1271
 * and returns the `isValidSignature` magic value. EOAs return false.
 */
export async function verifyEip1271Signature(input: VerifyEip1271Input): Promise<boolean> {
  const rpc = XLAYER_MAINNET.rpcs[0];
  if (input.client === undefined && rpc === undefined) {
    throw new TapeCiError("INVALID_CONFIG", "no RPC endpoint for EIP-1271 verification");
  }
  const client = input.client ?? createReadClient((rpc as { url: string }).url);
  try {
    const code = await client.getCode({ address: input.signerAddress });
    if (code === undefined || code === "0x") return false;
    const result = await client.readContract({
      address: input.signerAddress,
      abi: EIP1271_ABI,
      functionName: "isValidSignature",
      args: [input.digest, input.signature],
    });
    return String(result).toLowerCase() === EIP1271_MAGIC;
  } catch {
    return false;
  }
}
