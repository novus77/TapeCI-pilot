import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
  type PgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Mirrors `schema.sql` (PostgreSQL 16) plus the P2 extension migration. */

/** `CHECK (column ~ '^0x[0-9a-f]{40}$')` for lowercase 20-byte hex addresses. */
const addressCheck = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ '^0x[0-9a-f]{40}$'`);

/** `CHECK (column ~ '^0x[0-9a-f]{64}$')` for 32-byte hex hashes. */
const hash66Check = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ '^0x[0-9a-f]{64}$'`);

/** `CHECK (column ~ '^[0-9a-f]{40}$')` for bare Git commit SHAs. */
const commitShaCheck = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ '^[0-9a-f]{40}$'`);

export const deploymentState = pgEnum("deployment_state", [
  "RECEIVED",
  "BUILDING",
  "BUILT",
  "VALIDATING",
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "UPLOADING_ASSETS",
  "VERIFYING_ASSETS",
  "SWITCHING_ENTRY",
  "VERIFYING_RELEASE",
  "LIVE",
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "CHAIN_REORG_PENDING",
  "IMPLEMENTATION_CHANGED",
  "UPLOAD_CONFLICT",
  "UPLOAD_INTERRUPTED",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
  "CANCELED",
]);

export const fileState = pgEnum("file_state", [
  "PENDING",
  "UNCHANGED",
  "WRITING",
  "WRITTEN",
  "VERIFIED",
  "CONFLICT",
  "FAILED",
]);

export const transactionState = pgEnum("transaction_state", [
  "PREPARED",
  "SIGNED",
  "BROADCAST",
  "INCLUDED",
  "SAFE",
  "REPLACED",
  "REVERTED",
  "FAILED",
]);

const address = (name: string) => varchar(name, { length: 42 });
const hash66 = (name: string) => varchar(name, { length: 66 });
const hash40 = (name: string) => varchar(name, { length: 40 });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_github_user_id_key").on(table.githubUserId)],
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    address: address("address").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wallets_user_chain_address_key").on(table.userId, table.chainId, table.address),
    check("wallets_address_check", sql`${table.address} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("github_installations_installation_id_key").on(table.installationId)],
);

export const githubInstallationUsers = pgTable(
  "github_installation_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("github_installation_users_installation_user_key").on(
      table.installationId,
      table.userId,
    ),
    index("github_installation_users_user_idx").on(table.userId, table.createdAt.desc()),
    check("github_installation_users_role_check", sql`${table.role} in ('owner','member')`),
  ],
);

export const containers = pgTable(
  "containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    factoryAddress: address("factory_address").notNull(),
    processorIndex: bigint("processor_index", { mode: "number" }).notNull(),
    processorAddress: address("processor_address").notNull(),
    tokenId: numeric("token_id", { precision: 78, scale: 0 }).notNull(),
    containerAddress: address("container_address").notNull(),
    registryAddress: address("registry_address").notNull(),
    bindingAddress: address("binding_address").notNull(),
    lastCheckedBlock: numeric("last_checked_block", { precision: 78, scale: 0 }),
    lastObservedOwner: address("last_observed_owner"),
    lastRegistryImpl: address("last_registry_impl"),
    lastBindingImpl: address("last_binding_impl"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("containers_chain_container_key").on(table.chainId, table.containerAddress),
    uniqueIndex("containers_chain_processor_token_key").on(
      table.chainId,
      table.processorAddress,
      table.tokenId,
    ),
    check("containers_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("containers_factory_address_check", table.factoryAddress),
    check("containers_processor_index_check", sql`${table.processorIndex} >= 0`),
    addressCheck("containers_processor_address_check", table.processorAddress),
    check("containers_token_id_check", sql`${table.tokenId} >= 1`),
    addressCheck("containers_container_address_check", table.containerAddress),
    addressCheck("containers_registry_address_check", table.registryAddress),
    addressCheck("containers_binding_address_check", table.bindingAddress),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
    organizationId: uuid("organization_id"),
    githubInstallationId: uuid("github_installation_id")
      .notNull()
      .references(() => githubInstallations.id),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
    repoFullName: text("repo_full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    buildCommand: text("build_command").notNull().default("npm run build"),
    installCommand: text("install_command").notNull().default("npm ci"),
    outputDirectory: text("output_directory").notNull().default("dist"),
    containerId: uuid("container_id").notNull().references(() => containers.id),
    strictDewebMode: boolean("strict_deweb_mode").notNull().default(true),
    /** `versioned` = /releases/<id>/... (default); `root` = files at their own paths. */
    pathMode: text("path_mode").notNull().default("versioned"),
    /** §11.2 admission switch: false until an explicit, readiness-gated enable. */
    buildEnabled: boolean("build_enabled").notNull().default(false),
    /** §11.3 saved console config revision a build attempt was dispatched with. */
    configVersion: integer("config_version").notNull().default(1),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_repo_branch_container_key").on(
      table.githubRepositoryId,
      table.defaultBranch,
      table.containerId,
    ),
    check("projects_config_version_check", sql`${table.configVersion} >= 1`),
  ],
);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL means the grant never expires. Expired grants stop granting access at read time. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const organizationBudgets = pgTable("organization_budgets", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  monthlyCapWei: numeric("monthly_cap_wei", { precision: 78, scale: 0 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL means the grant never expires. Expired grants stop granting access at read time. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("project_members_project_user_key").on(table.projectId, table.userId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubDeliveryId: text("github_delivery_id").notNull(),
    githubInstallationNumericId: bigint("github_installation_numeric_id", { mode: "number" }),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    eventType: text("event_type").notNull(),
    ref: text("ref"),
    commitSha: hash40("commit_sha"),
    accepted: boolean("accepted").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorCode: text("error_code"),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_github_delivery_id_key").on(table.githubDeliveryId),
    check(
      "webhook_deliveries_commit_sha_check",
      sql`${table.commitSha} is null or ${table.commitSha} ~ '^[0-9a-f]{40}$'`,
    ),
  ],
);

export const projectBudgets = pgTable("project_budgets", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  monthlyCapWei: numeric("monthly_cap_wei", { precision: 78, scale: 0 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const approvalPolicies = pgTable("approval_policies", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  requiredRole: text("required_role").notNull().default("owner"),
  maxCostCapWei: numeric("max_cost_cap_wei", { precision: 78, scale: 0 }),
  expiresInSeconds: integer("expires_in_seconds").notNull().default(900),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deploymentNotificationReads = pgTable(
  "deployment_notification_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deploymentId] })],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    event: text("event").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    githubLogin: text("github_login"),
    method: text("method").notNull(),
    route: text("route").notNull(),
    path: text("path"),
    status: integer("status").notNull(),
    ip: text("ip").notNull(),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_created_idx").on(table.createdAt.desc()),
    index("audit_events_actor_idx").on(table.actorUserId, table.createdAt.desc()),
    index("audit_events_project_idx").on(table.projectId, table.createdAt.desc()),
    index("audit_events_organization_idx").on(table.organizationId, table.createdAt.desc()),
    check("audit_events_status_check", sql`${table.status} between 100 and 599`),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    containerId: uuid("container_id").notNull().references(() => containers.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    webhookDeliveryId: uuid("webhook_delivery_id").references(() => webhookDeliveries.id),
    rollbackTargetReleaseId: uuid("rollback_target_release_id").references((): AnyPgColumn => releases.id),
    idempotencyKey: text("idempotency_key"),
    sourceEventKey: text("source_event_key"),
    triggerKind: text("trigger_kind").notNull(),
    commitSha: hash40("commit_sha").notNull(),
    state: deploymentState("state").notNull().default("RECEIVED"),
    stateVersion: bigint("state_version", { mode: "number" }).notNull().default(0),
    targetChainId: bigint("target_chain_id", { mode: "number" }).notNull().default(196),
    registryAddress: address("registry_address").notNull(),
    artifactSha256: hash66("artifact_sha256"),
    artifactStorageKey: text("artifact_storage_key"),
    preparation_request: jsonb(),
    prepared_artifact_key: text(),
    manifestSha256: hash66("manifest_sha256"),
    planJson: jsonb("plan_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    approvedCostCapWei: numeric("approved_cost_cap_wei", { precision: 78, scale: 0 }),
    estimatedCostWei: numeric("estimated_cost_wei", { precision: 78, scale: 0 }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * §12.2: what a reapproved deployment needs to resume rather than re-plan — the
     * original plan summary, the journal identity and the recovery stage. It must
     * survive `AWAITING_APPROVAL → APPROVED`, because re-planning against half-written
     * resources is the `UPLOAD_CONFLICT` the spec forbids. Nullable: a deployment that
     * never entered recovery has none.
     */
    recoveryContext: jsonb("recovery_context"),
  },
  (table) => [
    uniqueIndex("deployments_project_idempotency_key").on(table.projectId, table.idempotencyKey),
    uniqueIndex("deployments_source_event_key").on(table.sourceEventKey),
    uniqueIndex("deployments_webhook_delivery_id_key").on(table.webhookDeliveryId),
    uniqueIndex("deployments_one_chain_writer_per_container")
      .on(table.containerId)
      .where(
        sql`${table.state} in ('APPROVED','UPLOADING_ASSETS','VERIFYING_ASSETS','SWITCHING_ENTRY','VERIFYING_RELEASE')`,
      ),
    check("deployments_prepared_artifact_key_check", sql`${table.prepared_artifact_key} is null or ${table.prepared_artifact_key} ~ '^sha256/[0-9a-f]{64}\\.tar$'`),
    index("deployments_project_created_idx").on(table.projectId, table.requestedAt.desc()),
    index("deployments_state_idx").on(table.state, table.requestedAt),
    check("deployments_trigger_kind_check", sql`${table.triggerKind} in ('webhook','manual','rollback')`),
    commitShaCheck("deployments_commit_sha_check", table.commitSha),
    check("deployments_state_version_check", sql`${table.stateVersion} >= 0`),
    check("deployments_chain_check", sql`${table.targetChainId} = 196`),
    check(
      "deployments_approved_cost_cap_check",
      sql`${table.approvedCostCapWei} is null or ${table.approvedCostCapWei} >= 0`,
    ),
    check(
      "deployments_estimated_cost_check",
      sql`${table.estimatedCostWei} is null or ${table.estimatedCostWei} >= 0`,
    ),
  ],
);

export const releaseFiles = pgTable(
  "release_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    targetPath: text("target_path").notNull(),
    sourceRelativePath: text("source_relative_path").notNull(),
    sha256: hash66("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    contentType: text("content_type").notNull(),
    state: fileState("state").notNull().default("PENDING"),
    lastConfirmedChunkIndex: integer("last_confirmed_chunk_index").notNull().default(-1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("release_files_deployment_path_key").on(table.deploymentId, table.targetPath),
    check("release_files_target_path_check", sql`length(${table.targetPath}) > 0`),
    check("release_files_size_check", sql`${table.byteSize} between 0 and 8400000`),
    check("release_files_chunks_check", sql`${table.chunkCount} between 1 and 350`),
    check(
      "release_files_chunk_progress_check",
      sql`${table.lastConfirmedChunkIndex} < ${table.chunkCount}`,
    ),
    hash66Check("release_files_sha_check", table.sha256),
  ],
);

export const chainTransactions = pgTable(
  "chain_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    releaseFileId: uuid("release_file_id").references(() => releaseFiles.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(196),
    signerAddress: address("signer_address").notNull(),
    toAddress: address("to_address").notNull(),
    operation: text("operation").notNull(),
    operationFingerprint: hash66("operation_fingerprint").notNull(),
    nonce: numeric("nonce", { precision: 78, scale: 0 }),
    gasLimit: numeric("gas_limit", { precision: 78, scale: 0 }),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    effectiveGasPriceWei: numeric("effective_gas_price_wei", { precision: 78, scale: 0 }),
    txHash: hash66("tx_hash"),
    state: transactionState("state").notNull().default("PREPARED"),
    receiptBlockNumber: numeric("receipt_block_number", { precision: 78, scale: 0 }),
    receiptBlockHash: hash66("receipt_block_hash"),
    replacementFor: uuid("replacement_for").references((): AnyPgColumn => chainTransactions.id),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chain_transactions_chain_tx_hash_key").on(table.chainId, table.txHash),
    uniqueIndex("chain_transactions_deployment_fingerprint_nonce_key").on(
      table.deploymentId,
      table.operationFingerprint,
      table.nonce,
    ),
    index("chain_transactions_deployment_idx").on(table.deploymentId, table.createdAt),
    index("chain_transactions_signer_nonce_idx").on(
      table.chainId,
      table.signerAddress,
      table.nonce,
    ),
    check("chain_transactions_chain_id_check", sql`${table.chainId} = 196`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    signerAddress: address("signer_address").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(196),
    manifestSha256: hash66("manifest_sha256").notNull(),
    approvalDigest: hash66("approval_digest").notNull(),
    signature: text("signature").notNull(),
    approvedCostCapWei: numeric("approved_cost_cap_wei", { precision: 78, scale: 0 }).notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("approvals_approval_digest_key").on(table.approvalDigest),
    uniqueIndex("approvals_nonce_key").on(table.nonce),
    check("approvals_cost_cap_check", sql`${table.approvedCostCapWei} >= 0`),
  ],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    releaseId: text("release_id").notNull(),
    commitSha: hash40("commit_sha").notNull(),
    manifestSha256: hash66("manifest_sha256").notNull(),
    entrySha256: hash66("entry_sha256").notNull(),
    entryPath: text("entry_path").notNull().default("index.html"),
    verifyReport: jsonb("verify_report").notNull(),
    verifiedBlockNumber: numeric("verified_block_number", { precision: 78, scale: 0 }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    isCurrent: boolean("is_current").notNull().default(false),
  },
  (table) => [
    uniqueIndex("releases_deployment_id_key").on(table.deploymentId),
    uniqueIndex("releases_project_release_id_key").on(table.projectId, table.releaseId),
    uniqueIndex("releases_one_current_per_project")
      .on(table.projectId)
      .where(sql`${table.isCurrent} = true`),
  ],
);

export const deploymentEvents = pgTable(
  "deployment_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    oldState: deploymentState("old_state"),
    newState: deploymentState("new_state"),
    eventType: text("event_type").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("deployment_events_by_job_idx").on(table.deploymentId, table.id),
    check(
      "deployment_events_actor_kind_check",
      sql`${table.actorKind} in ('user','worker','webhook','system')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// P2 extension tables (migration 0002)
// ---------------------------------------------------------------------------

export const walletChallenges = pgTable(
  "wallet_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: address("address").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(196),
    nonce: text("nonce").notNull(),
    message: text("message").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wallet_challenges_nonce_key").on(table.nonce),
    index("wallet_challenges_address_idx").on(table.address, table.createdAt.desc()),
    addressCheck("wallet_challenges_address_check", table.address),
  ],
);

export const buildTokens = pgTable(
  "build_tokens",
  {
    jti: uuid("jti").primaryKey(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    commitSha: hash40("commit_sha").notNull(),
    ref: text("ref").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("build_tokens_deployment_idx").on(table.deploymentId),
    commitShaCheck("build_tokens_commit_sha_check", table.commitSha),
  ],
);

export const artifactUploads = pgTable(
  "artifact_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    objectKey: text("object_key").notNull(),
    sha256: hash66("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("artifact_uploads_object_key_key").on(table.objectKey),
    index("artifact_uploads_deployment_idx").on(table.deploymentId),
    hash66Check("artifact_uploads_sha_check", table.sha256),
    check("artifact_uploads_size_check", sql`${table.sizeBytes} >= 0`),
  ],
);

export const operatorSessions = pgTable(
  "operator_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    containerId: uuid("container_id").notNull().references(() => containers.id),
    signerAddress: address("signer_address").notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("operator_sessions_container_idx").on(table.containerId, table.expiresAt),
    index("operator_sessions_signer_idx").on(table.signerAddress),
    addressCheck("operator_sessions_signer_address_check", table.signerAddress),
  ],
);

/**
 * On-chain actions TapeCI itself sent for a container (today: `DomainBinding.bind`).
 * The unique `tx_hash` makes a retried request idempotent at the storage layer.
 */
export const containerEvents = pgTable(
  "container_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    containerId: uuid("container_id").notNull().references(() => containers.id),
    chainId: bigint("chain_id", { mode: "number" }).notNull().default(196),
    containerAddress: address("container_address").notNull(),
    bindingAddress: address("binding_address").notNull(),
    eventType: text("event_type").notNull(),
    name: text("name").notNull(),
    nameHash: hash66("name_hash").notNull(),
    months: integer("months").notNull(),
    valueWei: numeric("value_wei", { precision: 78, scale: 0 }).notNull(),
    txHash: hash66("tx_hash").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    paidUntil: timestamp("paid_until", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("container_events_tx_hash_key").on(table.txHash),
    index("container_events_container_idx").on(table.containerId, table.createdAt.desc()),
    index("container_events_name_idx").on(table.containerAddress, table.name),
    check("container_events_event_type_check", sql`${table.eventType} in ('bind')`),
    check("container_events_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("container_events_container_address_check", table.containerAddress),
    addressCheck("container_events_binding_address_check", table.bindingAddress),
    hash66Check("container_events_name_hash_check", table.nameHash),
    hash66Check("container_events_tx_hash_check", table.txHash),
    check("container_events_months_check", sql`${table.months} between 1 and 120`),
    check("container_events_value_check", sql`${table.valueWei} >= 0`),
    check("container_events_block_check", sql`${table.blockNumber} >= 0`),
  ],
);

/**
 * Index-wide scan state, one row per chain (SPEC §8.3–§8.4). `origin_block` is the trusted
 * scan origin from ops; without it no range can be proven covered, so completeness is
 * `origin_block + one checkpoint per catalogue processor`, derived by
 * `readResourceIndexSnapshot` rather than stored as a second, staleable boolean.
 * `syncing` is persisted so a page served by another process can still say "syncing".
 */
export const resourceIndexState = pgTable(
  "resource_index_state",
  {
    chainId: bigint("chain_id", { mode: "number" }).primaryKey(),
    /** Trusted scan origin; NULL means it has not been configured/committed yet. */
    originBlock: numeric("origin_block", { precision: 78, scale: 0 }),
    syncing: boolean("syncing").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("resource_index_state_chain_id_check", sql`${table.chainId} = 196`),
    check(
      "resource_index_state_origin_block_check",
      sql`${table.originBlock} is null or ${table.originBlock} >= 0`,
    ),
  ],
);

/**
 * Per-processor coverage of the verified Transfer-log scan (SPEC §6, §8.3–§8.4, §8.8).
 * A row exists only after at least one chunk was folded in, and it always carries the block
 * hash, so restart can prove the checkpoint is still canonical before resuming. A failed or
 * rate-limited page never advances `through_block`: a shorter covered range is "partial",
 * never "this address owns nothing".
 */
export const resourceIndexCheckpoints = pgTable(
  "resource_index_checkpoints",
  {
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    processorAddress: address("processor_address").notNull(),
    factoryAddress: address("factory_address").notNull(),
    processorIndex: bigint("processor_index", { mode: "number" }).notNull(),
    /** Start of the stored range; normally `resource_index_state.origin_block`. */
    fromBlock: numeric("from_block", { precision: 78, scale: 0 }).notNull(),
    /** Last block covered contiguously. */
    throughBlock: numeric("through_block", { precision: 78, scale: 0 }).notNull(),
    /** Hash of `through_block`, used to detect a canonical-chain change on restart (§8.8). */
    throughBlockHash: hash66("through_block_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.processorAddress] }),
    index("resource_index_checkpoints_catalog_idx").on(table.chainId, table.processorIndex),
    check("resource_index_checkpoints_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("resource_index_checkpoints_factory_address_check", table.factoryAddress),
    check("resource_index_checkpoints_processor_index_check", sql`${table.processorIndex} >= 0`),
    addressCheck("resource_index_checkpoints_processor_address_check", table.processorAddress),
    check(
      "resource_index_checkpoints_blocks_check",
      sql`${table.fromBlock} >= 0 and ${table.throughBlock} >= ${table.fromBlock}`,
    ),
    hash66Check("resource_index_checkpoints_through_block_hash_check", table.throughBlockHash),
  ],
);

/**
 * Public chain projection of a discovered resource. `token_id` is a 78-digit decimal string:
 * tokenIds exceed 2^53, so it is numeric here and a string at every API boundary (§2, §5).
 */
export const walletResources = pgTable(
  "wallet_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    processorIndex: bigint("processor_index", { mode: "number" }).notNull(),
    processorAddress: address("processor_address").notNull(),
    tokenId: numeric("token_id", { precision: 78, scale: 0 }).notNull(),
    /** Derived container snapshot; §3.1 always re-reads it before use, never trusts this row. */
    containerAddress: address("container_address"),
    ownerAddress: address("owner_address"),
    deployed: boolean("deployed"),
    opened: boolean("opened"),
    /**
     * verified | unavailable | not_found | unverified. `unverified` is a candidate folded from
     * Transfer logs: its owner is known at `observed_block`, but deployed/opened have not been
     * read, so they stay NULL. Only `verified` carries boolean facts; a failed read must never
     * become `false` (§8.6, §5).
     */
    readStatus: text("read_status").notNull().default("unverified"),
    /** Block the owner was observed at, and (when verified) the block the read was pinned to. */
    observedBlock: numeric("observed_block", { precision: 78, scale: 0 }),
    observedBlockHash: hash66("observed_block_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wallet_resources_chain_processor_token_key").on(
      table.chainId,
      table.processorAddress,
      table.tokenId,
    ),
    // Public page: every resource of one address, paginated by processor then tokenId.
    index("wallet_resources_owner_idx").on(
      table.chainId,
      table.ownerAddress,
      table.processorAddress,
      table.tokenId,
    ),
    check("wallet_resources_chain_id_check", sql`${table.chainId} = 196`),
    check("wallet_resources_processor_index_check", sql`${table.processorIndex} >= 0`),
    addressCheck("wallet_resources_processor_address_check", table.processorAddress),
    // Token 0 is a legal asset key and query (§5, §6, P0-04). `containers_token_id_check`
    // still requires >= 1 and is deliberately NOT altered by this migration; this table only
    // indexes observed chain data, so it needs its own >= 0 constraint to represent token 0.
    check("wallet_resources_token_id_check", sql`${table.tokenId} >= 0`),
    addressCheck("wallet_resources_container_address_check", table.containerAddress),
    addressCheck("wallet_resources_owner_address_check", table.ownerAddress),
    check(
      "wallet_resources_read_status_check",
      sql`${table.readStatus} in ('verified','unavailable','not_found','unverified')`,
    ),
    check(
      "wallet_resources_observed_block_check",
      sql`${table.observedBlock} is null or ${table.observedBlock} >= 0`,
    ),
    hash66Check("wallet_resources_observed_block_hash_check", table.observedBlockHash),
    // Only a verified row may carry deployed/opened booleans: an unverified or failed read
    // leaves them NULL, never false (§8.6).
    check(
      "wallet_resources_fact_status_check",
      sql`${table.readStatus} = 'verified' or (${table.deployed} is null and ${table.opened} is null)`,
    ),
    // A verified row is a pinned-block read: it must name the block and both boolean facts.
    check(
      "wallet_resources_verified_read_check",
      sql`${table.readStatus} <> 'verified' or (${table.observedBlock} is not null and ${table.deployed} is not null and ${table.opened} is not null)`,
    ),
    // "Not found" is an explicit pinned chain answer, not a gap.
    check(
      "wallet_resources_not_found_read_check",
      sql`${table.readStatus} <> 'not_found' or ${table.observedBlock} is not null`,
    ),
  ],
);

/**
 * Immutable final quote (SPEC §5, §6, §7.2). A re-quote inserts a new row; no row is ever
 * updated, which is what keeps every already-confirmed step attached to its original price.
 */
export const resourceQuotes = pgTable(
  "resource_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** Verified delivery wallet; a quote never changes recipient (§9.3). */
    recipientAddress: address("recipient_address").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    /** Verified offer source or the built-in `open` source; never a user input (§7.2). */
    sourceId: text("source_id").notNull(),
    offerId: text("offer_id"),
    resourceSnapshot: jsonb("resource_snapshot"),
    /** Preparation options (prepareContainer, activateName, months, name); compared on requote. */
    options: jsonb("options").notNull(),
    stepsSnapshot: jsonb("steps_snapshot").notNull(),
    pricesSnapshot: jsonb("prices_snapshot").notNull(),
    observedBlock: numeric("observed_block", { precision: 78, scale: 0 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Opaque terms revision the user accepted; compared, never parsed as a number (§5). */
    termsVersion: text("terms_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("resource_quotes_user_created_idx").on(table.userId, table.createdAt.desc()),
    check("resource_quotes_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("resource_quotes_recipient_address_check", table.recipientAddress),
    check("resource_quotes_source_id_check", sql`length(${table.sourceId}) > 0`),
    check("resource_quotes_terms_version_check", sql`length(${table.termsVersion}) > 0`),
    // Acquisition and an existing resource are mutually exclusive: exactly one is priced (§7.2).
    check(
      "resource_quotes_offer_or_resource_check",
      sql`(${table.offerId} is null) <> (${table.resourceSnapshot} is null)`,
    ),
    check(
      "resource_quotes_resource_snapshot_check",
      sql`${table.resourceSnapshot} is null or jsonb_typeof(${table.resourceSnapshot}) = 'object'`,
    ),
    check("resource_quotes_options_check", sql`jsonb_typeof(${table.options}) = 'object'`),
    check(
      "resource_quotes_steps_snapshot_check",
      sql`jsonb_typeof(${table.stepsSnapshot}) = 'array' and jsonb_array_length(${table.stepsSnapshot}) > 0`,
    ),
    check(
      "resource_quotes_prices_snapshot_check",
      sql`jsonb_typeof(${table.pricesSnapshot}) = 'array'`,
    ),
    check("resource_quotes_observed_block_check", sql`${table.observedBlock} >= 0`),
    check("resource_quotes_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/**
 * Preparation task (SPEC §5, §6, §7.3). `version` is the optimistic-concurrency token: every
 * mutation is `UPDATE ... WHERE id = $1 AND version = $expectedVersion` and increments it, so
 * two concurrent confirmations cannot both create a paid intent. `idempotency_key` is unique per
 * user; a replay compares `request_digest` and returns the same task, a different digest is 409.
 */
export const provisioningTasks = pgTable(
  "provisioning_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** Immutable; a requote may not move the delivery wallet (§9.3). */
    recipientAddress: address("recipient_address").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    initialQuoteId: uuid("initial_quote_id").notNull().references(() => resourceQuotes.id),
    currentQuoteId: uuid("current_quote_id").notNull().references(() => resourceQuotes.id),
    idempotencyKey: text("idempotency_key").notNull(),
    /** SHA-256 over quoteId, recipient, chain and options; never a digest of the raw header. */
    requestDigest: hash66("request_digest").notNull(),
    /** waiting_user | running | needs_action | completed | canceled (SPEC §5). */
    state: text("state").notNull().default("waiting_user"),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provisioning_tasks_user_idempotency_key").on(table.userId, table.idempotencyKey),
    index("provisioning_tasks_user_created_idx").on(table.userId, table.createdAt.desc()),
    // Worker recovery: every task that may still need reconciliation (§3.3).
    index("provisioning_tasks_unfinished_idx")
      .on(table.state, table.updatedAt)
      .where(sql`${table.state} not in ('completed','canceled')`),
    check(
      "provisioning_tasks_state_check",
      sql`${table.state} in ('waiting_user','running','needs_action','completed','canceled')`,
    ),
    check("provisioning_tasks_version_check", sql`${table.version} >= 0`),
    check("provisioning_tasks_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("provisioning_tasks_recipient_address_check", table.recipientAddress),
    check(
      "provisioning_tasks_idempotency_key_check",
      sql`length(${table.idempotencyKey}) between 1 and 255`,
    ),
    hash66Check("provisioning_tasks_request_digest_check", table.requestDigest),
  ],
);

/** Every accepted quote revision, including the initial one; acceptance is append-only. */
export const provisioningQuoteAcceptances = pgTable(
  "provisioning_quote_acceptances",
  {
    taskId: uuid("task_id").notNull().references(() => provisioningTasks.id),
    quoteId: uuid("quote_id").notNull().references(() => resourceQuotes.id),
    acceptedBy: uuid("accepted_by").notNull().references(() => users.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.quoteId] }),
    index("provisioning_quote_acceptances_quote_idx").on(table.quoteId),
  ],
);

/** One ordered step of a preparation task (SPEC §5, §6, §9.1). */
export const provisioningSteps = pgTable(
  "provisioning_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => provisioningTasks.id),
    ordinal: integer("ordinal").notNull(),
    /** acquisition | open | activation. */
    kind: text("kind").notNull(),
    /** waiting | awaiting_signature | submitted | external_pending | confirmed | failed | skipped. */
    state: text("state").notNull().default("waiting"),
    quoteId: uuid("quote_id").notNull().references(() => resourceQuotes.id),
    /** Resource the step expects; NULL until an acquisition resolves its tokenId (§9.3). */
    expectedResource: jsonb("expected_resource"),
    /** Resource actually delivered/found: the verified outcome, not the expectation. */
    resolvedResource: jsonb("resolved_resource"),
    externalSourceId: text("external_source_id"),
    externalReference: text("external_reference"),
    /** Per-step CAS token for conditional state updates, mirroring the task's. */
    version: bigint("version", { mode: "number" }).notNull().default(0),
    /** Machine code (localized by the page); never provider prose (§5). */
    errorCode: text("error_code"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provisioning_steps_task_ordinal_key").on(table.taskId, table.ordinal),
    // Redundant with the PK, but PostgreSQL requires a unique constraint/index over the exact
    // referenced columns for the composite FK in provisioning_transactions (step_id, task_id).
    uniqueIndex("provisioning_steps_id_task_key").on(table.id, table.taskId),
    // One verified external order (source + reference) may not back two steps (§6).
    uniqueIndex("provisioning_steps_external_reference_key")
      .on(table.externalSourceId, table.externalReference)
      .where(sql`${table.externalSourceId} is not null and ${table.externalReference} is not null`),
    // Reconciler: steps whose sending/external outcome is still unresolved (§3.3, §9.1).
    index("provisioning_steps_unresolved_idx")
      .on(table.state, table.updatedAt)
      .where(sql`${table.state} in ('submitted','external_pending')`),
    check("provisioning_steps_ordinal_check", sql`${table.ordinal} >= 0`),
    check("provisioning_steps_version_check", sql`${table.version} >= 0`),
    check("provisioning_steps_kind_check", sql`${table.kind} in ('acquisition','open','activation')`),
    check(
      "provisioning_steps_state_check",
      sql`${table.state} in ('waiting','awaiting_signature','submitted','external_pending','confirmed','failed','skipped')`,
    ),
    check(
      "provisioning_steps_expected_resource_check",
      sql`${table.expectedResource} is null or jsonb_typeof(${table.expectedResource}) = 'object'`,
    ),
    check(
      "provisioning_steps_resolved_resource_check",
      sql`${table.resolvedResource} is null or jsonb_typeof(${table.resolvedResource}) = 'object'`,
    ),
    // A source without a reference (or vice versa) can never be verified against a provider.
    check(
      "provisioning_steps_external_pair_check",
      sql`(${table.externalSourceId} is null) = (${table.externalReference} is null)`,
    ),
    check(
      "provisioning_steps_external_pending_check",
      sql`${table.state} <> 'external_pending' or (${table.externalSourceId} is not null and ${table.externalReference} is not null)`,
    ),
  ],
);

/**
 * A saved send intent and its observed outcome (SPEC §6, §7.3, §9.1–9.2). The row is written
 * before the wallet is asked to sign, so `tx_hash` is NULL until the wallet returns a hash; a
 * broadcast-lost window stays `unresolved` and can later be matched to a recovered hash. A
 * replacement attempt is a new row with the same `intent_id`, `replacement_for` pointing at the
 * attempt it superseded (same sender/nonce), and the superseded row marked `replaced`.
 */
export const provisioningTransactions = pgTable(
  "provisioning_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => provisioningTasks.id),
    stepId: uuid("step_id").notNull(),
    quoteId: uuid("quote_id").notNull().references(() => resourceQuotes.id),
    /** Logical intent id returned as `PreparedStepTransaction.intentId`; stable across replacements. */
    intentId: uuid("intent_id").notNull(),
    chainId: bigint("chain_id", { mode: "number" }).notNull(),
    sender: address("sender").notNull(),
    target: address("target").notNull(),
    valueWei: numeric("value_wei", { precision: 78, scale: 0 }).notNull(),
    calldata: text("calldata").notNull(),
    gasLimit: numeric("gas_limit", { precision: 78, scale: 0 }).notNull(),
    gasPriceWei: numeric("gas_price_wei", { precision: 78, scale: 0 }).notNull(),
    maxGasCostWei: numeric("max_gas_cost_wei", { precision: 78, scale: 0 }).notNull(),
    /** SHA-256 of the intent's canonical fields, re-checked against the chain tx (§9.2). */
    expectedDigest: hash66("expected_digest").notNull(),
    nonce: numeric("nonce", { precision: 78, scale: 0 }),
    txHash: hash66("tx_hash"),
    replacementFor: uuid("replacement_for"),
    /** prepared | submitted | confirmed | failed | replaced | unresolved. */
    status: text("status").notNull().default("prepared"),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }),
    blockHash: hash66("block_hash"),
    gasUsed: numeric("gas_used", { precision: 78, scale: 0 }),
    effectiveGasPriceWei: numeric("effective_gas_price_wei", { precision: 78, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A hash identifies one attempt on one chain; NULL (not broadcast yet) is unconstrained.
    uniqueIndex("provisioning_transactions_chain_tx_hash_key").on(table.chainId, table.txHash),
    // An intent has exactly one root attempt, and that intent id is globally unique, so the
    // same intent cannot become a root in another task. A replacement row is excluded here but
    // must point (below) at an attempt with the same task and intent.
    uniqueIndex("provisioning_transactions_intent_root_key")
      .on(table.intentId)
      .where(sql`${table.replacementFor} is null`),
    // Referenced columns for the replacement self-FK: a replacement may only supersede an
    // attempt of the same task and the same intent (§6).
    uniqueIndex("provisioning_transactions_id_task_intent_key").on(
      table.id,
      table.taskId,
      table.intentId,
    ),
    // At most one unresolved sending intent per step (§6). A replacement first marks the
    // superseded row `replaced`, which is outside this predicate, then inserts the new attempt.
    uniqueIndex("provisioning_transactions_live_intent_key")
      .on(table.stepId)
      .where(sql`${table.status} in ('prepared','submitted','unresolved')`),
    index("provisioning_transactions_step_idx").on(table.stepId, table.createdAt),
    index("provisioning_transactions_sender_nonce_idx").on(
      table.chainId,
      table.sender,
      table.nonce,
    ),
    // Reconciler: attempts whose outcome still has to be verified (§3.3).
    index("provisioning_transactions_unresolved_idx")
      .on(table.status, table.updatedAt)
      .where(sql`${table.status} in ('submitted','unresolved')`),
    // `step_id` + `task_id` must name a real step of THIS task. The composite FK makes the
    // attribution structural, so a transaction cannot be moved to another task's step.
    foreignKey({
      name: "provisioning_transactions_step_task_fk",
      columns: [table.stepId, table.taskId],
      foreignColumns: [provisioningSteps.id, provisioningSteps.taskId],
    }),
    // A replacement must supersede an attempt of the same task and the same intent. Combined
    // with the single-root index, this is what forbids cross-task intent attribution (§6).
    foreignKey({
      name: "provisioning_transactions_replacement_fk",
      columns: [table.replacementFor, table.taskId, table.intentId],
      foreignColumns: [table.id, table.taskId, table.intentId],
    }),
    check("provisioning_transactions_chain_id_check", sql`${table.chainId} = 196`),
    addressCheck("provisioning_transactions_sender_check", table.sender),
    addressCheck("provisioning_transactions_target_check", table.target),
    check("provisioning_transactions_value_check", sql`${table.valueWei} >= 0`),
    check(
      "provisioning_transactions_calldata_check",
      sql`${table.calldata} ~ '^0x([0-9a-f]{2})*$'`,
    ),
    check(
      "provisioning_transactions_gas_check",
      sql`${table.gasLimit} > 0 and ${table.gasPriceWei} >= 0 and ${table.maxGasCostWei} >= ${table.gasLimit} * ${table.gasPriceWei}`,
    ),
    check("provisioning_transactions_nonce_check", sql`${table.nonce} is null or ${table.nonce} >= 0`),
    hash66Check("provisioning_transactions_expected_digest_check", table.expectedDigest),
    hash66Check("provisioning_transactions_tx_hash_check", table.txHash),
    hash66Check("provisioning_transactions_block_hash_check", table.blockHash),
    check(
      "provisioning_transactions_status_check",
      sql`${table.status} in ('prepared','submitted','confirmed','failed','replaced','unresolved')`,
    ),
    // A prepared intent has no hash; every broadcast attempt except a lost-hash one must.
    check(
      "provisioning_transactions_prepared_hash_check",
      sql`${table.status} <> 'prepared' or ${table.txHash} is null`,
    ),
    check(
      "provisioning_transactions_broadcast_hash_check",
      sql`${table.status} in ('prepared','unresolved') or ${table.txHash} is not null`,
    ),
    // Confirmation needs the receipt facts a canonical-chain check reads (§9.2).
    check(
      "provisioning_transactions_confirmed_receipt_check",
      sql`${table.status} <> 'confirmed' or (${table.blockNumber} is not null and ${table.blockHash} is not null and ${table.gasUsed} is not null)`,
    ),
    check(
      "provisioning_transactions_receipt_values_check",
      sql`(${table.blockNumber} is null or ${table.blockNumber} >= 0) and (${table.gasUsed} is null or ${table.gasUsed} >= 0) and (${table.effectiveGasPriceWei} is null or ${table.effectiveGasPriceWei} >= 0)`,
    ),
    check(
      "provisioning_transactions_replacement_check",
      sql`${table.replacementFor} is null or ${table.replacementFor} <> ${table.id}`,
    ),
  ],
);

/**
 * A not-yet-finalised project (SPEC §11.1–§11.2). It stores the resource key
 * `(chainId, processor, tokenId)` and deliberately has no container address: the container
 * is derived from that key at finalisation and is never accepted as client input (P0-06).
 * While a draft lives there is no `projects` row, so a push cannot resolve it to an
 * admitted project, a build attempt or a build token (AC-P4-01).
 */
export const projectDrafts = pgTable(
  "project_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** A draft is owned by its creator; project roles do not exist until it finalises. */
    ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
    /**
     * Organization the finished project will belong to. Nullable because a personal
     * project is legitimate; set, it scopes the draft to that org so an org user is
     * not surprised by a project appearing outside their organization (issue P4-08).
     */
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    githubInstallationId: uuid("github_installation_id")
      .notNull()
      .references(() => githubInstallations.id),
    /** GitHub's immutable repository id; the display name may be renamed/transferred. */
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
    repoFullName: text("repo_full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    installCommand: text("install_command").notNull().default("npm ci"),
    buildCommand: text("build_command").notNull().default("npm run build"),
    outputDirectory: text("output_directory").notNull().default("dist"),
    /** `versioned` (default) or `root`; `root` is only storable with an acknowledgement. */
    pathMode: text("path_mode").notNull().default("versioned"),
    /** Which acknowledgement text version was read, and by whom/when (§11.1 step 4). */
    rootPathAcknowledgedAt: timestamp("root_path_acknowledged_at", { withTimezone: true }),
    rootPathAcknowledgedBy: uuid("root_path_acknowledged_by").references(() => users.id),
    rootPathAckVersion: text("root_path_ack_version"),
    /** Asset key (§2); all NULL until a circuit is attached. No container address column. */
    chainId: bigint("chain_id", { mode: "number" }),
    processorAddress: address("processor_address"),
    tokenId: numeric("token_id", { precision: 78, scale: 0 }),
    state: text("state").notNull().default("draft"),
    /**
     * §15.1 CAS: a draft update must name the version it read, so a stale PATCH cannot
     * silently overwrite another tab's save. Bumped on every successful update.
     */
    version: integer("version").notNull().default(1),
    /** Set only with `state = 'finalized'`; the promotion evidence is the projects row. */
    finalizedProjectId: uuid("finalized_project_id").references(() => projects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("project_drafts_owner_idx").on(table.ownerUserId, table.updatedAt.desc()),
    // A project is the promotion of at most one draft; NULLs (open drafts) are not compared.
    uniqueIndex("project_drafts_finalized_project_key").on(table.finalizedProjectId),
    check(
      "project_drafts_repo_full_name_check",
      sql`${table.repoFullName} ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'`,
    ),
    check("project_drafts_github_repository_id_check", sql`${table.githubRepositoryId} > 0`),
    check(
      "project_drafts_default_branch_check",
      sql`length(${table.defaultBranch}) between 1 and 255`,
    ),
    check(
      "project_drafts_commands_check",
      sql`length(${table.installCommand}) between 1 and 1024 and length(${table.buildCommand}) between 1 and 1024`,
    ),
    // Canonical relative directory: no absolute/trailing slash, no `..` or empty segment
    // and no backslash. The API applies the same rule before the row is written.
    check(
      "project_drafts_output_directory_check",
      sql`length(${table.outputDirectory}) between 1 and 1024 and ${table.outputDirectory} !~ '(^/)|(^|/)\\.\\.(/|$)|(//)|(/$)' and strpos(${table.outputDirectory}, E'\\\\') = 0`,
    ),
    check("project_drafts_path_mode_check", sql`${table.pathMode} in ('versioned','root')`),
    // §11.1: root mode is only storable after the overwrite/rollback difference was read.
    check(
      "project_drafts_root_ack_check",
      sql`${table.pathMode} <> 'root' or (${table.rootPathAcknowledgedAt} is not null and ${table.rootPathAcknowledgedBy} is not null and ${table.rootPathAckVersion} is not null)`,
    ),
    check(
      "project_drafts_root_ack_version_check",
      sql`${table.rootPathAckVersion} is null or length(${table.rootPathAckVersion}) between 1 and 64`,
    ),
    // A partial key is not a key: attach all of (chain, processor, tokenId) or none.
    check(
      "project_drafts_resource_key_check",
      sql`((${table.chainId} is null) = (${table.processorAddress} is null)) and ((${table.processorAddress} is null) = (${table.tokenId} is null))`,
    ),
    check("project_drafts_chain_id_check", sql`${table.chainId} is null or ${table.chainId} = 196`),
    addressCheck("project_drafts_processor_address_check", table.processorAddress),
    // `containers_token_id_check` requires >= 1 (P0-04); token 0 cannot back a project.
    check("project_drafts_token_id_check", sql`${table.tokenId} is null or ${table.tokenId} >= 1`),
    check("project_drafts_state_check", sql`${table.state} in ('draft','finalized')`),
    check(
      "project_drafts_finalized_check",
      sql`(${table.state} = 'finalized') = (${table.finalizedProjectId} is not null)`,
    ),
    check("project_drafts_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

/**
 * One dispatch of one deployment (SPEC §11.3). The row is written *before* GitHub is
 * called, so `state = 'planned'` is the save-before-dispatch record. `commitSha`
 * (the source built) and `workflowCommitSha` (the workflow that actually ran) are two
 * independent identities stored in two columns and never derived from one another
 * (AC-P4-14). `configSnapshot` is per attempt so an in-flight build keeps serving its
 * own configuration after a console edit (AC-P4-10).
 */
export const buildAttempts = pgTable(
  "build_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id),
    attempt: integer("attempt").notNull(),
    /** The attempt this one retries; a retry is a new attempt, never a webhook replay. */
    retryOf: uuid("retry_of").references((): AnyPgColumn => buildAttempts.id),
    /** Target source revision, chosen by the user and never rewritten from a run claim. */
    commitSha: hash40("commit_sha").notNull(),
    /** Workflow revision that actually runs; a different identity from `commit_sha`. */
    workflowCommitSha: hash40("workflow_commit_sha").notNull(),
    /** Correlation id passed to the dispatched workflow; not an auth credential alone. */
    dispatchCorrelationId: text("dispatch_correlation_id").notNull(),
    configVersion: integer("config_version").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    state: text("state").notNull().default("planned"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("build_attempts_deployment_attempt_key").on(table.deploymentId, table.attempt),
    uniqueIndex("build_attempts_dispatch_correlation_key").on(table.dispatchCorrelationId),
    index("build_attempts_retry_idx").on(table.retryOf),
    index("build_attempts_commit_idx").on(table.commitSha, table.createdAt.desc()),
    check("build_attempts_attempt_check", sql`${table.attempt} >= 1`),
    check(
      "build_attempts_retry_check",
      sql`${table.retryOf} is null or ${table.retryOf} <> ${table.id}`,
    ),
    commitShaCheck("build_attempts_commit_sha_check", table.commitSha),
    commitShaCheck("build_attempts_workflow_commit_sha_check", table.workflowCommitSha),
    check(
      "build_attempts_dispatch_correlation_check",
      sql`length(${table.dispatchCorrelationId}) between 1 and 255`,
    ),
    check("build_attempts_config_version_check", sql`${table.configVersion} >= 1`),
    check(
      "build_attempts_config_snapshot_check",
      sql`jsonb_typeof(${table.configSnapshot}) = 'object'`,
    ),
    check(
      "build_attempts_state_check",
      sql`${table.state} in ('planned','dispatched','running','dispatch_unknown','succeeded','failed','canceled')`,
    ),
    // Terminal attempts carry their finish time; live ones cannot claim one.
    check(
      "build_attempts_terminal_check",
      sql`(${table.state} in ('succeeded','failed','canceled')) = (${table.finishedAt} is not null)`,
    ),
    check(
      "build_attempts_finished_check",
      sql`${table.finishedAt} is null or ${table.finishedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type WalletChallenge = typeof walletChallenges.$inferSelect;
export type ArtifactUpload = typeof artifactUploads.$inferSelect;
export type OperatorSession = typeof operatorSessions.$inferSelect;
export type DeploymentEvent = typeof deploymentEvents.$inferSelect;
export type ResourceIndexState = typeof resourceIndexState.$inferSelect;
export type ResourceIndexCheckpoint = typeof resourceIndexCheckpoints.$inferSelect;
export type WalletResource = typeof walletResources.$inferSelect;
export type ResourceQuote = typeof resourceQuotes.$inferSelect;
export type ProvisioningTask = typeof provisioningTasks.$inferSelect;
export type ProvisioningQuoteAcceptance = typeof provisioningQuoteAcceptances.$inferSelect;
export type ProvisioningStep = typeof provisioningSteps.$inferSelect;
export type ProvisioningTransaction = typeof provisioningTransactions.$inferSelect;
export type ProjectDraft = typeof projectDrafts.$inferSelect;
export type BuildAttempt = typeof buildAttempts.$inferSelect;
