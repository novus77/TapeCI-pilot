/**
 * `@tapeci/queue` — P2-06/07/08 execution layer.
 *
 * Public surface:
 * - state machine + CAS transitions (`states`, `state-machine`)
 * - per-container Redis lock (`lock`, `redis`)
 * - BullMQ queues/workers (`queues`, `workers`)
 * - wallet challenge auth (`wallet-auth`)
 * - EIP-712 approval + temporary operator sessions (`approval`)
 *
 * The default worker handlers throw a typed `INTERNAL` error: the API/service layer
 * injects the real plan/deploy/verify implementations through `startWorkers({handlers})`.
 */

export * from "./states.js";
export * from "./validation.js";
export * from "./redis.js";
export * from "./db.js";
export * from "./state-machine.js";
export * from "./lock.js";
export * from "./queues.js";
export * from "./workers.js";
export * from "./wallet-auth.js";
export * from "./approval.js";
