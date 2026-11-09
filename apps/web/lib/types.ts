/**
 * JSON shapes exchanged with the P2 API (`docs/P2_API.md`).
 *
 * Big integers (wei, gas, block numbers in the database) are represented as
 * decimal strings because JSON has no bigint. Timestamps are UTC ISO strings.
 *
 * Contract gaps that the UI tolerates (and reports in the UI copy):
 * - list/detail responses are not specified beyond the route table; these types
 *   assume the natural camelCase projection of `packages/database/src/schema.ts`;
 * - `releaseFiles` and `transactions` are not separate routes, so they are
 *   expected to be embedded in `GET /v1/deployments/:id`;
 * - `releaseVerified` is an optional forward-compatible field used to distinguish
 *   Verified from Uploaded in list views without an N+1 verification request.
 */

export type Hex = `0x${string}`;

export type DeploymentState =
  | "RECEIVED"
  | "BUILDING"
  | "BUILT"
  | "VALIDATING"
  | "PLAN_READY"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "UPLOADING_ASSETS"
  | "VERIFYING_ASSETS"
  | "SWITCHING_ENTRY"
  | "VERIFYING_RELEASE"
  | "LIVE"
  | "BUILD_FAILED"
  | "PLAN_REJECTED"
  | "APPROVAL_EXPIRED"
  | "AUTH_REVOKED"
  | "OWNERSHIP_CHANGED"
  | "INSUFFICIENT_BALANCE"
  | "FEE_OVER_BUDGET"
  | "RPC_DISAGREEMENT"
  | "CHAIN_REORG_PENDING"
  | "IMPLEMENTATION_CHANGED"
  | "UPLOAD_CONFLICT"
  | "UPLOAD_INTERRUPTED"
  | "VERIFY_FAILED"
  | "SWITCH_FAILED"
  | "ROLLBACK_REQUIRED"
  | "CANCELED";

export type FileState =
  | "PENDING"
  | "UNCHANGED"
  | "WRITING"
  | "WRITTEN"
  | "VERIFIED"
  | "CONFLICT"
  | "FAILED";

export type TransactionState =
  | "PREPARED"
  | "SIGNED"
  | "BROADCAST"
  | "INCLUDED"
  | "SAFE"
  | "REPLACED"
  | "REVERTED"
  | "FAILED";

export type ActorKind = "user" | "worker" | "webhook" | "system";

export interface ProjectInstallation {
  readonly id: string;
  readonly installationId: number;
  readonly accountLogin: string;
}

export interface ContainerSummary {
  readonly address: Hex;
  readonly chainId: number;
  readonly ownerAddress: Hex | null;
  readonly registryAddress: Hex;
  /** `null` when the API response does not expose the opened flag. */
  readonly opened: boolean | null;
}

export interface Project {
  readonly id: string;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly buildCommand: string;
  readonly installCommand: string;
  readonly outputDirectory: string;
  readonly strictDewebMode: boolean;
  /** `versioned` = /releases/<id>/...; `root` = files at their own paths. */
  readonly pathMode?: "versioned" | "root";
  readonly isArchived: boolean;
  readonly organizationId?: string | null;
  readonly container: ContainerSummary;
  /** Omitted when the API response does not expose GitHub installations. */
  readonly installations?: readonly ProjectInstallation[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  /**
   * Required by POST /v1/projects in docs/P2_API.md. The wizard only knows
   * owner/repo, so this is optional here: a real API must resolve the GitHub
   * repository id through the installation (contract gap reported to the Lead).
   */
  readonly githubRepositoryId?: number;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly containerAddress: Hex;
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
}

/**
 * SPEC §12.4: four facts that are deliberately NOT collapsed into one "live" flag —
 * the chain release, the name binding, the gateway's reachability, and the URL itself.
 */
export interface PublicationSummary {
  readonly release: {
    readonly deploymentId: string;
    readonly releaseId: string;
    readonly commitSha: string;
    readonly manifestSha256: string;
    readonly entryPath: string;
    /** `null` means "not readable", never "not verified". */
    readonly verified: boolean | null;
    readonly verifiedBlockNumber: string | null;
    readonly activatedAt: string | null;
  } | null;
  readonly binding: {
    readonly state: "active" | "expired" | "inactive" | "unknown";
    readonly name: string;
    readonly paidUntil: string | null;
  } | null;
  readonly publicUrl: string | null;
  readonly gatewayCheck: "unknown" | "checking" | "reachable" | "unreachable";
  readonly checkedAt: string | null;
  /** Why a fact is missing, so the UI can explain instead of showing a blank. */
  readonly missing: readonly string[];
}

export interface Release {
  readonly id: string;
  readonly projectId?: string;
  readonly deploymentId?: string;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly manifestSha256: Hex;
  readonly entrySha256: Hex;
  readonly entryPath: string;
  readonly verifiedBlockNumber: string;
  readonly activatedAt: string;
  readonly isCurrent: boolean;
}

export interface DeploymentProjectRef {
  readonly id: string;
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

export interface DeploymentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly project: DeploymentProjectRef | null;
  readonly containerId: string;
  readonly containerAddress: Hex | null;
  readonly triggerKind: string;
  readonly commitSha: string;
  readonly state: DeploymentState;
  readonly stateVersion: number;
  readonly targetChainId: number;
  /** `null` when the API deployment DTO does not include the registry address. */
  readonly registryAddress: Hex | null;
  readonly artifactSha256: Hex | null;
  readonly manifestSha256: Hex | null;
  readonly releaseId: string | null;
  readonly entryPath: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly approvedCostCapWei: string | null;
  readonly estimatedCostWei: string | null;
  /** Optional list-payload hint; see the contract-gap note above. */
  readonly releaseVerified?: boolean;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface DeploymentDetail extends DeploymentSummary {
  /**
   * Not part of the route table in docs/P2_API.md. Omitted when the deployment
   * detail response does not embed them (the current API DTO does not).
   */
  readonly releaseFiles?: readonly ReleaseFile[];
  readonly transactions?: readonly ChainTransaction[];
}

export interface ReleaseFile {
  readonly id: string;
  readonly deploymentId: string;
  readonly targetPath: string;
  readonly sourceRelativePath: string;
  readonly sha256: Hex;
  readonly byteSize: number;
  readonly chunkCount: number;
  readonly contentType: string;
  readonly state: FileState;
  readonly lastConfirmedChunkIndex: number;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChainTransaction {
  readonly id: string;
  readonly deploymentId: string;
  readonly releaseFileId: string | null;
  readonly chainId: number;
  readonly signerAddress: Hex;
  readonly toAddress: Hex;
  readonly operation: string;
  readonly operationFingerprint: Hex;
  readonly nonce: string | null;
  readonly gasLimit: string | null;
  readonly gasUsed: string | null;
  readonly effectiveGasPriceWei: string | null;
  readonly txHash: Hex | null;
  readonly state: TransactionState;
  readonly receiptBlockNumber: string | null;
  readonly receiptBlockHash: Hex | null;
  readonly replacementFor: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeploymentEvent {
  readonly id: string;
  readonly deploymentId: string;
  readonly oldState: DeploymentState | null;
  readonly newState: DeploymentState | null;
  readonly eventType: string;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PlanTotals {
  readonly files: number;
  readonly writes: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly chunks: number;
  readonly bytes: number;
}

/** Wei values are decimal strings in the projection of the stored P1 plan JSON. */
export interface PlanFees {
  readonly gasPriceWei: string;
  readonly estimatedGas: string;
  readonly estimatedCostWei: string;
  readonly marginBps: number;
  readonly recommendedCapWei: string;
  readonly costCapWei: string | null;
  readonly withinBudget: boolean;
}

/**
 * Projection of `tapeci.plan.v1` (`packages/deployer/src/release-plan.ts`) that
 * the console renders. The stored JSON has the same fields plus per-file rows;
 * bigints arrive as strings.
 */
export interface DeploymentPlan {
  readonly schemaVersion: string;
  readonly chainId: number;
  readonly container: Hex;
  readonly siteRegistry: Hex;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly entryPath: string;
  /** Bigints are serialized as decimal strings in stored plan JSON. */
  readonly pinnedBlockNumber: number | string;
  readonly pinnedBlockHash: Hex;
  readonly operators: readonly string[];
  readonly observedAt: string;
  readonly totals: PlanTotals;
  readonly fees: PlanFees;
  readonly containerOwner: Hex | null;
  readonly containerOpened: boolean;
  readonly blocked: boolean;
  readonly blockedReasons: readonly string[];
  readonly warnings: readonly string[];
}

export type ReleaseVerificationStatus =
  | "VERIFIED"
  | "MISMATCH"
  | "DISAGREEMENT"
  | "UNSUPPORTED_IMPLEMENTATION"
  | "INCOMPLETE";

export interface VerificationFileCheck {
  readonly path: string;
  readonly sourcePath: string;
  readonly expectedSha256: Hex;
  readonly expectedSize: number;
  readonly actualSha256: Hex | null;
  readonly actualSize: number | null;
  readonly chainDeclaredSha256: Hex | null;
  readonly chainDeclaredSize: number | null;
  readonly operators: readonly string[];
  readonly operatorsAgree: boolean;
  readonly manifestDeclarationMatchesChain: boolean;
  readonly matched: boolean;
}

export interface VerificationJournalCheck {
  readonly checked: true;
  readonly deploymentId: string;
  readonly complete: boolean;
  readonly verifiedFilesMatch: boolean;
  readonly transactionsOk: boolean;
  readonly allMinedBeforePin: boolean;
  readonly entryWrittenLast: boolean | null;
  readonly transactionCount: number;
  readonly totalGasUsed: string | number;
  readonly issues: readonly string[];
}

export interface VerificationFinality {
  readonly pinnedBlockNumber: number | null;
  readonly safeBlockNumber: number | null;
  readonly finalizedBlockNumber: number | null;
  readonly pinnedBlockIsSafe: boolean | null;
  readonly pinnedBlockIsFinalized: boolean | null;
}

/** Subset of the P1-07 `ReleaseVerificationReport` that the console renders. */
export interface VerificationReport {
  readonly chainId: number;
  readonly container: Hex;
  readonly registry: Hex;
  readonly pinnedBlockNumber: number | null;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly nodeOperators: readonly string[];
  readonly registryImplementation: Hex | null;
  readonly bindingImplementation: Hex | null;
  readonly status: ReleaseVerificationStatus;
  readonly releaseStatus: ReleaseVerificationStatus;
  readonly releaseMatch: boolean;
  readonly manifest: {
    readonly chainId: number;
    readonly container: Hex;
    readonly commitSha: string;
    readonly releaseId: string;
    readonly entryPath: string;
    readonly fallbackPath: string;
    readonly artifactDigest: Hex | null;
    readonly releaseManifestHash: Hex | null;
    readonly fileCount: number;
    readonly entrySingleTransactionEligible: boolean;
  };
  readonly files: readonly VerificationFileCheck[];
  readonly journal: VerificationJournalCheck | null;
  readonly finality: VerificationFinality;
  readonly warnings: readonly string[];
}

export interface OperatorSession {
  readonly id: string;
  readonly signerAddress: Hex;
  readonly approvalId: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** `null` when the API session DTO does not expose the creation time. */
  readonly createdAt: string | null;
}

export interface ContainerDetail {
  readonly id: string;
  readonly chainId: number;
  readonly address: Hex;
  readonly ownerAddress: Hex;
  readonly factoryAddress: Hex;
  readonly processorIndex: number;
  readonly processorAddress: Hex;
  readonly tokenId: string;
  readonly openerAddress: Hex;
  readonly registryAddress: Hex;
  readonly bindingAddress: Hex;
  readonly opened: boolean;
  readonly openedAt: string | null;
  readonly lastCheckedBlock: string;
  readonly lastObservedOwner: Hex;
  readonly lastRegistryImpl: Hex | null;
  readonly lastBindingImpl: Hex | null;
  readonly operatorSessions: readonly OperatorSession[];
}

/** Activation state of one on-chain name, derived from `DomainBinding` reads. */
export type BindingState = "ACTIVE" | "NOT_ACTIVATED" | "EXPIRED";

/**
 * `GET /v1/containers/:address/binding`.
 *
 * `undefined` (not `null`) means the route is not available in this build: the
 * page then renders a neutral "status unavailable" line instead of guessing.
 */
export interface ContainerBindingStatus {
  readonly containerAddress: Hex;
  readonly bindingAddress: Hex;
  readonly name: string;
  readonly suggestedName: string;
  /** `true` when `name` came from the API record rather than from `?name=`. */
  readonly nameRecorded: boolean;
  readonly state: BindingState;
  readonly isLive: boolean;
  readonly isContainerLive: boolean;
  /** Unix seconds as a base-10 string, or `null` when nothing was ever paid. */
  readonly paidUntil: string | null;
  /** Wei per month as a base-10 string. */
  readonly monthlyFeeWei: string | null;
  /** Whether the signed-in caller may POST the bind through the API. */
  readonly canWrite: boolean;
  readonly writeBlockedReason: string | null;
  /**
   * A broadcast hash whose receipt is not known yet, or `null`.
   *
   * Optional so fixtures written before bind tracking existed still satisfy the
   * type; `undefined` is read exactly like `null` (nothing pending).
   */
  readonly pendingSubmission?: BindSubmission | null;
  /** Recorded bind attempts, newest first. Absent when the route has no tracking. */
  readonly recentEvents?: readonly BindSubmission[];
}

/**
 * One recorded `bind` attempt (§3.3). `pending` means the hash is stored and the
 * receipt is not known yet — never that the name is live.
 */
export interface BindSubmission {
  readonly txHash: Hex;
  readonly state: "pending" | "confirmed";
  readonly name: string;
  readonly months: number;
  /** Base-10 wei string; never a `number`. */
  readonly valueWei: string;
  readonly paidUntil: string | null;
  readonly blockNumber: string | null;
  readonly gasUsed: string | null;
  readonly createdAt: string;
}

export interface BindRequestInput {
  readonly name: string;
  readonly months: number;
}

/** Registration of a hash the user's own wallet broadcast (never a confirmation). */
export interface BindSubmissionInput {
  readonly name: string;
  readonly months: number;
  readonly txHash: Hex;
}

export interface BindResult {
  readonly ok: boolean;
  readonly message: string;
  readonly txHash: Hex | null;
  readonly alreadyLive: boolean;
  /**
   * `pending` when the hash is stored but no receipt was observed. Optional so
   * existing callers that only read `ok`/`txHash` keep working; absent is read as
   * "the route did not report a tracked state".
   */
  readonly state?: "pending" | "confirmed";
}

export type DeploymentSortKey = "requestedAt" | "state" | "project";

export interface DeploymentFilter {
  readonly projectId?: string;
  readonly state?: DeploymentState;
  readonly limit?: number;
  /** Server-side ordering; the mock honours these too so tests are meaningful. */
  readonly sort?: DeploymentSortKey;
  readonly dir?: "asc" | "desc";
  readonly pageSize?: number;
}


export interface GithubInstallationSummary {
  readonly id: string;
  readonly installationId: number;
  readonly accountLogin: string;
  readonly suspended: boolean;
}

export interface GithubRepositorySummary {
  readonly id: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
}


export interface ApprovalTypedData {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: Hex;
  };
  readonly types: Readonly<Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>>;
  readonly primaryType: "Approval";
  readonly message: {
    readonly deploymentId: string;
    readonly manifestHash: Hex;
    readonly container: Hex;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
  readonly approval: {
    readonly manifestHash: Hex;
    readonly container: Hex;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
  readonly expectedSigner: Hex | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly githubLogin: string;
  readonly avatarUrl: string | null;
  readonly role: "owner" | "member" | string;
  readonly createdAt: string;
  readonly source?: "direct" | "inherited";
  readonly directRole?: string | null;
  readonly inheritedRole?: string | null;
  readonly lastActivityAt?: string | null;
}

export interface AuditEventRow {
  readonly id: string;
  readonly event: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly actorLogin?: string | null;
  readonly requestId: string | null;
  /**
   * Project/organization the mutation was recorded against. Both are `null`
   * when the route carries no scoped resource (e.g. `POST /v1/projects`).
   */
  readonly projectId?: string | null;
  readonly organizationId?: string | null;
  readonly ip: string;
  readonly createdAt: string;
}

export interface WebhookDeliveryRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly ref: string | null;
  readonly commitSha: string | null;
  readonly accepted: boolean;
  readonly errorCode: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

export interface NotificationRow {
  readonly deploymentId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  readonly state: DeploymentState;
  readonly commitSha: string;
  readonly requestedAt: string;
  readonly errorCode: string | null;
  readonly readAt: string | null;
}

export interface ReleaseComparisonRow {
  readonly path: string;
  readonly status: "added" | "removed" | "changed" | "unchanged";
  readonly baseSha256: string | null;
  readonly targetSha256: string | null;
  readonly baseBytes: number | null;
  readonly targetBytes: number | null;
}

export interface ReleaseComparison {
  readonly base: { readonly releaseId: string; readonly commitSha: string; readonly manifestSha256: string };
  readonly target: { readonly releaseId: string; readonly commitSha: string; readonly manifestSha256: string };
  readonly changes: readonly ReleaseComparisonRow[];
}

/* ------------------------------------------------------------------ *
 * P3 preparation surfaces (SPEC §7.2, §7.3)
 * ------------------------------------------------------------------ */

/** One line the user must accept. Never summed into a single "total". */
export interface PreparationPrice {
  readonly kind: "acquisition" | "open" | "activation" | "service" | "gas";
  readonly currency: "OKB";
  /** `null` means the amount is not known yet — never zero. */
  readonly amountWei: string | null;
  readonly estimated: boolean;
  readonly payer: `0x${string}`;
  /** `null` for a network fee: it has no recipient to show. */
  readonly payee: `0x${string}` | null;
}

export interface PreparationQuoteStep {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: "acquisition" | "open" | "activation";
  readonly resource: { readonly chainId: 196; readonly processor: `0x${string}`; readonly tokenId: string } | null;
  readonly prices: readonly PreparationPrice[];
}

export interface PreparationQuote {
  readonly id: string;
  readonly userId: string;
  readonly recipient: `0x${string}`;
  readonly chainId: 196;
  readonly sourceId: string;
  readonly offerId: string | null;
  readonly resource: { readonly chainId: 196; readonly processor: `0x${string}`; readonly tokenId: string } | null;
  readonly steps: readonly PreparationQuoteStep[];
  readonly prices: readonly PreparationPrice[];
  readonly observedBlock: string;
  readonly expiresAt: string;
  readonly termsVersion: string;
}

export type PreparationStepState =
  | "waiting"
  | "awaiting_signature"
  | "submitted"
  | "external_pending"
  | "confirmed"
  | "skipped"
  | "failed";

export type PreparationTaskState =
  | "running"
  | "needs_action"
  | "waiting_user"
  | "completed"
  | "failed"
  | "canceled";

export interface PreparationTransactionResult {
  readonly id: string;
  readonly intentId: string;
  readonly txHash: `0x${string}` | null;
  readonly status: "submitted" | "confirmed" | "failed" | "unresolved";
  readonly blockNumber: string | null;
  readonly valueWei: string;
}

export interface PreparationStep {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: "acquisition" | "open" | "activation";
  readonly state: PreparationStepState;
  readonly resource: { readonly chainId: 196; readonly processor: `0x${string}`; readonly tokenId: string } | null;
  readonly quoteId: string;
  readonly intentId: string | null;
  readonly transactions: readonly PreparationTransactionResult[];
  readonly errorCode: string | null;
}

export interface PreparationTask {
  readonly id: string;
  readonly state: PreparationTaskState;
  readonly recipient: `0x${string}`;
  readonly chainId: 196;
  readonly initialQuoteId: string;
  readonly currentQuoteId: string;
  readonly version: number;
  readonly steps: readonly PreparationStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** §7.3 `PreparedStepAction`: the exact transaction the wallet must sign. */
export interface PreparedStepAction {
  readonly kind: "transaction";
  readonly intent: {
    readonly intentId: string;
    readonly taskId: string;
    readonly stepId: string;
    readonly quoteId: string;
    readonly chainId: 196;
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    readonly value: string;
    readonly maxValueWei: string;
    readonly data: `0x${string}`;
    readonly gasLimit: string;
    readonly gasPriceWei: string;
    readonly maxGasCostWei: string;
    readonly expiresAt: string;
  };
}

export interface ReleasePreparationRequest {
  readonly schemaVersion: "tapeci.preparation.v1";
  readonly mode: "original" | "gzip-individual" | "gzip-whole" | "gzip-grouped";
  readonly spaFallback: boolean;
  readonly gatewayId?: string;
}

/** The recorded plan's own cost lines (SPEC §15) — measurements, not a fresh estimate. */
export interface PreparationCost {
  readonly strategy: ReleasePreparationRequest["mode"];
  readonly physicalFiles: number;
  readonly writeFiles: number;
  readonly reusedFiles: number;
  readonly plannedBytes: number;
  readonly plannedChunks: number;
  readonly estimatedGas: string;
  readonly estimatedCostWei: string;
  readonly recommendedCapWei: string;
  readonly costCapWei: string;
  readonly withinBudget: boolean;
}

/**
 * Why automatic selection did or did not pick compression.
 *
 * Machine reasons, localized by the console. `cost-unknown` exists because §15 says an unknown
 * cost means original — never "free".
 */
export type AutomaticSelectionReason =
  | "gateway-not-qualified"
  | "production-simulation-required"
  | "cost-unknown"
  | "not-strictly-cheaper"
  | "strictly-cheaper";

export interface DeploymentPreparation {
  readonly request: ReleasePreparationRequest;
  readonly snapshotSha256: string | null;
  readonly manifestSha256: string | null;
  readonly canPrepare: boolean;
  readonly unavailableReason: string | null;
  readonly gateways: readonly { readonly id: string; readonly origin: string; readonly adapterSha256: string }[];
  /** `null` until the worker has produced a plan for this deployment. */
  readonly cost: PreparationCost | null;
  readonly automaticSelection: {
    readonly strategy: "original" | "compressed";
    readonly reason: AutomaticSelectionReason;
  };
  readonly quoteType: "model-estimate";
}
