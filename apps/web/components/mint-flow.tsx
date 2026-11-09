"use client";

/**
 * The mint flow (SPEC §3.2): choose a processor, review every fee, then send the two
 * transactions from the user's own wallet.
 *
 * Why a flow and not a table with a button: §3.2 requires the user to see the source, the
 * goods, the delivery target and every fee *before* a paid step, and §9.3 forbids folding
 * acquisition and opening into one authorisation. A bare table can express "which processor"
 * but not "what will you pay, in what order, and what happens if it fails".
 *
 * The three transactions are deliberately separate:
 *  1. `mint`    — buy one transistor (skipped when the wallet already holds one)
 *  2. `tapeout` — irreversibly turn it into a circuit with an on-chain id
 *  3. `open`    — quoted and confirmed later, because the circuit id does not exist until (2)
 *                 lands (§9.3)
 */
import { useState } from "react";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { usePublicClient, useSendTransaction } from "wagmi";

import { priceSelfMint } from "@/app/actions";
import type { MintableProcessor, SelfMintQuote } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { shortValue } from "@/lib/format";
import { useT } from "./locale-provider";
import { WalletConnection, useWalletConnection } from "./wallet-connection";

const TAPED_OUT_TOPIC: Hex = keccak256(toHex("TapedOut(uint256,address,uint32,uint32)"));

type Phase = "choose" | "confirm" | "running" | "done";

interface ExecutedStep {
  readonly kind: "mint" | "tapeout";
  readonly hash: Hex;
}

function formatOkb(wei: string): string {
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return fraction.length === 0 ? `${whole.toString()} OKB` : `${whole.toString()}.${fraction} OKB`;
  } catch {
    return "—";
  }
}

export function MintFlow({
  processors,
  error,
  demo,
}: {
  readonly processors: readonly MintableProcessor[];
  /** Populated when the catalogue could not be read at all — a different fact from "no stock". */
  readonly error: string | null;
  /** Demo mode cannot sign or send; say so instead of failing at the wallet prompt. */
  readonly demo: boolean;
}) {
  const { t } = useT();
  const wallet = useWalletConnection();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();

  const [phase, setPhase] = useState<Phase>("choose");
  const [query, setQuery] = useState("");
  // What the list is highlighting, which is not the same as what the user has committed to:
  // browsing a price must not start a paid step.
  const [focused, setFocused] = useState<MintableProcessor | null>(processors[0] ?? null);
  const [selected, setSelected] = useState<MintableProcessor | null>(null);
  const [quote, setQuote] = useState<SelfMintQuote | null>(null);
  const [pricing, setPricing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [steps, setSteps] = useState<readonly ExecutedStep[]>([]);
  const [running, setRunning] = useState<"mint" | "tapeout" | null>(null);
  const [result, setResult] = useState<{ tokenId: string } | null>(null);

  async function choose(processor: MintableProcessor): Promise<void> {
    setSelected(processor);
    setPricing(true);
    setFailure(null);
    const priced = await priceSelfMint(processor.cpuIndex);
    setPricing(false);
    if (!priced.ok) {
      setFailure(priced.message);
      return;
    }
    setQuote(priced.quote);
    setPhase("confirm");
  }

  async function execute(): Promise<void> {
    if (quote === null || selected === null || demo) return;
    setFailure(null);
    setPhase("running");
    setSteps([]);
    try {
      const sent: ExecutedStep[] = [];
      // 1. mint — only when the quote says the wallet needs a transistor.
      const mintStep = quote.steps.find((step) => step.kind === "mint");
      if (mintStep !== undefined && mintStep.valueWei !== "0") {
        setRunning("mint");
        const hash = await sendTransactionAsync({
          account: wallet.address ?? undefined,
          to: mintStep.to as Address,
          data: mintStep.data as Hex,
          value: BigInt(mintStep.valueWei),
          chainId: 196,
        });
        await publicClient?.waitForTransactionReceipt({ hash });
        sent.push({ kind: "mint", hash });
        setSteps([...sent]);
      }

      // 2. tapeout — value must equal the fee exactly; the quote carries the fee itself.
      const tapeoutStep = quote.steps.find((step) => step.kind === "tapeout");
      if (tapeoutStep === undefined) throw new Error("quote has no tapeout step");
      setRunning("tapeout");
      const hash = await sendTransactionAsync({
        account: wallet.address ?? undefined,
        to: tapeoutStep.to as Address,
        data: tapeoutStep.data as Hex,
        value: BigInt(tapeoutStep.valueWei),
        chainId: 196,
      });
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      sent.push({ kind: "tapeout", hash });
      setSteps([...sent]);

      // 3. the REAL id comes from the event, never from `predictedTokenId`.
      const event = receipt?.logs.find((log) => log.topics[0]?.toLowerCase() === TAPED_OUT_TOPIC.toLowerCase());
      const tokenId = event?.topics[1] === undefined ? null : BigInt(event.topics[1]);
      if (tokenId === null) throw new Error("the tapeout receipt carried no TapedOut event");

      // The container is derived server-side by the prepare flow, never here — §3.2 forbids
      // this page from inventing a container address, and the opener is the only authority.
      setResult({ tokenId: tokenId.toString(10) });
      setPhase("done");
    } catch (cause) {
      // A rejected wallet prompt and a reverted transaction are different: the first left
      // nothing behind, the second may have spent gas. The message says which.
      setFailure(describeError(cause));
      setPhase("confirm");
    } finally {
      setRunning(null);
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = processors.filter((processor) => {
    if (needle === "") return true;
    // Same matching rules as the protocol's own tool: address prefix, #index, or index digits.
    if (needle.startsWith("0x")) return processor.processor.toLowerCase().startsWith(needle);
    const digits = needle.replace(/^#/, "");
    return /^[0-9]+$/.test(digits) ? String(processor.cpuIndex).startsWith(digits) : true;
  });

  return (
    <div className="mint-flow" data-testid="mint-flow">
      <ol className="mint-steps" data-testid="mint-steps">
        {(["choose", "confirm", "done"] as const).map((step, index) => (
          <li
            key={step}
            data-state={
              phase === step ? "current" : index < ["choose", "confirm", "done"].indexOf(phase) ? "done" : "todo"
            }
          >
            <span className="mint-step-index">{index + 1}</span>
            {t(`mint.step.${step}`)}
          </li>
        ))}
      </ol>

      {error === null ? null : (
        <p className="action-reason" role="alert" data-testid="mint-catalogue-error">
          {error}
        </p>
      )}

      {phase === "choose" && error === null ? (
        <section aria-labelledby="mint-choose-heading" data-testid="mint-choose">
          <div className="section-head">
            <h2 id="mint-choose-heading">{t("mint.chooseHeading")}</h2>
            <span className="panel-meta">
              {t("mint.chooseMeta", {
                shown: String(visible.length),
                count: String(processors.length),
              })}
            </span>
          </div>
          <div className="mint-browse">
            <div className="panel mint-list-panel">
              <div className="field">
                <label htmlFor="mint-search" className="visually-hidden">
                  {t("mint.searchLabel")}
                </label>
                <input
                  id="mint-search"
                  type="search"
                  value={query}
                  placeholder={t("mint.searchPlaceholder")}
                  data-testid="mint-search"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <ul className="mint-processor-list" aria-label={t("mint.chooseHeading")}>
                {visible.map((processor) => (
                  <li key={processor.cpuIndex}>
                    <button
                      type="button"
                      className="mint-processor-row"
                      data-testid={`processor-row-${String(processor.cpuIndex)}`}
                      data-selected={focused?.cpuIndex === processor.cpuIndex ? "true" : "false"}
                      aria-pressed={focused?.cpuIndex === processor.cpuIndex}
                      onClick={() => setFocused(processor)}
                    >
                      <span className="mint-processor-id">#{processor.cpuIndex}</span>
                      <span className="mint-processor-addr mono">{shortValue(processor.processor, 6, 4)}</span>
                      <span className="mint-processor-total">{formatOkb(processor.totalBeforeOpenWei)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {visible.length === 0 ? (
                <p className="field-hint" data-testid="mint-no-match">{t("mint.noMatch")}</p>
              ) : null}
            </div>

            <div className="panel mint-detail" data-testid="mint-detail">
              {focused === null ? (
                <p className="field-hint">{t("mint.pickOne")}</p>
              ) : (
                <>
                  <div className="section-head">
                    <div>
                      <h3 className="card-title">
                        #{focused.cpuIndex}
                        {processors[0]?.cpuIndex === focused.cpuIndex ? (
                          <span className="badge badge-live">{t("mint.cheapest")}</span>
                        ) : null}
                      </h3>
                      <p className="card-sub">
                        <code title={focused.processor}>{focused.processor}</code>
                      </p>
                    </div>
                    <div className="processor-total">
                      <strong data-testid="detail-total">{formatOkb(focused.totalBeforeOpenWei)}</strong>
                      <span className="field-hint">{t("mint.totalBeforeOpen")}</span>
                    </div>
                  </div>
                  <dl className="meta-grid compact">
                    <div className="meta-item">
                      <dt>{t("mint.transistorsLeft")}</dt>
                      <dd>{focused.available}</dd>
                    </div>
                    <div className="meta-item">
                      <dt>{t("mint.mintCost")}</dt>
                      <dd data-testid="detail-mint">{formatOkb(focused.mintCostWei)}</dd>
                    </div>
                    <div className="meta-item">
                      <dt>{t("mint.tapeoutFee")}</dt>
                      <dd data-testid="detail-tapeout">{formatOkb(focused.tapeoutFeeWei)}</dd>
                    </div>
                    <div className="meta-item">
                      <dt>{t("mint.predictedIdShort")}</dt>
                      <dd>#{(BigInt(focused.nextId) + 1n).toString(10)}</dd>
                    </div>
                  </dl>
                  <p className="card-foot">
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={pricing}
                      data-testid={`processor-choose-${String(focused.cpuIndex)}`}
                      onClick={() => void choose(focused)}
                    >
                      {pricing ? t("mint.pricing") : t("mint.chooseThis")}
                    </button>
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {(phase === "confirm" || phase === "running") && quote !== null && selected !== null ? (
        <section aria-labelledby="mint-confirm-heading" data-testid="mint-confirm" className="panel">
          <div className="section-head">
            <h2 id="mint-confirm-heading">{t("mint.confirmHeading")}</h2>
            <button type="button" className="button button-ghost" onClick={() => { setPhase("choose"); setQuote(null); }}>
              {t("mint.changeProcessor")}
            </button>
          </div>

          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("mint.selectedProcessor")}</dt>
              <dd>#{selected.cpuIndex}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("mint.mintCost")}</dt>
              <dd data-testid="quote-mint">{formatOkb(quote.prices.mintCostWei)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("mint.tapeoutFee")}</dt>
              <dd data-testid="quote-tapeout">{formatOkb(quote.prices.tapeoutFeeWei)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("mint.openerFee")}</dt>
              <dd data-testid="quote-opener">{formatOkb(quote.prices.openerFeeWei)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("mint.total")}</dt>
              <dd>
                <strong data-testid="quote-total">{formatOkb(quote.prices.totalWei)}</strong>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("mint.predictedIdShort")}</dt>
              <dd>#{quote.predictedTokenId}</dd>
            </div>
          </dl>

          <p className="field-hint" data-testid="quote-predicted">
            {t("mint.predictedWarning")}
          </p>
          <p className="field-hint">{t("mint.openSeparately")}</p>

          {demo ? (
            <div className="notice notice-info" data-testid="mint-demo">
              <span className="badge">{t("mint.demoBadge")}</span>
              <p>{t("mint.demoBlocked")}</p>
            </div>
          ) : (
            <WalletConnection testId="mint-wallet">
              <button
                type="button"
                className="button button-primary"
                data-testid="mint-execute"
                disabled={phase === "running" || !wallet.isConnected || wallet.wrongChain}
                onClick={() => void execute()}
              >
                {phase === "running" ? t("mint.running") : t("mint.execute")}
              </button>
            </WalletConnection>
          )}

          {steps.length > 0 ? (
            <ul className="mint-progress" data-testid="mint-progress">
              {steps.map((step) => (
                <li key={step.hash} data-state="done">
                  <span>{t(`mint.tx.${step.kind}`)}</span>
                  <code title={step.hash}>{shortValue(step.hash, 10, 8)}</code>
                </li>
              ))}
              {running === null ? null : (
                <li data-state="running">
                  <span>{t(`mint.tx.${running}`)}</span>
                  <span className="field-hint">{t("mint.waiting")}</span>
                </li>
              )}
            </ul>
          ) : null}

          {failure === null ? null : (
            <p className="action-reason" role="alert" data-testid="mint-failure">
              {failure}
            </p>
          )}
        </section>
      ) : null}

      {phase === "done" && result !== null ? (
        <section aria-labelledby="mint-done-heading" data-testid="mint-done" className="panel">
          <div className="section-head">
            <h2 id="mint-done-heading">{t("mint.doneHeading")}</h2>
            <span className="badge badge-live">{t("mint.doneBadge")}</span>
          </div>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("mint.circuitId")}</dt>
              <dd data-testid="mint-result-token">#{result.tokenId}</dd>
            </div>

          </dl>
          <p className="field-hint">{t("mint.nextOpenHint")}</p>
          <p className="button-row">
            <a
              className="button button-primary"
              data-testid="mint-next-open"
              href={`/resources/prepare?processor=${encodeURIComponent(selected?.processor ?? "")}&tokenId=${encodeURIComponent(result.tokenId)}`}
            >
              {t("mint.nextOpen")}
            </a>
            <a className="button" href="/resources">
              {t("mint.backToResources")}
            </a>
          </p>
        </section>
      ) : null}
    </div>
  );
}
