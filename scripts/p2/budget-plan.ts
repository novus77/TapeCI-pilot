/**
 * P2-10 read-only budget planner.
 *
 * Reads the current X Layer gas price from the configured operators and applies
 * the P1 observed gas model to representative site profiles. It never signs,
 * broadcasts or writes. Run: `corepack pnpm budget:p2`.
 */
import { XLAYER_MAINNET } from "@tapeci/config";
import { createReadClient } from "@tapeci/chain";
import {
  OBSERVED_XLAYER_GAS_MODEL,
  costWei,
  estimateFileGas,
  estimateTotalGas,
  recommendedCapWei,
} from "@tapeci/deployer";

const MARGIN_BPS = 2_000;

interface Profile {
  readonly name: string;
  readonly sizes: readonly number[];
}

const PROFILES: readonly Profile[] = [
  { name: "canary: 2 files / 40 KB", sizes: [4_096, 36_000] },
  { name: "small site: 5 files / 120 KB", sizes: [512, 30_000, 30_000, 30_000, 29_000] },
  {
    name: "medium site: 20 files / 2 MB",
    sizes: Array.from({ length: 20 }, (_, index) => (index === 0 ? 512 : 105_000)),
  },
  {
    name: "large site: 100 files / 8 MB",
    sizes: Array.from({ length: 100 }, (_, index) => (index === 0 ? 512 : 84_000)),
  },
];

function endpointUrl(operator: "okx" | "drpc", fallback: string): string {
  const override =
    operator === "okx" ? process.env.TAPECI_RPC_OKX : process.env.TAPECI_RPC_DRPC;
  return override === undefined || override.trim() === "" ? fallback : override.trim();
}

async function main(): Promise<void> {
  const seenOperators = new Set<string>();
  const endpoints = XLAYER_MAINNET.rpcs.filter((rpc) => {
    if (seenOperators.has(rpc.operator)) return false;
    seenOperators.add(rpc.operator);
    return true;
  });
  const observations = await Promise.all(
    endpoints.map(async (rpc) => {
      const url = endpointUrl(rpc.operator, rpc.url);
      const client = createReadClient(url);
      const [blockNumber, gasPrice] = await Promise.all([
        client.getBlockNumber(),
        client.getGasPrice(),
      ]);
      return {
        operator: rpc.operator,
        url,
        blockNumber: blockNumber.toString(),
        gasPriceWei: gasPrice.toString(),
        gasPriceGwei: Number(gasPrice) / 1e9,
      };
    }),
  );
  const gasPrices = observations.map((row) => BigInt(row.gasPriceWei));
  const minGasPrice = gasPrices.reduce((a, b) => (b < a ? b : a));
  const entryGas = estimateFileGas(512);
  const rollbackCostWei = costWei(entryGas, minGasPrice);
  const rollbackCapWei = recommendedCapWei(rollbackCostWei, MARGIN_BPS);

  const profiles = PROFILES.map((profile) => {
    const bytes = profile.sizes.reduce((sum, size) => sum + size, 0);
    const gas = estimateTotalGas(profile.sizes);
    const estimatedCostWei = costWei(gas, minGasPrice);
    const recommendedCapWeiValue = recommendedCapWei(estimatedCostWei, MARGIN_BPS);
    // BullMQ deploy queue retries up to 3 attempts, plus one rollback entry write
    // with its own cap. This is the conservative authorization envelope.
    const envelopeWei = recommendedCapWeiValue * 3n + rollbackCapWei * 2n;
    return {
      name: profile.name,
      files: profile.sizes.length,
      bytes,
      chunks: profile.sizes.reduce((sum, size) => sum + Math.ceil(size / 24_000), 0),
      estimatedGas: gas.toString(),
      estimatedCostWei: estimatedCostWei.toString(),
      estimatedCostOkb: Number(estimatedCostWei) / 1e18,
      recommendedCapWei: recommendedCapWeiValue.toString(),
      recommendedCapOkb: Number(recommendedCapWeiValue) / 1e18,
      envelopeIncludingRetryAndRollbackWei: envelopeWei.toString(),
      envelopeOkb: Number(envelopeWei) / 1e18,
    };
  });

  console.log(
    JSON.stringify(
      {
        schemaVersion: "tapeci.p2-10-budget.v1",
        observedAt: new Date().toISOString(),
        chainId: 196,
        gasModel: OBSERVED_XLAYER_GAS_MODEL,
        marginBps: MARGIN_BPS,
        observations,
        minGasPriceWei: minGasPrice.toString(),
        entryGas: entryGas.toString(),
        rollbackCostWei: rollbackCostWei.toString(),
        rollbackCapWei: rollbackCapWei.toString(),
        profiles,
        assumptions: [
          "all files are written (empty container / new release paths)",
          "one putFile per file and one appendChunk per 24,000-byte chunk after chunk 0",
          "no gas price spike; cap is estimated cost + 20%",
          "envelope = 3 x release cap (BullMQ default attempts) + 2 x rollback entry cap",
        ],
      },
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
