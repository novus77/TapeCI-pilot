/**
 * Publication summary for one project (SPEC §12.4).
 *
 * The summary reports three independent facts and never folds them into one
 * "live" boolean:
 *
 * - `release`      — the project's *current* release: the artifact whose chain
 *                    write was verified. A historical release is never returned
 *                    as current; only `releases.is_current = true` is read.
 * - `binding`      — the domain name and its paid window, judged against the
 *                    injected clock and, when wired, a fresh chain read.
 * - `gatewayCheck` — whether the gateway answered the *derived* public URL.
 *
 * The public URL is derived here and nowhere else: a trusted gateway host
 * suffix (operator configuration) plus the bound on-chain name. No request
 * field and no stored free-text field can supply a URL to probe; the probe is
 * called with exactly the string this module built.
 *
 * A fact that cannot be read is reported as `unknown`/`null` plus a gap code —
 * never as `false`, `expired` or `unreachable`.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  containerEvents,
  containers,
  projects,
  releases,
  type Database,
} from "@tapeci/database";
import { validateOnChainName } from "@tapeci/deployer";
import { ApiError } from "./errors.js";

/**
 * TapeKit gateway apex for derived site URLs. Taken from the read-only gateway
 * evidence recorded on 2026-10-26 (`docs/evidence/real-integrations/
 * gateway-2026-10-26.json`): the on-chain name `10.2.4.tape` is served at
 * `https://10-2-4.tapekit.org/`. Kept as a pinned constant because env wiring is
 * owned by the integrator; a caller that has a different trusted gateway passes
 * its own suffix to `PublicationDeps.gatewayHostSuffix`.
 */
export const TAPEKIT_GATEWAY_HOST_SUFFIX = "tapekit.org";

/** The protocol namespace every TapeKit name ends with on X Layer. */
const PROTOCOL_NAME_SUFFIX = ".tape";

/** `active` = live; `expired` = paid window closed; `inactive` = a verified read says not live. */
export type PublicationBindingState = "active" | "expired" | "inactive" | "unknown";

export interface PublicationBinding {
  readonly state: PublicationBindingState;
  readonly name: string;
  /** ISO expiry; `null` when the window was never recorded or the chain read failed. */
  readonly paidUntil: string | null;
}

export interface PublicationRelease {
  readonly deploymentId: string;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly manifestSha256: string;
  readonly entryPath: string;
  /**
   * `true` only when the stored verification report proves the release matched.
   * `null` when the report cannot be read — an unreadable report is not proof of
   * an unverified release, so it is never reported as `false`.
   */
  readonly verified: boolean | null;
  /** The pinned block the verification ran at; `null` when none was recorded. */
  readonly verifiedBlockNumber: string | null;
  readonly activatedAt: string;
}

/**
 * `checking` belongs to the client contract (a refresh is in flight). It is
 * never produced by `loadPublicationSummary`, which always returns a settled
 * outcome or `unknown`.
 */
export type GatewayCheck = "unknown" | "checking" | "reachable" | "unreachable";

/** A fact the summary could not establish. Never a negative fact. */
export type PublicationGap =
  | "NO_CURRENT_RELEASE"
  | "RELEASE_VERIFICATION_UNPROVEN"
  | "NO_BOUND_NAME"
  | "BINDING_UNKNOWN"
  | "GATEWAY_NOT_CONFIGURED"
  | "GATEWAY_CONFIGURATION_INVALID"
  | "GATEWAY_URL_NOT_DERIVABLE"
  | "GATEWAY_CHECK_UNKNOWN";

export interface PublicationSummary {
  readonly release: PublicationRelease | null;
  readonly binding: PublicationBinding | null;
  /** Derived from the trusted gateway suffix + bound name; `null` when it cannot be built honestly. */
  readonly publicUrl: string | null;
  readonly gatewayCheck: GatewayCheck;
  readonly checkedAt: string | null;
  readonly missing: readonly PublicationGap[];
}

/** Outcome of asking a gateway for the derived URL. A thrown probe is `unknown`. */
export type GatewayProbeOutcome = "reachable" | "unreachable" | "unknown";

/**
 * Probes exactly the URL it is given. Tests inject a fake, so no test reaches
 * the network; the loader never defaults to the real probe below.
 */
export type GatewayProbe = (url: string) => Promise<GatewayProbeOutcome>;

/** Result of a fresh chain activation read for the bound name. */
export type BindingChainRead =
  | { readonly status: "verified"; readonly isLive: boolean; readonly paidUntil: Date | null }
  | { readonly status: "unavailable"; readonly reason: string };

export interface PublicationDeps {
  readonly db: Database;
  /**
   * Trusted gateway host suffix (e.g. `tapekit.org`), from operator
   * configuration — never from a request. `null` means no gateway is
   * configured, which yields `publicUrl: null` instead of a guessed URL.
   */
  readonly gatewayHostSuffix: string | null;
  /** Injected so tests never touch the network. */
  readonly probeGateway: GatewayProbe;
  /** Injected clock: binding expiry and `checkedAt` are decided from it. */
  readonly now: () => Date;
  /**
   * Optional fresh chain read for the bound name (`readBindingState` in
   * `apps/api/src/binding.ts`). When omitted the recorded `paidUntil` is the
   * only evidence: it can prove an expired window and a still-open name-level
   * window, but it cannot see container-level activation or later chain
   * changes, so production is expected to wire this.
   */
  readonly readBinding?: (input: {
    readonly containerAddress: string;
    readonly name: string;
  }) => Promise<BindingChainRead>;
}

export interface PublicationInput {
  readonly projectId: string;
}

/**
 * Load the publication summary for one project.
 *
 * Authorisation is the caller's job (the route checks project membership); this
 * function only reads facts. A project id that does not resolve is a 404 rather
 * than an empty summary, so a deleted project cannot look like "nothing
 * published yet".
 */
export async function loadPublicationSummary(
  deps: PublicationDeps,
  input: PublicationInput,
): Promise<PublicationSummary> {
  const project = await loadProject(deps.db, input.projectId);
  const now = deps.now();
  const release = await loadCurrentRelease(deps.db, project.projectId);
  const bound = await loadBoundName(deps.db, project.containerId);
  const binding = bound === null ? null : await resolveBinding(deps, project.containerAddress, bound, now);

  const url = derivePublicUrl(binding?.name ?? null, deps.gatewayHostSuffix);
  const publicUrl = url.status === "derived" ? url.url : null;
  const checkedAt = publicUrl === null ? null : now.toISOString();
  const gatewayCheck: GatewayCheck =
    publicUrl === null ? "unknown" : await deps.probeGateway(publicUrl).catch(() => "unknown" as const);

  return {
    release,
    binding,
    publicUrl,
    gatewayCheck,
    checkedAt,
    missing: gapsOf(release, binding, url, gatewayCheck),
  };
}

/**
 * One HTTPS GET, short timeout, no body kept. A non-2xx/3xx answer means the
 * gateway is reachable but not serving this name; a transport failure or
 * timeout is `unknown`, because it is not evidence that the name is unserved.
 */
export function createGatewayProbe(options: { readonly timeoutMs?: number } = {}): GatewayProbe {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return "unknown";
      const response = await fetch(parsed, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "TapeCI-publication-check/1" },
      });
      await response.body?.cancel();
      return response.status >= 200 && response.status < 400 ? "reachable" : "unreachable";
    } catch {
      return "unknown";
    }
  };
}

/**
 * The one place a public URL is built.
 *
 * TapeKit's gateway drops the `.tape` protocol suffix and joins the remaining
 * name labels with `-` (`10.2.4.tape` -> `https://10-2-4.tapekit.org/`, the
 * mapping recorded in the 2026-10-26 gateway evidence). A name that does not
 * end in `.tape`, an invalid name or an invalid suffix yields no URL rather
 * than a guess.
 */
export function derivePublicUrl(
  name: string | null,
  hostSuffix: string | null,
): PublicUrlDerivation {
  if (name === null) return { status: "no-name" };
  if (hostSuffix === null) return { status: "unconfigured" };
  const suffix = hostSuffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!DNS_NAME.test(suffix)) return { status: "invalid-configuration" };
  if (!validateOnChainName(name).ok) return { status: "not-derivable" };
  if (!name.endsWith(PROTOCOL_NAME_SUFFIX)) return { status: "not-derivable" };
  const hostLabel = name.slice(0, -PROTOCOL_NAME_SUFFIX.length).split(".").join("-");
  if (!DNS_LABEL.test(hostLabel)) return { status: "not-derivable" };
  const host = `${hostLabel}.${suffix}`;
  if (host.length > 253) return { status: "not-derivable" };
  return { status: "derived", url: `https://${host}/` };
}

export type PublicUrlDerivation =
  | { readonly status: "derived"; readonly url: string }
  | { readonly status: "no-name" }
  | { readonly status: "unconfigured" }
  | { readonly status: "invalid-configuration" }
  | { readonly status: "not-derivable" };

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

async function loadProject(
  db: Database,
  projectId: string,
): Promise<{
  readonly projectId: string;
  readonly containerId: string;
  readonly containerAddress: string;
}> {
  const [row] = await db
    .select({
      projectId: projects.id,
      containerId: containers.id,
      containerAddress: containers.containerAddress,
    })
    .from(projects)
    .innerJoin(containers, eq(containers.id, projects.containerId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined) throw new ApiError(404, "PROJECT_NOT_FOUND", "project not found");
  return row;
}

/** Only the current release: a superseded release must never read as current. */
async function loadCurrentRelease(db: Database, projectId: string): Promise<PublicationRelease | null> {
  const [row] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.projectId, projectId), eq(releases.isCurrent, true)))
    .limit(1);
  if (row === undefined) return null;
  const verifiedBlockNumber = row.verifiedBlockNumber === "0" ? null : row.verifiedBlockNumber;
  return {
    deploymentId: row.deploymentId,
    releaseId: row.releaseId,
    commitSha: row.commitSha,
    manifestSha256: row.manifestSha256,
    entryPath: row.entryPath,
    verified: storedReleaseMatch(row.verifyReport),
    verifiedBlockNumber,
    activatedAt: row.activatedAt.toISOString(),
  };
}

/**
 * The name of the newest confirmed bind for the container. A pending row (no
 * gas used yet) is an attempt, not a binding. `container_events` is the only
 * source of the name; the derived "suggested name" is not a bound name.
 */
async function loadBoundName(
  db: Database,
  containerId: string,
): Promise<{ readonly name: string; readonly paidUntil: Date | null } | null> {
  const [row] = await db
    .select()
    .from(containerEvents)
    .where(
      and(
        eq(containerEvents.containerId, containerId),
        eq(containerEvents.eventType, "bind"),
        isNotNull(containerEvents.gasUsed),
      ),
    )
    .orderBy(desc(containerEvents.createdAt), desc(containerEvents.id))
    .limit(1);
  if (row === undefined) return null;
  return { name: row.name, paidUntil: row.paidUntil };
}

async function resolveBinding(
  deps: PublicationDeps,
  containerAddress: string,
  bound: { readonly name: string; readonly paidUntil: Date | null },
  now: Date,
): Promise<PublicationBinding> {
  const read = deps.readBinding;
  if (read === undefined) {
    // No chain read: the recorded window is the only evidence. An expired
    // window is a definite fact; an unexpired one is the best available and is
    // labelled from the record, not from a fresh read.
    return {
      state:
        bound.paidUntil === null ? "unknown" : bound.paidUntil <= now ? "expired" : "active",
      name: bound.name,
      paidUntil: bound.paidUntil?.toISOString() ?? null,
    };
  }
  const facts = await read({ containerAddress, name: bound.name });
  if (facts.status === "unavailable") {
    // A failed read is not a negative fact: no state, no paidUntil claim.
    return { state: "unknown", name: bound.name, paidUntil: null };
  }
  const paidUntil = facts.paidUntil;
  return {
    state: facts.isLive
      ? "active"
      : paidUntil !== null && paidUntil <= now
        ? "expired"
        : "inactive",
    name: bound.name,
    paidUntil: paidUntil?.toISOString() ?? null,
  };
}

/** `verifyReport` is JSON; only an explicit `releaseMatch: true/false` proves anything. */
function storedReleaseMatch(report: unknown): boolean | null {
  if (typeof report !== "object" || report === null) return null;
  if (!("releaseMatch" in report)) return null;
  return typeof report.releaseMatch === "boolean" ? report.releaseMatch : null;
}

function gapsOf(
  release: PublicationRelease | null,
  binding: PublicationBinding | null,
  url: PublicUrlDerivation,
  gatewayCheck: GatewayCheck,
): readonly PublicationGap[] {
  const missing: PublicationGap[] = [];
  if (release === null) missing.push("NO_CURRENT_RELEASE");
  if (release !== null && release.verified === null) missing.push("RELEASE_VERIFICATION_UNPROVEN");
  if (binding === null) missing.push("NO_BOUND_NAME");
  if (binding !== null && binding.state === "unknown") missing.push("BINDING_UNKNOWN");
  if (url.status === "unconfigured") missing.push("GATEWAY_NOT_CONFIGURED");
  if (url.status === "invalid-configuration") missing.push("GATEWAY_CONFIGURATION_INVALID");
  if (url.status === "not-derivable") missing.push("GATEWAY_URL_NOT_DERIVABLE");
  if (url.status === "derived" && gatewayCheck === "unknown") missing.push("GATEWAY_CHECK_UNKNOWN");
  return missing;
}
