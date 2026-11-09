import type { BuildDispatchGithub } from "./build-dispatch.js";
import type { ResourceIndexStore } from "./resource-index.js";
import type { WalletClient } from "viem";
import type { ReadClient } from "@tapeci/chain";
import type { Database } from "@tapeci/database";
import type { GithubOidcClaims, GitHubFetch, ObjectStore } from "@tapeci/github";
import type { Hex } from "@tapeci/shared";
import type { ApiEnv } from "./env.js";

export interface ResolvedContainer {
  readonly address: Hex;
  readonly factory: Hex;
  readonly opener: Hex;
  readonly registry: Hex;
  readonly binding: Hex;
  readonly processorIndex: number;
  readonly processor: Hex;
  readonly tokenId: string;
  readonly owner: Hex;
  readonly opened: boolean;
}

export interface ApiDeps {
  readonly db: Database;
  readonly env: ApiEnv;
  /**
   * Injectable GitHub surface for build dispatch (SPEC §11.3). Tests inject a fake so
   * no network call is made; production builds it from the App credentials.
   */
  readonly dispatchGithub?: BuildDispatchGithub;
  /** Injectable for tests; the default reads X Layer through two operators. */
  readonly resolveContainer?: (address: Hex) => Promise<ResolvedContainer>;
  /**
   * Injectable resource index (SPEC §8). Tests need a seeded index to exercise
   * grouping, cursor paging and the `complete: true` path; production would use the
   * PostgreSQL-backed store. Absent means the in-memory index is used.
   */
  readonly resourceIndex?: ResourceIndexStore;
  /** Injectable for tests; default enqueues a BullMQ plan job. */
  readonly enqueuePlan?: (deploymentId: string) => Promise<void>;
  /** Injectable for tests; default enqueues a BullMQ deploy job. */
  readonly enqueueDeployment?: (deploymentId: string) => Promise<void>;
  /** Injectable OIDC verifier; default checks GitHub's issuer/JWKS. */
  readonly verifyOidc?: (token: string) => Promise<GithubOidcClaims>;
  /** Injectable object store for tests; default is selected from env. */
  readonly objectStore?: ObjectStore;
  /** Injectable EIP-1271 verifier for contract-owner approvals (tests). */
  readonly verifyContractSignature?: (input: {
    readonly signerAddress: Hex;
    readonly digest: Hex;
    readonly signature: Hex;
  }) => Promise<boolean>;
  /** Injectable GitHub HTTP for OAuth/App tests; production uses global fetch. */
  readonly github?: {
    readonly fetch?: GitHubFetch;
    readonly oauthBaseUrl?: string;
    readonly apiBaseUrl?: string;
    readonly now?: () => Date;
  };
  /**
   * Chain access for the DomainBinding routes (`GET …/binding`, `POST …/bind`).
   * Defaults read X Layer through the configured operators (view calls only).
   * Tests inject these so no request ever reaches a real network.
   */
  readonly readClient?: () => ReadClient;
  /**
   * Operator wallet for `bind`. Defaults to the same env-driven runtime the deploy
   * worker uses (`createWorkerRuntime`); tests inject a local wallet or a stub.
   */
  readonly operatorWallet?: () => WalletClient | null;
  /** Clock used for "is activation still covered" decisions; tests pin it. */
  readonly now?: () => Date;
}
