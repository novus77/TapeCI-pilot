import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { wallets } from "@tapeci/database";
import {
  createWalletChallenge,
  verifyAndConsumeWalletChallenge,
} from "@tapeci/queue";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { recordBody, stringField } from "../validation.js";

export function registerWalletRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/auth/wallet/challenge", async (request) => {
    requireUser(request);
    const body = recordBody(request.body);
    const address = stringField(body, "address") as string;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ApiError(400, "INVALID_BODY", "address must be a 20-byte hex address");
    }
    const challenge = await createWalletChallenge(deps.db, { address });
    return {
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  });

  app.post("/v1/auth/wallet/verify", async (request) => {
    const user = requireUser(request);
    const body = recordBody(request.body);
    const address = stringField(body, "address") as string;
    const signature = stringField(body, "signature") as string;
    const nonce = stringField(body, "nonce", { optional: true });
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ApiError(400, "INVALID_BODY", "address must be a 20-byte hex address");
    }
    const challenge = await verifyAndConsumeWalletChallenge(deps.db, {
      address,
      signature: signature as `0x${string}`,
      ...(nonce === undefined ? {} : { nonce }),
    });
    const [wallet] = await deps.db
      .insert(wallets)
      .values({
        userId: user.id,
        chainId: 196,
        address: address.toLowerCase(),
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wallets.userId, wallets.chainId, wallets.address],
        set: { verifiedAt: new Date() },
      })
      .returning();
    if (wallet === undefined) {
      const [existing] = await deps.db
        .select()
        .from(wallets)
        .where(eq(wallets.address, address.toLowerCase()))
        .limit(1);
      return { ok: true, wallet: existing ?? null, challengeNonce: challenge.nonce };
    }
    return {
      ok: true,
      wallet: { id: wallet.id, address: wallet.address, chainId: wallet.chainId },
      challengeNonce: challenge.nonce,
    };
  });
}
