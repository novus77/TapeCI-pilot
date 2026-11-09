#!/usr/bin/env tsx
/**
 * READ-ONLY helper: build the Opener.open(circuits, tokenId) transaction for a
 * processor NFT you already hold. It never signs or sends anything.
 *
 *   pnpm container:open-calldata -- --processor-index 0 --token-id 3
 *   pnpm container:open-calldata -- --processor 0x... --token-id 3
 *
 * Output: { to, data, valueWei, valueOkb, processor, tokenId, owner, opened, container }
 * Send it from `owner` with your own wallet; the value must equal Opener.FEE().
 */
import { encodeFunctionData, formatEther, getAddress } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import { createReadClient, factoryAbi, openerAbi, processorAbi } from "@tapeci/chain";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tokenIdArg = arg("--token-id");
const processorIndexArg = arg("--processor-index");
const processorArg = arg("--processor");
const rpc = arg("--rpc") ?? "https://rpc.xlayer.tech";
if (tokenIdArg === undefined) throw new Error("--token-id is required");
if (processorArg === undefined && processorIndexArg === undefined) {
  throw new Error("--processor 0x... or --processor-index <n> is required");
}
const client = createReadClient(rpc);
const tokenId = BigInt(tokenIdArg);
const processor =
  processorArg !== undefined
    ? getAddress(processorArg)
    : getAddress(
        await client.readContract({
          address: XLAYER_MAINNET.factory,
          abi: factoryAbi,
          functionName: "cpuAt",
          args: [BigInt(processorIndexArg ?? "0")],
        }),
      );
const [owner, opened, container, fee] = await Promise.all([
  client.readContract({ address: processor, abi: processorAbi, functionName: "ownerOf", args: [tokenId] }),
  client.readContract({
    address: XLAYER_MAINNET.opener,
    abi: openerAbi,
    functionName: "isOpened",
    args: [processor, tokenId],
  }),
  client.readContract({
    address: XLAYER_MAINNET.opener,
    abi: openerAbi,
    functionName: "accountOf",
    args: [processor, tokenId],
  }),
  client.readContract({ address: XLAYER_MAINNET.opener, abi: openerAbi, functionName: "FEE" }),
]);
if (opened) {
  console.log(
    JSON.stringify(
      { alreadyOpened: true, container: getAddress(container), owner: getAddress(owner), processor, tokenId: tokenId.toString() },
      null,
      2,
    ),
  );
  process.exit(0);
}
const data = encodeFunctionData({
  abi: openerAbi,
  functionName: "open",
  args: [processor, tokenId],
});
console.log(
  JSON.stringify(
    {
      readOnly: true,
      chainId: 196,
      to: XLAYER_MAINNET.opener,
      data,
      valueWei: fee.toString(),
      valueOkb: formatEther(fee),
      processor,
      tokenId: tokenId.toString(),
      owner: getAddress(owner),
      opened: false,
      note: "Send from `owner` with value=valueWei. Do not use a different account; Opener requires the NFT holder.",
    },
    null,
    2,
  ),
);
