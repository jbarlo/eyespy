/** Tensor layouts for the tracker graphs: the loops that build attention's memory inputs and convert masks and tokens. */
import { invariant } from "../../invariant/index.ts";
import { MEMORY_LEN, POINTER_LEN } from "../pure.ts";
import type { MemorySelection } from "./bank.ts";

const TOKENS = 72 * 72;
const MEM_DIM = 64;
/** A pointer becomes this many tokens of MEM_DIM values. */
const POINTER_SPLIT = POINTER_LEN / MEM_DIM;
const PE_DIM = POINTER_LEN / 2;

/** The bank-side tables the tracker graphs were exported with (tables.onnx). */
export type Tables = {
  /** [5184, 64] spatial position of a memory token. */
  readonly memPos: Float32Array;
  /** [7, 64] temporal position of a memory block. */
  readonly tpos: Float32Array;
  /** [64, 256] and [64]: the linear layer from a pointer's sine position to its position. */
  readonly tprojW: Float32Array;
  readonly tprojB: Float32Array;
  /** [1, 256, 72, 72] the dense prompt when no mask is given. */
  readonly noMask: Float32Array;
};

/** One vector over the grid, channels first. */
export function denseFromVector(v: Float32Array): Float32Array {
  const out = new Float32Array(v.length * TOKENS);
  for (let c = 0; c < v.length; c++) out.fill(v[c]!, c * TOKENS, (c + 1) * TOKENS);
  return out;
}

/**
 * [64, 72, 72] channels first, to token by token, rounded to bfloat16 as upstream's `_encode_new_memory` stores them.
 * Tracks diverge from upstream's without that rounding. The rounding is the one of torch's float-to-bfloat16 cast,
 * to nearest and to even on a tie, on the upper half of the float32 bits.
 */
export function memoryTokens(mem: Float32Array): Float32Array {
  invariant(mem.length === MEMORY_LEN, () => `memory tokens: ${mem.length} values, need ${MEMORY_LEN}`);
  const out = new Float32Array(MEMORY_LEN);
  for (let c = 0; c < MEM_DIM; c++) for (let i = 0; i < TOKENS; i++) out[i * MEM_DIM + c] = mem[c * TOKENS + i]!;
  const bits = new Uint32Array(out.buffer);
  for (let i = 0; i < MEMORY_LEN; i++) {
    const b = bits[i]!;
    bits[i] = ((b + 0x7fff + ((b >>> 16) & 1)) >>> 16) << 16;
  }
  return out;
}

export type SeedMask = {
  readonly area: number;
  /** 0 or 1, for mask_embed. */
  readonly binary: Float32Array;
  /** -10 or +10, as _use_mask_as_output makes logits of the mask, for memenc. */
  readonly logits: Float32Array;
};

export function seedMask(mask: Uint8Array): SeedMask {
  const binary = new Float32Array(mask.length);
  const logits = new Float32Array(mask.length);
  let area = 0;
  for (let i = 0; i < mask.length; i++) {
    const on = mask[i] ? 1 : 0;
    area += on;
    binary[i] = on;
    logits[i] = on * 20 - 10;
  }
  return { area, binary, logits };
}

/** get_1d_sine_pe at offset / maxOffset through the projection layer, written to `out` at `at`. */
function pointerPosition(offset: number, maxOffset: number, t: Tables, out: Float32Array, at: number): void {
  const v = offset / maxOffset;
  const pe = new Float32Array(POINTER_LEN);
  for (let i = 0; i < PE_DIM; i++) {
    const a = v / Math.pow(10000, (2 * Math.floor(i / 2)) / PE_DIM);
    pe[i] = Math.sin(a);
    pe[PE_DIM + i] = Math.cos(a);
  }
  for (let r = 0; r < MEM_DIM; r++) {
    let s = t.tprojB[r]!;
    for (let c = 0; c < POINTER_LEN; c++) s += t.tprojW[r * POINTER_LEN + c]! * pe[c]!;
    out[at + r] = s;
  }
}

export type MemoryInputs = {
  /** [1, blocks × 5184, 64] */
  readonly spatial: Float32Array;
  readonly spatialPos: Float32Array;
  readonly spatialTokens: number;
  /** [1, pointers × 4, 64] */
  readonly pointer: Float32Array;
  readonly pointerPos: Float32Array;
  readonly pointerTokens: number;
};

export function memoryInputs(sel: MemorySelection, t: Tables): MemoryInputs {
  const spatialTokens = sel.blocks.length * TOKENS;
  const spatial = new Float32Array(spatialTokens * MEM_DIM);
  const spatialPos = new Float32Array(spatialTokens * MEM_DIM);
  sel.blocks.forEach((b, k) => {
    const start = k * MEMORY_LEN;
    spatial.set(b.tokens, start);
    const row = b.row * MEM_DIM;
    for (let i = 0; i < MEMORY_LEN; i++) spatialPos[start + i] = t.memPos[i]! + t.tpos[row + (i % MEM_DIM)]!;
  });
  const pointerTokens = sel.pointers.length * POINTER_SPLIT;
  const pointer = new Float32Array(sel.pointers.length * POINTER_LEN);
  const pointerPos = new Float32Array(sel.pointers.length * POINTER_LEN);
  sel.pointers.forEach((p, k) => {
    const start = k * POINTER_LEN;
    pointer.set(p.pointer, start);
    pointerPosition(p.offset, sel.maxOffset, t, pointerPos, start);
    for (let s = 1; s < POINTER_SPLIT; s++) pointerPos.copyWithin(start + s * MEM_DIM, start, start + MEM_DIM);
  });
  return { spatial, spatialPos, spatialTokens, pointer, pointerPos, pointerTokens };
}
