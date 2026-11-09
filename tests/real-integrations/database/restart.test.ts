import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { appliedMigrations, migrateUp, queryRows } from "@tapeci/database";
import { realIntegrationEnabled } from "../../../scripts/real-integrations/common.js";

const execFileAsync = promisify(execFile);
const enabled =
  realIntegrationEnabled() && process.env.TAPECI_REAL_DATABASE_RESTART === "1";

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout.trim();
}

describe.skipIf(!enabled)("PostgreSQL container restart persistence", () => {
  it("retains migrations and rows after stopping and restarting an isolated server", async () => {
    const token = randomBytes(6).toString("hex");
    const container = `tapeci-real-restart-${token}`;
    const volume = `tapeci-real-restart-${token}`;
    const port = 40_000 + randomBytes(2).readUIntBE(0, 2) % 20_000;
    const databaseUrl = `postgres://tapeci:tapeci@127.0.0.1:${port}/tapeci`;
    let created = false;

    try {
      await docker([
        "run",
        "--detach",
        "--name",
        container,
        "--publish",
        `127.0.0.1:${port}:5432`,
        "--env",
        "POSTGRES_USER=tapeci",
        "--env",
        "POSTGRES_PASSWORD=tapeci",
        "--env",
        "POSTGRES_DB=tapeci",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/postgresql/data`,
        "postgres:16-alpine",
      ]);
      created = true;

      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await queryRows(databaseUrl, "SELECT 1");
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(ready, "isolated PostgreSQL did not become ready").toBe(true);

      await migrateUp(databaseUrl);
      const marker = `restart-${token}`;
      await queryRows(
        databaseUrl,
        "INSERT INTO users (github_user_id, github_login) VALUES ($1, $2)",
        [9_700_000_000 + randomBytes(3).readUIntBE(0, 3), marker],
      );
      const migrationsBefore = await appliedMigrations(databaseUrl);
      expect(migrationsBefore).toHaveLength(13);

      await docker(["stop", "--time", "20", container]);
      await docker(["start", container]);

      ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await queryRows(databaseUrl, "SELECT 1");
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(ready, "restarted PostgreSQL did not become ready").toBe(true);

      const rows = await queryRows<{ github_login: string }>(
        databaseUrl,
        "SELECT github_login FROM users WHERE github_login = $1",
        [marker],
      );
      expect(rows).toEqual([{ github_login: marker }]);
      expect(await appliedMigrations(databaseUrl)).toEqual(migrationsBefore);
    } finally {
      if (created) {
        await docker(["rm", "--force", "--volumes", container]).catch(() => undefined);
      }
      await docker(["volume", "rm", "--force", volume]).catch(() => undefined);
    }
  }, 180_000);
});
