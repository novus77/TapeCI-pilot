import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, parse } from "yaml";

const read = (path: string): string => readFileSync(path, "utf8");

describe("production deployment baseline", () => {
  it("never tracks the populated production env file", () => {
    const ignores = read(".gitignore");
    // Line-anchored: the negation line contains the substring "infra/env.prod".
    expect(ignores).toMatch(/^infra\/env\.prod$/m);
    expect(ignores).toMatch(/^!infra\/env\.prod\.example$/m);
    const ignored = execFileSync("git", ["check-ignore", "infra/env.prod"], { encoding: "utf8" });
    expect(ignored.trim()).toBe("infra/env.prod");
    const dockerignore = read(".dockerignore");
    // Line-anchored: "infra/env.prod" is a substring of "!infra/env.prod.example",
    // so a plain toContain would pass even when the rule is missing.
    expect(dockerignore).toMatch(/^infra\/env\.prod$/m);
    expect(dockerignore).toMatch(/^infra\/\*\.env\.prod$/m);
  });

  it("ships non-root, healthchecked images for api, worker and web", () => {
    for (const image of ["infra/Dockerfile.api", "infra/Dockerfile.worker", "infra/Dockerfile.web"]) {
      expect(existsSync(image), image).toBe(true);
      const text = read(image);
      expect(text).toContain("USER node");
      expect(text).toContain("HEALTHCHECK");
      expect(text).not.toMatch(/PRIVATE KEY|BEGIN RSA/);
    }
    const apiImage = read("infra/Dockerfile.api");
    expect(apiImage).toContain("scripts/p2/ensure-bucket.ts");
    const web = read("infra/Dockerfile.web");
    expect(web).toContain("ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID");
    expect(web).toContain("WORKDIR /app/apps/web");
    expect(read("infra/env.prod.example")).toContain("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=");
    const worker = read("infra/Dockerfile.worker");
    expect(worker).toContain("/healthz");
  });

  it("defines the production compose stack and passes docker compose config", () => {
    const compose = read("infra/docker-compose.prod.yml");
    const parsed = parse(compose) as { services: Record<string, unknown> };
    for (const service of ["postgres", "redis", "minio", "api", "worker", "web", "prometheus", "grafana"]) {
      expect(parsed.services[service], `missing service ${service}`).toBeDefined();
    }
    expect(compose).not.toContain("privileged: true");
    // MinIO is pinned to an immutable digest (the official public image is gone).
    expect(compose).toMatch(/image: pgsty\/minio:RELEASE\.[^\s]+@sha256:[0-9a-f]{64}/);
    if (execFileSync("bash", ["-lc", "command -v docker || true"], { encoding: "utf8" }).trim() === "") return;
    execFileSync(
      "docker",
      ["compose", "-f", "infra/docker-compose.prod.yml", "config", "-q"],
      { env: { ...process.env }, stdio: "pipe" },
    );
    expect(compose).toContain("../ops/prometheus/prometheus.yml");
    // Line-anchored: "./ops" is a substring of "../ops".
    expect(compose).not.toMatch(/^\s*-\s+\.\/ops\//m);
    // minio/minio was withdrawn from Docker Hub and quay.io; the stack must not
    // point at an image that cannot be pulled.
    expect(compose).not.toMatch(/^\s+image:\s+minio\/minio:/m);
    // The header must tell operators to use --env-file; a plain `env_file:` is
    // silently overridden by the `environment:` block and would ignore env.prod.
    expect(compose).toContain("--env-file");
  });

  it("--env-file values actually reach api/worker (environment: would hide them)", () => {
    // Regression: Compose interpolation does not read a service's `env_file:`,
    // and `environment:` wins over `env_file:` at run time. So a user's real
    // DATABASE_URL / S3_ENDPOINT in infra/env.prod was silently replaced by the
    // defaults here, with `config` still exiting 0. Only --env-file works.
    if (execFileSync("bash", ["-lc", "command -v docker || true"], { encoding: "utf8" }).trim() === "") return;
    const dir = mkdtempSync(join(tmpdir(), "tapeci-envfile-"));
    try {
      const envFile = join(dir, "env.prod");
      writeFileSync(
        envFile,
        [
          "POSTGRES_PASSWORD=RealPass123",
          "DATABASE_URL=postgres://real:pass@managed.example.com:5432/tapeci",
          "S3_ENDPOINT=https://real.r2.example.com",
          "S3_BUCKET=real-bucket",
        ].join("\n"),
      );
      const env = { ...process.env };
      for (const key of ["DATABASE_URL", "POSTGRES_PASSWORD", "S3_ENDPOINT", "S3_BUCKET"]) delete env[key];
      const rendered = parse(
        execFileSync(
          "docker",
          ["compose", "--env-file", envFile, "-f", "infra/docker-compose.prod.yml", "config"],
          { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        ),
      ) as { services: Record<string, { environment?: Record<string, string> }> };
      for (const service of ["api", "worker"]) {
        const serviceEnv = rendered.services[service]?.environment ?? {};
        expect(serviceEnv["DATABASE_URL"], `${service} DATABASE_URL`).toBe(
          "postgres://real:pass@managed.example.com:5432/tapeci",
        );
        expect(serviceEnv["S3_ENDPOINT"], `${service} S3_ENDPOINT`).toBe(
          "https://real.r2.example.com",
        );
        expect(serviceEnv["S3_BUCKET"], `${service} S3_BUCKET`).toBe("real-bucket");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("api/worker DATABASE_URL password matches what postgres is configured with", () => {
    // Regression: `postgres://u:${POSTGRES_PASSWORD}@h/db` nested inside a default
    // does not inherit the `:-change-me` default of POSTGRES_PASSWORD itself. With
    // no env set, Postgres got "change-me" while the API got an EMPTY password,
    // and `docker compose config` still exited 0.
    if (execFileSync("bash", ["-lc", "command -v docker || true"], { encoding: "utf8" }).trim() === "") return;
    const base = { ...process.env };
    delete base["POSTGRES_PASSWORD"];
    delete base["DATABASE_URL"];

    const resolved = parse(
      execFileSync("docker", ["compose", "-f", "infra/docker-compose.prod.yml", "config"], {
        env: base,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ) as { services: Record<string, { environment?: Record<string, string> }> };

    const password = resolved.services["postgres"]?.environment?.["POSTGRES_PASSWORD"] ?? "";
    expect(password, "postgres password must have a default").not.toBe("");
    for (const service of ["api", "worker"]) {
      const url = resolved.services[service]?.environment?.["DATABASE_URL"] ?? "";
      expect(url, `${service} DATABASE_URL`).toContain(`:${password}@`);
      expect(url, `${service} DATABASE_URL must not carry an empty password`).not.toMatch(/:@/);
    }

    // An explicitly supplied password must win in both places.
    const explicit = parse(
      execFileSync("docker", ["compose", "-f", "infra/docker-compose.prod.yml", "config"], {
        env: { ...base, POSTGRES_PASSWORD: "s3cret-value" },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(explicit.services["postgres"]?.environment?.["POSTGRES_PASSWORD"]).toBe("s3cret-value");
    for (const service of ["api", "worker"]) {
      expect(explicit.services[service]?.environment?.["DATABASE_URL"]).toContain(
        "postgres://tapeci:s3cret-value@",
      );
    }
  });

  it("Kubernetes workloads are hardened, probed and budgeted", () => {
    const documents = readdirSync("ops/k8s")
      .filter((name) => name.endsWith(".yaml"))
      .flatMap((name) => parseAllDocuments(read(`ops/k8s/${name}`)))
      .map((document) => document.toJS() as Record<string, unknown>)
      .filter((document) => document !== null && typeof document === "object");
    const deployments = documents.filter((document) => document["kind"] === "Deployment");
    expect(deployments).toHaveLength(3);
    for (const deployment of deployments) {
      const spec = deployment["spec"] as { template: { spec: { securityContext?: Record<string, unknown>; containers: Array<Record<string, unknown>> } } };
      expect(spec.template.spec.securityContext?.["runAsNonRoot"]).toBe(true);
      for (const container of spec.template.spec.containers) {
        expect(container["readinessProbe"]).toBeDefined();
        expect(container["livenessProbe"]).toBeDefined();
        expect(container["resources"]).toBeDefined();
        expect((container["securityContext"] as Record<string, unknown>)["allowPrivilegeEscalation"]).toBe(false);
      }
    }
    const kinds = documents.map((document) => document["kind"]);
    for (const kind of ["Ingress", "NetworkPolicy", "PodDisruptionBudget", "Service", "PersistentVolumeClaim"]) {
      expect(kinds, `missing ${kind}`).toContain(kind);
    }
    const configMap = documents.find((document) => document["kind"] === "ConfigMap") as { data?: Record<string, string> };
    expect(configMap.data?.["TAPECI_API_HOST"]).toBe("0.0.0.0");
    const worker = deployments.find((deployment) => (deployment["metadata"] as { name: string }).name === "worker") as { spec: { template: { spec: { containers: Array<Record<string, unknown>>; volumes?: unknown[] } } } };
    const workerContainer = worker.spec.template.spec.containers[0] as { readinessProbe: { httpGet: { path: string } }; livenessProbe: { httpGet: { path: string } } };
    expect(workerContainer.readinessProbe.httpGet.path).toBe("/readyz");
    expect(workerContainer.livenessProbe.httpGet.path).toBe("/healthz");
    expect(worker.spec.template.spec.volumes).toBeDefined();
    const podSecurity = worker.spec.template.spec as unknown as { securityContext: Record<string, unknown> };
    expect(podSecurity.securityContext["fsGroup"]).toBe(1000);
    const apiDeployment = deployments.find((deployment) => (deployment["metadata"] as { name: string }).name === "api") as { spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } };
    const apiContainer = apiDeployment.spec.template.spec.containers[0] as { readinessProbe: { httpGet: { path: string } } };
    expect(apiContainer.readinessProbe.httpGet.path).toBe("/readyz");
    const networkPolicy = documents.find((document) => (document["metadata"] as { name: string })?.name === "allow-platform") as { spec: { egress: Array<{ ports?: Array<{ port: number }> }> } };
    const policyPorts = networkPolicy.spec.egress.flatMap((rule) => rule.ports ?? []).map((port) => port.port);
    for (const port of [8787, 8788, 3000]) expect(policyPorts).toContain(port);
    const secret = documents.find((document) => document["kind"] === "Secret") as { stringData?: Record<string, string> };
    expect(JSON.stringify(secret)).not.toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/);
  });

  it("api and worker share one object store configuration", () => {
    // The API writes the artifact tar and the worker reads it. If their S3_* /
    // TAPECI_OBJECT_STORE values differ (or are absent, silently defaulting to
    // the per-container "local" store), plan/deploy fails with
    // OBJECT_STORE_NOT_FOUND only at run time.
    const documents = readdirSync("ops/k8s")
      .filter((name) => name.endsWith(".yaml"))
      .flatMap((name) => parseAllDocuments(read(`ops/k8s/${name}`)))
      .map((document) => document.toJS() as Record<string, unknown>)
      .filter((document) => document !== null && typeof document === "object");
    const configMap = documents.find((document) => document["kind"] === "ConfigMap") as { data?: Record<string, string> };
    expect(configMap.data?.["TAPECI_OBJECT_STORE"]).toBe("s3");
    for (const key of ["S3_REGION", "S3_PREFIX", "S3_FORCE_PATH_STYLE"]) {
      expect(configMap.data?.[key], `configmap ${key}`).toBeDefined();
    }

    if (execFileSync("bash", ["-lc", "command -v docker || true"], { encoding: "utf8" }).trim() === "") return;
    const env = { ...process.env };
    delete env["TAPECI_ENV_FILE"];
    const rendered = parse(
      execFileSync("docker", ["compose", "-f", "infra/docker-compose.prod.yml", "config"], {
        env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    ) as { services: Record<string, { environment?: Record<string, string> }> };
    const keys = [
      "TAPECI_OBJECT_STORE",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_PREFIX",
      "S3_REGION",
      "S3_FORCE_PATH_STYLE",
    ];
    const apiEnv = rendered.services["api"]?.environment ?? {};
    const workerEnv = rendered.services["worker"]?.environment ?? {};
    for (const key of keys) {
      expect(apiEnv[key], `api ${key}`).toBeDefined();
      expect(workerEnv[key], `worker ${key}`).toBe(apiEnv[key]);
    }
    expect(apiEnv["TAPECI_OBJECT_STORE"]).toBe("s3");
  });

  it("Kustomization, backfill config and security gates are wired", () => {
    const kustomization = parse(read("ops/k8s/kustomization.yaml")) as { resources: string[] };
    const expected = readdirSync("ops/k8s")
      .filter((name) => name.endsWith(".yaml") && name !== "kustomization.yaml" && name !== "secret.example.yaml")
      .sort();
    expect([...kustomization.resources].sort()).toEqual(expected);
    const env = read("infra/env.prod.example");
    expect(env).toContain("TAPECI_AUDIT_BACKFILL_INTERVAL_MS=3600000");
    expect(env).toContain("TAPECI_TEXTFILE_DIR=../.tapeci/textfile");
    expect(read("ops/systemd/tapeci-audit-backfill.service")).toContain("/var/lib/tapeout/textfile/");
    const security = read(".github/workflows/security.yml");
    for (const marker of ["codeql-action", "dependency-review-action", "gitleaks-action", "sbom-action"]) {
      expect(security).toContain(marker);
    }
    expect(read(".github/workflows/k8s-validate.yml")).toContain("validate-k8s.sh");
    expect(existsSync("scripts/ops/install-audit-backfill-timer.sh")).toBe(true);
    expect(existsSync("scripts/ops/k8s-server-dry-run.sh")).toBe(true);
  });

  it("Grafana dashboard and Prometheus scrape cover the operating signals", () => {
    const dashboard = JSON.parse(read("ops/grafana/tapeci-dashboard.json")) as { panels: Array<{ id: number; title: string; targets: Array<{ expr: string }> }> };
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(6);
    const expressions = dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr)).join("\n");
    for (const metric of [
      "tapeci_api_http_requests_total",
      "tapeci_worker_job_failures_total",
      "tapeci_audit_scope_resolve_failures_total",
      "tapeci_audit_backfill_unresolved",
    ]) {
      expect(expressions, `dashboard missing ${metric}`).toContain(metric);
    }
    // Plan Task A.8 names these panels explicitly: API up/5xx/latency, worker
    // up/job failures, queue backlog, audit scope failures, backfill
    // unresolved/stale. Title matching is case-insensitive on purpose.
    const titles = dashboard.panels.map((panel) => panel.title.toLowerCase());
    for (const required of [
      "api up",
      "5xx",
      "latency",
      "worker up",
      "job failures",
      "queue backlog",
      "scope resolve failures",
      "backfill unresolved",
    ]) {
      expect(titles.some((title) => title.includes(required)), `missing panel "${required}"`).toBe(true);
    }
    // Stale-ness of the backfill must be visible, not just the unresolved count.
    expect(expressions).toContain("tapeci_audit_backfill_last_run_timestamp_seconds");
    expect(expressions).toContain("tapeci_queue_jobs");
    const ids = dashboard.panels.map((panel) => panel.id);
    expect(new Set(ids).size, "duplicate panel ids").toBe(ids.length);
    const prometheus = parse(read("ops/prometheus/prometheus.yml")) as { scrape_configs: Array<{ job_name: string }>; rule_files: string[] };
    expect(prometheus.scrape_configs.map((job) => job.job_name)).toEqual(expect.arrayContaining(["tapeci-api", "tapeci-worker"]));
    expect(prometheus.rule_files.join(",")).toContain("tapeci-alerts.yml");
    // The audit backfill metrics only exist through the node_exporter textfile
    // collector; without this target the backfill panels stay empty forever.
    expect(read("ops/prometheus/prometheus.yml")).toContain("textfile");
  });
});
