import { describe, expect, it } from "vitest";
import {
  evaluateGatewayEvidence,
  type GatewayExpectation,
  type GatewayObservation,
} from "../../../scripts/real-integrations/chain/gateway.js";

const CONTAINER = "0xc0b4900262d0bc13f2c67c0fc4cf92c04e0ab814";
const DOMAIN = "10.2.4.tape";
const URL = "https://10-2-4.tapekit.org/";
const HASH = `0x${"12".repeat(32)}` as const;
const NOW = new Date("2026-10-26T12:00:00.000Z");

const expectation: GatewayExpectation = {
  chainId: 196,
  domain: DOMAIN,
  container: CONTAINER,
  url: URL,
  expectedContentSha256: HASH,
  now: NOW,
};

function chainOperator(
  operator: string,
  overrides: Partial<GatewayObservation["chain"][number]> = {},
): GatewayObservation["chain"][number] {
  return {
    operator,
    rpcHost: `${operator}.rpc.example`,
    chainId: 196,
    pinnedBlock: 74_152_054n,
    blockHash: `0x${"aa".repeat(32)}`,
    isLive: true,
    isContainerLive: true,
    paidUntilUnix: 1_795_522_690n,
    error: null,
    ...overrides,
  };
}

function observation(overrides: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    chain: [chainOperator("okx"), chainOperator("drpc")],
    dns: {
      a: ["203.0.113.10"],
      aaaa: [],
      cname: [],
      errors: [],
    },
    tls: {
      strictAuthorized: true,
      hostMatches: true,
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
      subject: "CN=tapekit.org",
      issuer: "CN=Example CA",
      error: null,
    },
    http: {
      status: 200,
      finalUrl: URL,
      contentType: "text/html",
      contentSha256: HASH,
      error: null,
    },
    ...overrides,
  };
}

describe("gateway evidence", () => {
  it("verifies chain LIVE, DNS, TLS, HTTPS, and content hash", () => {
    const evidence = evaluateGatewayEvidence(observation(), expectation);

    expect(evidence.schema).toBe("tapeci.real-integration.gateway.v1");
    expect(evidence.readOnly).toBe(true);
    expect(evidence.writeActionsPerformed).toBe(false);
    expect(evidence.status).toBe("VERIFIED");
    expect(evidence.blockers).toEqual([]);
    expect(evidence.http?.contentSha256).toBe(HASH);
  });

  it("blocks HTTP 200 when the domain is not LIVE on chain", () => {
    const evidence = evaluateGatewayEvidence(
      observation({
        chain: [
          chainOperator("okx", { isLive: false }),
          chainOperator("drpc", { isLive: false }),
        ],
      }),
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("chain.domainLive");
  });

  it("blocks missing DNS, TLS hostname mismatch, and expired certificates", () => {
    const noDns = evaluateGatewayEvidence(
      observation({ dns: { a: [], aaaa: [], cname: [], errors: [] } }),
      expectation,
    );
    expect(noDns.blockers).toContain("dns.records");

    const badTls = evaluateGatewayEvidence(
      observation({
        tls: {
          strictAuthorized: false,
          hostMatches: false,
          validFrom: "2025-01-01T00:00:00.000Z",
          validTo: "2025-12-31T00:00:00.000Z",
          subject: "CN=wrong.example",
          issuer: "CN=Example CA",
          error: "certificate has expired",
        },
      }),
      expectation,
    );
    expect(badTls.blockers).toContain("tls.trusted");
    expect(badTls.blockers).toContain("tls.host");
    expect(badTls.blockers).toContain("tls.validity");
  });

  it("blocks a non-2xx response or content hash mismatch", () => {
    const evidence = evaluateGatewayEvidence(
      observation({
        http: {
          status: 404,
          finalUrl: "https://10-2-4.tapekit.org/",
          contentType: "text/html",
          contentSha256: `0x${"34".repeat(32)}`,
          error: null,
        },
      }),
      expectation,
    );

    expect(evidence.status).toBe("BLOCKED");
    expect(evidence.blockers).toContain("http.status");
    expect(evidence.blockers).toContain("http.contentHash");
  });

  it("strips URL credentials and query values from evidence", () => {
    const evidence = evaluateGatewayEvidence(
      observation({
        http: {
          status: 200,
          finalUrl: "https://user:secret@10-2-4.tapekit.org/?token=private",
          contentType: "text/html",
          contentSha256: HASH,
          error: null,
        },
      }),
      {
        ...expectation,
        url: "https://user:secret@10-2-4.tapekit.org/?token=private",
      },
    );
    const json = JSON.stringify(evidence);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("private");
    expect(json).toContain("https://10-2-4.tapekit.org/");
  });
});
