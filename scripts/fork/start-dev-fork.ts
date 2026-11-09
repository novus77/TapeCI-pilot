/**
 * Start a local Anvil fork of X Layer, open a fresh container, and print the
 * addresses/env needed to run the API/worker/web against the fork.
 *
 *   corepack pnpm fork:dev > .tapeci/fork.env.json
 */
import { startAnvilFork } from "./anvil.js";
import { clientsFor, openNewContainer } from "./support.js";

const fork = await startAnvilFork({ offset: 60, port: Number(process.env.TAPECI_FORK_PORT ?? "8545") });
const clients = clientsFor(fork);
const opened = await openNewContainer({
  fork,
  client: clients.publicClient,
  testClient: clients.testClient,
  opener: "0x1000000000000000000000000000000000000004",
});
const pin = await clients.publicClient.getBlockNumber();
console.log(
  JSON.stringify(
    {
      forkUrl: fork.url,
      chainId: fork.chainId,
      forkBlockNumber: fork.forkBlockNumber.toString(),
      container: opened.container,
      owner: opened.owner,
      processor: opened.fixture.processor,
      processorIndex: opened.fixture.processorIndex,
      tokenId: opened.fixture.tokenId.toString(),
      registry: "0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6",
      binding: "0x68809fd2fb343aa57d0aeb7f33defe477c9666f9",
      factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
      opener: "0x536add8f30f03b69f6fbf29d425a816a0dc50106",
      planPinBlock: pin.toString(),
      pid: fork.pid,
    },
    null,
    2,
  ),
);
// Keep the fork alive until killed.
process.on("SIGTERM", () => void fork.stop().then(() => process.exit(0)));
process.on("SIGINT", () => void fork.stop().then(() => process.exit(0)));
await new Promise<void>(() => undefined);
