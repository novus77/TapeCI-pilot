import type { Metadata } from "next";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { listWebhookDeliveries } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Webhook deliveries" };

export default async function WebhooksPage() {
  const { t } = await getServerT();
  let deliveries: Awaited<ReturnType<typeof listWebhookDeliveries>> = [];
  let error: string | null = null;
  try {
    deliveries = await listWebhookDeliveries();
  } catch (caught) {
    error = describeError(caught);
  }
  return (
    <div className="console-page page--webhooks">
      <PageHeader
        eyebrow={t("console.operations")}
        title={t("webhooks.title")}
        lede={t("console.webhooksLede")}
      />
      {error === null ? null : <ErrorNotice title={t("webhooks.loadError")} message={error} />}
      <div className="table-wrap" role="region" aria-label={t("webhooks.title")} tabIndex={0}>
        <table className="table">
          <caption className="visually-hidden">{t("webhooks.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("webhooks.received")}</th>
              <th scope="col">{t("webhooks.event")}</th>
              <th scope="col">{t("console.ref")}</th>
              <th scope="col">{t("webhooks.commit")}</th>
              <th scope="col">{t("webhooks.accepted")}</th>
              <th scope="col">{t("webhooks.error")}</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>{new Date(delivery.receivedAt).toISOString()}</td>
                <td>{delivery.eventType}</td>
                <td className="mono">{delivery.ref ?? "—"}</td>
                <td className="mono">{delivery.commitSha ?? "—"}</td>
                <td>{delivery.accepted ? t("common.yes") : t("common.no")}</td>
                <td className="mono">{delivery.errorCode ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deliveries.length === 0 && error === null ? (
        <p className="field-hint">{t("webhooks.empty")}</p>
      ) : null}
    </div>
  );
}
