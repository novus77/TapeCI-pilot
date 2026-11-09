import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CopyValue } from "@/components/copy-value";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { ResourceVerifyAction, ResourcesRefresh } from "@/components/resource-list";
import { ResourceWalletPanel } from "@/components/resource-wallet";
import { EmptyState, RiskNotice } from "@/components/risk-notice";
import { SkeletonTable } from "@/components/skeleton";
import { StatusChip } from "@/components/stage-badge";
import {
  getWalletResources,
  inspectResource,
  listResourceProcessors,
  type ProcessorCatalogue,
  type WalletResource,
  type WalletResourcePage,
} from "@/lib/api";
import { ApiError, describeError } from "@/lib/errors";
import { isHexAddress, shortValue } from "@/lib/format";
import { getServerT, type ServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Resources" };

/**
 * `/resources` — read the circuits an address holds (SPEC §3.1, §3.4, §7.2).
 *
 * The page obeys the P2 state contract (`product-p2.md` §2):
 * - page state comes from `WalletResourcePage.syncStatus` + `complete`, with the
 *   precedence `unavailable > partial > ready`; a row's `readStatus` is a different
 *   fact and is rendered per row.
 * - "No circuits" exists in exactly one variant: `ready && complete` with zero rows,
 *   and it carries the catalogue size and scanned block range (W2, W10).
 * - a `null` renders as "Not read", never as `false`; `not_found` and `unavailable`
 *   get their own sentences (W5, W7).
 * - there is no purchase action anywhere: §0.3 keeps purchase closed, P5 owns it.
 *
 * A user-initiated refresh is a route transition (`ResourcesRefresh`), so the
 * current state survives and the region reports `aria-busy` instead of falling back
 * to the skeleton. `loading` is only the first response's Suspense fallback.
 */

type PageState = "ready" | "partial" | "unavailable";

interface ResourceSearchParams {
  readonly address?: string | string[];
  readonly cursor?: string | string[];
  readonly processor?: string | string[];
  readonly tokenId?: string | string[];
}

interface ResourceGroup {
  readonly processor: WalletResource["resource"]["processor"];
  readonly processorIndex: number;
  readonly rows: readonly WalletResource[];
}

export default async function ResourcesPage({
  searchParams,
}: {
  readonly searchParams: Promise<ResourceSearchParams>;
}) {
  const query = await searchParams;
  const { t } = await getServerT();
  const address = firstValue(query.address);
  const addressValid = address !== null && isHexAddress(address);
  const cursor = firstValue(query.cursor);
  const processor = firstValue(query.processor);
  const tokenId = firstValue(query.tokenId);

  return (
    <div className="console-page page--resources">
      <PageHeader
        eyebrow={
          <>
            <Link href="/">{t("nav.overview")}</Link> / {t("resources.title")}
          </>
        }
        title={t("resources.title")}
        lede={t("resources.lede")}
        actions={
          // The page is a lookup, so a user who holds nothing has nowhere to go without this.
          <Link className="button button-primary" href="/resources/mint" data-testid="mint-cta">
            {t("resources.mintCta")}
          </Link>
        }
      />

      <div className="resource-discovery">
        <ResourceWalletPanel currentAddress={address} />
      </div>

      <form
        className="filter-form panel resource-address-lookup"
        action="/resources"
        method="get"
        aria-labelledby="resources-address-heading"
      >
        <h2 id="resources-address-heading" className="visually-hidden">
          {t("resources.addressLabel")}
        </h2>
        <div className="field" style={{ minWidth: "min(100%, 380px)" }}>
          <label htmlFor="resources-address">{t("resources.addressLabel")}</label>
          <input
            id="resources-address"
            name="address"
            defaultValue={address ?? ""}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="resources-address-hint"
          />
          <p className="field-hint" id="resources-address-hint">
            {t("resources.addressHint")}
          </p>
          {address !== null && !addressValid ? (
            <p className="field-error">{t("resources.invalidAddress")}</p>
          ) : null}
        </div>
        <div className="filter-actions">
          <button className="button button-primary" type="submit">
            {t("resources.check")}
          </button>
        </div>
      </form>


      <Suspense fallback={<ResourcesLoading label={t("resources.loading")} />}>
        <ResourcesResult
          address={address}
          addressValid={addressValid}
          cursor={cursor}
          t={t}
        />
      </Suspense>

      <ManualLookup address={address} processor={processor} tokenId={tokenId} t={t} />
    </div>
  );
}

/** The only pre-response state: layout-shaped placeholders, no count, no claim. */
function ResourcesLoading({ label }: { readonly label: string }) {
  return (
    <div
      className="panel"
      data-testid="resources-state"
      data-state="loading"
      aria-busy="true"
    >
      <p className="field-hint" role="status">
        {label}
      </p>
      <SkeletonTable rows={4} columns={4} />
    </div>
  );
}

async function ResourcesResult({
  address,
  addressValid,
  cursor,
  t,
}: {
  readonly address: string | null;
  readonly addressValid: boolean;
  readonly cursor: string | null;
  readonly t: ServerT;
}) {
  if (address === null) {
    return <IdleState t={t} />;
  }
  if (!addressValid) {
    return <IdleState t={t} invalid />;
  }

  const [pageResult, catalogue] = await Promise.all([
    getWalletResources(address, { cursor }).then(
      (page) => ({ ok: true as const, page }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    listResourceProcessors().catch(() => null),
  ]);

  if (!pageResult.ok) {
    return <UnavailableState error={pageResult.error} t={t} />;
  }
  const page = pageResult.page;
  const state = deriveState(page);
  if (state === "unavailable") {
    return <UnavailableState error={null} t={t} />;
  }
  if (state === "partial") {
    return <PartialState page={page} catalogue={catalogue} t={t} />;
  }
  return <ReadyState page={page} catalogue={catalogue} t={t} />;
}

/** `unavailable > partial > ready`; `syncing` is a partial scan, not a ready one. */
function deriveState(page: WalletResourcePage): PageState {
  if (page.syncStatus === "unavailable") return "unavailable";
  if (page.syncStatus !== "ready" || !page.complete) return "partial";
  return "ready";
}

/**
 * Pre-query state. Not one of the four contract states because no request has been
 * issued yet; `idle` is deliberately distinct from `loading` and from `ready`.
 */
function IdleState({ t, invalid = false }: { readonly t: ServerT; readonly invalid?: boolean }) {
  return (
    <div data-testid="resources-state" data-state="idle">
      <EmptyState
        title={t("resources.idleTitle")}
        message={invalid ? t("resources.invalidAddress") : t("resources.idleBody")}
      />
    </div>
  );
}

/**
 * The chain read failed. Nothing about the address is known here, so no table and no
 * count is rendered: a `null` must never become "Not opened" (W5, §8.6).
 */
function UnavailableState({ error, t }: { readonly error: unknown; readonly t: ServerT }) {
  const code = error instanceof ApiError ? error.code : "RESOURCE_READ_UNAVAILABLE";
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div data-testid="resources-state" data-state="unavailable">
      <ErrorNotice
        title={t("resources.readFailed")}
        message={
          error === null
            ? t("resources.readFailedBody")
            : error instanceof ApiError
              ? error.message
              : describeError(error)
        }
        hint={error === null ? undefined : t("resources.readFailedBody")}
        retryLabel={t("common.retry")}
      />
      <p className="field-hint">
        {t("resources.errorCode")}: <code className="mono">{code}</code>
        {requestId === null ? null : <> · {t("resources.requestId", { requestId })}</>}
      </p>
    </div>
  );
}

/** An unfinished scan is "we have not finished looking", never "no circuits" (W1–W4). */
function PartialState({
  page,
  catalogue,
  t,
}: {
  readonly page: WalletResourcePage;
  readonly catalogue: ProcessorCatalogue | null;
  readonly t: ServerT;
}) {
  return (
    <div data-testid="resources-state" data-state="partial">
      <RiskNotice tone="warning" title={t("resources.scanIncomplete")}>
        <p>{t("resources.scanIncompleteBody")}</p>
        <p>{coverageLine(page, catalogue, t)}</p>
        <p>{t("resources.partialLookupHint")}</p>
      </RiskNotice>
      <p className="filter-summary">
        {t("resources.foundSoFar", { count: page.resources.length })}
      </p>
      {page.resources.length === 0 ? null : <ResourceGroups rows={page.resources} t={t} />}
      <div className="filter-actions">
        <ResourcesRefresh />
      </div>
    </div>
  );
}

/** Complete for the trusted catalogue — the only state that may say "no circuits". */
function ReadyState({
  page,
  catalogue,
  t,
}: {
  readonly page: WalletResourcePage;
  readonly catalogue: ProcessorCatalogue | null;
  readonly t: ServerT;
}) {
  const empty = page.resources.length === 0;
  const catalogueSize = catalogue === null ? null : catalogue.processors.length;
  return (
    <div data-testid="resources-state" data-state="ready">
      <div className="section-head">
        <h2 id="resources-heading">
          {t("resources.headerFor", { address: shortValue(page.address, 8, 6) })}
        </h2>
        <span className="section-meta">
          <StatusChip label={t("resources.scanComplete")} tone="success" />
        </span>
      </div>
      <p className="filter-summary">
        {t("resources.readAtBlock", { block: page.observedBlock ?? t("resources.blockNone") })} ·{" "}
        {page.nextCursor === null
          ? t("resources.foundTotal", { count: page.resources.length })
          : t("resources.foundSoFar", { count: page.resources.length })}{" "}
        · {coverageLine(page, catalogue, t)}
      </p>
      {empty ? (
        <EmptyState
          title={t("resources.empty")}
          message={
            catalogueSize === null
              ? t("resources.emptyCoverageUnknown")
              : t("resources.emptyCoverage", {
                  count: catalogueSize,
                  block: page.indexedThroughBlock ?? t("resources.blockNone"),
                })
          }
        />
      ) : (
        <ResourceGroups rows={page.resources} t={t} />
      )}
      <div className="filter-actions">
        <ResourcesRefresh />
        {page.nextCursor === null ? null : (
          <Link
            className="button button-ghost"
            href={pageHref(page.address, page.nextCursor)}
          >
            {t("resources.nextPage")}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Catalogue size plus the block range actually scanned. `complete` is
 * catalogue-scoped (§8.1): a delisted processor is invisible to the scan, so the
 * clause travels with every complete/empty statement (W10).
 */
function coverageLine(
  page: WalletResourcePage,
  catalogue: ProcessorCatalogue | null,
  t: ServerT,
): string {
  const catalogueText =
    catalogue === null
      ? t("resources.catalogueUnknown")
      : t("resources.catalogueSize", { count: catalogue.processors.length });
  const rangeText =
    page.indexedThroughBlock === null
      ? t("resources.scanNeverStarted")
      : t("resources.scanIndexedThrough", { block: page.indexedThroughBlock });
  return `${catalogueText} ${rangeText}`;
}

function pageHref(address: string, cursor: string | null): string {
  const params = new URLSearchParams({ address });
  if (cursor !== null) params.set("cursor", cursor);
  return `/resources?${params.toString()}`;
}

function ResourceGroups({ rows, t }: { readonly rows: readonly WalletResource[]; readonly t: ServerT }) {
  return (
    <>
      {groupByProcessor(rows).map((group) => (
        <section
          key={group.processor}
          className="panel"
          aria-labelledby={`resources-processor-${group.processor}`}
        >
          <div className="panel-head">
            <h3 id={`resources-processor-${group.processor}`}>
              {t("resources.groupHeading", { index: group.processorIndex })}
            </h3>
            <span className="panel-meta mono" title={group.processor}>
              {shortValue(group.processor, 10, 8)}
            </span>
          </div>
          <div
            className="table-wrap"
            role="region"
            aria-label={t("resources.tableCaption")}
            tabIndex={0}
          >
            <table className="table">
              <caption className="visually-hidden">{t("resources.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("resources.circuit")}</th>
                  <th scope="col">{t("resources.container")}</th>
                  <th scope="col">{t("resources.owner")}</th>
                  <th scope="col">{t("resources.deployed")}</th>
                  <th scope="col">{t("resources.opened")}</th>
                  <th scope="col">{t("resources.block")}</th>
                  <th scope="col">{t("resources.readStatus")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("resources.use")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <ResourceRow key={row.resource.tokenId} row={row} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function ResourceRow({ row, t }: { readonly row: WalletResource; readonly t: ServerT }) {
  const container = row.container;
  const usable = row.readStatus === "verified" && container !== null;
  return (
    <tr data-read-status={row.readStatus}>
      <th scope="row">
        <code className="mono">#{row.resource.tokenId}</code>
      </th>
      <td>
        {container === null ? (
          <span className="muted">{t("resources.notDerived")}</span>
        ) : (
          <CopyValue
            value={container}
            label={t("resources.container")}
            display={shortValue(container, 10, 8)}
          />
        )}
      </td>
      <td>
        {row.owner === null ? (
          t("resources.notRead")
        ) : (
          <code className="mono" title={row.owner}>
            {shortValue(row.owner, 10, 8)}
          </code>
        )}
      </td>
      <td>{readFact(row.deployed, t("resources.deployed"), t("resources.notDeployed"), row.observedBlock, t)}</td>
      <td>{readFact(row.opened, t("resources.opened"), t("resources.notOpened"), row.observedBlock, t)}</td>
      <td>{blockLabel(row.observedBlock, t)}</td>
      <td>
        <ReadStatusCell row={row} t={t} />
      </td>
      <td>
        {usable ? (
          // The container page only resolves for a container that already belongs to
          // one of the user's projects (`GET /v1/containers/:address` joins
          // containers→projects→members). A circuit never used in a project has no
          // such row, so linking there 404s (issue P3-02). Route by state instead:
          // an opened circuit continues into project creation for that resource, and
          // an unopened one needs the open quote first (§3.1 steps 4-5).
          row.opened === true ? (
            // §3.1 step 3: re-verify before acting. The container hand-off is not
            // built yet (P4-01), so the control proves the facts are still current
            // and says what the next step would be, rather than linking somewhere
            // that would ignore the selection (issues P3-02 and P2-08).
            <ResourceVerifyAction
              processor={row.resource.processor}
              tokenId={row.resource.tokenId}
              snapshotOpened={row.opened}
              snapshotOwner={row.owner}
              labels={{
                verify: t("resources.verify"),
                verifying: t("resources.verifying"),
                opened: t("resources.verifyOpened"),
                notOpened: t("resources.verifyNotOpened"),
                changed: t("resources.verifyChanged"),
                unreadable: t("resources.verifyUnreadable"),
                notFound: t("resources.verifyNotFound"),
                ownerChanged: t("resources.verifyOwnerChanged"),
                readAt: t("resources.verifyReadAt"),
              }}
            />
          ) : (
            // §3.1 step 4: an unopened circuit goes to the quote screen, which prices the
            // `open` step. The price deliberately does not appear here — `/resources` only
            // reads (product-p2 §2.7).
            <Link
              className="button button-ghost"
              data-testid="resources-open-link"
              href={`/resources/prepare?processor=${row.resource.processor}&tokenId=${row.resource.tokenId}`}
            >
              {t("resources.openCircuit")}
            </Link>
          )
        ) : null}
      </td>
    </tr>
  );
}

/** `true`/`false`/`null` are three facts: a failed read is "Not read", never `false`. */
function readFact(
  value: boolean | null,
  yes: string,
  no: string,
  block: string | null,
  t: ServerT,
): ReactNode {
  if (value === null) return t("resources.notRead");
  if (value) return yes;
  return (
    <>
      {no} <span className="field-hint">{blockLabel(block, t)}</span>
    </>
  );
}

function blockLabel(block: string | null, t: ServerT): string {
  return block === null ? t("resources.blockNone") : t("resources.blockLabel", { block });
}

/**
 * Row-level outcomes are three different sentences (W7): `not_found` is an explicit
 * absence, `unavailable` is a failed read, and neither offers a "use" action.
 */
function ReadStatusCell({ row, t }: { readonly row: WalletResource; readonly t: ServerT }) {
  switch (row.readStatus) {
    case "verified":
      return <>{t("resources.statusVerified")}</>;
    case "not_found":
      return (
        <>
          {t("resources.statusNotFound")}{" "}
          <span className="field-hint">{t("resources.rowNotFound")}</span>
        </>
      );
    default:
      return (
        <>
          {t("resources.statusUnavailable")}{" "}
          <span className="field-hint">{t("resources.rowUnavailable")}</span>
        </>
      );
  }
}

function groupByProcessor(rows: readonly WalletResource[]): readonly ResourceGroup[] {
  const groups = new Map<string, { processor: ResourceGroup["processor"]; processorIndex: number; rows: WalletResource[] }>();
  for (const row of rows) {
    const key = row.resource.processor;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        processor: row.resource.processor,
        processorIndex: row.processorIndex,
        rows: [row],
      });
      continue;
    }
    existing.rows.push(row);
  }
  return [...groups.values()]
    .sort((a, b) => a.processorIndex - b.processorIndex)
    .map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => compareTokenId(a.resource.tokenId, b.resource.tokenId)) }));
}

/** Decimal string comparison, so a token id above `MAX_SAFE_INTEGER` still sorts. */
function compareTokenId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Manual `(processor, tokenId)` lookup. It reads one `WalletResource` through the
 * same route the list uses and renders it with the same row semantics; it never
 * accepts a container address and never persists anything.
 */
function ManualLookup({
  address,
  processor,
  tokenId,
  t,
}: {
  readonly address: string | null;
  readonly processor: string | null;
  readonly tokenId: string | null;
  readonly t: ServerT;
}) {
  return (
    <section className="panel" aria-labelledby="resources-manual-heading" data-testid="resources-manual">
      <div className="panel-head">
        <h2 id="resources-manual-heading">{t("resources.manualTitle")}</h2>
      </div>
      <p className="panel-copy">{t("resources.manualBody")}</p>
      <form className="filter-form" action="/resources" method="get">
        {address === null ? null : <input type="hidden" name="address" value={address} />}
        <div className="field">
          <label htmlFor="resources-processor">{t("resources.processorField")}</label>
          <input
            id="resources-processor"
            name="processor"
            defaultValue={processor ?? ""}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="resources-token">{t("resources.tokenIdField")}</label>
          <input
            id="resources-token"
            name="tokenId"
            defaultValue={tokenId ?? ""}
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
        <div className="filter-actions">
          <button className="button button-primary" type="submit">
            {t("resources.inspect")}
          </button>
        </div>
      </form>
      <p className="field-hint">{t("resources.tokenIdHint")}</p>
      {processor === null || tokenId === null ? null : (
        <Suspense fallback={<p className="field-hint">{t("common.loading")}</p>}>
          <InspectionResult processor={processor} tokenId={tokenId} t={t} />
        </Suspense>
      )}
    </section>
  );
}

async function InspectionResult({
  processor,
  tokenId,
  t,
}: {
  readonly processor: string;
  readonly tokenId: string;
  readonly t: ServerT;
}) {
  const result = await inspectResource(processor, tokenId).then(
    (resource) => ({ ok: true as const, resource }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!result.ok) {
    return (
      <RiskNotice tone="critical" title={t("resources.inspectError")}>
        <p>{errorMessage(result.error)}</p>
      </RiskNotice>
    );
  }
  return (
    <div data-testid="resources-inspection" data-read-status={result.resource.readStatus}>
      <ResourceGroups rows={[result.resource]} t={t} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return describeError(error);
}

function firstValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return null;
  const trimmed = first.trim();
  return trimmed.length === 0 ? null : trimmed;
}
