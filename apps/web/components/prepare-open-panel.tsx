"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { encodeFunctionData } from "viem";
import {
  useAccount,
  useChainId,
  useConnect,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";

import {
  createPreparationAction,
  createResourceQuoteAction,
  loadPreparationAction,
  prepareStepAction,
  reconcilePreparationAction,
  recordStepTransactionAction,
} from "@/app/actions";
import type { ActionFailure } from "@/app/actions";
import { detectInjectedWallet } from "@/lib/approval-signature";
import { describeError } from "@/lib/errors";
import {
  formatDuration,
  formatGwei,
  formatInteger,
  formatUtcDateTime,
  formatWeiAsOkb,
  shortValue,
} from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import type {
  PreparationPrice,
  PreparationQuote,
  PreparationStep,
  PreparationStepState,
  PreparationTask,
  PreparationTaskState,
  PreparedStepAction,
} from "@/lib/types";
import { walletConnectAvailability } from "@/lib/wallet-connectors";
import { xLayer } from "@/lib/wagmi";

import { useT } from "./locale-provider";
import { RiskNotice } from "./risk-notice";
import { StatusChip } from "./stage-badge";

/**
 * The open journey's only interactive surface (SPEC §3.1 step 4, §7.2, §7.3).
 *
 * Two screens share it:
 * - `/resources/prepare` (`mode: "quote"`): connect the delivery wallet, re-read the
 *   quote from the server, review every price line, then create the task.
 * - `/preparations/[id]` (`mode: "task"`): prepare one step, show the exact intent,
 *   send it from the user's own wallet, record the hash, and re-check an attempt.
 *
 * The rules this file is built around (`product-p3.md` §2.4, §2.9, §5.3):
 * - a fee and its gas stay two lines; nothing is summed into a "total";
 * - `amountWei: null` is rendered as the localized unknown label, never zero;
 * - a submitted step is "sent, not yet verified" and has no second send action;
 * - an `open` is not a publication: the copy never calls it a live site;
 * - no connected wallet means no signing control, and the recipient is never a
 *   free-text field — it is the wallet's own address, checked against the owner.
 */

export type PrepareOpenPanelProps =
  | {
      readonly mode: "quote";
      readonly processor: `0x${string}`;
      readonly tokenId: string;
      readonly owner: `0x${string}` | null;
      readonly observedBlock: string | null;
    }
  | { readonly mode: "task"; readonly task: PreparationTask };

export function PrepareOpenPanel(props: PrepareOpenPanelProps) {
  return props.mode === "quote" ? <QuotePanel {...props} /> : <TaskPanel task={props.task} />;
}

/** `open(address,uint256)` — the canonical opener write, declared locally on purpose. */
const OPENER_OPEN_ABI = [
  {
    type: "function",
    name: "open",
    stateMutability: "payable",
    inputs: [
      { name: "circuits", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const TASK_STATE_KEYS: Readonly<Record<PreparationTaskState, MessageKey>> = {
  running: "preparation.state.running",
  needs_action: "preparation.state.needs_action",
  waiting_user: "preparation.state.waiting_user",
  completed: "preparation.state.completed",
  failed: "preparation.state.failed",
  canceled: "preparation.state.canceled",
};

const TASK_STATE_TONES: Readonly<
  Record<PreparationTaskState, "success" | "warning" | "danger" | "neutral">
> = {
  running: "warning",
  needs_action: "warning",
  waiting_user: "neutral",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
};

const STEP_STATE_KEYS: Readonly<Record<PreparationStepState, MessageKey>> = {
  waiting: "preparation.stepState.waiting",
  awaiting_signature: "preparation.stepState.awaiting_signature",
  // Deliberately not the word "confirmed": a registered hash is not a receipt.
  submitted: "preparation.stepState.submitted",
  external_pending: "preparation.stepState.external_pending",
  confirmed: "preparation.stepState.verified",
  skipped: "preparation.stepState.skipped",
  failed: "preparation.stepState.failed",
};

const STEP_STATE_TONES: Readonly<
  Record<PreparationStepState, "success" | "warning" | "danger" | "neutral">
> = {
  waiting: "neutral",
  awaiting_signature: "warning",
  submitted: "warning",
  external_pending: "warning",
  confirmed: "success",
  skipped: "neutral",
  failed: "danger",
};

const STEP_KIND_KEYS: Readonly<Record<PreparationStep["kind"], MessageKey>> = {
  open: "preparation.kind.open",
  acquisition: "preparation.kind.acquisition",
  activation: "preparation.kind.activation",
};

const PRICE_KIND_KEYS: Readonly<Record<PreparationPrice["kind"], MessageKey>> = {
  open: "prepare.kind.open",
  gas: "prepare.kind.gas",
  acquisition: "prepare.kind.acquisition",
  activation: "prepare.kind.activation",
  service: "prepare.kind.service",
};

/**
 * Codes with a localized explanation. A code outside this map is still rendered
 * raw — the map decides whether there is prose, never whether the code is shown.
 */
const PREPARE_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  OWNER_REQUIRED: "prepare.error.ownerRequired",
  NOT_CURRENT_OWNER: "prepare.error.notCurrentOwner",
  WALLET_VERIFICATION_REQUIRED: "prepare.error.walletVerificationRequired",
  WALLET_MISMATCH: "prepare.error.walletMismatch",
  WRONG_CHAIN: "prepare.error.wrongChain",
  QUOTE_EXPIRED: "prepare.error.quoteExpired",
  QUOTE_CHANGED: "prepare.error.quoteChanged",
  RESOURCE_READ_UNAVAILABLE: "prepare.error.resourceReadUnavailable",
  PROCESSOR_NOT_REGISTERED: "prepare.error.processorNotRegistered",
  RESOURCE_NOT_FOUND: "prepare.error.resourceNotFound",
  RESOURCE_TOKEN_ZERO_UNSUPPORTED: "prepare.error.tokenZero",
  ALREADY_OPENED: "prepare.error.alreadyOpened",
  IDEMPOTENCY_CONFLICT: "prepare.error.idempotencyConflict",
};

const PREPARATION_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  CONFIRMATION_POLICY_UNCONFIGURED: "preparation.error.confirmationPolicyUnconfigured",
  TRANSACTION_REVERTED: "preparation.error.transactionReverted",
  TRANSACTION_UNRESOLVED: "preparation.error.transactionUnresolved",
  TRANSACTION_MISMATCH: "preparation.error.transactionMismatch",
  DELIVERY_UNVERIFIED: "preparation.error.deliveryUnverified",
  RPC_DISAGREEMENT: "preparation.error.rpcDisagreement",
  QUOTE_EXPIRED: "preparation.error.quoteExpired",
  OWNER_REQUIRED: "preparation.error.ownerRequired",
  WALLET_MISMATCH: "preparation.error.walletMismatch",
  STEP_VERSION_CONFLICT: "preparation.error.versionConflict",
  TASK_CANCELED: "preparation.error.taskCanceled",
};

const TX_STATUS_KEYS: Readonly<
  Record<PreparationStep["transactions"][number]["status"], MessageKey>
> = {
  submitted: "preparation.txStatus.submitted",
  confirmed: "preparation.txStatus.confirmed",
  failed: "preparation.txStatus.failed",
  unresolved: "preparation.txStatus.unresolved",
};

/**
 * Encode the call the quote is for. The server re-derives its own intent at
 * `prepare`; this is the same canonical call shown before any task exists, and
 * the copy says so rather than claiming it is an already-saved intent.
 */
function encodeOpenData(processor: string, tokenId: string): `0x${string}` | null {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(processor)) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(tokenId)) return null;
  try {
    return encodeFunctionData({
      abi: OPENER_OPEN_ABI,
      functionName: "open",
      args: [processor as `0x${string}`, BigInt(tokenId)],
    });
  } catch {
    return null;
  }
}

/** Client-only clock: `null` until mount, so the server render never guesses. */
function useNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ *
 * Wallet
 * ------------------------------------------------------------------ */

interface DeliveryWallet {
  readonly address: `0x${string}` | undefined;
  readonly isConnected: boolean;
  readonly chainId: number;
  readonly wrongChain: boolean;
  readonly connecting: boolean;
  readonly switching: boolean;
  readonly canConnect: boolean;
  readonly notice: string | null;
  readonly error: string | null;
  readonly connect: () => Promise<boolean>;
  readonly ensureChain: () => Promise<boolean>;
}

/**
 * The delivery wallet is the browser's own account. There is no field to type a
 * recipient: §7.2 requires the recipient to be a verified wallet whose address is
 * the circuit's current owner, and a typed address would be an authorization claim.
 */
function useDeliveryWallet(): DeliveryWallet {
  const { t } = useT();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [presence, setPresence] = useState<"unknown" | "present" | "missing">("unknown");
  const [error, setError] = useState<string | null>(null);

  // A missing `window.ethereum` is only knowable after mount.
  useEffect(() => {
    setPresence(detectInjectedWallet(window) ? "present" : "missing");
  }, []);

  const availability = walletConnectAvailability({
    connectorIds: connectors.map((connector) => connector.id),
    hasInjectedProvider: presence === "present",
  });
  const targetId = availability.state === "connectable" ? availability.connectorId : null;
  const targetConnector = connectors.find((connector) => connector.id === targetId);
  const noticeKey: MessageKey | null =
    availability.state === "injected-missing"
      ? "prepare.noProviderBody"
      : availability.state === "no-connector"
        ? "prepare.walletNoConnector"
        : null;

  async function connect(): Promise<boolean> {
    if (targetConnector === undefined) {
      setError(t("prepare.walletNoConnector"));
      return false;
    }
    setError(null);
    try {
      // The async variant throws; the mutate variant would leave a dead button.
      await connectAsync({ connector: targetConnector });
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

  async function ensureChain(): Promise<boolean> {
    if (!isConnected || chainId === xLayer.id) return isConnected;
    try {
      await switchChainAsync({ chainId: xLayer.id });
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    }
  }

  return {
    address,
    isConnected,
    chainId,
    wrongChain: isConnected && chainId !== xLayer.id,
    connecting,
    switching,
    canConnect: targetConnector !== undefined,
    notice: noticeKey === null ? null : t(noticeKey),
    error,
    connect,
    ensureChain,
  };
}

function WalletConnectRow({
  wallet,
  testId,
}: {
  readonly wallet: DeliveryWallet;
  readonly testId: string;
}) {
  const { t } = useT();
  return (
    <div className="wallet-row" data-testid={testId}>
      <span className={`wallet-status ${wallet.isConnected ? "is-connected" : ""}`}>
        {wallet.address === undefined
          ? t("wallet.notConnected")
          : `${t("prepare.deliveryWallet")}: ${shortValue(wallet.address, 8, 6)}`}
      </span>
      {wallet.isConnected ? null : (
        <button
          type="button"
          className="button"
          data-testid={`${testId}-connect`}
          disabled={wallet.connecting || !wallet.canConnect}
          onClick={() => {
            void wallet.connect();
          }}
        >
          {wallet.connecting ? t("wallet.connecting") : t("wallet.connect")}
        </button>
      )}
      {wallet.wrongChain ? (
        <button
          type="button"
          className="button button-primary"
          data-testid={`${testId}-switch-chain`}
          disabled={wallet.switching}
          onClick={() => {
            void wallet.ensureChain();
          }}
        >
          {wallet.switching ? t("wallet.switching") : t("wallet.switchChain")}
        </button>
      ) : null}
      {wallet.isConnected && !wallet.wrongChain ? (
        <span className="field-hint">{t("wallet.chain", { chainId: wallet.chainId })}</span>
      ) : null}
    </div>
  );
}

/**
 * A refused action. When a localized explanation exists it is used and the server
 * string is not repeated; when it does not, the raw server answer is shown. The
 * machine code is visible in both cases.
 */
function ActionErrorNotice({
  failure,
  retry,
  scope = "prepare",
}: {
  readonly failure: ActionFailure;
  readonly retry?: () => void;
  readonly scope?: "prepare" | "preparation";
}) {
  const { t } = useT();
  const map = scope === "preparation" ? PREPARATION_ERROR_KEYS : PREPARE_ERROR_KEYS;
  const key = failure.code === null ? undefined : map[failure.code];
  return (
    <RiskNotice tone="critical" title={key === undefined ? t("prepare.actionFailed") : t(key)}>
      {key === undefined ? <p>{failure.message}</p> : null}
      {failure.code === null ? null : (
        <p className="field-hint">
          {t("prepare.errorCode")}: <code className="mono">{failure.code}</code>
        </p>
      )}
      {retry === undefined ? null : (
        <div className="notice-actions">
          <button type="button" className="button button-ghost" onClick={retry}>
            {t("common.retry")}
          </button>
        </div>
      )}
    </RiskNotice>
  );
}

/* ------------------------------------------------------------------ *
 * `/resources/prepare`
 * ------------------------------------------------------------------ */

function QuotePanel({
  processor,
  tokenId,
  owner,
  observedBlock,
}: {
  readonly processor: `0x${string}`;
  readonly tokenId: string;
  readonly owner: `0x${string}` | null;
  readonly observedBlock: string | null;
}) {
  const { t } = useT();
  const router = useRouter();
  const wallet = useDeliveryWallet();
  const [quote, setQuote] = useState<PreparationQuote | null>(null);
  const [quoteFailure, setQuoteFailure] = useState<ActionFailure | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState<ActionFailure | null>(null);

  const address = wallet.address;
  const matchesOwner =
    address !== undefined &&
    owner !== null &&
    address.toLowerCase() === owner.toLowerCase();
  const ready = wallet.isConnected && matchesOwner;

  // One request per (processor, tokenId, wallet, attempt). The guard matters under
  // React strict mode, where the effect runs twice and would otherwise price twice.
  const [lastRequest, setLastRequest] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || address === undefined) {
      setRequesting(false);
      setQuote(null);
      setQuoteFailure(null);
      setLastRequest(null);
      return;
    }
    const key = `${processor}:${tokenId}:${address.toLowerCase()}:${attempt}`;
    if (lastRequest === key) return;
    setLastRequest(key);
    setRequesting(true);
    setQuoteFailure(null);
    void createResourceQuoteAction({ processor, tokenId, recipient: address }).then((result) => {
      setRequesting(false);
      if (result.ok) {
        setQuote(result.quote);
        setConfirmFailure(null);
        return;
      }
      setQuote(null);
      setQuoteFailure(result);
    });
  }, [address, attempt, lastRequest, processor, ready, tokenId]);

  function renewQuote(): void {
    setQuote(null);
    setConfirmFailure(null);
    setAttempt((current) => current + 1);
  }

  async function confirm(): Promise<void> {
    if (quote === null) return;
    setConfirming(true);
    setConfirmFailure(null);
    // Derived from the quote id: a double click reuses the same request digest and
    // the server answers with the same task instead of opening a second one.
    const result = await createPreparationAction(quote.id, `prepare-${quote.id}`);
    setConfirming(false);
    if (!result.ok) {
      setConfirmFailure(result);
      return;
    }
    router.push(`/preparations/${encodeURIComponent(result.task.id)}`);
  }

  return (
    <section className="panel" aria-labelledby="prepare-quote-heading" data-testid="prepare-panel">
      <div className="panel-head">
        <h2 id="prepare-quote-heading">{t("prepare.quoteHeading")}</h2>
        {quote === null ? null : (
          <span className="panel-meta mono">{t("prepare.source")} {quote.sourceId}</span>
        )}
      </div>

      <WalletConnectRow wallet={wallet} testId="prepare-wallet" />
      {wallet.notice === null ? null : <p className="field-hint">{wallet.notice}</p>}
      {wallet.error === null ? null : (
        <RiskNotice tone="critical" title={t("prepare.connectFailed")}>
          <p>{wallet.error}</p>
        </RiskNotice>
      )}

      {!wallet.isConnected ? (
        <RiskNotice tone="warning" title={t("prepare.noWalletTitle")}>
          <p data-testid="prepare-wallet-required">{t("prepare.noWalletBody")}</p>
          <p data-testid="prepare-owner-requirement">
            {t("prepare.ownerRequirement", { owner: owner ?? t("prepare.ownerUnknown") })}
          </p>
        </RiskNotice>
      ) : null}

      {wallet.isConnected && !matchesOwner ? (
        <RiskNotice tone="warning" title={t("prepare.ownerMismatchTitle")}>
          <p data-testid="prepare-owner-mismatch">
            {t("prepare.ownerMismatchBody", {
              owner: owner ?? t("prepare.ownerUnknown"),
              wallet: address ?? t("prepare.ownerUnknown"),
            })}
          </p>
        </RiskNotice>
      ) : null}

      {ready && requesting ? (
        <p className="field-hint" role="status" data-testid="prepare-quote-loading">
          {t("prepare.quoting")}
        </p>
      ) : null}

      {quoteFailure === null ? null : (
        <ActionErrorNotice failure={quoteFailure} retry={renewQuote} />
      )}

      {quote === null ? null : (
        <QuoteDetails
          quote={quote}
          processor={processor}
          tokenId={tokenId}
          observedBlock={observedBlock}
          confirming={confirming}
          confirmFailure={confirmFailure}
          onConfirm={() => {
            void confirm();
          }}
          onRenew={renewQuote}
        />
      )}
    </section>
  );
}

function QuoteDetails({
  quote,
  processor,
  tokenId,
  observedBlock,
  confirming,
  confirmFailure,
  onConfirm,
  onRenew,
}: {
  readonly quote: PreparationQuote;
  readonly processor: `0x${string}`;
  readonly tokenId: string;
  readonly observedBlock: string | null;
  readonly confirming: boolean;
  readonly confirmFailure: ActionFailure | null;
  readonly onConfirm: () => void;
  readonly onRenew: () => void;
}) {
  const { t } = useT();
  const now = useNow(1000);
  const expiresMs = Date.parse(quote.expiresAt);
  const expired = now !== null && !Number.isNaN(expiresMs) && expiresMs <= now;
  const callData = encodeOpenData(processor, tokenId);
  const feeLine = quote.prices.find((price) => price.kind === "open") ?? null;

  return (
    <div data-testid="prepare-quote" data-expired={expired ? "true" : "false"}>
      <h3>{t("prepare.priceHeading")}</h3>
      <p className="panel-copy">{t("prepare.priceBody")}</p>

      {quote.prices.length === 0 ? (
        <RiskNotice tone="warning" title={t("prepare.noPayableTitle")}>
          <p>{t("prepare.noPayableBody")}</p>
        </RiskNotice>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="prepare-prices">
            <caption className="visually-hidden">{t("prepare.priceCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("prepare.line")}</th>
                <th scope="col">{t("prepare.amount")}</th>
                <th scope="col">{t("prepare.nature")}</th>
                <th scope="col">{t("prepare.payer")}</th>
                <th scope="col">{t("prepare.payee")}</th>
              </tr>
            </thead>
            <tbody>
              {quote.prices.map((price, index) => (
                <PriceRow key={`${price.kind}-${index}`} price={price} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="meta-grid compact">
        <div className="meta-item">
          <dt>{t("prepare.observedBlock")}</dt>
          <dd className="mono" data-testid="prepare-observed-block">
            {quote.observedBlock}
          </dd>
        </div>
        {observedBlock === null ? null : (
          <div className="meta-item">
            <dt>{t("prepare.pageReadLabel", { block: observedBlock })}</dt>
            <dd className="mono">{observedBlock}</dd>
          </div>
        )}
        <div className="meta-item">
          <dt>{t("prepare.expiresAt")}</dt>
          <dd data-testid="prepare-expiry">{formatUtcDateTime(quote.expiresAt)}</dd>
        </div>
        <div className="meta-item">
          <dt>{t("prepare.countdownLabel")}</dt>
          <dd>
            <Countdown expiresAt={quote.expiresAt} />
          </dd>
        </div>
      </dl>

      <details data-testid="prepare-calldata">
        <summary>
          <code className="mono">open(processor, tokenId)</code>
        </summary>
        <p className="field-hint">{t("prepare.calldataBody")}</p>
        <dl className="meta-grid compact">
          <div className="meta-item">
            <dt>{t("prepare.processor")}</dt>
            <dd className="mono">{processor}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("prepare.tokenId")}</dt>
            <dd className="mono">{tokenId}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("prepare.calldataValue")}</dt>
            <dd className="mono">
              {feeLine === null
                ? t("console.unknown")
                : formatWeiAsOkb(feeLine.amountWei, t("console.unknown"))}
            </dd>
          </div>
        </dl>
        {callData === null ? (
          <p className="field-hint">{t("prepare.calldataUnavailable")}</p>
        ) : (
          <p>
            <code className="mono" style={{ wordBreak: "break-all" }} data-testid="prepare-calldata-value">
              {callData}
            </code>
          </p>
        )}
      </details>

      <RiskNotice tone="info" title={t("prepare.notWebsiteTitle")}>
        <p data-testid="prepare-no-website">{t("prepare.notWebsiteBody")}</p>
      </RiskNotice>

      <div className="action-list">
        <div className="action-item">
          <div className="action-copy">
            <h3>{t("prepare.confirmHeading")}</h3>
            <p className="action-reason">{t("prepare.confirmNote")}</p>
          </div>
          <button
            type="button"
            className="button button-primary"
            data-testid="prepare-confirm"
            disabled={confirming || expired}
            onClick={onConfirm}
          >
            {confirming ? t("prepare.confirming") : t("prepare.confirm")}
          </button>
        </div>
      </div>

      {expired ? (
        <RiskNotice tone="warning" title={t("prepare.expiredTitle")}>
          <p>{t("prepare.expiredBody")}</p>
          <div className="notice-actions">
            <button
              type="button"
              className="button button-ghost"
              data-testid="prepare-renew"
              onClick={onRenew}
            >
              {t("prepare.renewQuote")}
            </button>
          </div>
        </RiskNotice>
      ) : null}

      {confirmFailure === null ? null : (
        <ActionErrorNotice failure={confirmFailure} retry={onRenew} />
      )}
    </div>
  );
}

function PriceRow({ price }: { readonly price: PreparationPrice }) {
  const { t } = useT();
  // `null` is unknown, never zero. The gas line may also be absent if it could not
  // be estimated (§3.3), which is a different word from "unknown".
  const unknown = price.kind === "gas" ? t("prepare.gasNotEstimated") : t("console.unknown");
  return (
    <tr
      data-testid="prepare-price"
      data-kind={price.kind}
      data-estimated={price.estimated ? "true" : "false"}
    >
      <th scope="row">{t(PRICE_KIND_KEYS[price.kind])}</th>
      <td className="mono">
        {formatWeiAsOkb(price.amountWei, unknown)}{" "}
        <span className="field-hint">
          ({price.estimated ? t("prepare.estimated") : t("prepare.exact")})
        </span>
      </td>
      <td>{price.estimated ? t("prepare.basisEstimate") : t("prepare.basisExact")}</td>
      <td className="mono" title={price.payer}>
        {shortValue(price.payer, 8, 6)}
      </td>
      <td>
        {price.payee === null ? (
          <span className="field-hint">{t("prepare.noPayee")}</span>
        ) : (
          <code className="mono" title={price.payee}>
            {shortValue(price.payee, 8, 6)}
          </code>
        )}
      </td>
    </tr>
  );
}

function Countdown({ expiresAt }: { readonly expiresAt: string }) {
  const { t } = useT();
  const now = useNow(1000);
  if (now === null) return <span>{t("prepare.countdownPending")}</span>;
  const remaining = Date.parse(expiresAt) - now;
  if (Number.isNaN(remaining)) return <span>{t("console.unknown")}</span>;
  if (remaining <= 0) {
    return <span data-testid="prepare-countdown">{t("prepare.countdownExpired")}</span>;
  }
  return (
    <span data-testid="prepare-countdown">
      {t("prepare.countdownRemaining", { time: formatDuration(remaining) })}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * `/preparations/[id]`
 * ------------------------------------------------------------------ */

function TaskPanel({ task }: { readonly task: PreparationTask }) {
  const { t } = useT();
  const wallet = useDeliveryWallet();
  const [current, setCurrent] = useState<PreparationTask>(task);

  // A server refresh replaces the task; local updates from `prepare`/`reconcile`
  // arrive here too, so both paths render the newest version.
  useEffect(() => {
    setCurrent(task);
  }, [task]);

  return (
    <>
      <section
        className="panel"
        aria-labelledby="preparation-summary-heading"
        data-testid="preparation-task"
        data-task-state={current.state}
      >
        <div className="panel-head">
          <h2 id="preparation-summary-heading">{t("preparation.stateHeading")}</h2>
          <StatusChip label={t(TASK_STATE_KEYS[current.state])} tone={TASK_STATE_TONES[current.state]} />
        </div>
        <dl className="meta-grid">
          <div className="meta-item">
            <dt>{t("preparation.taskId")}</dt>
            <dd className="mono">{current.id}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("preparation.recipient")}</dt>
            <dd className="mono" data-testid="preparation-recipient">
              {current.recipient}
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("preparation.chain")}</dt>
            <dd>{current.chainId}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("preparation.version")}</dt>
            <dd>{current.version}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("preparation.updatedAt")}</dt>
            <dd>{formatUtcDateTime(current.updatedAt)}</dd>
          </div>
        </dl>
        <p className="panel-copy">{t("preparation.summaryBody")}</p>

        <WalletConnectRow wallet={wallet} testId="preparation-wallet" />
        {wallet.notice === null ? null : <p className="field-hint">{wallet.notice}</p>}
        {wallet.error === null ? null : (
          <RiskNotice tone="critical" title={t("prepare.connectFailed")}>
            <p>{wallet.error}</p>
          </RiskNotice>
        )}
        <p className="field-hint" data-testid="preparation-wallet-hint">
          {wallet.isConnected && wallet.address !== undefined
            ? wallet.address.toLowerCase() === current.recipient.toLowerCase()
              ? t("preparation.walletMatches", { recipient: shortValue(current.recipient, 8, 6) })
              : t("preparation.wrongRecipient", { recipient: current.recipient })
            : t("preparation.walletNeeded", { recipient: current.recipient })}
        </p>
      </section>

      {current.steps.length === 0 ? (
        <section className="panel">
          <RiskNotice tone="warning" title={t("preparation.noSteps")}>
            <p>{t("preparation.noStepsBody")}</p>
          </RiskNotice>
        </section>
      ) : null}

      {current.steps.map((step) => (
        <StepPanel
          key={step.id}
          step={step}
          task={current}
          wallet={wallet}
          onTask={setCurrent}
        />
      ))}
    </>
  );
}

function StepPanel({
  step,
  task,
  wallet,
  onTask,
}: {
  readonly step: PreparationStep;
  readonly task: PreparationTask;
  readonly wallet: DeliveryWallet;
  readonly onTask: (task: PreparationTask) => void;
}) {
  const { t } = useT();
  return (
    <section
      className="panel"
      data-testid="preparation-step"
      data-step-id={step.id}
      data-step-kind={step.kind}
      data-step-state={step.state}
    >
      <div className="panel-head">
        <h2>{t("preparation.stepOrdinal", { ordinal: step.ordinal + 1 })}</h2>
        <StatusChip label={t(STEP_STATE_KEYS[step.state])} tone={STEP_STATE_TONES[step.state]} />
      </div>

      <dl className="meta-grid compact">
        <div className="meta-item">
          <dt>{t("console.kind")}</dt>
          <dd>{t(STEP_KIND_KEYS[step.kind])}</dd>
        </div>
        <div className="meta-item">
          <dt>{t("preparation.stepStateLabel")}</dt>
          <dd data-testid="preparation-step-state" data-state={step.state}>
            {t(STEP_STATE_KEYS[step.state])}
          </dd>
        </div>
        {step.resource === null ? null : (
          <div className="meta-item">
            <dt>{t("resources.circuit")}</dt>
            <dd className="mono">#{step.resource.tokenId}</dd>
          </div>
        )}
        {step.resource === null ? null : (
          <div className="meta-item">
            <dt>{t("resources.processor")}</dt>
            <dd className="mono">{step.resource.processor}</dd>
          </div>
        )}
        <div className="meta-item">
          <dt>{t("preparation.intentId")}</dt>
          <dd className="mono" data-testid="preparation-step-intent">
            {step.intentId ?? t("preparation.noIntent")}
          </dd>
        </div>
      </dl>

      <StepError step={step} />
      <TransactionFacts step={step} />

      {step.state === "waiting" || step.state === "awaiting_signature" ? (
        <SignableStep step={step} task={task} wallet={wallet} onTask={onTask} />
      ) : null}
      {step.state === "submitted" ? <SubmittedStep step={step} task={task} onTask={onTask} /> : null}
      {step.state === "skipped" ? <SkippedStep /> : null}
      {step.state === "failed" ? <FailedStep /> : null}
      {step.state === "confirmed" ? <VerifiedStep /> : null}
      {step.state === "external_pending" ? (
        <RiskNotice tone="warning" title={t("preparation.externalPendingTitle")}>
          <p>{t("preparation.externalPendingBody")}</p>
        </RiskNotice>
      ) : null}
    </section>
  );
}

/** A step's `errorCode` is always visible; localization is additive, never hiding. */
function StepError({ step }: { readonly step: PreparationStep }) {
  const { t } = useT();
  if (step.errorCode === null) return null;
  const key = PREPARATION_ERROR_KEYS[step.errorCode];
  const tone =
    step.errorCode === "CONFIRMATION_POLICY_UNCONFIGURED" ||
    step.errorCode === "TRANSACTION_UNRESOLVED" ||
    step.errorCode === "DELIVERY_UNVERIFIED" ||
    step.errorCode === "RPC_DISAGREEMENT"
      ? "warning"
      : "critical";
  return (
    <div data-testid="preparation-step-error" data-code={step.errorCode}>
      <RiskNotice tone={tone} title={key === undefined ? t("preparation.errorUnknownTitle") : t(key)}>
        {key === undefined ? <p>{t("preparation.errorUnmapped")}</p> : null}
        <p className="field-hint">
          {t("preparation.errorCode")}: <code className="mono">{step.errorCode}</code>
        </p>
      </RiskNotice>
    </div>
  );
}

function TransactionFacts({ step }: { readonly step: PreparationStep }) {
  const { t } = useT();
  if (step.transactions.length === 0) return null;
  return (
    <div className="table-wrap" data-testid="preparation-transactions">
      <table className="table">
        <caption className="visually-hidden">{t("preparation.transactionsCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("preparation.txHash")}</th>
            <th scope="col">{t("preparation.txStatus")}</th>
            <th scope="col">{t("preparation.txBlock")}</th>
            <th scope="col">{t("preparation.txValue")}</th>
          </tr>
        </thead>
        <tbody>
          {step.transactions.map((transaction) => (
            <tr key={transaction.id} data-testid="preparation-transaction" data-status={transaction.status}>
              <td className="mono" title={transaction.txHash ?? undefined}>
                {transaction.txHash === null
                  ? t("preparation.txHashMissing")
                  : shortValue(transaction.txHash, 10, 8)}
              </td>
              <td>{t(TX_STATUS_KEYS[transaction.status])}</td>
              <td className="mono">{transaction.blockNumber ?? t("preparation.txBlockNone")}</td>
              <td className="mono">
                {formatWeiAsOkb(transaction.valueWei, t("console.unknown"))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The one fact that must survive a reload after a send: the public hash the wallet
 * returned when the server refused to record it. This is not an order fact source
 * (§3.3 forbids that) — it only prevents the page from offering a second send for a
 * transaction that may already be broadcast. It is removed as soon as recording
 * succeeds, and it never authorizes anything by itself.
 */
const UNRECORDED_STORAGE_PREFIX = "tapeci:preparation:unrecorded:";

function unrecordedKey(taskId: string, stepId: string): string {
  return `${UNRECORDED_STORAGE_PREFIX}${taskId}:${stepId}`;
}

function readStoredHash(key: string): { readonly intentId: string; readonly txHash: `0x${string}` } | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const intentId = "intentId" in parsed ? parsed.intentId : undefined;
    const txHash = "txHash" in parsed ? parsed.txHash : undefined;
    if (typeof intentId !== "string" || intentId.length === 0) return null;
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(txHash)) return null;
    return { intentId, txHash: txHash.toLowerCase() as `0x${string}` };
  } catch {
    return null;
  }
}

function writeStoredHash(
  key: string,
  value: { readonly intentId: string; readonly txHash: `0x${string}` } | null,
): void {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota). The in-memory guard still
    // applies for this page view; only a reload loses the reminder.
  }
}

/**
 * A step the wallet can still sign: `waiting` or `awaiting_signature`.
 *
 * Loading the intent is a server call (`prepare`) that persists the intent and
 * bumps the task version, so the fresh task is fetched before the wallet can send.
 * Without that the hash registration would race the version it was prepared at.
 */
function SignableStep({
  step,
  task,
  wallet,
  onTask,
}: {
  readonly step: PreparationStep;
  readonly task: PreparationTask;
  readonly wallet: DeliveryWallet;
  readonly onTask: (task: PreparationTask) => void;
}) {
  const { t } = useT();
  const router = useRouter();
  const { sendTransactionAsync } = useSendTransaction();
  const [intent, setIntent] = useState<PreparedStepAction["intent"] | null>(null);
  const [pending, setPending] = useState<"prepare" | "send" | "record" | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [unrecorded, setUnrecorded] = useState<{
    readonly intentId: string;
    readonly txHash: `0x${string}`;
  } | null>(null);
  const storageKey = unrecordedKey(task.id, step.id);

  // A reload after a sent-but-unrecorded hash must not re-offer a send.
  useEffect(() => {
    setUnrecorded(readStoredHash(storageKey));
  }, [storageKey]);

  const address = wallet.address;
  const recipientMatches =
    address !== undefined && address.toLowerCase() === task.recipient.toLowerCase();
  const canSign =
    intent !== null &&
    intent.stepId === step.id &&
    wallet.isConnected &&
    recipientMatches &&
    !wallet.wrongChain &&
    pending === null;

  async function loadIntent(): Promise<void> {
    setPending("prepare");
    setFailure(null);
    const prepared = await prepareStepAction(task.id, step.id, task.version);
    if (!prepared.ok) {
      setPending(null);
      setFailure(prepared);
      return;
    }
    setIntent(prepared.action.intent);
    // The prepare transition changed the step and the task version; a hash
    // recorded against the old version would be refused as a version conflict.
    const fresh = await loadPreparationAction(task.id);
    setPending(null);
    if (!fresh.ok) {
      setFailure(fresh);
      return;
    }
    onTask(fresh.task);
  }

  async function recordHash(
    intentId: string,
    txHash: `0x${string}`,
    version: number,
  ): Promise<boolean> {
    const recorded = await recordStepTransactionAction({
      taskId: task.id,
      stepId: step.id,
      intentId,
      txHash,
      expectedVersion: version,
    });
    if (!recorded.ok) {
      setFailure(recorded);
      return false;
    }
    onTask(recorded.task);
    return true;
  }

  async function send(): Promise<void> {
    if (intent === null || address === undefined) return;
    if (!(await wallet.ensureChain())) return;
    setPending("send");
    setFailure(null);
    let txHash: `0x${string}`;
    try {
      txHash = await sendTransactionAsync({
        account: address,
        to: intent.to,
        value: BigInt(intent.value),
        data: intent.data,
        gas: BigInt(intent.gasLimit),
        gasPrice: BigInt(intent.gasPriceWei),
        chainId: xLayer.id,
      });
    } catch (error) {
      // Rejected or closed wallet: nothing was sent and the step stays signable.
      setPending(null);
      setFailure({ ok: false, message: describeError(error), code: null });
      return;
    }
    // The hash exists from here on. It is registered before anything else, and a
    // registration failure is never made to look like "nothing was sent".
    setPending("record");
    setIntent(null);
    const ok = await recordHash(intent.intentId, txHash, task.version);
    setPending(null);
    if (!ok) {
      const pending = { intentId: intent.intentId, txHash };
      setUnrecorded(pending);
      writeStoredHash(storageKey, pending);
      return;
    }
    setUnrecorded(null);
    writeStoredHash(storageKey, null);
    router.refresh();
  }

  async function recordAgain(): Promise<void> {
    if (unrecorded === null) return;
    setPending("record");
    setFailure(null);
    const ok = await recordHash(unrecorded.intentId, unrecorded.txHash, task.version);
    setPending(null);
    if (ok) {
      setUnrecorded(null);
      writeStoredHash(storageKey, null);
      router.refresh();
    }
  }

  return (
    <div data-testid="preparation-wallet-step">
      {unrecorded === null ? null : (
        <RiskNotice tone="critical" title={t("preparation.unrecordedTitle")}>
          <p>{t("preparation.unrecordedBody")}</p>
          <p className="mono">{unrecorded.txHash}</p>
          <div className="notice-actions">
            <button
              type="button"
              className="button button-danger"
              data-testid="preparation-record-again"
              disabled={pending !== null}
              onClick={() => {
                void recordAgain();
              }}
            >
              {pending === "record" ? t("preparation.recording") : t("preparation.recordAgain")}
            </button>
          </div>
        </RiskNotice>
      )}

      {intent === null && unrecorded === null ? (
        <div className="action-list">
          <div className="action-item">
            <div className="action-copy">
              <h3>{t("preparation.prepareTitle")}</h3>
              <p className="action-reason">{t("preparation.prepareBody")}</p>
            </div>
            <button
              type="button"
              className="button button-primary"
              data-testid="preparation-prepare"
              disabled={pending !== null}
              onClick={() => {
                void loadIntent();
              }}
            >
              {pending === "prepare" ? t("preparation.preparing") : t("preparation.prepare")}
            </button>
          </div>
        </div>
      ) : null}

      {intent === null ? null : (
        <div data-testid="preparation-intent">
          <h3>{t("preparation.intentHeading")}</h3>
          <dl className="meta-grid compact">
            <div className="meta-item">
              <dt>{t("preparation.intentTo")}</dt>
              <dd className="mono">{intent.to}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("preparation.intentValue")}</dt>
              <dd className="mono">{formatWeiAsOkb(intent.value, t("console.unknown"))}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("preparation.intentGasLimit")}</dt>
              <dd className="mono">{formatInteger(intent.gasLimit)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("preparation.intentGasPrice")}</dt>
              <dd className="mono">{formatGwei(intent.gasPriceWei, t("console.unknown"))}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("preparation.intentMaxGas")}</dt>
              <dd className="mono">
                {formatWeiAsOkb(intent.maxGasCostWei, t("prepare.gasNotEstimated"))}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("preparation.intentExpiry")}</dt>
              <dd>{formatUtcDateTime(intent.expiresAt)}</dd>
            </div>
          </dl>
          <details data-testid="preparation-calldata">
            <summary>
              <code className="mono">open(processor, tokenId)</code>
            </summary>
            <p className="field-hint">{t("preparation.calldataNote")}</p>
            <p>
              <code className="mono" style={{ wordBreak: "break-all" }}>
                {intent.data}
              </code>
            </p>
          </details>

          {wallet.isConnected ? null : (
            <RiskNotice tone="warning" title={t("preparation.walletRequiredTitle")}>
              <p data-testid="preparation-wallet-readonly">
                {t("preparation.walletRequiredBody", { recipient: task.recipient })}
              </p>
            </RiskNotice>
          )}
          {wallet.isConnected && !recipientMatches ? (
            <RiskNotice tone="warning" title={t("preparation.wrongWalletTitle")}>
              <p>{t("preparation.wrongRecipient", { recipient: task.recipient })}</p>
            </RiskNotice>
          ) : null}

          <div className="action-list">
            <div className="action-item">
              <div className="action-copy">
                <h3>{t("preparation.sendTitle")}</h3>
                <p className="action-reason">{t("preparation.sendBody")}</p>
              </div>
              <button
                type="button"
                className="button button-primary"
                data-testid="preparation-send"
                disabled={!canSign}
                onClick={() => {
                  void send();
                }}
              >
                {pending === "send" || pending === "record"
                  ? t("preparation.sending")
                  : t("preparation.send")}
              </button>
            </div>
          </div>
        </div>
      )}

      {failure === null ? null : <ActionErrorNotice failure={failure} scope="preparation" />}
    </div>
  );
}

/**
 * P3's honest terminal (issue P3-01): a registered hash is never presented as a
 * success. There is no second send action while the attempt is unresolved, and a
 * re-check reports what the server can prove rather than turning the hash into a
 * verification by itself.
 */
function SubmittedStep({
  step,
  task,
  onTask,
}: {
  readonly step: PreparationStep;
  readonly task: PreparationTask;
  readonly onTask: (task: PreparationTask) => void;
}) {
  const { t } = useT();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [checkedState, setCheckedState] = useState<MessageKey | null>(null);

  const policyBlocked = step.errorCode === "CONFIRMATION_POLICY_UNCONFIGURED";

  async function checkAgain(): Promise<void> {
    setPending(true);
    setFailure(null);
    setCheckedState(null);
    const result = await reconcilePreparationAction(task.id, task.version);
    setPending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    onTask(result.task);
    const fresh = result.task.steps.find((candidate) => candidate.id === step.id);
    setCheckedState(fresh === undefined ? null : STEP_STATE_KEYS[fresh.state]);
    router.refresh();
  }

  return (
    <div data-testid="preparation-submitted">
      <RiskNotice tone="warning" title={t("preparation.sentNotVerifiedTitle")}>
        <p data-testid="preparation-submitted-sentence">{t("preparation.sentNotVerifiedBody")}</p>
        <p data-testid="preparation-policy-hint">{t("preparation.policyHint")}</p>
        <p data-testid="preparation-no-second-send">{t("preparation.noSecondSend")}</p>
        {policyBlocked ? <p data-testid="preparation-policy-blocker">{t("preparation.policyBody")}</p> : null}
      </RiskNotice>

      <div className="filter-actions">
        <button
          type="button"
          className="button"
          data-testid="preparation-check-again"
          disabled={pending}
          onClick={() => {
            void checkAgain();
          }}
        >
          {pending ? t("preparation.checking") : t("preparation.checkAgain")}
        </button>
        <span className="field-hint">{t("preparation.checkAgainBody")}</span>
      </div>

      {checkedState === null ? null : (
        <p className="field-hint" role="status" data-testid="preparation-check-result">
          {t("preparation.checkResult", { state: t(checkedState) })}
        </p>
      )}

      {failure === null ? null : <ActionErrorNotice failure={failure} scope="preparation" />}
    </div>
  );
}

/** P3's only skip cause is "already open": nothing was charged for this step. */
function SkippedStep() {
  const { t } = useT();
  return (
    <RiskNotice tone="info" title={t("preparation.skippedTitle")}>
      <p data-testid="preparation-skipped-reason">{t("preparation.skippedWhy")}</p>
    </RiskNotice>
  );
}

function FailedStep() {
  const { t } = useT();
  return (
    <RiskNotice tone="critical" title={t("preparation.failedTitle")}>
      <p>{t("preparation.failedBody")}</p>
    </RiskNotice>
  );
}

function VerifiedStep() {
  const { t } = useT();
  return (
    <RiskNotice tone="success" title={t("preparation.verifiedTitle")}>
      <p data-testid="preparation-verified-body">{t("preparation.verifiedBody")}</p>
      <p data-testid="preparation-not-published">{t("preparation.verifiedNotPublished")}</p>
      <p>{t("preparation.handoffPending")}</p>
    </RiskNotice>
  );
}
