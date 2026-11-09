export interface ProjectFormValues {
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly containerAddress: string;
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
}

export type ProjectField = keyof ProjectFormValues;

export type FieldErrors = Partial<Record<ProjectField, string>>;

export interface CreateProjectResult {
  readonly ok: boolean;
  readonly message: string;
  readonly projectId: string | null;
  readonly repoFullName: string | null;
  readonly fieldErrors: FieldErrors;
}

export interface DeploymentActionCapabilities {
  readonly canApprove: boolean;
  readonly canExecute: boolean;
  readonly canRollback: boolean;
  /** §12.3: the server will accept a resume request for this attempt. */
  readonly canResume: boolean;
  /** §12.2: the server will accept a reapproval request for this attempt. */
  readonly canReapprove: boolean;
  readonly reasons: {
    readonly approve: string | null;
    readonly execute: string | null;
    readonly rollback: string | null;
    readonly resume: string | null;
    readonly reapprove: string | null;
  };
  /** Set when the server offers no action at all, so the UI can explain instead of hiding. */
  readonly blockedReason: string | null;
  /** True when the API is replaced by deterministic fixtures. */
  readonly demoMode: boolean;
  /** Approvals are EIP-712 signatures; the browser build cannot produce one yet. */
  readonly requiresSignature: boolean;
}

export type DeploymentActionKind =
  | "approve"
  | "execute"
  | "rollback"
  /** §12.3: continue an interrupted upload from the stored plan. */
  | "resume"
  /** §12.2: open a fresh approval window for the same recoverable plan. */
  | "reapprove";

export interface DeploymentActionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly deploymentId: string | null;
}
