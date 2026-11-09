import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly labels?: Record<string, string>;
}

describe("Prometheus alert rules", () => {
  it("covers audit resolver/backfill and platform failure modes", async () => {
    const text = await readFile("ops/prometheus/tapeci-alerts.yml", "utf8");
    const parsed = parse(text) as { groups: Array<{ name: string; rules: Rule[] }> };
    const rules = parsed.groups.flatMap((group) => group.rules);
    const byName = new Map(rules.map((rule) => [rule.alert, rule]));
    for (const name of [
      "TapeCiAuditScopeResolveFailures",
      "TapeCiAuditBackfillUnresolved",
      "TapeCiAuditBackfillStale",
      "TapeCiApiDown",
      "TapeCiWorkerDown",
      "TapeCiHttp5xx",
      "TapeCiWorkerJobFailures",
    ]) {
      expect(byName.has(name), `missing alert ${name}`).toBe(true);
    }
    expect(byName.get("TapeCiAuditScopeResolveFailures")?.expr).toContain(
      "tapeci_audit_scope_resolve_failures_total",
    );
    expect(byName.get("TapeCiAuditBackfillStale")?.expr).toContain(
      "tapeci_audit_backfill_last_run_timestamp_seconds",
    );
    expect(rules.every((rule) => rule.expr.trim().length > 0)).toBe(true);
    expect(rules.filter((rule) => rule.labels?.severity === "critical").length).toBeGreaterThan(0);
  });
});
