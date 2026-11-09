"use client";

import Link from "next/link";
import { CopyValue } from "./copy-value";
import { useT } from "./locale-provider";
import { formatWeiAsOkb, shortValue } from "@/lib/format";

export interface ApprovalReviewData {
  readonly repository: string;
  readonly container: string | null;
  readonly commit: string;
  readonly manifest: string | null;
  readonly chainId: number;
  readonly estimate: string | null;
  readonly cap: string | null;
}

export function ApprovalReview({ review }: { readonly review: ApprovalReviewData }) {
  const { t } = useT();
  return <div className="approval-review" data-testid="approval-review">
    <p className="review-repository">{review.repository}</p>
    <dl className="review-facts">
      <div><dt>{t("home.container")}</dt><dd>{review.container === null ? t("console.unknown") : <Link href={`/containers/${review.container}`} title={review.container}>{shortValue(review.container, 8, 6)}</Link>}</dd></div>
      <div><dt>{t("deployment.chain")}</dt><dd>X Layer · {review.chainId}</dd></div>
      <div><dt>{t("deployment.commit")}</dt><dd><code title={review.commit}>{review.commit.slice(0, 8)}</code></dd></div>
      <div className="review-manifest"><dt>{t("deployment.manifestSha")}</dt><dd>{review.manifest === null ? t("console.unknown") : <CopyValue value={review.manifest} label="manifest SHA-256" display={shortValue(review.manifest, 10, 6)} />}</dd></div>
    </dl>
    <dl className="review-costs">
      <div><dt>{t("plan.estimatedCost")}</dt><dd>{formatWeiAsOkb(review.estimate, t("console.unknown"))}</dd></div>
      <div><dt>{t("plan.approvedCap")}</dt><dd>{formatWeiAsOkb(review.cap, t("console.unknown"))}</dd></div>
    </dl>
  </div>;
}
