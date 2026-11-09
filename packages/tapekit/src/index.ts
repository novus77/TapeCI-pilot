/**
 * The pieces of the TapeOut protocol kernel this platform needs in order to mint a
 * circuit itself (SPEC `2026-10-28-self-mint-spec.md`).
 *
 * Deliberately narrow: netlist encoding and the calldata for `mint` / `tapeout`. Container
 * derivation, opening and the two-operator read discipline already live in `@tapeci/chain`,
 * `@tapeci/verifier` and the P3 provisioning code, and are reused rather than reimplemented.
 */
export * from "./netlist.js";
export * from "./tapeout.js";
