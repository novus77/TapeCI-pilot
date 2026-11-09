import { parseAbi } from "viem";

/**
 * SiteRegistry write + read ABI, transcribed from TapeKit SPEC Appendix B.5 and
 * confirmed against the live X Layer implementation bytecode by P0-03
 * (see docs/abi-validation.md). Do not add functions here without on-chain evidence.
 */
export const siteRegistryAbi = parseAbi([
  // ---- write (onlyEditor: container holder or operator set with setOperator) ----
  "function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)",
  "function appendChunk(address container, string path, uint256 expectIndex, bytes data)",
  "function removeFile(address container, string path)",
  "function setFallback(address container, string path)",
  "function setOperator(address container, address op, uint256 ttl)",
  // ---- read ----
  "function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)",
  "function read(address container, string path) view returns (bytes)",
  "function readRange(address container, string path, uint256 offset, uint256 len) view returns (bytes)",
  "function pathCount(address container) view returns (uint256)",
  "function pathsRange(address container, uint256 from, uint256 n) view returns (string[])",
  "function paths(address container) view returns (string[])",
  "function fallbackPath(address container) view returns (string)",
  "function isOpenedContainer(address container) view returns (bool)",
  "function CHUNK_MAX() view returns (uint256)",
  // ---- events (used by watchers; eth_getLogs is rate-limited on X Layer RPCs) ----
  "event FileSet(address indexed container, string path, uint32 size, bytes32 sha256Hash, string contentType)",
  "event FileRemoved(address indexed container, string path)",
  "event FallbackSet(address indexed container, string path)",
  "event OperatorSet(address indexed container, address operator, address setBy, uint40 until)",
]);

/** TapeOut factory (UUPS proxy). `cpuAt(i)` is the append-only processor table. */
export const factoryAbi = parseAbi([
  "function cpuCount() view returns (uint256)",
  "function cpuAt(uint256 index) view returns (address)",
  "function cpus(uint256 index) view returns (address)",
  "function isCPU(address circuits) view returns (bool)",
  "function deployFee() view returns (uint256)",
  "function protocolFee() view returns (uint256)",
  "function owner() view returns (address)",
  "function isSealed() view returns (bool)",
  "function circuitBeacon() view returns (address)",
  "function transistorBeacon() view returns (address)",
]);

/** Container opener (not a proxy). */
export const openerAbi = parseAbi([
  "function accountOf(address circuits, uint256 tokenId) view returns (address)",
  "function isOpened(address circuits, uint256 tokenId) view returns (bool)",
  "function isDeployed(address circuits, uint256 tokenId) view returns (bool)",
  "function open(address circuits, uint256 tokenId) payable returns (address)",
  "function FEE() view returns (uint256)",
]);

/** ERC-6551 account bound to a circuit. */
export const containerAbi = parseAbi([
  "function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)",
  "function owner() view returns (address)",
  "function state() view returns (uint256)",
]);

/** Circuits contract (ERC-721, one per processor). */
export const processorAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function nextId() view returns (uint256)",
  "function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)",
]);

/**
 * DomainBinding (UUPS proxy): activation/payment records.
 *
 * The write surface (`bind`, `syncContainer`) follows TapeKit SPEC §DomainBinding
 * as observed on the X Layer implementation `0x5ebf29b8…347df`: `bind` is payable,
 * holder-only (the container's effective owner) and requires
 * `msg.value = months * monthlyFee()`. `monthlyFee()` reads 0 on X Layer today,
 * so the current cost of activation is gas only — always re-read it.
 */
export const bindingAbi = parseAbi([
  // ---- write (holder-only) ----
  "function bind(string name, address container, uint256 months) payable",
  "function syncContainer(string domain, address container)",
  // ---- read ----
  "function isLive(string name, address container) view returns (bool)",
  "function isContainerLive(address container) view returns (bool)",
  "function paidUntil(bytes32 nameHash, address container) view returns (uint40)",
  "function containerPaidUntil(address container) view returns (uint40)",
  "function monthlyFee() view returns (uint256)",
  // ---- events ----
  "event Bound(bytes32 indexed domainHash, string domain, address indexed container, uint40 paidUntil, uint256 paid)",
  "event ContainerPaid(address indexed container, uint40 paidUntil)",
  "event Unbound(bytes32 indexed domainHash, address indexed container)",
]);

/** Minimal ERC-1967 UUPS surface used to read/pin implementations (never trust `implementation()`). */
export const uupsAbi = parseAbi([
  "function implementation() view returns (address)",
  "function proxiableUUID() view returns (bytes32)",
  "function owner() view returns (address)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
]);
