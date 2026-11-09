import type { ChainConfig } from "@tapeci/config";
import { bindingAbi, factoryAbi, openerAbi } from "./abis.js";
import type { ReadClient } from "./clients.js";

export interface ChainFees {
  readonly gasPriceWei: bigint;
  readonly openerOpenFeeWei: bigint;
  readonly monthlyFeeWei: bigint;
  readonly factoryDeployFeeWei: bigint;
}

/** Fees are read live; none of these values may be hard-coded into a quote (PRD §3.1). */
export async function readFees(
  client: ReadClient,
  config: ChainConfig,
  blockNumber?: bigint,
): Promise<ChainFees> {
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const [gasPrice, openFee, monthlyFee, deployFee] = await Promise.all([
    client.getGasPrice(),
    client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "FEE",
      ...readOptions,
    }),
    client.readContract({
      address: config.binding,
      abi: bindingAbi,
      functionName: "monthlyFee",
      ...readOptions,
    }),
    client.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "deployFee",
      ...readOptions,
    }),
  ]);
  return {
    gasPriceWei: gasPrice,
    openerOpenFeeWei: openFee,
    monthlyFeeWei: monthlyFee,
    factoryDeployFeeWei: deployFee,
  };
}

export interface ActivationStatus {
  readonly containerActivated: boolean;
  readonly containerPaidUntil: number;
}

export async function readActivation(
  client: ReadClient,
  config: ChainConfig,
  container: `0x${string}`,
  blockNumber?: bigint,
): Promise<ActivationStatus> {
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const [live, paidUntil] = await Promise.all([
    client.readContract({
      address: config.binding,
      abi: bindingAbi,
      functionName: "isContainerLive",
      args: [container],
      ...readOptions,
    }),
    client.readContract({
      address: config.binding,
      abi: bindingAbi,
      functionName: "containerPaidUntil",
      args: [container],
      ...readOptions,
    }),
  ]);
  return { containerActivated: live, containerPaidUntil: paidUntil };
}
