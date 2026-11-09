import { XLAYER_MAINNET } from "@tapeci/config";
import {
  assertContainerVerified,
  findProcessorIndex,
  inspectContainer,
  type ContainerInspection,
  type VerifiedContainerInspection,
} from "@tapeci/chain";
import type { Hex } from "@tapeci/shared";
import { createOperatorClients } from "@tapeci/verifier";
import type { ResolvedContainer } from "./deps.js";
import { ApiError } from "./errors.js";

/**
 * Read-only X Layer container inspection through the configured operators.
 *
 * The three chain outcomes stay distinguishable (SPEC §8.6):
 * - `verified` + `opened: false` → 409 `CONTAINER_NOT_OPEN` (a real answer),
 * - `not_found` → 422 `CONTAINER_NOT_TAPEOUT`,
 * - `unavailable` → 503 `CONTAINER_READ_UNAVAILABLE`, retryable, so the UI can say
 *   "could not read" instead of "not activated".
 */
export async function resolveContainerOnChain(address: Hex): Promise<ResolvedContainer> {
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) throw new ApiError(500, "INTERNAL", "no RPC operator configured");
  const inspection = await inspectContainer(primary.client, XLAYER_MAINNET, address);
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new ApiError(500, "INTERNAL", "no registry configured");
  const verified = resolveVerifiedOrThrow(inspection);
  const processorIndex = await findProcessorIndex(primary.client, XLAYER_MAINNET, verified.processor);
  if (processorIndex === null) {
    throw new ApiError(422, "CONTAINER_NOT_TAPEOUT", "processor is not registered in the factory");
  }
  return {
    address: verified.container,
    factory: XLAYER_MAINNET.factory,
    opener: XLAYER_MAINNET.opener,
    registry,
    binding: XLAYER_MAINNET.binding,
    processorIndex,
    processor: verified.processor,
    tokenId: verified.tokenId.toString(),
    owner: verified.owner,
    opened: verified.opened,
  };
}

/**
 * Map one inspection to the HTTP outcome. Exported so a unit test can prove the
 * three-way split without a network: the whole point of I03 is that `unavailable`
 * must not reuse `CONTAINER_NOT_OPEN`'s 409.
 */
export function resolveVerifiedOrThrow(
  inspection: ContainerInspection,
): VerifiedContainerInspection {
  if (inspection.readStatus === "unavailable") {
    throw new ApiError(
      503,
      "CONTAINER_READ_UNAVAILABLE",
      `could not read container ${inspection.container}: ${inspection.failure.message}`,
      {
        container: inspection.container,
        stage: inspection.failure.stage,
        observedBlock:
          inspection.observedBlock === null ? null : inspection.observedBlock.toString(),
      },
      true,
    );
  }
  // `not_found` becomes the existing 422 CONTAINER_NOT_TAPEOUT via the shared table.
  const verified = assertContainerVerified(inspection);
  if (!verified.opened) {
    throw new ApiError(409, "CONTAINER_NOT_OPEN", `container ${inspection.container} is not opened`, {
      observedBlock: verified.observedBlock.toString(),
      deployed: verified.deployed,
    });
  }
  return verified;
}
