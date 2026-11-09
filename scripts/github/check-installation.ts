import { loadGithubAppEnv } from "./load-env.js";
import { getInstallationToken, listInstallationRepositories } from "@tapeci/github";

const env = await loadGithubAppEnv();
const installationId = Number(process.argv[2] ?? "173094654");
if (env.GITHUB_APP_ID === undefined || env.GITHUB_APP_PRIVATE_KEY === undefined) {
  throw new Error("missing App credentials in .tapeci/github-app.env");
}
const token = await getInstallationToken({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  installationId,
});
console.log(`token_expires=${token.expiresAt.toISOString()}`);
const repos = await listInstallationRepositories({ token: token.token });
console.log(`repos=${repos.length}`);
for (const repo of repos.slice(0, 10)) {
  console.log(`${repo.fullName} default=${repo.defaultBranch} private=${repo.private}`);
}
