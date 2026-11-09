import { loadGithubAppEnv } from "./load-env.js";
import { listAppInstallations } from "@tapeci/github";

const env = await loadGithubAppEnv();
const installations = await listAppInstallations({
  appId: env.GITHUB_APP_ID!,
  privateKey: env.GITHUB_APP_PRIVATE_KEY!,
});
for (const row of installations) {
  console.log(`${row.id}\t${row.account.login}\t${row.suspendedAt === null ? "active" : "suspended"}`);
}
