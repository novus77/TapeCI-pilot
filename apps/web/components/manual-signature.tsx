"use client";

import { useId, useState, type ChangeEvent, type FormEvent } from "react";

import {
  approveDeploymentWithSignatureAction,
  loadApprovalPayloadAction,
} from "@/app/actions";
import {
  describeSignatureProblem,
  formatApprovalPayloadJson,
  normalizeSignature,
} from "@/lib/approval-signature";
import { describeError } from "@/lib/errors";
import { isHexAddress } from "@/lib/format";
import type { ApprovalTypedData } from "@/lib/types";

import { useT } from "./locale-provider";
import { RiskNotice } from "./risk-notice";

type LoadState = "idle" | "loading" | "ready" | "failed";

interface Outcome {
  readonly ok: boolean;
  readonly title: string;
  readonly message: string;
}

/**
 * Fallback A from `.superpowers/sdd/unblock-approval/plan.md`: sign the
 * approval outside the browser and paste the signature back.
 *
 * The panel renders the exact EIP-712 document the API verifies and submits the
 * pasted signature through the existing server action, so the API applies the
 * same owner/cost-cap/expiry checks as the wallet path. No key ever reaches the
 * browser and nothing here signs anything.
 */
export function ManualSignaturePanel({
  deploymentId,
  walletDetected,
  onApproved,
}: {
  readonly deploymentId: string;
  /** Result of the post-mount `window.ethereum` probe; only changes the copy. */
  readonly walletDetected: boolean;
  readonly onApproved?: () => void;
}) {
  const { t } = useT();
  const panelId = useId();
  const signerId = useId();
  const signerHintId = useId();
  const signatureId = useId();
  const signatureHintId = useId();
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [payload, setPayload] = useState<ApprovalTypedData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signer, setSigner] = useState("");
  const [signature, setSignature] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState(false);

  async function load(): Promise<void> {
    setLoadState("loading");
    setLoadError(null);
    setOutcome(null);
    try {
      const loaded = await loadApprovalPayloadAction(deploymentId);
      if (!loaded.ok) {
        setLoadState("failed");
        setLoadError(loaded.message);
        return;
      }
      setPayload(loaded.payload);
      setSigner(loaded.payload.expectedSigner ?? "");
      setLoadState("ready");
    } catch (error) {
      setLoadState("failed");
      setLoadError(describeError(error));
    }
  }

  function toggle(): void {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loadState !== "loading") void load();
  }

  async function copyPayload(): Promise<void> {
    if (payload === null) return;
    try {
      await navigator.clipboard.writeText(formatApprovalPayloadJson(payload));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      setOutcome({
        ok: false,
        title: t("manual.copyFailed"),
        message: t("manual.copyFallback", { message: describeError(error) }),
      });
    }
  }

  function handleSignerChange(event: ChangeEvent<HTMLInputElement>): void {
    setSigner(event.target.value);
    setOutcome(null);
  }

  function handleSignatureChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setSignature(event.target.value);
    setOutcome(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (payload === null) return;
    const normalizedSignature = normalizeSignature(signature);
    const signatureProblem = describeSignatureProblem(signature);
    if (signatureProblem !== null || normalizedSignature === null) {
      setOutcome({ ok: false, title: t("manual.notSubmitted"), message: signatureProblem ?? t("manual.malformed") });
      return;
    }
    const trimmedSigner = signer.trim();
    if (!isHexAddress(trimmedSigner)) {
      setOutcome({
        ok: false,
        title: t("manual.notSubmitted"),
        message: t("manual.addressInvalid"),
      });
      return;
    }
    setSubmitting(true);
    setOutcome(null);
    try {
      const result = await approveDeploymentWithSignatureAction(
        deploymentId,
        trimmedSigner,
        normalizedSignature,
        payload.approval,
      );
      setOutcome({
        ok: result.ok,
        title: result.ok ? t("manual.approvalRecorded") : t("manual.approvalRefused"),
        message: result.message,
      });
      if (result.ok) onApproved?.();
    } catch (error) {
      setOutcome({ ok: false, title: t("manual.approvalRefused"), message: describeError(error) });
    } finally {
      setSubmitting(false);
    }
  }

  const payloadJson = payload === null ? "" : formatApprovalPayloadJson(payload);
  const signatureProblem = signature.trim().length === 0 ? null : describeSignatureProblem(signature);
  const signerProblem =
    signer.trim().length === 0 || isHexAddress(signer.trim())
      ? null
      : t("manual.addressInvalid");

  return (
    <div className="manual-signature">
      <button
        type="button"
        className="button button-ghost manual-signature-toggle"
        data-testid="manual-signature"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {open ? t("manual.hide") : t("manual.toggle")}
      </button>

      {open ? (
        <div className="manual-signature-panel" id={panelId}>
          <p className="manual-signature-lede">
            {walletDetected
              ? t("manual.hintConnected")
              : t("manual.hintNoWallet")}
          </p>

          {loadState === "loading" ? (
            <p className="field-hint" role="status">
              {t("manual.loadingPayload")}
            </p>
          ) : null}

          {loadState === "failed" && loadError !== null ? (
            <RiskNotice tone="critical" title={t("manual.loadError")}>
              <p>{loadError}</p>
              <p>{t("manual.loadFailedBody")}</p>
            </RiskNotice>
          ) : null}

          {loadState === "ready" && payload !== null ? (
            <>
              <div className="manual-signature-doc">
                <div className="manual-signature-doc-head">
                  <h3>{t("manual.typedData")}</h3>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => {
                      void copyPayload();
                    }}
                    aria-label={copied ? t("common.copied") : t("manual.copyJson")}
                    title={t("manual.copyJsonTitle")}
                  >
                    {copied ? t("common.copied") : t("manual.copyJson")}
                  </button>
                </div>
                <pre
                  className="manual-signature-json mono"
                  data-testid="manual-signature-payload"
                  tabIndex={0}
                >
                  {payloadJson}
                </pre>
                <p className="field-hint">
                  {t("manual.payloadInstructions")}{" "}
                  {payload.expectedSigner === null
                    ? t("manual.expectedSignerMissing")
                    : t("manual.expectedSigner", { signer: payload.expectedSigner })}
                </p>
              </div>

              <form className="manual-signature-form" onSubmit={(event) => void submit(event)} noValidate>
                <div className="field">
                  <label htmlFor={signerId}>{t("manual.signingAddress")}</label>
                  <input
                    id={signerId}
                    type="text"
                    value={signer}
                    onChange={handleSignerChange}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="0x…"
                    aria-invalid={signerProblem !== null}
                    aria-describedby={signerHintId}
                  />
                  <p
                    id={signerHintId}
                    className={signerProblem === null ? "field-hint" : "field-error"}
                  >
                    {signerProblem ??
                      t("manual.signingAddressHint")}
                  </p>
                </div>

                <div className="field">
                  <label htmlFor={signatureId}>{t("manual.signature")}</label>
                  <textarea
                    id={signatureId}
                    data-testid="manual-signature-input"
                    value={signature}
                    onChange={handleSignatureChange}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t("manual.signaturePlaceholder")}
                    aria-invalid={signatureProblem !== null}
                    aria-describedby={signatureHintId}
                  />
                  <p
                    id={signatureHintId}
                    className={signatureProblem === null ? "field-hint" : "field-error"}
                  >
                    {signatureProblem ??
                      t("manual.signatureHint")}
                  </p>
                </div>

                <div className="button-row">
                  <button
                    type="submit"
                    className="button button-primary"
                    data-testid="manual-signature-submit"
                    disabled={submitting}
                  >
                    {submitting ? t("manual.submitting") : t("manual.submit")}
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={submitting}
                    onClick={() => {
                      void load();
                    }}
                  >
                    {t("manual.reloadPayload")}
                  </button>
                </div>

                <div aria-live="polite">
                  {outcome === null ? null : (
                    <RiskNotice tone={outcome.ok ? "success" : "critical"} title={outcome.title}>
                      <p>{outcome.message}</p>
                    </RiskNotice>
                  )}
                </div>
              </form>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
