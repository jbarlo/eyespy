/**
 * Track files. tracks.json is the index and assoc.json what association decided. Under clips/<key>/tracks/<id>/ a track has seed.npz, a mask-NNN.npz per frame
 * and a mem-<direction>-NNN.npz per leg. Memory tokens are bfloat16, which upstream rounds them to, so they are stored
 * as the upper half of their float32 bits with no loss.
 */
import { z } from "zod";
import { isDetId, type DetId } from "../../detections/pure.ts";
import { parseJson } from "../../railway/index.ts";
import { MASK_SIZE } from "../../perception/pure.ts";
import type { StoredSeed } from "../../tracking/ports.ts";
import {
  EMPTY_ASSOC,
  EMPTY_TRACK_INDEX,
  type AssocData,
  MEMORY_LEN,
  POINTER_LEN,
  type TrackIndex,
  type TrackMask,
  type TrackedFrame,
} from "../../tracking/pure.ts";
import { isClipKey, isFrameNo, type ClipKey, type FrameNo } from "../../video/pure.ts";
import { packbits, readNpz, unpackbits, writeNpz } from "./npz.kernel.ts";
import { bf16Bits, bf16Floats } from "./tracks.kernel.ts";

const MASK_PIXELS = MASK_SIZE * MASK_SIZE;
const clip = z.custom<ClipKey>((v) => typeof v === "string" && isClipKey(v), "not a clip key");

const IndexSchema = z.object({
  paused: z.boolean(),
  next: z.number().int().positive(),
  tracks: z.array(
    z.object({
      id: z.string().regex(/^t\d+$/),
      det: z.custom<DetId>((v) => typeof v === "string" && isDetId(v), "not a detection id"),
      clip,
      seedAt: z.number().int().nonnegative(),
      clipFrames: z.number().int().positive(),
      first: z.number().int().nonnegative(),
      last: z.number().int().nonnegative(),
      priority: z.number().int(),
      state: z.enum(["active", "cancelled", "failed"]),
      failure: z.string().nullable(),
      seeded: z.boolean(),
      forward: z.number().int(),
      reverse: z.number().int(),
      parkAfter: z.number().int().positive(),
      recheck: z.number().int().positive(),
      forwardMisses: z.number().int().nonnegative(),
      reverseMisses: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      seenFirst: z.number().int(),
      seenLast: z.number().int(),
      seenCount: z.number().int().nonnegative(),
      auto: z.boolean(),
    }),
  ),
  pending: z.array(
    z.object({
      clip,
      at: z.number().int().nonnegative(),
      frame: z.custom<FrameNo>((v) => typeof v === "number" && isFrameNo(v), "not a frame number"),
      threshold: z.number(),
      maxTracks: z.number().int(),
      parkAfter: z.number().int().positive(),
      recheck: z.number().int().positive(),
    }),
  ),
  pairs: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      frames: z.number().int().positive(),
      first: z.number().int().nonnegative(),
      last: z.number().int().nonnegative(),
    }),
  ),
});

const det = z.custom<DetId>((v) => typeof v === "string" && isDetId(v), "not a detection id");
const AssocSchema = z.object({
  links: z.record(
    z.string(),
    z.object({
      how: z.enum(["seed", "match", "dup", "small", "over"]),
      track: z.string().nullable(),
      of: det.optional(),
    }),
  ),
  weak: z.array(z.object({ det, track: z.string(), iou: z.number(), score: z.number() })),
});

/** Association from its file's text, empty if there is no file or the text doesn't parse. It can be made again. */
export const decodeAssoc = (text: string | null): AssocData => {
  if (text === null) return EMPTY_ASSOC;
  const r = AssocSchema.safeParse(parseJson(text).unwrapOr(null));
  return r.success ? r.data : EMPTY_ASSOC;
};

/** The index from its file's text, empty if there is no file, or null if the text doesn't parse. */
export const decodeTrackIndex = (text: string | null): TrackIndex | null => {
  if (text === null) return EMPTY_TRACK_INDEX;
  const r = IndexSchema.safeParse(parseJson(text).unwrapOr(null));
  return r.success ? r.data : null;
};

// Tokens and pointers are incompressible, and a unit writes them each time, so these zips only store.
const STORE = 0;

export const encodeSeed = (s: StoredSeed, ms: number): Uint8Array =>
  writeNpz(
    [
      ["tokens", { dtype: "<u2", shape: [MEMORY_LEN], data: bf16Bits(s.tokens) }],
      ["pointer", { dtype: "<f4", shape: [POINTER_LEN], data: s.pointer }],
    ],
    ms,
    STORE,
  );

export const decodeSeed = (b: Uint8Array): StoredSeed | null => {
  const a = readNpz(b).unwrapOr(null);
  const tokens = a?.get("tokens")?.data;
  const pointer = a?.get("pointer")?.data;
  return tokens instanceof Uint16Array && tokens.length === MEMORY_LEN && pointer instanceof Float32Array
    ? { tokens: bf16Floats(tokens), pointer }
    : null;
};

export const encodeMask = (m: TrackMask, ms: number): Uint8Array =>
  writeNpz(
    [
      ["mask", { dtype: "|u1", shape: [Math.ceil(MASK_PIXELS / 8)], data: packbits(m.mask) }],
      ["info", { dtype: "<f4", shape: [2], data: Float32Array.of(m.score, m.iou) }],
    ],
    ms,
  );

export const decodeMask = (b: Uint8Array): TrackMask | null => {
  const a = readNpz(b).unwrapOr(null);
  const mask = a?.get("mask")?.data;
  const info = a?.get("info")?.data;
  return mask instanceof Uint8Array && info instanceof Float32Array
    ? { mask: unpackbits(mask, MASK_PIXELS), score: info[0] ?? 0, iou: info[1] ?? 0 }
    : null;
};

/** The frames oldest first, and tokens for the last `kept` of them, which are the only ones that have any. */
export const encodeMemory = (recent: readonly TrackedFrame[], ms: number): Uint8Array => {
  const kept = recent.flatMap((f) => (f.tokens ? [f.tokens] : []));
  const tokens = new Uint16Array(kept.length * MEMORY_LEN);
  kept.forEach((t, k) => tokens.set(bf16Bits(t), k * MEMORY_LEN));
  const pointers = new Float32Array(recent.length * POINTER_LEN);
  recent.forEach((f, k) => pointers.set(f.pointer, k * POINTER_LEN));
  return writeNpz(
    [
      ["ats", { dtype: "<i4", shape: [recent.length], data: Int32Array.from(recent.map((f) => f.at)) }],
      ["tokens", { dtype: "<u2", shape: [kept.length, MEMORY_LEN], data: tokens }],
      ["pointers", { dtype: "<f4", shape: [recent.length, POINTER_LEN], data: pointers }],
    ],
    ms,
    STORE,
  );
};

export const decodeMemory = (b: Uint8Array): readonly TrackedFrame[] | null => {
  const a = readNpz(b).unwrapOr(null);
  const ats = a?.get("ats")?.data;
  const tokens = a?.get("tokens")?.data;
  const pointers = a?.get("pointers")?.data;
  if (!(ats instanceof Int32Array && tokens instanceof Uint16Array && pointers instanceof Float32Array)) return null;
  const firstKept = ats.length - tokens.length / MEMORY_LEN;
  return Array.from(ats, (at, k) => ({
    at,
    tokens:
      k < firstKept
        ? null
        : bf16Floats(tokens.subarray((k - firstKept) * MEMORY_LEN, (k - firstKept + 1) * MEMORY_LEN)),
    pointer: pointers.slice(k * POINTER_LEN, (k + 1) * POINTER_LEN),
  }));
};
