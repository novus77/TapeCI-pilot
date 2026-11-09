import { canonicalJson } from "@tapeci/shared";
import type { ReleasePlan } from "./release-plan.js";

export function compareReleaseCosts(input: { original: ReleasePlan; compressed: ReleasePlan; originalServiceFeeWei?: bigint; compressedServiceFeeWei?: bigint }) {
  const original = input.original;
  const compressed = input.compressed;
  const identity = (plan: ReleasePlan) => canonicalJson({ chainId: plan.chainId, container: plan.container.toLowerCase(), siteRegistry: plan.siteRegistry.toLowerCase(), pinnedBlockNumber: plan.pinnedBlockNumber.toString(), pinnedBlockHash: plan.pinnedBlockHash.toLowerCase(), gasPriceWei: plan.fees.gasPriceWei.toString(), operators: [...plan.operators].sort() });
  if (identity(original) !== identity(compressed)) throw new Error("Release quote context mismatch");
  if (original.blocked || compressed.blocked) throw new Error("Blocked plans are not comparable quotes");
  const originalQuote = summarize(original, input.originalServiceFeeWei ?? 0n);
  const compressedQuote = summarize(compressed, input.compressedServiceFeeWei ?? 0n);
  return {
    quoteType: "model-estimate" as const,
    original: originalQuote, compressed: compressedQuote,
    modelCheaper: compressedQuote.totalEstimatedCostWei < originalQuote.totalEstimatedCostWei ? "compressed" as const : compressedQuote.totalEstimatedCostWei > originalQuote.totalEstimatedCostWei ? "original" as const : "equal" as const,
    automaticSelection: "original" as const,
    automaticSelectionReason: "production-simulation-and-gateway-qualification-required" as const,
  };
}

function summarize(plan: ReleasePlan, serviceFeeWei: bigint) {
  if (serviceFeeWei < 0n) throw new Error("Invalid negative service fee");
  if (plan.fees.estimatedCostWei !== plan.fees.estimatedGas * plan.fees.gasPriceWei) throw new Error("Inconsistent plan fee estimate");
  return {
    physicalFiles: plan.totals.files, writeFiles: plan.totals.writes, reusedFiles: plan.totals.unchanged,
    plannedBytes: plan.totals.bytes, plannedChunks: plan.totals.chunks,
    estimatedNetworkCostWei: plan.fees.estimatedCostWei, networkRecommendedCapWei: plan.fees.recommendedCapWei,
    serviceFeeWei, totalEstimatedCostWei: plan.fees.estimatedCostWei + serviceFeeWei,
  };
}

/**
 * Why automatic selection stayed with the original release (SPEC §15).
 *
 * These are machine reasons, not prose: the console localizes them, and a test asserts each
 * branch. `unknown-cost` exists because §15 says an unknown cost means original — it must never
 * be treated as "free".
 */
export type AutomaticSelectionReason =
  | "gateway-not-qualified"
  | "production-simulation-required"
  | "cost-unknown"
  | "not-strictly-cheaper"
  | "strictly-cheaper";

export interface StrategyQualification {
  /** Is a production gateway qualified for this exact target? */
  readonly gatewayQualified: boolean;
  /** Does a production-compatible transaction simulation exist for this quote? */
  readonly productionSimulation: boolean;
}

/**
 * The §15 rule, as a pure function.
 *
 * Automatic compression requires **all** of: a qualified gateway, a production-compatible
 * simulation, a known cost, and a strictly cheaper complete quote. Anything else keeps
 * `original`. Equality is not enough — "strictly" is in the spec, and a tie is not a saving.
 *
 * The production path passes `productionSimulation: false` today, so this returns `original`
 * with `production-simulation-required` — the same safety stance as the C2 addendum, but now
 * the rule is explicit and tested rather than a hardcoded constant.
 */
export function selectReleaseStrategy(input: {
  /** Does a cost for this deployment's own plan exist at all? */
  readonly costKnown: boolean;
  /** The original-vs-compressed comparison, when both plans could be produced. */
  readonly comparison: { readonly modelCheaper: "original" | "compressed" | "equal" } | null;
  readonly qualification: StrategyQualification;
}): { readonly strategy: "original" | "compressed"; readonly reason: AutomaticSelectionReason } {
  if (!input.qualification.gatewayQualified) {
    return { strategy: "original", reason: "gateway-not-qualified" };
  }
  if (!input.costKnown) {
    // §15: unknown cost means original — never "free".
    return { strategy: "original", reason: "cost-unknown" };
  }
  if (!input.qualification.productionSimulation) {
    return { strategy: "original", reason: "production-simulation-required" };
  }
  // No comparison means cheaper was never established; §15 requires it to be *strictly* cheaper.
  if (input.comparison === null || input.comparison.modelCheaper !== "compressed") {
    return { strategy: "original", reason: "not-strictly-cheaper" };
  }
  return { strategy: "compressed", reason: "strictly-cheaper" };
}
