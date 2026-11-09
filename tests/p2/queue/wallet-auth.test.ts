import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildWalletChallengeMessage,
  consumeWalletChallenge,
  createWalletChallenge,
  verifyAndConsumeWalletChallenge,
  verifyWalletSignature,
  type Database,
} from "@tapeci/queue";
import {
  detectServices,
  setupTestDatabase,
  type TestDatabaseHandle,
} from "./helpers.js";

const services = await detectServices();
const describeDb = services.database ? describe : describe.skip;

function randomAccount() {
  return privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
}

describeDb("wallet challenge auth", () => {
  let handle: TestDatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
  });

  function db(): Database {
    if (handle === undefined) throw new Error("test database is not ready");
    return handle.db;
  }

  it("builds a SIWE-style message bound to domain, chain id, nonce and expiry", () => {
    const issuedAt = new Date("2026-10-19T00:00:00.000Z");
    const expirationTime = new Date("2026-10-19T00:05:00.000Z");
    const message = buildWalletChallengeMessage({
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      chainId: 196,
      nonce: "0x1234",
      issuedAt,
      expirationTime,
    });
    expect(message).toContain("tapeci.app wants you to sign in with your X Layer account:");
    expect(message).toContain("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(message).toContain("Chain ID: 196");
    expect(message).toContain("Nonce: 0x1234");
    expect(message).toContain("Issued At: 2026-10-19T00:00:00.000Z");
    expect(message).toContain("Expiration Time: 2026-10-19T00:05:00.000Z");
  });

  it("verifies a wallet signature with viem verifyMessage", async () => {
    const account = randomAccount();
    const challenge = await createWalletChallenge(db(), { address: account.address });
    const signature = await account.signMessage({ message: challenge.message });

    await expect(
      verifyWalletSignature({
        address: account.address,
        message: challenge.message,
        signature,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyWalletSignature({
        address: account.address,
        message: `${challenge.message}\ntampered`,
        signature,
      }),
    ).resolves.toBe(false);

    const other = randomAccount();
    await expect(
      verifyWalletSignature({
        address: other.address,
        message: challenge.message,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it("consumes a challenge exactly once (replay rejected)", async () => {
    const account = randomAccount();
    const challenge = await createWalletChallenge(db(), { address: account.address });
    const signature = await account.signMessage({ message: challenge.message });

    const consumed = await verifyAndConsumeWalletChallenge(db(), {
      address: account.address,
      signature,
    });
    expect(consumed.nonce).toBe(challenge.nonce);
    expect(consumed.consumedAt).not.toBeNull();

    await expect(
      verifyAndConsumeWalletChallenge(db(), {
        address: account.address,
        signature,
        nonce: challenge.nonce,
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: "challenge_already_consumed" },
    });
  });

  it("rejects an expired challenge in both consume and verify paths", async () => {
    const account = randomAccount();
    const challenge = await createWalletChallenge(db(), {
      address: account.address,
      ttlSeconds: 60,
    });
    const signature = await account.signMessage({ message: challenge.message });
    const later = new Date(challenge.expiresAt.getTime() + 1_000);

    await expect(
      consumeWalletChallenge(db(), challenge.nonce, account.address, { now: later }),
    ).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
      details: { reason: "challenge_expired" },
    });

    await expect(
      verifyAndConsumeWalletChallenge(db(), {
        address: account.address,
        signature,
        nonce: challenge.nonce,
        now: later,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });

  it("rejects a signature from a different wallet", async () => {
    const owner = randomAccount();
    const attacker = randomAccount();
    const challenge = await createWalletChallenge(db(), { address: owner.address });
    const signature = await attacker.signMessage({ message: challenge.message });

    await expect(
      verifyAndConsumeWalletChallenge(db(), {
        address: owner.address,
        signature,
        nonce: challenge.nonce,
      }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: "invalid_signature" },
    });
  });

  it("atomic consumption: exactly one of two concurrent consumers wins", async () => {
    const account = randomAccount();
    const challenge = await createWalletChallenge(db(), { address: account.address });
    const signature = await account.signMessage({ message: challenge.message });

    const results = await Promise.allSettled([
      verifyAndConsumeWalletChallenge(db(), {
        address: account.address,
        signature,
        nonce: challenge.nonce,
      }),
      verifyAndConsumeWalletChallenge(db(), {
        address: account.address,
        signature,
        nonce: challenge.nonce,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("uses the newest active challenge when no nonce is provided", async () => {
    const account = randomAccount();
    await createWalletChallenge(db(), { address: account.address, nonce: "0xolder" });
    const newer = await createWalletChallenge(db(), {
      address: account.address,
      nonce: "0xnewer",
    });

    // Signature over the older challenge is not what the newest challenge contains.
    const olderSignature = await account.signMessage({ message: "not the newest challenge" });
    await expect(
      verifyAndConsumeWalletChallenge(db(), {
        address: account.address,
        signature: olderSignature,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

    const newerSignature = await account.signMessage({ message: newer.message });
    const consumed = await verifyAndConsumeWalletChallenge(db(), {
      address: account.address,
      signature: newerSignature,
    });
    expect(consumed.nonce).toBe(newer.nonce);
  });

  it("enforces chain id 196 and bounded TTLs", async () => {
    const account = randomAccount();
    await expect(
      createWalletChallenge(db(), { address: account.address, chainId: 1 }),
    ).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
    await expect(
      createWalletChallenge(db(), { address: account.address, ttlSeconds: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      createWalletChallenge(db(), { address: account.address, ttlSeconds: 60 * 60 * 24 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
