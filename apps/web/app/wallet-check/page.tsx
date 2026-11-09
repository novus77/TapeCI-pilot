import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { WalletAcceptance } from "@/components/wallet-acceptance";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Wallet acceptance check" };

export default async function WalletCheckPage() {
  const { t } = await getServerT();
  return (
    <div className="console-page page--wallet-check">
      <PageHeader eyebrow="Acceptance" title={t("accept.title")} lede={t("accept.lede")} />
      <WalletAcceptance />
    </div>
  );
}
