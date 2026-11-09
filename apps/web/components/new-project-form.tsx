"use client";

import { FeedbackButton } from "./motion-feedback";

import Link from "next/link";
import { useEffect, useState, useTransition, type ChangeEvent, type FormEvent } from "react";

import { createProjectAction, loadInstallationRepositoriesAction } from "@/app/actions";
import type {
  CreateProjectResult,
  FieldErrors,
  ProjectField,
  ProjectFormValues,
} from "@/lib/action-types";
import type { MessageKey } from "@/lib/i18n";
import type { GithubInstallationSummary, GithubRepositorySummary } from "@/lib/types";
import { hasFieldErrors, localizeValidationMessage, validateProjectForm } from "@/lib/validation";

import { useT } from "./locale-provider";
import { EmptyState, RiskNotice } from "./risk-notice";

interface FieldConfig {
  readonly field: ProjectField;
  readonly step: 0 | 1;
  readonly placeholder: string;
  readonly hint: MessageKey;
}

const FIELD_CONFIGS: readonly FieldConfig[] = [
  {
    field: "repoFullName",
    step: 0,
    placeholder: "tapeoutprotocol/tapekit-site",
    hint: "new.repoHint",
  },
  {
    field: "defaultBranch",
    step: 0,
    placeholder: "main",
    hint: "new.branchHint",
  },
  {
    field: "containerAddress",
    step: 1,
    placeholder: "0x1f0a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c",
    hint: "new.containerHint",
  },
  {
    field: "installCommand",
    step: 1,
    placeholder: "npm ci",
    hint: "new.installHint",
  },
  {
    field: "buildCommand",
    step: 1,
    placeholder: "npm run build",
    hint: "new.buildHint",
  },
  {
    field: "outputDirectory",
    step: 1,
    placeholder: "dist",
    hint: "new.outputHint",
  },
];

const FIELD_ORDER: readonly ProjectField[] = [
  "repoFullName",
  "defaultBranch",
  "containerAddress",
  "installCommand",
  "buildCommand",
  "outputDirectory",
];

/** Field labels come from the dictionary; `new.*` covers every project field. */
const FIELD_LABEL_KEYS: Readonly<Record<ProjectField, MessageKey>> = {
  repoFullName: "new.repo",
  defaultBranch: "new.branch",
  containerAddress: "new.container",
  installCommand: "new.install",
  buildCommand: "new.build",
  outputDirectory: "new.output",
};

/**
 * The step titles double as React keys, so the English fallback stays here even
 * when a dictionary key exists. `titleKey` is null where the dictionary has no
 * entry for the compound title ("Container & build").
 */
const STEP_CONFIGS: readonly { readonly title: string; readonly titleKey: MessageKey | null }[] = [
  { title: "Repository", titleKey: "new.repo" },
  { title: "Container & build", titleKey: "new.containerBuild" },
];

const INITIAL_VALUES: ProjectFormValues = {
  repoFullName: "",
  defaultBranch: "main",
  containerAddress: "",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
};

function pickErrors(all: FieldErrors, fields: readonly ProjectField[]): FieldErrors {
  const picked: FieldErrors = {};
  for (const field of fields) {
    const message = all[field];
    if (message !== undefined) picked[field] = message;
  }
  return picked;
}

function fieldsForStep(step: number): readonly ProjectField[] {
  return FIELD_CONFIGS.filter((config) => config.step === step).map((config) => config.field);
}

export function NewProjectForm({
  demoMode,
  installations = [],
  installUrl,
}: {
  readonly demoMode: boolean;
  readonly installations?: readonly GithubInstallationSummary[];
  readonly installUrl?: string;
}) {
  const { locale, t } = useT();
  const [step, setStep] = useState<0 | 1>(0);
  const [values, setValues] = useState<ProjectFormValues>(INITIAL_VALUES);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<CreateProjectResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [repositories, setRepositories] = useState<readonly GithubRepositorySummary[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [repositoriesPending, startRepositoriesTransition] = useTransition();

  useEffect(() => {
    if (demoMode || installationId === "") return;
    let cancelled = false;
    startRepositoriesTransition(async () => {
      const result = await loadInstallationRepositoriesAction(installationId);
      if (cancelled) return;
      if (result.ok) {
        setRepositories(result.repositories);
        setRepositoryError(null);
      } else {
        setRepositories([]);
        setRepositoryError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [demoMode, installationId]);

  function updateField(field: ProjectField) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      if (field === "repoFullName") setSelectedRepositoryId(null);
      setValues((current) => ({ ...current, [field]: value }));
      setErrors((current) => {
        if (current[field] === undefined) return current;
        const next: FieldErrors = { ...current };
        delete next[field];
        return next;
      });
    };
  }

  function handleProviderRepositoryChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = Number(event.target.value);
    const repository = repositories.find((candidate) => candidate.id === value);
    if (repository === undefined) {
      setSelectedRepositoryId(null);
      return;
    }
    setSelectedRepositoryId(repository.id);
    setValues((current) => ({
      ...current,
      repoFullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
    }));
  }

  function focusFirst(fieldErrors: FieldErrors) {
    const first = FIELD_ORDER.find((field) => fieldErrors[field] !== undefined);
    if (first === undefined) return;
    window.setTimeout(() => {
      document.getElementById(`project-${first}`)?.focus();
    }, 0);
  }

  function handleNext() {
    const nextErrors = pickErrors(validateProjectForm(values), fieldsForStep(step));
    setErrors(nextErrors);
    if (hasFieldErrors(nextErrors)) {
      focusFirst(nextErrors);
      return;
    }
    setStep(1);
  }

  function handleBack() {
    setErrors((current) => pickErrors(current, fieldsForStep(0)));
    setStep(0);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const allErrors = validateProjectForm(values);
    setErrors(allErrors);
    if (hasFieldErrors(allErrors)) {
      const first = FIELD_ORDER.find((field) => allErrors[field] !== undefined);
      if (first !== undefined) {
        const config = FIELD_CONFIGS.find((candidate) => candidate.field === first);
        if (config !== undefined) setStep(config.step);
      }
      focusFirst(allErrors);
      return;
    }
    startTransition(async () => {
      const next = await createProjectAction(values, selectedRepositoryId ?? undefined);
      setResult(next);
      if (!next.ok) setErrors(next.fieldErrors);
    });
  }

  function reset() {
    setValues(INITIAL_VALUES);
    setErrors({});
    setResult(null);
    setStep(0);
  }

  const stepTitle = (index: number): string => {
    const config = STEP_CONFIGS[index];
    if (config === undefined) return "";
    return config.titleKey === null ? config.title : t(config.titleKey);
  };

  if (result !== null && result.ok && result.projectId !== null) {
    return (
      <section className="panel panel-success" data-testid="project-created">
        <h2>{t("new.projectCreated")}</h2>
        <p className="panel-copy">{result.message}</p>
        <dl className="meta-grid">
          <div className="meta-item">
            <dt>{t("new.repo")}</dt>
            <dd>{result.repoFullName}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("new.projectId")}</dt>
            <dd className="mono">{result.projectId}</dd>
          </div>
        </dl>
        <p className="panel-copy">{t("console.pathHandoff")}</p>
        <div className="button-row">
          <Link className="button" href={`/projects/${result.projectId}/settings`}>{t("console.configureProject")}</Link>
          <Link className="button button-primary" href={`/projects/${result.projectId}`}>
            {t("home.openProject")}
          </Link>
          <FeedbackButton type="button" className="button" onClick={reset}>
            {t("new.another")}
          </FeedbackButton>
        </div>
      </section>
    );
  }

  const visibleConfigs = FIELD_CONFIGS.filter((config) => config.step === step);
  const visibleFields = visibleConfigs.map((config) => config.field);
  const visibleErrors = FIELD_ORDER.filter(
    (field) => visibleFields.includes(field) && errors[field] !== undefined,
  );

  return (
    <form className="wizard" onSubmit={handleSubmit} noValidate>
      <ol className="wizard-steps" aria-label={t("new.progress")}>
        {STEP_CONFIGS.map((config, index) => (
          <li
            key={config.title}
            className={index === step ? "wizard-step is-current" : "wizard-step"}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="wizard-index" aria-hidden="true">
              {index + 1}
            </span>
            <span>{stepTitle(index === 0 ? 0 : 1)}</span>
          </li>
        ))}
      </ol>

      {demoMode ? (
        <RiskNotice tone="info" title={t("demo.title")}>
          <p>
            {t("new.demoBody")}
          </p>
        </RiskNotice>
      ) : null}

      {result !== null && !result.ok ? (
        <RiskNotice tone="critical" title={t("new.failed")}>
          <p>{result.message}</p>
        </RiskNotice>
      ) : null}

      {visibleErrors.length > 0 ? (
        <div className="error-summary" role="alert">
          <p className="error-summary-title">
            {t("new.fixFields", { count: visibleErrors.length })}
          </p>
          <ul>
            {visibleErrors.map((field) => (
              <li key={field}>
                <a href={`#project-${field}`}>
                  {t(FIELD_LABEL_KEYS[field])}: {localizeValidationMessage(errors[field], locale)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!demoMode && step === 0 ? (
        <div className="repo-picker">
          {installations.length === 0 ? (
            <RiskNotice tone="warning" title={t("new.installMissing")}>
              <p>
                {t("new.installPrompt")}{" "}
                {installUrl === undefined ? null : (
                  <a href={installUrl}>{t("new.installOnGithub")}</a>
                )}
              </p>
            </RiskNotice>
          ) : (
            <>
              <div className="field">
                <label htmlFor="project-installation">{t("new.githubInstallation")}</label>
                <select
                  id="project-installation"
                  value={installationId}
                  onChange={(event) => {
                    setInstallationId(event.target.value);
                    setSelectedRepositoryId(null);
                    setRepositories([]);
                  }}
                >
                  {installations.map((installation) => (
                    <option key={installation.id} value={installation.id}>
                      {installation.accountLogin}
                      {installation.suspended ? ` (${t("new.suspended")})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="project-repository">{t("new.repo")}</label>
                <select
                  id="project-repository"
                  value={selectedRepositoryId ?? ""}
                  onChange={handleProviderRepositoryChange}
                  disabled={repositoriesPending || repositories.length === 0}
                >
                  <option value="">
                    {repositoriesPending ? t("common.loading") : t("new.selectRepo")}
                  </option>
                  {repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.fullName}
                      {repository.private ? ` (${t("new.private")})` : ""}
                      {repository.archived ? ` (${t("new.archived")})` : ""}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {t("new.repoAuto")}
                </p>
                {repositoryError === null ? null : (
                  <p className="field-error" role="alert">
                    {repositoryError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      <fieldset className="form-fieldset">
        <legend>{stepTitle(step)}</legend>
        {visibleConfigs.map((config) => {
          const field = config.field;
          const error = errors[field];
          const errorId = `project-${field}-error`;
          const hintId = `project-${field}-hint`;
          return (
            <div className="field" key={field}>
              <label htmlFor={`project-${field}`}>{t(FIELD_LABEL_KEYS[field])}</label>
              <input
                id={`project-${field}`}
                name={field}
                type="text"
                value={values[field]}
                onChange={updateField(field)}
                placeholder={config.placeholder}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
              />
              <p className="field-hint" id={hintId}>
                {t(config.hint)}
              </p>
              {error === undefined ? null : (
                <p className="field-error" id={errorId} role="alert">
                  {localizeValidationMessage(error, locale)}
                </p>
              )}
            </div>
          );
        })}
      </fieldset>

      {step === 1 ? <p className="panel-copy">{t("console.pathHandoff")}</p> : null}
      <div className="button-row">
        {step === 1 ? (
          <FeedbackButton type="button" className="button" onClick={handleBack} disabled={isPending}>
            {t("new.back")}
          </FeedbackButton>
        ) : null}
        {step === 0 ? (
          <FeedbackButton type="button" className="button button-primary" onClick={handleNext}>
            {t("new.continue")}
          </FeedbackButton>
        ) : (
          <FeedbackButton type="submit" className="button button-primary" busy={isPending} disabled={isPending}>
            {isPending ? t("new.creating") : t("new.submit")}
          </FeedbackButton>
        )}
      </div>

      {step === 0 ? (
        <EmptyState
          title={t("new.what")}
          message={t("new.nextBody")}
        />
      ) : null}
    </form>
  );
}
