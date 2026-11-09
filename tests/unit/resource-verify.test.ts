/**
 * The `/resources` re-verify control (SPEC §3.1 step 3, AC-P2-26/AC-P2-27).
 *
 * Both rounds of the independent acceptance found this control had **no test at all** —
 * which is how its owner comparison silently went missing the first time. These cases pin
 * the rule so it cannot regress again.
 */
import { describe, expect, it } from "vitest";

import { classifyVerifyDrift } from "../../apps/web/lib/resource-verify.js";

const ALICE = "0x571d447f4f24688ec35ccf07f1d6993655f6af15";
const BOB = "0x7a8b9c0d1e2f30415263748596a7b8c9d0e1f203";

describe("re-verify drift", () => {
  it("reports no drift when the chain agrees with the snapshot", () => {
    expect(
      classifyVerifyDrift({ opened: false, owner: ALICE }, { opened: false, owner: ALICE }),
    ).toBe("none");
  });

  it("reports an opened change", () => {
    expect(
      classifyVerifyDrift({ opened: false, owner: ALICE }, { opened: true, owner: ALICE }),
    ).toBe("opened");
  });

  it("reports an owner change even though `opened` is unchanged", () => {
    // The case the bug was about: a circuit transferred to another wallet is STILL opened,
    // so a comparison that only looks at `opened` says "nothing changed" about a circuit
    // that is no longer yours (AC-P2-27).
    expect(
      classifyVerifyDrift({ opened: true, owner: ALICE }, { opened: true, owner: BOB }),
    ).toBe("owner");
  });

  it("reports both when each changed", () => {
    expect(
      classifyVerifyDrift({ opened: false, owner: ALICE }, { opened: true, owner: BOB }),
    ).toBe("both");
  });

  it("compares addresses case-insensitively, because hex casing is not identity", () => {
    expect(
      classifyVerifyDrift(
        { opened: false, owner: ALICE.toUpperCase() },
        { opened: false, owner: ALICE.toLowerCase() },
      ),
    ).toBe("none");
  });

  it("does not claim opened-drift against an unknown snapshot", () => {
    // `null` means "not read", never `false`: an unread snapshot cannot be contradicted.
    expect(classifyVerifyDrift({ opened: null, owner: ALICE }, { opened: true, owner: ALICE })).toBe(
      "none",
    );
  });

  it("does not claim an owner change from an unreadable fresh read", () => {
    expect(classifyVerifyDrift({ opened: false, owner: ALICE }, { opened: false, owner: null })).toBe(
      "none",
    );
  });

  it("does not claim an owner change without a snapshot owner", () => {
    expect(classifyVerifyDrift({ opened: false, owner: null }, { opened: false, owner: BOB })).toBe(
      "none",
    );
  });
});
