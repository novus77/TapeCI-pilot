"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { encodeFunctionData } from "viem";
import {
  useAccount,
  useChainId,
  useConnect,
  useEstimateGas,
  useGasPrice,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";

import { bindContainerWithOperatorAction, registerBindSubmissionAction } from "@/app/actions";
import { detectInjectedWallet } from "@/lib/approval-signature";
import {
  BIND_MONTHS_MAX,
  BIND_MONTHS_MIN,
  bindValueWei,
  parseBindMonths,
  validateBindName,
} from "@/lib/binding";
import { describeError } from "@/lib/errors";
import { formatGwei, formatInteger, formatUtcDateTime, formatWeiAsOkb, shortValue } from "@/lib/format";
import type { ContainerBindingStatus } from "@/lib/types";
import {
  bindTrackingText,
  normalizeTxHash,
  walletAvailabilityNotice,
  walletConnectAvailability,
} from "@/lib/wallet-connectors";
import { xLayer } from "@/lib/wagmi";

import { useT } from "./locale-provider";
import { RiskNotice } from "./risk-notice";

/**
 * The two `DomainBinding` entries this form needs. Declared locally (rather than
 * imported from `@tapeci/chain`) so the client bundle only carries what it calls.
 */
const DOMAIN_BINDING_ABI = [
  {
    type: "function",
    name: "bind",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "container", type: "address" },
      { name: "months", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "monthlyFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type BindOutcome = {
  readonly path: "wallet" | "operator";
  readonly ok: boolean;
  readonly message: string;
  readonly txHash: `0x${string}` | null;
  /**
   * `pending` means the server stored the hash and has no receipt yet: the name
   * is not live and a second send must not be offered.
   */
  readonly state?: "pending" | "confirmed";
};

/** `null` until mounted: the first paint cannot know whether a wallet exists. */
type WalletPresence = "unknown" | "present" | "missing";

export interface BindNameFormProps {
  readonly containerAddress: `0x${string}`;
  readonly bindingAddress: `0x${string}`;
  readonly ownerAddress: `0x${string}`;
  readonly suggestedName: string;
  /** `?name=` when present, else the suggested name. */
  readonly initialName: string;
  readonly defaultMonths?: number;
  /** `null` when this build has no readable binding route. */
  readonly status: ContainerBindingStatus | null;
}

export function BindNameForm({
  containerAddress,
  bindingAddress,
  ownerAddress,
  suggestedName,
  initialName,
  defaultMonths = BIND_MONTHS_MIN,
  status,
}: BindNameFormProps) {
  const router = useRouter();
  const { t, locale } = useT();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const nameId = useId();
  const monthsId = useId();
  const nameHintId = useId();
  const walletHintId = useId();
  const operatorHintId = useId();
  const costHeadingId = useId();
  const manualHashId = useId();
  const manualHashHintId = useId();

  const [name, setName] = useState(initialName.length > 0 ? initialName : suggestedName);
  const [monthsText, setMonthsText] = useState(String(defaultMonths));
  const [walletPresence, setWalletPresence] = useState<WalletPresence>("unknown");
  const [pending, setPending] = useState<"wallet" | "operator" | "register" | null>(null);
  const [outcome, setOutcome] = useState<BindOutcome | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [manualHash, setManualHash] = useState("");
  const [checking, setChecking] = useState(false);

  // A missing `window.ethereum` is only knowable after mount, so the probe runs in
  // an effect instead of claiming either state on the server render.
  useEffect(() => {
    setWalletPresence(detectInjectedWallet(window) ? "present" : "missing");
  }, []);

  const { writeContractAsync, isPending: writing } = useWriteContract();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { data: chainMonthlyFee } = useReadContract({
    address: bindingAddress,
    abi: DOMAIN_BINDING_ABI,
    functionName: "monthlyFee",
    chainId: xLayer.id,
    query: { staleTime: 30_000, retry: false },
  });
  const { data: gasPriceWei } = useGasPrice({ chainId: xLayer.id, query: { staleTime: 30_000, retry: false } });

  const trimmedName = name.trim();
  const nameError = validateBindName(trimmedName);
  const nameOk = nameError === null;
  const months = parseBindMonths(monthsText);
  const monthsOk = months !== null;
  const monthsValue = months ?? defaultMonths;

  // Prefer the live chain read; fall back to the API's value; else unknown.
  const monthlyFeeWei: string | null =
    chainMonthlyFee !== undefined ? chainMonthlyFee.toString() : (status?.monthlyFeeWei ?? null);
  const value = bindValueWei(monthlyFeeWei, monthsValue);

  // `estimateGas` takes a pre-encoded call: encode once here so the preview and
  // the wallet button estimate exactly the same calldata.
  const callData: `0x${string}` | undefined =
    nameOk && monthsOk
      ? encodeFunctionData({
          abi: DOMAIN_BINDING_ABI,
          functionName: "bind",
          args: [trimmedName, containerAddress, BigInt(monthsValue)],
        })
      : undefined;
  const { data: gasEstimate, isError: gasUnavailable } = useEstimateGas({
    to: bindingAddress,
    data: callData,
    ...(value === null ? {} : { value }),
    chainId: xLayer.id,
    query: { enabled: callData !== undefined && value !== null, retry: false },
  });

  const gasCostLabel =
    gasEstimate === undefined
      ? gasUnavailable
        ? t("binding.gasUnknown")
        : "—"
      : gasPriceWei === undefined
        ? t("binding.gasFee", { fee: `${formatInteger(gasEstimate.toString())} gas` })
        : t("binding.gasFee", {
            fee: `${formatInteger(gasEstimate.toString())} gas · ${formatGwei(
              gasPriceWei.toString(),
              t("console.unknown"),
            )} ≈ ${formatWeiAsOkb((gasEstimate * gasPriceWei).toString(), t("console.unknown"))}`,
          });

  // A missing injected provider only rules out the *injected* connector. A
  // configured WalletConnect connector pairs by QR without `window.ethereum`, so
  // the control must stay usable in that case (§10, AC-P1-1).
  const availability = walletConnectAvailability({
    connectorIds: connectors.map((connector) => connector.id),
    hasInjectedProvider: walletPresence === "present",
  });
  const availabilityNotice = walletAvailabilityNotice(availability);
  // The connector the user should connect with: the injected one when a provider
  // exists, otherwise WalletConnect.
  const targetConnectorId = availability.state === "connectable" ? availability.connectorId : null;
  const targetConnector = connectors.find((connector) => connector.id === targetConnectorId);
  const connectable = targetConnector !== undefined;
  const wrongChain = isConnected && chainId !== xLayer.id;
  const isOwner = address !== undefined && address.toLowerCase() === ownerAddress.toLowerCase();
  const busy = pending !== null || writing || connecting;

  // A pending attempt already exists for this container: never offer a second
  // send, only a re-check (§3.3).
  const pendingSubmission = status?.pendingSubmission ?? null;

  // Derived from `connectable`, not from the provider probe: if no connector is
  // registered the control is genuinely unusable, and that must be said whether or
  // not the probe has settled (§10 forbids a silent disable).
  const walletBlockedReason = !isConnected
    ? connectable
      ? null
      : t("binding.walletDisabledNoWallet")
    : !isOwner
      ? t("binding.nextActionWrongOwner", { owner: shortValue(ownerAddress, 8, 6) })
      : null;
  // Not being connected is NOT a reason to disable: the button's own label says
  // "Connect wallet" and its handler connects. Including `!isConnected` here made
  // that branch unreachable — the control invited an action it refused (SPEC §10).
  // The provider probe's "unknown" state is deliberately NOT a disabling reason: it
  // is the transient window before the probe settles, and disabling there produced a
  // control that was neither usable nor explained (SPEC §10). A click while unknown
  // simply attempts the connect and surfaces the real error. Disabled is reserved
  // for "there is genuinely nothing to connect with", which always carries
  // `walletBlockedReason`.
  const walletDisabled = wrongChain
    ? switching || !isConnected
    : busy ||
      !nameOk ||
      !monthsOk ||
      (!isConnected && !connectable) ||
      walletBlockedReason !== null ||
      pendingSubmission !== null;

  // A write role can only be confirmed by the API; without the route, no guess.
  const canWriteWithOperator = status !== null && status.canWrite;
  const operatorBlockedReason =
    status === null
      ? t("binding.operatorUnavailable")
      : status.canWrite
        ? null
        : (status.writeBlockedReason ?? t("binding.operatorDisabled"));
  const operatorDisabled =
    busy || !nameOk || !monthsOk || !canWriteWithOperator || pendingSubmission !== null;

  function updateName(next: string): void {
    setName(next);
    setOutcome(null);
  }

  function updateMonths(next: string): void {
    setMonthsText(next);
    setOutcome(null);
  }

  async function ensureChain(): Promise<boolean> {
    if (!wrongChain) return true;
    try {
      // The wallet must be on X Layer before the write, otherwise viem rejects it
      // with "current chain does not match target chain".
      await switchChainAsync({ chainId: xLayer.id });
      return true;
    } catch {
      setOutcome({ path: "wallet", ok: false, message: t("binding.switchChainFailed"), txHash: null });
      return false;
    }
  }

  /** Connect through the connector that can actually work in this browser. */
  async function connectWallet(): Promise<boolean> {
    if (isConnected) return true;
    if (targetConnector === undefined) {
      setConnectError(t("binding.walletDisabledNoWallet"));
      return false;
    }
    setConnectError(null);
    try {
      // `connectAsync` throws; the mutate variant would swallow the failure and
      // leave the button looking inert.
      await connectAsync({ connector: targetConnector });
      return true;
    } catch (error) {
      // A failed connection must stay retryable: the error is shown and the
      // control is left enabled, never latched into a dead state.
      setConnectError(describeError(error));
      return false;
    }
  }

  /**
   * Record the hash the wallet just produced. This is the fix for the
   * direct-wallet gap: without it the bind leaves no `container_events` row, so
   * the console cannot show pending/confirmed and a refresh loses the attempt.
   */
  async function recordWalletHash(
    txHash: `0x${string}`,
    monthsCount: number,
  ): Promise<BindOutcome> {
    setPending("register");
    try {
      const result = await registerBindSubmissionAction(
        containerAddress,
        trimmedName,
        monthsCount,
        txHash,
      );
      if (!result.ok) {
        return {
          path: "wallet",
          ok: false,
          message: `${bindTrackingText(locale, "bind.tracking.notRecorded")} ${result.message}`,
          txHash,
        };
      }
      return {
        path: "wallet",
        ok: true,
        message:
          result.state === "confirmed"
            ? bindTrackingText(locale, "bind.tracking.confirmedBody")
            : bindTrackingText(locale, "bind.tracking.pendingBody"),
        txHash,
        ...(result.state === undefined ? {} : { state: result.state }),
      };
    } catch (error) {
      return {
        path: "wallet",
        ok: false,
        message: `${bindTrackingText(locale, "bind.tracking.notRecorded")} ${describeError(error)}`,
        txHash,
      };
    } finally {
      setPending(null);
    }
  }

  async function activateWithWallet(): Promise<void> {
    if (!nameOk || !monthsOk || value === null) return;
    // Connecting is part of the activation flow now, so a user on a fresh
    // browser never has to find another page first (§10, AC-P1-1).
    if (!(await connectWallet())) return;
    setPending("wallet");
    setOutcome(null);
    try {
      if (!(await ensureChain())) return;
      const txHash = await writeContractAsync({
        address: bindingAddress,
        abi: DOMAIN_BINDING_ABI,
        functionName: "bind",
        args: [trimmedName, containerAddress, BigInt(monthsValue)],
        value,
        chainId: xLayer.id,
      });
      // The hash exists from here on, so it is registered before anything else.
      // A registration failure is reported as a failure — the activation is
      // untracked and the user must know a refresh will lose it.
      const recorded = await recordWalletHash(txHash, monthsValue);
      setOutcome(recorded);
      if (recorded.ok) router.refresh();
    } catch (error) {
      setOutcome({ path: "wallet", ok: false, message: describeError(error), txHash: null });
    } finally {
      setPending(null);
    }
  }

  async function activateWithOperator(): Promise<void> {
    if (!nameOk || !monthsOk) return;
    setPending("operator");
    setOutcome(null);
    try {
      const result = await bindContainerWithOperatorAction(containerAddress, trimmedName, monthsValue);
      setOutcome({
        path: "operator",
        ok: result.ok,
        message: result.ok
          ? result.alreadyLive
            ? t("binding.alreadyLive")
            : result.state === "pending"
              ? bindTrackingText(locale, "bind.tracking.pendingBody")
              : t("binding.successOperator")
          : result.message,
        txHash: result.txHash,
        ...(result.state === undefined ? {} : { state: result.state }),
      });
      if (result.ok) router.refresh();
    } catch (error) {
      setOutcome({ path: "operator", ok: false, message: describeError(error), txHash: null });
    } finally {
      setPending(null);
    }
  }

  /**
   * Register a hash the user already broadcast. This is the §3.3 recovery path:
   * a wallet that closed before the hash came back still leaves a record, and the
   * server — not the pasted text — decides whether the name is live.
   */
  async function registerPastedHash(): Promise<void> {
    const txHash = normalizeTxHash(manualHash);
    if (txHash === null || !nameOk || !monthsOk) return;
    setOutcome(null);
    try {
      const recorded = await recordWalletHash(txHash, monthsValue);
      setOutcome(recorded);
      if (recorded.ok) {
        setManualHash("");
        router.refresh();
      }
    } finally {
      setPending(null);
    }
  }

  async function checkPending(): Promise<void> {
    if (pendingSubmission === null) return;
    setChecking(true);
    setOutcome(null);
    try {
      // Re-registering the same hash is idempotent on the server and re-reads the
      // receipt, which is exactly what "check the transaction" means here.
      const recorded = await recordWalletHash(pendingSubmission.txHash, pendingSubmission.months);
      setOutcome(recorded);
      if (recorded.ok && recorded.state === "confirmed") router.refresh();
    } finally {
      setChecking(false);
    }
  }

  const manualHashValid = manualHash.trim().length === 0 || normalizeTxHash(manualHash) !== null;

  return (
    <form
      className="bind-form"
      data-testid="bind-name-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!operatorDisabled) void activateWithOperator();
      }}
    >
      <div className="bind-fields">
        <div className="field">
          <label htmlFor={nameId}>{t("binding.name")}</label>
          <input
            id={nameId}
            data-testid="bind-name-input"
            type="text"
            value={name}
            onChange={(event) => updateName(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("binding.namePlaceholder")}
            aria-invalid={!nameOk}
            aria-describedby={nameHintId}
          />
          <p id={nameHintId} className={nameOk ? "field-hint" : "field-error"}>
            {nameOk ? t("binding.formHint") : t("binding.nameInvalid")}
          </p>
        </div>

        <div className="field">
          <label htmlFor={monthsId}>{t("binding.months")}</label>
          <input
            id={monthsId}
            data-testid="bind-months-input"
            type="number"
            inputMode="numeric"
            min={BIND_MONTHS_MIN}
            max={BIND_MONTHS_MAX}
            step={1}
            value={monthsText}
            onChange={(event) => updateMonths(event.target.value)}
            aria-invalid={!monthsOk}
            aria-describedby={`${monthsId}-hint`}
          />
          <p id={`${monthsId}-hint`} className={monthsOk ? "field-hint" : "field-error"}>
            {monthsOk ? t("binding.monthsHint") : t("binding.monthsInvalid")}
          </p>
        </div>
      </div>

      <section className="bind-cost" aria-labelledby={costHeadingId}>
        <h3 id={costHeadingId}>{t("binding.costPreview")}</h3>
        <dl className="meta-grid compact" data-testid="bind-cost-preview">
          <div className="meta-item">
            <dt>{t("binding.costValue")}</dt>
            <dd className="mono" data-testid="bind-cost-value">
              {formatWeiAsOkb(value === null ? null : value.toString(), t("console.unknown"))}
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("binding.costGas")}</dt>
            <dd data-testid="bind-cost-gas">{gasCostLabel}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("binding.monthlyFee")}</dt>
            <dd className="mono">{formatWeiAsOkb(monthlyFeeWei, t("console.unknown"))}</dd>
          </div>
        </dl>
      </section>

      {pendingSubmission === null ? null : (
        <RiskNotice tone="warning" title={bindTrackingText(locale, "bind.tracking.pendingNotice")}>
          <p>{bindTrackingText(locale, "bind.tracking.pendingBody")}</p>
          <p>
            {t("binding.txHash")}: <code className="mono">{pendingSubmission.txHash}</code>
          </p>
          <button
            type="button"
            className="button"
            data-testid="bind-check-pending"
            disabled={checking || busy}
            onClick={() => {
              void checkPending();
            }}
          >
            {checking
              ? bindTrackingText(locale, "bind.tracking.checking")
              : bindTrackingText(locale, "bind.tracking.check")}
          </button>
        </RiskNotice>
      )}

      {connectError === null ? null : (
        <RiskNotice tone="critical" title={bindTrackingText(locale, "bind.tracking.connectFailed")}>
          <p>{connectError}</p>
          <p>{bindTrackingText(locale, "bind.tracking.connectRetry")}</p>
        </RiskNotice>
      )}

      <div className="button-row">
        <button
          type="button"
          className="button button-primary"
          data-testid="bind-wallet-button"
          disabled={walletDisabled}
          aria-describedby={walletBlockedReason === null ? undefined : walletHintId}
          onClick={() => {
            if (!isConnected) {
              void connectWallet();
              return;
            }
            if (wrongChain) {
              void ensureChain();
              return;
            }
            void activateWithWallet();
          }}
        >
          {switching
            ? t("binding.switchingChain")
            : connecting
              ? bindTrackingText(locale, "bind.tracking.connecting")
              : !isConnected && connectable
                ? bindTrackingText(locale, "bind.tracking.connectWallet")
                : wrongChain
                  ? t("binding.switchChain")
                  : pending === "wallet"
                    ? t("binding.walletPending")
                    : t("binding.activateWallet")}
        </button>
        <button
          type="submit"
          className="button"
          data-testid="bind-operator-button"
          disabled={operatorDisabled}
          aria-describedby={operatorBlockedReason === null ? undefined : operatorHintId}
        >
          {pending === "operator" ? t("binding.operatorPending") : t("binding.activateOperator")}
        </button>
      </div>

      {walletBlockedReason === null ? null : (
        <p className="field-hint" id={walletHintId} data-testid="bind-wallet-reason">
          {walletBlockedReason}
        </p>
      )}
      {operatorBlockedReason === null ? null : (
        <p className="field-hint" id={operatorHintId} data-testid="bind-operator-reason">
          {operatorBlockedReason}
        </p>
      )}

      {/* A missing injected wallet is reported, never silently disabling the
          control: the notice names the cause instead of leaving a dead button. */}
      {availabilityNotice === null || isConnected ? null : (
        <p className="field-hint" data-testid="bind-wallet-availability">
          {t(availabilityNotice)}
        </p>
      )}

      {isConnected ? null : (
        <div className="field">
          <label htmlFor={manualHashId}>{bindTrackingText(locale, "bind.tracking.manualHash")}</label>
          <input
            id={manualHashId}
            data-testid="bind-manual-hash"
            type="text"
            value={manualHash}
            onChange={(event) => {
              setManualHash(event.target.value);
              setOutcome(null);
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="0x…"
            aria-invalid={!manualHashValid}
            aria-describedby={manualHashHintId}
          />
          <p id={manualHashHintId} className={manualHashValid ? "field-hint" : "field-error"}>
            {manualHashValid
              ? bindTrackingText(locale, "bind.tracking.manualHashHint")
              : bindTrackingText(locale, "bind.tracking.manualHashInvalid")}
          </p>
          <button
            type="button"
            className="button"
            data-testid="bind-manual-hash-submit"
            disabled={normalizeTxHash(manualHash) === null || busy || !nameOk || !monthsOk}
            onClick={() => {
              void registerPastedHash();
            }}
          >
            {pending === "register"
              ? bindTrackingText(locale, "bind.tracking.checking")
              : bindTrackingText(locale, "bind.tracking.manualHashSubmit")}
          </button>
        </div>
      )}

      <div aria-live="polite">
        {outcome === null ? null : (
          <RiskNotice
            tone={outcome.ok ? (outcome.state === "pending" ? "warning" : "success") : "critical"}
            title={
              outcome.ok
                ? outcome.state === "pending"
                  ? bindTrackingText(locale, "bind.tracking.pendingTitle")
                  : outcome.state === "confirmed"
                    ? bindTrackingText(locale, "bind.tracking.confirmedTitle")
                    : t("binding.successWallet")
                : t("binding.nameInvalid")
            }
          >
            <p>{outcome.message}</p>
            {outcome.txHash === null ? null : (
              <p>
                {t("binding.txHash")}: <code className="mono">{outcome.txHash}</code>
              </p>
            )}
            {outcome.ok && outcome.state === undefined ? null : (
              <p>
                {outcome.state === "pending"
                  ? bindTrackingText(locale, "bind.tracking.pendingBody")
                  : bindTrackingText(locale, "bind.tracking.recorded")}
              </p>
            )}
          </RiskNotice>
        )}
      </div>

      <p className="field-hint">
        {t("binding.bindingContract")}:{" "}
        <code className="mono" title={bindingAddress}>
          {shortValue(bindingAddress, 10, 8)}
        </code>
        {status === null
          ? null
          : ` · ${t("binding.paidUntil")}: ${formatUtcDateTime(paidUntilIso(status.paidUntil))}`}
      </p>
    </form>
  );
}

/** `paidUntil` arrives as unix seconds (uint40) from the chain or ISO in fixtures. */
function paidUntilIso(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
