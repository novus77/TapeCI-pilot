/** Pure connector-selection helpers so the wallet config is unit-testable. */

import type { MessageKey } from "./i18n";

export type WalletConnectorKind = "injected" | "walletconnect";

export interface WalletConnectorDescriptor {
  readonly id: "injected" | "walletConnect";
  readonly kind: WalletConnectorKind;
}

export function normalizeWalletConnectProjectId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function walletConnectorKinds(projectId: string | undefined): readonly WalletConnectorKind[] {
  return normalizeWalletConnectProjectId(projectId) === null
    ? ["injected"]
    : ["injected", "walletconnect"];
}

export function walletConnectorDescriptors(
  projectId: string | undefined,
): readonly WalletConnectorDescriptor[] {
  return walletConnectorKinds(projectId).map((kind) =>
    kind === "injected"
      ? { id: "injected", kind }
      : { id: "walletConnect", kind },
  );
}

/** Only the injected connector needs `window.ethereum`; WalletConnect pairs by QR. */
export function connectorRequiresInjectedProvider(connectorId: string | undefined): boolean {
  return connectorId === "injected";
}

/**
 * Whether the browser can start a connection right now.
 *
 * The presence of `window.ethereum` decides *which* connector is usable, never
 * whether the control is offered: a configured WalletConnect connector pairs by
 * QR even in a browser with no injected provider, and an injected-only setup with
 * no provider is reported as `injected-missing` instead of a silently disabled
 * button.
 */
export type WalletConnectAvailability =
  | { readonly state: "connectable"; readonly connectorId: string }
  | { readonly state: "injected-missing" }
  | { readonly state: "no-connector" };

export function walletConnectAvailability(input: {
  readonly connectorIds: readonly string[];
  readonly hasInjectedProvider: boolean;
}): WalletConnectAvailability {
  const injected = input.connectorIds.find((id) => connectorRequiresInjectedProvider(id));
  if (injected !== undefined && input.hasInjectedProvider) {
    return { state: "connectable", connectorId: injected };
  }
  const independent = input.connectorIds.find((id) => !connectorRequiresInjectedProvider(id));
  if (independent !== undefined) return { state: "connectable", connectorId: independent };
  if (injected !== undefined) return { state: "injected-missing" };
  return { state: "no-connector" };
}

/**
 * The copy that explains a non-connectable state, or `null` when the control can
 * be used. Returning an i18n key (rather than rendering nothing) is what makes a
 * missing injected wallet an explainable state instead of a dead button.
 */
export function walletAvailabilityNotice(availability: WalletConnectAvailability): MessageKey | null {
  switch (availability.state) {
    case "connectable":
      return null;
    case "injected-missing":
      return "wallet.noWalletTitle";
    case "no-connector":
      return "wallet.noConnector";
  }
}

/** `0x` + 32 bytes, lowercased, or `null` when the text is not a transaction hash. */
export function normalizeTxHash(value: string): `0x${string}` | null {
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

/**
 * Memoize an asynchronous factory so the value is created once — but drop a
 * failed attempt, so a connection error is recoverable rather than permanently
 * cached. Without this a single failed WalletConnect import leaves every later
 * attempt awaiting the same rejected promise.
 */
export function createLazyOnce<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return async () => {
    pending ??= create();
    try {
      return await pending;
    } catch (error) {
      pending = null;
      throw error;
    }
  };
}

/**
 * Copy for the bind-tracking states (§3.3), kept here rather than in `i18n.ts`
 * because that file is integrated serially by the lead.
 *
 * These are the states a bind can be in *after* a hash exists, so the wording
 * never offers a second send: a pending attempt is re-checked, not repeated.
 */
export const BIND_TRACKING_COPY = {
  en: {
    "bind.tracking.pendingTitle": "Transaction submitted, not confirmed yet",
    "bind.tracking.pendingBody":
      "The hash is recorded on the server. The receipt is not known yet, so the name is not live. Re-check before doing anything else; do not send a second bind for the same name.",
    "bind.tracking.confirmedTitle": "Transaction confirmed",
    "bind.tracking.confirmedBody":
      "The bind transaction was mined and the activation was re-read from the chain.",
    "bind.tracking.check": "Check the transaction",
    "bind.tracking.checking": "Checking…",
    "bind.tracking.notRecorded":
      "The wallet returned a hash but the server did not record it. The activation is not tracked and a refresh will lose it.",
    "bind.tracking.recorded": "Recorded on the server.",
    "bind.tracking.pendingNotice":
      "A bind transaction is already pending for this container. Check it before sending another.",
    "bind.tracking.manualHash": "Already sent? Paste the transaction hash",
    "bind.tracking.manualHashHint":
      "If the wallet broadcast a bind but this page closed before the hash came back, paste the hash to record it. The server verifies the receipt; a pasted hash never marks the name live by itself.",
    "bind.tracking.manualHashSubmit": "Record this hash",
    "bind.tracking.manualHashInvalid": "A transaction hash is 0x followed by 64 hex characters.",
    "bind.tracking.connectWallet": "Connect wallet",
    "bind.tracking.connecting": "Connecting…",
    "bind.tracking.chooseConnector": "Wallet connector",
    "bind.tracking.connectFailed": "The wallet connection failed",
    "bind.tracking.connectRetry": "Nothing was sent. Fix the cause and connect again.",
  },
  zh: {
    "bind.tracking.pendingTitle": "交易已提交，尚未确认",
    "bind.tracking.pendingBody":
      "哈希已记录在服务端，但还没有拿到回执，因此名称尚未生效。请先重新检查，不要为同一个名称再发一次 bind。",
    "bind.tracking.confirmedTitle": "交易已确认",
    "bind.tracking.confirmedBody": "bind 交易已上链，并已从链上重新读取激活状态。",
    "bind.tracking.check": "检查交易",
    "bind.tracking.checking": "正在检查…",
    "bind.tracking.notRecorded": "钱包返回了哈希，但服务端没有记录。该激活未被跟踪，刷新后会丢失。",
    "bind.tracking.recorded": "已在服务端记录。",
    "bind.tracking.pendingNotice": "该容器已有一笔待确认的 bind 交易。请先检查它，再决定是否发送。",
    "bind.tracking.manualHash": "已经发过？粘贴交易哈希",
    "bind.tracking.manualHashHint":
      "如果钱包已广播 bind，但页面在回传哈希前关闭，可粘贴哈希进行登记。回执由服务端核验；粘贴的哈希本身不会让名称生效。",
    "bind.tracking.manualHashSubmit": "登记此哈希",
    "bind.tracking.manualHashInvalid": "交易哈希为 0x 加 64 个十六进制字符。",
    "bind.tracking.connectWallet": "连接钱包",
    "bind.tracking.connecting": "正在连接…",
    "bind.tracking.chooseConnector": "钱包连接器",
    "bind.tracking.connectFailed": "钱包连接失败",
    "bind.tracking.connectRetry": "没有发送任何交易。请排除原因后重新连接。",
  },
} as const;

export type BindTrackingKey = keyof (typeof BIND_TRACKING_COPY)["en"];

/**
 * Look up bind-tracking copy. Kept separate from `translate` so the keys can be
 * folded into `i18n.ts` without changing a call site; an unknown locale falls
 * back to English rather than rendering a raw key.
 */
export function bindTrackingText(locale: string, key: BindTrackingKey): string {
  return locale === "zh" ? BIND_TRACKING_COPY.zh[key] : BIND_TRACKING_COPY.en[key];
}
