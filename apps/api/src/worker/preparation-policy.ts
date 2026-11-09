import { TapeCiError, type Hex } from "@tapeci/shared";

export interface PreparationRequest {
  readonly schemaVersion: "tapeci.preparation.v1";
  readonly mode: "original" | "gzip-individual" | "gzip-whole" | "gzip-grouped";
  readonly spaFallback: boolean;
  readonly gatewayId?: string;
}
export interface CompressionGatewayQualification {
  readonly id: string;
  readonly origin: string;
  readonly chainId: 196;
  readonly siteRegistry: Hex;
  readonly container: Hex;
  readonly adapterSha256: Hex;
  readonly serviceFeeWei: string;
}

export function parsePreparationRequest(input: unknown): PreparationRequest {
  if (input === null || input === undefined) return { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false };
  if (typeof input !== "object" || Array.isArray(input)) throw new TapeCiError("INVALID_CONFIG", "invalid preparation request");
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some(key => !["schemaVersion", "mode", "spaFallback", "gatewayId"].includes(key)) || request.schemaVersion !== "tapeci.preparation.v1" || (typeof request.mode !== "string" || !["original", "gzip-individual", "gzip-whole", "gzip-grouped"].includes(request.mode)) || typeof request.spaFallback !== "boolean") throw new TapeCiError("INVALID_CONFIG", "unsupported preparation request");
  if (request.mode === "original") {
    if (request.gatewayId !== undefined || request.spaFallback) throw new TapeCiError("INVALID_CONFIG", "original preparation cannot specify a compressed gateway or fallback");
    return { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false };
  }
  if (typeof request.gatewayId !== "string" || request.gatewayId.trim() === "") throw new TapeCiError("INVALID_CONFIG", "compressed preparation requires a gateway qualification ID");
  return { schemaVersion: "tapeci.preparation.v1", mode: request.mode as PreparationRequest["mode"], spaFallback: request.spaFallback, gatewayId: request.gatewayId };
}

export function requireCompressionGateway(request: PreparationRequest, target: { chainId: number; siteRegistry: string; container: string }, profiles: readonly CompressionGatewayQualification[]): CompressionGatewayQualification | null {
  if (request.mode === "original") return null;
  const matches = profiles.filter(profile => profile.id === request.gatewayId);
  if (matches.length !== 1) throw new TapeCiError("INVALID_CONFIG", "compressed target gateway is not qualified");
  const profile = matches[0]!;
  const origin = new URL(profile.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== profile.origin || origin.username || origin.password || (origin.protocol !== "https:" && !(origin.protocol === "http:" && local))) throw new TapeCiError("INVALID_CONFIG", "invalid qualified gateway origin");
  if (profile.chainId !== target.chainId || profile.siteRegistry.toLowerCase() !== target.siteRegistry.toLowerCase() || profile.container.toLowerCase() !== target.container.toLowerCase()) throw new TapeCiError("INVALID_CONFIG", "gateway qualification does not match the deployment target");
  if (!/^0x[0-9a-f]{64}$/.test(profile.adapterSha256) || !/^(0|[1-9][0-9]*)$/.test(profile.serviceFeeWei)) throw new TapeCiError("INVALID_CONFIG", "invalid gateway qualification metadata");
  return { ...profile, siteRegistry: profile.siteRegistry.toLowerCase() as Hex, container: profile.container.toLowerCase() as Hex };
}

/** Trusted operator configuration shared by the API and Worker; never user input. */
export function parseCompressionGateways(input: string | undefined): readonly CompressionGatewayQualification[] {
  if (input === undefined || input.trim() === "") return [];
  const value: unknown = JSON.parse(input);
  if (!Array.isArray(value)) throw new TapeCiError("INVALID_CONFIG", "compression gateways must be an array");
  const profiles = value.map((item: unknown): CompressionGatewayQualification => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TapeCiError("INVALID_CONFIG", "invalid compression gateway profile");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !["id", "origin", "chainId", "siteRegistry", "container", "adapterSha256", "serviceFeeWei"].includes(key)) || typeof row.id !== "string" || row.id.trim() === "" || typeof row.origin !== "string" || row.chainId !== 196 || typeof row.siteRegistry !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.siteRegistry) || typeof row.container !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.container) || typeof row.adapterSha256 !== "string" || typeof row.serviceFeeWei !== "string") throw new TapeCiError("INVALID_CONFIG", "invalid compression gateway profile");
    const profile: CompressionGatewayQualification = { id: row.id, origin: row.origin, chainId: 196, siteRegistry: row.siteRegistry as Hex, container: row.container as Hex, adapterSha256: row.adapterSha256 as Hex, serviceFeeWei: row.serviceFeeWei };
    return requireCompressionGateway({ schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: profile.id }, profile, [profile])!;
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new TapeCiError("INVALID_CONFIG", "duplicate compression gateway IDs");
  return profiles;
}
