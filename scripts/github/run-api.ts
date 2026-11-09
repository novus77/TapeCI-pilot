/** Start the API with `.tapeci/github-app.env` loaded as real env vars. */
import { loadGithubAppEnv } from "./load-env.js";

const env = await loadGithubAppEnv();
for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}
// Local-only values that are not App credentials.
process.env.SESSION_SIGNING_SECRET ??= "local-dev-session-secret-please-change";
process.env.DATABASE_URL ??= "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
process.env.REDIS_URL ??= "redis://127.0.0.1:56379";

await import("../../apps/api/src/server.js");
