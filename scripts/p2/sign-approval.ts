/**
 * Sign a deployment approval locally, without a browser wallet.
 *
 *   # 1) create .tapeci/owner.env (chmod 600) containing:
 *   #    TAPECI_OWNER_PRIVATE_KEY=0x...
 *   # 2) print the signature (default, does not submit):
 *   tsx scripts/p2/sign-approval.ts --deployment <id>
 *   # 3) sign and submit to the API:
 *   tsx scripts/p2/sign-approval.ts --deployment <id> --post
 *
 * The key never leaves this process; it is never printed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const deploymentId = arg("--deployment");
if (deploymentId === undefined) throw new Error("usage: sign-approval.ts --deployment <id> [--post] [--api URL] [--key-file PATH]");
const apiUrl = arg("--api") ?? process.env.TAPECI_API_URL ?? "http://127.0.0.1:8787";
const keyFile = arg("--key-file") ?? join(process.cwd(), ".tapeci/owner.env");
const post = process.argv.includes("--post");

async function loadKey(): Promise<Hex> {
  const text = await readFile(keyFile, "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith("TAPECI_OWNER_PRIVATE_KEY="));
  if (line === undefined) throw new Error(`${keyFile} has no TAPECI_OWNER_PRIVATE_KEY`);
  const value = line.slice("TAPECI_OWNER_PRIVATE_KEY=".length).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("owner key is malformed");
  return value as Hex;
}

const headers = {
  "x-tapeci-github-login": process.env.TAPECI_DEV_GITHUB_LOGIN ?? "novus77",
  "x-tapeci-github-user-id": process.env.TAPECI_DEV_GITHUB_USER_ID ?? "87079346",
};

const payloadResponse = await fetch(`${apiUrl}/v1/deployments/${deploymentId}/approval-payload`, { headers });
if (!payloadResponse.ok) throw new Error(`payload failed: ${payloadResponse.status} ${await payloadResponse.text()}`);
const payload = (await payloadResponse.json()) as {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  message: Record<string, unknown>;
  approval: Record<string, unknown>;
  expectedSigner: string;
};
const account = privateKeyToAccount(await loadKey());
if (getAddress(payload.expectedSigner).toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`key ${account.address} is not the expected signer ${payload.expectedSigner}`);
}
const typedData = {
  domain: payload.domain,
  types: payload.types,
  primaryType: "Approval" as const,
  message: payload.message,
} as unknown as Parameters<typeof account.signTypedData>[0];
const signature = await account.signTypedData(typedData);
console.log(JSON.stringify({ deploymentId, signer: account.address, signature }, null, 2));

if (post) {
  const response = await fetch(`${apiUrl}/v1/deployments/${deploymentId}/approve`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ signerAddress: account.address, signature, approval: payload.approval }),
  });
  const body = await response.text();
  console.log(JSON.stringify({ approveStatus: response.status, body }));
  if (!response.ok) process.exitCode = 1;
}
