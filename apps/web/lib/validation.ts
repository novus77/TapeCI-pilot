import { messages, translate, type Locale, type MessageKey } from "./i18n";
import type { FieldErrors, ProjectField, ProjectFormValues } from "./action-types";

export const PROJECT_FIELD_LABELS: Readonly<Record<ProjectField, string>> = {
  repoFullName: "Repository",
  defaultBranch: "Branch",
  containerAddress: "Container address",
  installCommand: "Install command",
  buildCommand: "Build command",
  outputDirectory: "Output directory",
};

export const PROJECT_FIELDS: readonly ProjectField[] = [
  "repoFullName",
  "defaultBranch",
  "containerAddress",
  "installCommand",
  "buildCommand",
  "outputDirectory",
];

const COMMAND_LIMIT = 300;
const PATH_LIMIT = 120;

function trimmed(value: string): string {
  return value.trim();
}

function validateRepo(value: string): string | null {
  if (value.length === 0) return "Enter a GitHub repository as owner/repo.";
  const parts = value.split("/");
  if (parts.length !== 2) return "Use exactly one slash: owner/repo.";
  const [owner, repo] = parts;
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return "Both the owner and the repository name are required.";
  }
  const allowed = /^[A-Za-z0-9_.-]+$/;
  if (!allowed.test(owner) || !allowed.test(repo)) {
    return "Only letters, digits, dot, dash and underscore are allowed.";
  }
  if (owner.startsWith(".") || repo.startsWith(".")) return "Repository segments cannot start with a dot.";
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return "Invalid repository name.";
  if (value.length > 140) return "Repository name is too long.";
  return null;
}

function validateBranch(value: string): string | null {
  if (value.length === 0) return "Enter the branch that triggers releases.";
  if (value.length > 120) return "Branch name is too long.";
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    return "Use letters, digits, dot, dash, underscore or slash.";
  }
  if (value.startsWith("/") || value.startsWith("-") || value.startsWith(".")) {
    return "The branch cannot start with /, - or .";
  }
  if (value.endsWith("/") || value.endsWith(".") || value.includes("//")) {
    return "The branch cannot end with / or . or contain //.";
  }
  if (value.includes("..")) return "The branch cannot contain ..";
  return null;
}

function validateAddress(value: string): string | null {
  if (value.length === 0) return "Enter the X Layer container address.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return "Enter a 20-byte hex address: 0x followed by 40 hex characters.";
  }
  return null;
}

function validateCommand(value: string, label: string): string | null {
  const command = trimmed(value);
  if (command.length === 0) return `${label} is required.`;
  if (command.length > COMMAND_LIMIT) return `${label} must be at most ${COMMAND_LIMIT} characters.`;
  if (/[\r\n]/.test(command)) return `${label} must be a single line.`;
  return null;
}

function validateOutputDirectory(value: string): string | null {
  const path = trimmed(value);
  if (path.length === 0) return "Enter the build output directory.";
  if (path.length > PATH_LIMIT) return `Output directory must be at most ${PATH_LIMIT} characters.`;
  if (path.startsWith("/") || path.startsWith("\\")) return "Use a path relative to the repository root.";
  if (path.includes("\\")) return "Use forward slashes in the output path.";
  if (path.split("/").includes("..")) return "The output path cannot contain ..";
  if (/^[A-Za-z]:/.test(path)) return "Use a path relative to the repository root.";
  return null;
}

/** Shared by the client form (instant feedback) and the server action (authority). */
export function validateProjectForm(values: ProjectFormValues): FieldErrors {
  const errors: FieldErrors = {};
  const repoError = validateRepo(trimmed(values.repoFullName));
  if (repoError !== null) errors.repoFullName = repoError;
  const branchError = validateBranch(trimmed(values.defaultBranch));
  if (branchError !== null) errors.defaultBranch = branchError;
  const addressError = validateAddress(trimmed(values.containerAddress));
  if (addressError !== null) errors.containerAddress = addressError;
  const installError = validateCommand(values.installCommand, "Install command");
  if (installError !== null) errors.installCommand = installError;
  const buildError = validateCommand(values.buildCommand, "Build command");
  if (buildError !== null) errors.buildCommand = buildError;
  const outputError = validateOutputDirectory(values.outputDirectory);
  if (outputError !== null) errors.outputDirectory = outputError;
  return errors;
}

export function normalizeProjectValues(values: ProjectFormValues): ProjectFormValues {
  return {
    repoFullName: trimmed(values.repoFullName),
    defaultBranch: trimmed(values.defaultBranch),
    containerAddress: trimmed(values.containerAddress),
    installCommand: trimmed(values.installCommand),
    buildCommand: trimmed(values.buildCommand),
    outputDirectory: trimmed(values.outputDirectory),
  };
}

export function hasFieldErrors(errors: FieldErrors): boolean {
  return PROJECT_FIELDS.some((field) => errors[field] !== undefined);
}

/** Localize known validation errors while preserving unknown server diagnostics verbatim. */
export function localizeValidationMessage(message: string | undefined, locale: Locale): string {
  if (message === undefined) return "";
  const key = (Object.keys(messages.en) as MessageKey[]).find((candidate) => candidate.startsWith("validation.") && messages.en[candidate] === message);
  return key === undefined ? message : translate(locale, key);
}
