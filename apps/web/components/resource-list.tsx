"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { useAccount } from "wagmi";

import { reVerifyResource } from "@/app/actions";
import { classifyVerifyDrift } from "@/lib/resource-verify";
import { useT } from "./locale-provider";

/**
 * Interactive controls for `/resources`.
 *
 * The page is a Server Component: the scan state (`ready` / `partial` /
 * `unavailable`) is derived on the server from the DTO, never from a client guess,
 * and the rows themselves are server-rendered because none of them is interactive
 * beyond `CopyValue`. Only the two controls that need browser state live here:
 *
 * - Refresh keeps the current result on screen (a route transition) and marks the
 *   state region `aria-busy` while the re-read is in flight, instead of dropping
 *   back to a skeleton — erasing a truthful "scan incomplete" banner for two
 *   seconds is how "incomplete" becomes "empty" (§2.1, §2.4 of the P2 contract).
 * - The connected-wallet shortcut is the only place this page may name the browser's
 *   wallet instead of the address in the URL; W9 keeps those two facts apart.
 */

export function ResourcesRefresh() {
  const router = useRouter();
  const { t } = useT();
  const [pending, startTransition] = useTransition();

  // The region is owned by the server component, so the contract's observable
  // "busy" flag is set on the rendered root from here, where the transition state
  // is actually known.
  useEffect(() => {
    const root = document.querySelector('[data-testid="resources-state"]');
    if (root === null) return;
    root.setAttribute("aria-busy", pending ? "true" : "false");
  }, [pending]);

  return (
    <button
      type="button"
      className="button button-ghost"
      data-testid="resources-refresh"
      disabled={pending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
    >
      {pending ? t("common.retrying") : t("resources.refresh")}
    </button>
  );
}

export function ConnectedWalletShortcut() {
  const { t } = useT();
  const { address, isConnected } = useAccount();
  if (!isConnected || address === undefined) {
    return <p className="field-hint">{t("resources.noWallet")}</p>;
  }
  return (
    <p className="field-hint">
      <Link href={`/resources?address=${address}`}>
        {t("resources.connectedWallet", {
          address: `${address.slice(0, 6)}…${address.slice(-4)}`,
        })}
      </Link>
    </p>
  );
}

/**
 * §3.1 step 3 / AC-P2-25..28: choosing a circuit re-verifies it on chain instead of
 * trusting the snapshot the row was rendered from.
 *
 * The button is deliberately not a link: a link would navigate on stale facts. It
 * re-reads first, reports the difference when the chain disagrees with the snapshot,
 * and only then says what the next step would be.
 */
export function ResourceVerifyAction({
  processor,
  tokenId,
  snapshotOpened,
  snapshotOwner,
  labels,
}: {
  readonly processor: string;
  readonly tokenId: string;
  readonly snapshotOpened: boolean | null;
  /** The owner this page was rendered with; a change here is a real drift. */
  readonly snapshotOwner: string | null;
  readonly labels: {
    readonly verify: string;
    readonly verifying: string;
    readonly opened: string;
    readonly notOpened: string;
    readonly changed: string;
    readonly unreadable: string;
    readonly notFound: string;
    readonly ownerChanged: string;
    readonly readAt: string;
  };
}) {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [fresh, setFresh] = useState<{
    opened: boolean;
    owner: string | null;
    observedBlock: string | null;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function verify(): Promise<void> {
    setState("running");
    setProblem(null);
    setFresh(null);
    const result = await reVerifyResource({ processor, tokenId });
    if (!result.ok) {
      setProblem(
        result.reason === "not_found"
          ? labels.notFound
          : result.reason === "unavailable"
            ? labels.unreadable
            : result.reason,
      );
      setState("done");
      return;
    }
    setFresh({ opened: result.opened, owner: result.owner, observedBlock: result.observedBlock });
    setState("done");
  }

  // A snapshot that disagrees with the chain is the case this control exists for, and
  // that includes the OWNER: a circuit transferred between page load and click is still
  // "opened", so comparing only `opened` would call a transferred circuit unchanged
  // (AC-P2-27). Addresses compare case-insensitively because hex casing is not identity.
  // The rule lives in `lib/resource-verify` so it can be tested; this component only
  // renders its answer.
  const drift =
    fresh === null
      ? "none"
      : classifyVerifyDrift(
          { opened: snapshotOpened, owner: snapshotOwner },
          { opened: fresh.opened, owner: fresh.owner },
        );
  const drifted = drift !== "none";
  const ownerDrift = drift === "owner" || drift === "both";

  return (
    <div className="resource-verify">
      <button
        type="button"
        className="button button-ghost"
        data-testid="resource-verify"
        disabled={state === "running"}
        aria-busy={state === "running"}
        onClick={() => void verify()}
      >
        {state === "running" ? labels.verifying : labels.verify}
      </button>
      {problem === null ? null : (
        <p className="field-hint" role="status" data-testid="resource-verify-problem">
          {problem}
        </p>
      )}
      {fresh === null ? null : (
        <p className="field-hint" role="status" data-testid="resource-verify-result">
          {drifted
            ? ownerDrift
              ? labels.ownerChanged
              : labels.changed
            : fresh.opened
              ? labels.opened
              : labels.notOpened}
          {/* AC-P2-26: the block is part of the answer — a fact without the block it was
              read at cannot be compared with the snapshot it is replacing. */}
          {fresh.observedBlock === null
            ? null
            : ` ${labels.readAt.replace("{block}", fresh.observedBlock)}`}
        </p>
      )}
    </div>
  );
}
