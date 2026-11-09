import type { Metadata } from "next";
import Link from "next/link";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { PrepareOpenPanel } from "@/components/prepare-open-panel";
import { RiskNotice } from "@/components/risk-notice";
import { inspectResource, type WalletResource } from "@/lib/api";
import { ApiError, describeError } from "@/lib/errors";
import { isHexAddress } from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Prepare" };

interface PrepareSearchParams {
  readonly processor?: string | string[];
  readonly tokenId?: string | string[];
}

/**
 * `/resources/prepare` — review the `open` quote for one existing circuit (SPEC
 * §3.1 step 4, §3.4, §7.2; `product-p3.md` §2.4).
 *
 * This server component reads the resource facts only — the container, the current
 * owner and the block they were read at — so the page can name what is being opened
 * before a wallet exists. Pricing, wallet connection and task creation live in the
 * client panel, because a quote requires a verified delivery wallet and only the
 * browser knows which account that is.
 *
 * What must never happen here: a quote when the circuit is unreadable, not found or
 * already opened; a fabricated container; or a price rendered on `/resources` itself.
 */
export default async function PreparePage({
  searchParams,
}: {
  readonly searchParams: Promise<PrepareSearchParams>;
}) {
  const query = await searchParams;
  const { t } = await getServerT();
  const processor = firstValue(query.processor);
  const tokenId = firstValue(query.tokenId);

  const header = (
    <PageHeader
      eyebrow={
        <>
          <Link href="/resources">{t("resources.title")}</Link> / {t("prepare.title")}
        </>
      }
      title={t("prepare.title")}
      lede={t("prepare.lede")}
    />
  );
  const backLabel = t("preparation.backToResources");

  if (processor === null || tokenId === null) {
    return (
      <>
        {header}
        <Problem
          title={t("prepare.missingParamsTitle")}
          body={t("prepare.missingParamsBody")}
          backLabel={backLabel}
        />
      </>
    );
  }
  if (!isHexAddress(processor)) {
    return (
      <>
        {header}
        <Problem
          title={t("prepare.invalidProcessorTitle")}
          body={t("prepare.invalidProcessor")}
          backLabel={backLabel}
        />
      </>
    );
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(tokenId)) {
    return (
      <>
        {header}
        <Problem
          title={t("prepare.invalidTokenTitle")}
          body={t("prepare.invalidTokenId")}
          backLabel={backLabel}
        />
      </>
    );
  }
  // `product-p2.md` §3 / P2-R1: circuit 0 is rejected before any read or quote.
  if (tokenId === "0") {
    return (
      <>
        {header}
        <Problem
          title={t("prepare.tokenZeroTitle")}
          body={t("prepare.tokenZeroBody")}
          backLabel={backLabel}
        />
      </>
    );
  }

  let resource: WalletResource;
  try {
    resource = await inspectResource(processor, tokenId);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "RESOURCE_READ_UNAVAILABLE";
    return (
      <>
        {header}
        <div data-testid="prepare-read-error">
          <ErrorNotice
            title={t("prepare.resourceUnreadTitle")}
            message={
              error instanceof ApiError
                ? `${error.code}: ${error.message}`
                : describeError(error)
            }
            hint={t("prepare.resourceUnreadBody")}
            retryLabel={t("common.retry")}
          />
          <p className="field-hint">
            {t("prepare.errorCode")}: <code className="mono">{code}</code>
          </p>
        </div>
      </>
    );
  }

  // A failed read is a failed read, not "not opened" (§8.6). No quote, no price.
  if (resource.readStatus === "unavailable") {
    return (
      <>
        {header}
        <div data-testid="prepare-resource-unavailable">
          <RiskNotice tone="critical" title={t("prepare.resourceUnreadTitle")}>
            <p>{t("prepare.resourceUnreadBody")}</p>
          </RiskNotice>
        </div>
      </>
    );
  }
  if (resource.readStatus === "not_found") {
    return (
      <>
        {header}
        <div data-testid="prepare-resource-not-found">
          <RiskNotice tone="warning" title={t("prepare.notFoundTitle")}>
            <p>{t("prepare.notFoundBody")}</p>
          </RiskNotice>
        </div>
      </>
    );
  }
  // The container is always an output of `(processor, tokenId)` read on chain. If it
  // did not come back, this page does not derive one and does not quote.
  if (resource.container === null || resource.owner === null) {
    return (
      <>
        {header}
        <div data-testid="prepare-resource-incomplete">
          <RiskNotice tone="critical" title={t("prepare.incompleteTitle")}>
            <p>{t("prepare.containerUnknown")}</p>
          </RiskNotice>
        </div>
      </>
    );
  }
  // §9.1 row 2: already open means nothing is payable. "Already opened at block N"
  // is the whole answer; no quote is requested and nothing is charged.
  if (resource.opened === true) {
    return (
      <>
        {header}
        <div data-testid="prepare-already-opened">
          <RiskNotice tone="info" title={t("prepare.alreadyOpenedTitle")}>
            <p data-testid="prepare-already-opened-body">
              {t("prepare.alreadyOpenedBody", {
                block: resource.observedBlock ?? t("resources.blockNone"),
              })}
            </p>
          </RiskNotice>
          <ResourceSummary processor={processor} tokenId={tokenId} resource={resource} />
          <p className="filter-actions">
            <Link className="button button-ghost" href="/resources">
              {backLabel}
            </Link>
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="console-page page--prepare">
      {header}
      <ResourceSummary processor={processor} tokenId={tokenId} resource={resource} />
      <PrepareOpenPanel
        mode="quote"
        processor={processor as `0x${string}`}
        tokenId={tokenId}
        owner={resource.owner}
        observedBlock={resource.observedBlock}
      />
    </div>
  );
}

/** The resource being opened, its container and the block it was read at. */
async function ResourceSummary({
  processor,
  tokenId,
  resource,
}: {
  readonly processor: string;
  readonly tokenId: string;
  readonly resource: WalletResource;
}) {
  const { t } = await getServerT();
  return (
    <section className="panel" aria-labelledby="prepare-resource-heading" data-testid="prepare-resource">
      <div className="panel-head">
        <h2 id="prepare-resource-heading">{t("prepare.resourceHeading")}</h2>
        <span className="panel-meta">{t("resources.statusVerified")}</span>
      </div>
      <dl className="meta-grid">
        <div className="meta-item">
          <dt>{t("resources.circuit")}</dt>
          <dd className="mono">#{tokenId}</dd>
        </div>
        <div className="meta-item">
          <dt>{t("resources.processor")}</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>
            {processor}
          </dd>
        </div>
        <div className="meta-item">
          <dt>{t("resources.container")}</dt>
          <dd className="mono" data-testid="prepare-container" style={{ wordBreak: "break-all" }}>
            {resource.container ?? t("console.unknown")}
          </dd>
        </div>
        <div className="meta-item">
          <dt>{t("resources.owner")}</dt>
          <dd className="mono" data-testid="prepare-owner" style={{ wordBreak: "break-all" }}>
            {resource.owner ?? t("prepare.ownerUnknown")}
          </dd>
        </div>
        <div className="meta-item">
          <dt>{t("prepare.resourceReadBlock", { block: resource.observedBlock ?? t("resources.blockNone") })}</dt>
          <dd className="mono">{resource.observedBlock ?? t("resources.blockNone")}</dd>
        </div>
      </dl>
      <p className="panel-copy">
        {t("prepare.notOpenedAt", {
          block: resource.observedBlock ?? t("resources.blockNone"),
        })}
      </p>
    </section>
  );
}

function Problem({
  title,
  body,
  backLabel,
}: {
  readonly title: string;
  readonly body: string;
  readonly backLabel: string;
}) {
  return (
    <div data-testid="prepare-problem">
      <RiskNotice tone="warning" title={title}>
        <p>{body}</p>
      </RiskNotice>
      <p className="filter-actions">
        <Link className="button button-ghost" href="/resources">
          {backLabel}
        </Link>
      </p>
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return null;
  const trimmed = first.trim();
  return trimmed.length === 0 ? null : trimmed;
}
