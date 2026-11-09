import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

const MAX_TYPED_DATA_BYTES = 65_536;
const TAPECI_CHAIN_ID = 196;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APPROVAL_TYPES = {
  Approval: [
    { name: "deploymentId", type: "string" },
    { name: "manifestHash", type: "bytes32" },
    { name: "container", type: "address" },
    { name: "costCapWei", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export type WalletIntegrationKind = "injected" | "walletconnect" | "hardware";

export interface ApprovalTypedDataJson {
  readonly domain: {
    readonly name: "TapeCI";
    readonly version: "1";
    readonly chainId: 196;
    readonly verifyingContract: Address;
  };
  readonly types: typeof APPROVAL_TYPES;
  readonly primaryType: "Approval";
  readonly message: {
    readonly deploymentId: string;
    readonly manifestHash: Hex;
    readonly container: Address;
    readonly costCapWei: string;
    readonly nonce: string;
    readonly expiresAt: string;
  };
}

export interface ParsedApprovalTypedData {
  readonly domain: ApprovalTypedDataJson["domain"];
  readonly types: typeof APPROVAL_TYPES;
  readonly primaryType: "Approval";
  readonly message: {
    readonly deploymentId: string;
    readonly manifestHash: Hex;
    readonly container: Address;
    readonly costCapWei: bigint;
    readonly nonce: string;
    readonly expiresAt: bigint;
  };
}

export interface ExternalSignatureCase {
  readonly document: ParsedApprovalTypedData;
  readonly expectedSigner: Address;
  readonly signature: Hex;
  readonly walletKind: WalletIntegrationKind;
}

export interface SignatureVerificationResult {
  readonly verified: boolean;
  readonly chainId: 196;
  readonly expectedSigner: Address;
  readonly recoveredAddress: Address | null;
  readonly reason: "verified" | "signer_mismatch" | "signature_recovery_failed";
}

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function uint256String(value: unknown, label: string): bigint {
  const text = stringValue(value, label);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${label} must be a canonical unsigned decimal integer string`);
  }
  return BigInt(text);
}

function addressValue(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${label} must be a 20-byte EVM address`);
  }
  return getAddress(value);
}

function hash32Value(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte hex value`);
  }
  return value as Hex;
}

function parseDomain(value: unknown): ApprovalTypedDataJson["domain"] {
  if (!isRecord(value)) throw new Error("typed data domain must be an object");
  exactKeys(value, ["name", "version", "chainId", "verifyingContract"], "typed data domain");
  if (value.name !== "TapeCI") throw new Error("typed data domain name must be TapeCI");
  if (value.version !== "1") throw new Error("typed data domain version must be 1");
  if (value.chainId !== TAPECI_CHAIN_ID) throw new Error("typed data chainId must be 196");
  return {
    name: "TapeCI",
    version: "1",
    chainId: TAPECI_CHAIN_ID,
    verifyingContract: addressValue(value.verifyingContract, "typed data verifyingContract"),
  };
}

function parseTypes(value: unknown): typeof APPROVAL_TYPES {
  if (!isRecord(value)) throw new Error("typed data types must be an object");
  exactKeys(value, ["Approval"], "typed data types");
  const approval = value.Approval;
  if (!Array.isArray(approval) || approval.length !== APPROVAL_TYPES.Approval.length) {
    throw new Error("typed data Approval fields are invalid");
  }
  approval.forEach((field, index) => {
    const expected = APPROVAL_TYPES.Approval[index];
    if (
      !isRecord(field) ||
      expected === undefined ||
      field.name !== expected.name ||
      field.type !== expected.type
    ) {
      throw new Error(`typed data Approval field ${index} is invalid`);
    }
    exactKeys(field, ["name", "type"], `typed data Approval field ${index}`);
  });
  return APPROVAL_TYPES;
}

function parseMessage(value: unknown): ApprovalTypedDataJson["message"] {
  if (!isRecord(value)) throw new Error("typed data message must be an object");
  exactKeys(
    value,
    ["deploymentId", "manifestHash", "container", "costCapWei", "nonce", "expiresAt"],
    "typed data message",
  );
  const deploymentId = stringValue(value.deploymentId, "typed data message.deploymentId");
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new Error("typed data message.deploymentId must be a UUID");
  }
  const nonce = stringValue(value.nonce, "typed data message.nonce");
  if (nonce.length > 256) throw new Error("typed data message.nonce is too long");
  uint256String(value.costCapWei, "typed data message.costCapWei");
  uint256String(value.expiresAt, "typed data message.expiresAt");
  return {
    deploymentId,
    manifestHash: hash32Value(value.manifestHash, "typed data message.manifestHash"),
    container: addressValue(value.container, "typed data message.container"),
    costCapWei: value.costCapWei as string,
    nonce,
    expiresAt: value.expiresAt as string,
  };
}

export function parseApprovalTypedDataJson(text: string): ParsedApprovalTypedData {
  if (Buffer.byteLength(text, "utf8") > MAX_TYPED_DATA_BYTES) {
    throw new Error(`typed data input is too large (maximum ${MAX_TYPED_DATA_BYTES} bytes)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("typed data input is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("typed data input must be an object");
  exactKeys(parsed, ["domain", "types", "primaryType", "message"], "typed data input");
  if (parsed.primaryType !== "Approval") throw new Error("typed data primaryType must be Approval");
  const domain = parseDomain(parsed.domain);
  const types = parseTypes(parsed.types);
  const message = parseMessage(parsed.message);
  return {
    domain,
    types,
    primaryType: "Approval",
    message: {
      ...message,
      costCapWei: BigInt(message.costCapWei),
      expiresAt: BigInt(message.expiresAt),
    },
  };
}

export function parseSignature(value: string): Hex {
  const trimmed = value.trim();
  if (!SIGNATURE_PATTERN.test(trimmed)) {
    throw new Error("signature must be a 65-byte 0x-prefixed ECDSA signature");
  }
  return trimmed as Hex;
}

function pathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function assertSignaturePathAllowed(signaturePath: string, repositoryRoot: string): void {
  if (pathInside(resolve(repositoryRoot), resolve(signaturePath))) {
    throw new Error("signature file must be outside the repository");
  }
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseWalletKind(value: string): WalletIntegrationKind {
  if (value === "injected" || value === "walletconnect" || value === "hardware") return value;
  throw new Error("TAPECI_REAL_WALLET_KIND must be injected, walletconnect or hardware");
}

async function readOwnerOnlySignature(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("signature path must be a regular file");
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("signature file permissions must be owner-only (chmod 600)");
  }
  return readFile(canonical, "utf8");
}

export async function readExternalSignatureCase(env: Environment): Promise<ExternalSignatureCase> {
  if (env.TAPECI_REAL_WALLET_RUN !== "1") {
    throw new Error("set TAPECI_REAL_WALLET_RUN=1 to run an external-signer verification");
  }
  const walletKind = parseWalletKind(required(env, "TAPECI_REAL_WALLET_KIND"));
  const expectedSigner = addressValue(
    required(env, "TAPECI_REAL_WALLET_SIGNER"),
    "TAPECI_REAL_WALLET_SIGNER",
  );
  const typedDataPath = resolve(required(env, "TAPECI_REAL_WALLET_TYPED_DATA_FILE"));
  const signaturePath = resolve(required(env, "TAPECI_REAL_WALLET_SIGNATURE_FILE"));
  const repositoryRoot = resolve(env.TAPECI_REAL_WALLET_REPO_ROOT ?? process.cwd());

  assertSignaturePathAllowed(signaturePath, repositoryRoot);
  const canonicalSignaturePath = await realpath(signaturePath);
  assertSignaturePathAllowed(canonicalSignaturePath, repositoryRoot);
  const [typedDataText, signatureText] = await Promise.all([
    readFile(typedDataPath, "utf8"),
    readOwnerOnlySignature(canonicalSignaturePath),
  ]);
  return {
    document: parseApprovalTypedDataJson(typedDataText),
    expectedSigner,
    signature: parseSignature(signatureText),
    walletKind,
  };
}

export function maskAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function assertApprovalSubmissionAllowed(
  env: Environment,
  confirmationFlag: boolean,
): void {
  if (env.TAPECI_REAL_WALLET_SUBMIT !== "1") {
    throw new Error("set TAPECI_REAL_WALLET_SUBMIT=1 to allow approval submission");
  }
  if (!confirmationFlag) {
    throw new Error("approval submission requires the explicit --confirm-submit flag");
  }
}

export async function verifyApprovalTypedData(input: {
  readonly document: ParsedApprovalTypedData;
  readonly expectedSigner: string;
  readonly signature: string;
}): Promise<SignatureVerificationResult> {
  const expectedSigner = addressValue(input.expectedSigner, "expectedSigner");
  const signature = parseSignature(input.signature);
  try {
    const recoveredAddress = await recoverTypedDataAddress({
      domain: input.document.domain as TypedDataDomain,
      types: input.document.types,
      primaryType: input.document.primaryType,
      message: input.document.message,
      signature,
    });
    const verified = recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    return {
      verified,
      chainId: TAPECI_CHAIN_ID,
      expectedSigner,
      recoveredAddress,
      reason: verified ? "verified" : "signer_mismatch",
    };
  } catch {
    return {
      verified: false,
      chainId: TAPECI_CHAIN_ID,
      expectedSigner,
      recoveredAddress: null,
      reason: "signature_recovery_failed",
    };
  }
}
