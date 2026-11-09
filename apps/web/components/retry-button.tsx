"use client";

import { FeedbackButton } from "./motion-feedback";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useT } from "./locale-provider";

/**
 * Re-runs the server render for the current route.
 *
 * `router.refresh()` re-fetches the server component tree without losing client
 * state, which is the right retry for a page whose data failed to load. The button
 * reports its own progress and is disabled while the refresh is in flight, so a
 * second click cannot stack requests.
 */
export function RetryButton({ label }: { readonly label?: string }) {
  const router = useRouter();
  const { t } = useT();
  const [pending, startTransition] = useTransition();

  return (
    <FeedbackButton
      type="button"
      className="button button-ghost retry-button"
      data-testid="retry-button"
      busy={pending}
      disabled={pending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
    >
      {pending ? t("common.retrying") : (label ?? t("common.retry"))}
    </FeedbackButton>
  );
}
