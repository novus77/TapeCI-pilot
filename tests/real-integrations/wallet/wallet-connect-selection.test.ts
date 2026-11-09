import { describe, expect, it } from "vitest";
import {
  connectorRequiresInjectedProvider,
  walletConnectorDescriptors,
} from "../../../apps/web/lib/wallet-connectors.js";

describe("wallet connection provider requirements", () => {
  it("requires window.ethereum only for the injected connector", () => {
    expect(connectorRequiresInjectedProvider("injected")).toBe(true);
    expect(connectorRequiresInjectedProvider("walletConnect")).toBe(false);
    expect(connectorRequiresInjectedProvider(undefined)).toBe(false);
  });

  it("describes connectors without constructing browser-only providers", () => {
    expect(walletConnectorDescriptors(undefined)).toEqual([{ id: "injected", kind: "injected" }]);
    expect(walletConnectorDescriptors("public-project-id")).toEqual([
      { id: "injected", kind: "injected" },
      { id: "walletConnect", kind: "walletconnect" },
    ]);
  });

  it("does not load the WalletConnect provider during server rendering", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../../apps/web/lib/wagmi.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('from "wagmi/connectors/walletConnect"');
    expect(source).toContain("setup: async () =>");
    expect(source).not.toContain('from "wagmi/connectors";');
  });
});
