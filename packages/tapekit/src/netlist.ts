/**
 * Netlist encoder — the byte layout `NetlistVM.sol` reads on chain
 * (SPEC `2026-10-28-self-mint-spec.md` §3).
 *
 * The format is unforgiving and the tapeout is irreversible, so this module refuses to
 * encode anything it cannot prove is well formed rather than letting the contract revert
 * after the user has paid.
 *
 * Signal space:
 *   [0]       constant 0
 *   [1]       constant 1
 *   [2 .. 2+nIn-1]   input pins
 *   then one signal per element, in declaration order
 *
 * Element bytes (multi-byte integers big-endian):
 *   NAND  0x00 | a(u24) | b(u24)                 7 bytes, 1 signal out
 *   LATCH 0x01 | d(u24)                          4 bytes, 1 signal out
 *   REF   0x02 | cpu(20B) | cid(u64) | rIn(1) | rOut(1) | rIn × input(u24)
 *                                               30 + 3·rIn bytes, rOut signals out
 *
 * Outputs are the LAST `nOut` signals, so declaration order decides which pin is which.
 */

/** Element opcodes, matching `NetlistVM.sol`'s OP_NAND / OP_LATCH / OP_REF. */
export const NETLIST_OP = Object.freeze({ NAND: 0, LATCH: 1, REF: 2 } as const);

export const CONSTANT_ZERO = 0;
export const CONSTANT_ONE = 1;
export const FIRST_INPUT_SIGNAL = 2;

/** A u24 index covers this, which bounds the whole signal space. */
const U24_MAX = 0xffffff;

export interface NandElement {
  readonly op: typeof NETLIST_OP.NAND;
  /** Must reference an already-existing signal: forward references are illegal. */
  readonly a: number;
  readonly b: number;
}

export interface LatchElement {
  readonly op: typeof NETLIST_OP.LATCH;
  /**
   * May reference a later signal — that is how a feedback loop is expressed — but it must
   * still land inside the signal space.
   */
  readonly d: number;
}

export interface RefElement {
  readonly op: typeof NETLIST_OP.REF;
  readonly cpu: `0x${string}`;
  readonly cid: bigint;
  readonly inputs: readonly number[];
  readonly outputs: number;
}

export type NetlistElement = NandElement | LatchElement | RefElement;

/** `nand(a, b)`; both indices must already exist when the element is encoded. */
export function nand(a: number, b: number): NandElement {
  return { op: NETLIST_OP.NAND, a, b };
}

/** `latch(d)`; `d` may point forward to close a feedback loop. */
export function latch(d: number): LatchElement {
  return { op: NETLIST_OP.LATCH, d };
}

/** `ref(...)` — reuse another circuit's outputs as this circuit's inputs. */
export function ref(input: {
  readonly cpu: `0x${string}`;
  readonly cid: bigint;
  readonly inputs: readonly number[];
  readonly outputs: number;
}): RefElement {
  return { op: NETLIST_OP.REF, ...input };
}

/**
 * The single circuit this platform offers first: `out = NOT in`.
 *
 * One NAND with both inputs tied to the same signal is an inverter, and it is the smallest
 * circuit that produces a real, usable container: `nIn=1`, `nOut=1`, one gate, no state.
 * SPEC §3 fixes this on purpose — a menu of circuits nobody can verify is worse than one
 * that has been measured end to end.
 */
export function inverterCircuit(): {
  readonly nIn: number;
  readonly nOut: number;
  readonly ops: readonly NetlistElement[];
} {
  // Signal 2 is the single input; feeding it to both NAND inputs inverts it.
  return { nIn: 1, nOut: 1, ops: [nand(FIRST_INPUT_SIGNAL, FIRST_INPUT_SIGNAL)] };
}

export interface EncodedNetlist {
  /** Concatenated element bytes, as passed to `tapeout(bytes,uint32,uint32)`. */
  readonly bytes: Uint8Array;
  readonly hex: `0x${string}`;
  /** Total signals the VM will hold, including the two constants and the inputs. */
  readonly signalCount: number;
}

export class NetlistEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetlistEncodingError";
  }
}

function u24(value: number, field: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > U24_MAX) {
    throw new NetlistEncodingError(`${field} must be a u24 index, got ${String(value)}`);
  }
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u64(value: bigint, field: string): Uint8Array {
  if (value < 0n || value >= 1n << 64n) {
    throw new NetlistEncodingError(`${field} must be a u64, got ${value.toString()}`);
  }
  const out = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function addressBytes(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new NetlistEncodingError(`cpu must be a 20-byte hex address, got ${value}`);
  }
  const out = new Uint8Array(20);
  for (let index = 0; index < 20; index += 1) {
    out[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return out;
}

/**
 * Encode a netlist.
 *
 * Validation happens here rather than in the contract because the contract's revert arrives
 * after the user has signed and paid gas. Rules enforced (§3):
 * - a NAND input may not reference a signal that does not exist yet;
 * - a LATCH target may point forward, but must still be inside the final signal space;
 * - outputs are the last `nOut` signals, so `nOut` may not exceed what the elements produce.
 */
export function encodeNetlist(
  ops: readonly NetlistElement[],
  nIn: number,
  nOut: number,
): EncodedNetlist {
  if (!Number.isSafeInteger(nIn) || nIn < 1 || nIn > U24_MAX) {
    throw new NetlistEncodingError(`nIn must be a positive u24, got ${String(nIn)}`);
  }
  if (!Number.isSafeInteger(nOut) || nOut < 1 || nOut > U24_MAX) {
    throw new NetlistEncodingError(`nOut must be a positive u24, got ${String(nOut)}`);
  }
  if (ops.length === 0) {
    // A circuit with no elements has no output to point at; the VM would reject it and the
    // user would have paid for the privilege.
    throw new NetlistEncodingError("a netlist needs at least one element");
  }

  // Signals that exist so far: two constants plus the inputs.
  let nextSignal = FIRST_INPUT_SIGNAL + nIn;
  const totalSignalsAfter = (() => {
    let count = nextSignal;
    for (const op of ops) {
      count += op.op === NETLIST_OP.REF ? op.outputs : 1;
    }
    return count;
  })();

  const chunks: Uint8Array[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op === NETLIST_OP.NAND) {
      for (const [name, signal] of [
        ["a", op.a],
        ["b", op.b],
      ] as const) {
        // Forward references are illegal for NAND: the value would not exist yet.
        if (signal < 0 || signal >= nextSignal) {
          throw new NetlistEncodingError(
            `op[${String(index)}].${name} references signal ${String(signal)}, but only ` +
              `${String(nextSignal)} signals exist at that point`,
          );
        }
      }
      chunks.push(new Uint8Array([NETLIST_OP.NAND]), u24(op.a, `${index}.a`), u24(op.b, `${index}.b`));
      nextSignal += 1;
      continue;
    }
    if (op.op === NETLIST_OP.LATCH) {
      // A latch may point forward (it reads the previous clock's value), but the target has
      // to be a signal that will exist by the time the circuit runs.
      if (op.d < 0 || op.d >= totalSignalsAfter) {
        throw new NetlistEncodingError(
          `op[${String(index)}].d references signal ${String(op.d)}, outside the ` +
            `${String(totalSignalsAfter)}-signal space`,
        );
      }
      chunks.push(new Uint8Array([NETLIST_OP.LATCH]), u24(op.d, `${index}.d`));
      nextSignal += 1;
      continue;
    }
    if (op.op === NETLIST_OP.REF) {
      if (!Number.isSafeInteger(op.outputs) || op.outputs < 1 || op.outputs > 0xff) {
        throw new NetlistEncodingError(
          `op[${String(index)}].outputs must be 1..255, got ${String(op.outputs)}`,
        );
      }
      if (op.inputs.length > 0xff) {
        throw new NetlistEncodingError(`op[${String(index)}] has too many inputs`);
      }
      for (const input of op.inputs) {
        if (input < 0 || input >= nextSignal) {
          throw new NetlistEncodingError(
            `op[${String(index)}] references input signal ${String(input)}, but only ` +
              `${String(nextSignal)} signals exist at that point`,
          );
        }
      }
      chunks.push(
        new Uint8Array([NETLIST_OP.REF]),
        addressBytes(op.cpu),
        u64(op.cid, `${index}.cid`),
        new Uint8Array([op.inputs.length, op.outputs]),
        ...op.inputs.map((signal, position) => u24(signal, `${index}.inputs[${String(position)}]`)),
      );
      nextSignal += op.outputs;
      continue;
    }
    // Exhaustive: a new opcode must be handled rather than silently encoded as NAND.
    throw new NetlistEncodingError(`unknown element opcode ${String((op as { op: unknown }).op)}`);
  }

  if (nOut > nextSignal) {
    throw new NetlistEncodingError(
      `nOut (${String(nOut)}) exceeds the ${String(nextSignal)} signals the netlist produces`,
    );
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, hex: toHex(bytes), signalCount: nextSignal };
}

function toHex(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}
