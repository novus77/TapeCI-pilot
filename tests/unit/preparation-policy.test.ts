import { expect, it } from "vitest";
import { parseCompressionGateways, parsePreparationRequest, requireCompressionGateway } from "../../apps/api/src/worker/preparation-policy.js";
const target = { chainId: 196 as const, siteRegistry: `0x${"11".repeat(20)}` as const, container: `0x${"22".repeat(20)}` as const };
const profile = { ...target, id: "qualified", origin: "https://gateway.example", adapterSha256: `0x${"ab".repeat(32)}` as const, serviceFeeWei: "0" };
it("rejects JSON array modes rather than coercing them into supported strings", () => {
  expect(() => parsePreparationRequest({ schemaVersion: "tapeci.preparation.v1", mode: ["gzip-whole"], spaFallback: false, gatewayId: "qualified" })).toThrow(/request/i);
});
it("requires explicit target-matching trusted gateway metadata", () => {
  const request = parsePreparationRequest({ schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: "qualified" });
  expect(requireCompressionGateway(request, target, [profile])).toEqual(profile);
  expect(() => requireCompressionGateway(request, target, [])).toThrow(/not qualified/i);
  expect(() => requireCompressionGateway(request, { ...target, container: `0x${"33".repeat(20)}` }, [profile])).toThrow(/target/i);
  expect(() => requireCompressionGateway(request, target, [{ ...profile, origin: "https://user:pass@gateway.example" }])).toThrow(/origin/i);
});

it("loads opt-in gateway configuration and rejects ambiguous or malformed profiles", () => {
  expect(parseCompressionGateways(undefined)).toEqual([]);
  expect(parseCompressionGateways(JSON.stringify([profile]))).toEqual([profile]);
  for (const input of ["{}", "null", "[1]", "not-json", JSON.stringify([profile, profile]), JSON.stringify([{ ...profile, container: "bad" }]), JSON.stringify([{ ...profile, origin: "https://gateway.example/path" }]), JSON.stringify([{ ...profile, credential: "unexpected" }])]) {
    expect(() => parseCompressionGateways(input)).toThrow();
  }
});
