/**
 * Snapshot-vs-chain comparison for the `/resources` re-verify control (SPEC §3.1 step 3,
 * AC-P2-26/AC-P2-27).
 *
 * Extracted from the component so the rule can be tested: round 1 and round 2 of the
 * independent acceptance both found the control had **zero** test coverage, which is how its
 * owner comparison went missing in the first place.
 *
 * The rule is deliberately conservative:
 * - `opened` drift is only claimed when both sides are known (`null` is "not read", not
 *   "false", so an unknown snapshot cannot be contradicted);
 * - an owner change is a real drift **even when `opened` is unchanged**, because a circuit
 *   transferred to another wallet is still "opened" — comparing only `opened` reports
 *   "nothing changed" for a circuit that is no longer yours;
 * - hex casing is not identity, so addresses compare case-insensitively;
 * - an unreadable fresh owner is not evidence of a transfer.
 */
export type VerifyDrift = "none" | "opened" | "owner" | "both";

export interface VerifySnapshot {
  readonly opened: boolean | null;
  readonly owner: string | null;
}

export interface VerifyFresh {
  readonly opened: boolean;
  readonly owner: string | null;
}

export function classifyVerifyDrift(
  snapshot: VerifySnapshot,
  fresh: VerifyFresh,
): VerifyDrift {
  const openedDrift = snapshot.opened !== null && fresh.opened !== snapshot.opened;
  const ownerDrift =
    snapshot.owner !== null &&
    fresh.owner !== null &&
    fresh.owner.toLowerCase() !== snapshot.owner.toLowerCase();
  if (openedDrift && ownerDrift) return "both";
  if (ownerDrift) return "owner";
  if (openedDrift) return "opened";
  return "none";
}
