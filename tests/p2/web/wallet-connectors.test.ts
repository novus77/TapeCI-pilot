import { describe, expect, it } from "vitest";

import {
  BIND_TRACKING_COPY,
  bindTrackingText,
  connectorRequiresInjectedProvider,
  createLazyOnce,
  normalizeTxHash,
  normalizeWalletConnectProjectId,
  walletAvailabilityNotice,
  walletConnectAvailability,
  walletConnectorDescriptors,
  walletConnectorKinds,
} from "../../../apps/web/lib/wallet-connectors.js";

/**
 * SPEC §15.1's first test file: WalletConnect must work when `window.ethereum` is
 * absent, a missing injected wallet must be *reported* rather than silently
 * disabling the control, and a connection error must be recoverable.
 *
 * Everything here is pure: no `window`, no network, no relay handshake. A real
 * WalletConnect pairing needs a project id and a relay connection and is not
 * claimed by this file — see `.superpowers/sdd/provisioning/dev-p1a.md`.
 */

describe("wallet connector selection", () => {
  it("keeps injected only when the WalletConnect project id is absent/blank", () => {
    expect(normalizeWalletConnectProjectId(undefined)).toBeNull();
    expect(normalizeWalletConnectProjectId("   ")).toBeNull();
    expect(walletConnectorKinds(undefined)).toEqual(["injected"]);
    expect(walletConnectorKinds("  ")).toEqual(["injected"]);
  });

  it("adds WalletConnect when a project id is configured", () => {
    expect(normalizeWalletConnectProjectId(" abc123 ")).toBe("abc123");
    expect(walletConnectorKinds("abc123")).toEqual(["injected", "walletconnect"]);
  });

  it("does not require window.ethereum for a WalletConnect pairing", () => {
    expect(connectorRequiresInjectedProvider("injected")).toBe(true);
    expect(connectorRequiresInjectedProvider("walletConnect")).toBe(false);
  });

  it("drives connector choice from the configured project id, not window.ethereum", () => {
    expect(walletConnectorDescriptors(undefined).map((descriptor) => descriptor.id)).toEqual([
      "injected",
    ]);
    expect(walletConnectorDescriptors("abc123").map((descriptor) => descriptor.id)).toEqual([
      "injected",
      "walletConnect",
    ]);
  });
});

describe("connect availability without window.ethereum", () => {
  it("offers WalletConnect when there is no injected provider", () => {
    const availability = walletConnectAvailability({
      connectorIds: ["injected", "walletConnect"],
      hasInjectedProvider: false,
    });
    expect(availability).toEqual({ state: "connectable", connectorId: "walletConnect" });
    expect(walletAvailabilityNotice(availability)).toBeNull();
  });

  it("prefers the injected connector when a provider exists", () => {
    const availability = walletConnectAvailability({
      connectorIds: ["injected", "walletConnect"],
      hasInjectedProvider: true,
    });
    expect(availability).toEqual({ state: "connectable", connectorId: "injected" });
  });

  it("reports a missing injected wallet instead of silently disabling the control", () => {
    const availability = walletConnectAvailability({
      connectorIds: ["injected"],
      hasInjectedProvider: false,
    });
    expect(availability.state).toBe("injected-missing");
    // An explainable state: the panel renders this key rather than a dead button.
    expect(walletAvailabilityNotice(availability)).toBe("wallet.noWalletTitle");
  });

  it("reports a build with no connector at all", () => {
    const availability = walletConnectAvailability({
      connectorIds: [],
      hasInjectedProvider: false,
    });
    expect(availability.state).toBe("no-connector");
    expect(walletAvailabilityNotice(availability)).toBe("wallet.noConnector");
  });
});

describe("connection errors are recoverable", () => {
  it("drops a failed lazy value so the next attempt re-runs the factory", async () => {
    let calls = 0;
    const load = createLazyOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("relay unreachable");
      return "connector";
    });

    await expect(load()).rejects.toThrow("relay unreachable");
    // The second attempt must not reuse the rejected promise: that is what made
    // a single failed WalletConnect import permanently dead.
    await expect(load()).resolves.toBe("connector");
    expect(calls).toBe(2);
  });

  it("creates the value once when the factory succeeds", async () => {
    let calls = 0;
    const load = createLazyOnce(async () => {
      calls += 1;
      return { id: calls };
    });

    const first = await load();
    const second = await load();
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });
});

describe("bind tracking copy and hash normalisation", () => {
  it("normalises a transaction hash and rejects anything else", () => {
    const hash = `0x${"AB".repeat(32)}`;
    expect(normalizeTxHash(`  ${hash}  `)).toBe(`0x${"ab".repeat(32)}`);
    expect(normalizeTxHash("0x")).toBeNull();
    expect(normalizeTxHash(`0x${"a".repeat(63)}`)).toBeNull();
    expect(normalizeTxHash(`0x${"g".repeat(64)}`)).toBeNull();
    expect(normalizeTxHash("")).toBeNull();
  });

  it("covers every key in both locales", () => {
    const en = Object.keys(BIND_TRACKING_COPY.en).sort();
    const zh = Object.keys(BIND_TRACKING_COPY.zh).sort();
    expect(zh).toEqual(en);
  });

  it("describes a pending attempt as not live and points at re-checking", () => {
    // The pending state is never rendered as success, and the copy steers to a
    // re-check rather than a second send. Both locales must say so.
    expect(bindTrackingText("en", "bind.tracking.pendingTitle")).toMatch(/not confirmed/i);
    expect(bindTrackingText("en", "bind.tracking.pendingBody")).toMatch(/not live/i);
    expect(bindTrackingText("en", "bind.tracking.pendingBody")).toMatch(/re-check/i);

    expect(bindTrackingText("zh", "bind.tracking.pendingTitle")).toContain("尚未确认");
    expect(bindTrackingText("zh", "bind.tracking.pendingBody")).toContain("尚未生效");
    // The zh copy warns against a second bind; it must never invite one.
    expect(bindTrackingText("zh", "bind.tracking.pendingBody")).toContain("不要");

    // A re-check control exists in both locales, and it is not a send action.
    for (const locale of ["en", "zh"]) {
      const label = bindTrackingText(locale, "bind.tracking.check");
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/bind\(|activate/i);
    }
  });

  it("falls back to English for an unknown locale", () => {
    expect(bindTrackingText("fr", "bind.tracking.confirmedTitle")).toBe(
      BIND_TRACKING_COPY.en["bind.tracking.confirmedTitle"],
    );
  });
});
