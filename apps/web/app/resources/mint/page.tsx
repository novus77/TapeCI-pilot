import type { Metadata } from "next";
import Link from "next/link";

import { MintFlow } from "@/components/mint-flow";
import { PageHeader } from "@/components/page-header";
import { RiskNotice } from "@/components/risk-notice";
import { isMockMode, listMintableProcessors, type MintableProcessor } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Mint a circuit" };

/**
 * `/resources/mint` — obtain a circuit when the wallet holds none (SPEC §3.2).
 *
 * The catalogue is read on the server so the first paint already has the choices; the flow
 * itself is a client component because it walks the user through a paid, multi-transaction
 * sequence and must react to their wallet.
 *
 * §3.2 order, preserved: source and goods first, every fee before any paid step, then the
 * wallet confirms each transaction in turn.
 */
export default async function MintResourcePage() {
  const { t } = await getServerT();

  let processors: readonly MintableProcessor[] = [];
  let error: string | null = null;
  try {
    const list = await listMintableProcessors({ limit: 80, take: 24 });
    if (list.syncStatus === "unavailable") {
      // "Could not read the catalogue" is not "there is nothing to buy" (§3.2 step 1).
      error = t("mint.unavailable");
    } else {
      processors = list.processors;
    }
  } catch (cause) {
    error = describeError(cause);
  }

  return (
    <div className="console-page page--mint">
      <PageHeader
        eyebrow={
          <>
            <Link href="/resources">{t("nav.resources")}</Link> / {t("mint.title")}
          </>
        }
        title={t("mint.title")}
        lede={t("mint.lede")}
        actions={
          <Link className="button" href="/resources">
            {t("mint.backToResources")}
          </Link>
        }
      />

      <RiskNotice tone="warning" title={t("mint.riskTitle")}>
        <ul>
          <li>{t("mint.riskIrreversible")}</li>
          <li>{t("mint.riskCost")}</li>
          <li>{t("mint.riskPredictedId")}</li>
        </ul>
      </RiskNotice>

      <MintFlow processors={processors} error={error} demo={isMockMode()} />

      <p className="field-hint">{t("mint.alreadyHave")}</p>
    </div>
  );
}
