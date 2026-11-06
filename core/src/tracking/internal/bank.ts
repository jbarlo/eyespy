/**
 * Which memory a frame reads, and what a tracked frame leaves behind. The rules are upstream's
 * `_gather_memory_frame_outputs` and `_get_object_pointers` with num_maskmem 3: the seed's block, then the two previous
 * frames' blocks, then the seed's pointer and those of up to 15 previous frames.
 */
import { MAX_POINTERS, RECENT_BLOCKS, type TrackMemory, type TrackedFrame } from "../pure.ts";

/** Row of the temporal position table for the seed's block, which is its last entry. */
const SEED_TEMPORAL_ROW = 6;

type MemoryBlock = {
  readonly tokens: Float32Array;
  /** Row of the temporal position table: offset - 1, or SEED_TEMPORAL_ROW. */
  readonly row: number;
};
type MemoryPointer = {
  readonly pointer: Float32Array;
  /** Frames between it and the current frame, in the track's direction. */
  readonly offset: number;
};
export type MemorySelection = {
  readonly blocks: readonly MemoryBlock[];
  readonly pointers: readonly MemoryPointer[];
  /** What pointer offsets are divided by. The seed's offset may exceed it, as upstream. */
  readonly maxOffset: number;
};

/** How far `from` lies before `at` in the track's direction. */
const distance = (m: TrackMemory, from: number, at: number): number =>
  m.direction === "forward" ? at - from : from - at;

/** The frame this track last covered. */
export const lastFrame = (m: TrackMemory): number => m.recent.at(-1)?.at ?? m.seed.at;

/** Whether the track may move on to frame `at`. */
export const canReach = (m: TrackMemory, at: number): boolean =>
  Number.isInteger(at) && at >= 0 && at < m.seed.clipFrames && distance(m, lastFrame(m), at) > 0;

export function selectMemory(m: TrackMemory, at: number): MemorySelection {
  const span = Math.min(m.seed.clipFrames, MAX_POINTERS);
  const withOffset = m.recent.map((frame) => ({ frame, offset: distance(m, frame.at, at) }));
  const recentBlocks = withOffset
    .filter((e) => e.offset <= RECENT_BLOCKS && e.frame.tokens !== null)
    .toSorted((a, b) => b.offset - a.offset)
    .flatMap((e) => (e.frame.tokens ? [{ tokens: e.frame.tokens, row: e.offset - 1 }] : []));
  const recentPointers = withOffset
    .filter((e) => e.offset < span)
    .toSorted((a, b) => a.offset - b.offset)
    .map((e) => ({ pointer: e.frame.pointer, offset: e.offset }));
  return {
    blocks: [{ tokens: m.seed.tokens, row: SEED_TEMPORAL_ROW }, ...recentBlocks],
    pointers: [{ pointer: m.seed.pointer, offset: distance(m, m.seed.at, at) }, ...recentPointers],
    maxOffset: span - 1,
  };
}

/**
 * The track's state with `frame` added. It forgets what no later frame can read: the next frame is at least one on,
 * so tokens last RECENT_BLOCKS frames and pointers MAX_POINTERS - 1.
 */
export function remember(m: TrackMemory, frame: TrackedFrame): TrackMemory {
  const kept = m.recent.flatMap((old): readonly TrackedFrame[] => {
    const age = distance(m, old.at, frame.at) + 1;
    if (age >= MAX_POINTERS) return [];
    return [age > RECENT_BLOCKS ? { ...old, tokens: null } : old];
  });
  return { ...m, recent: [...kept, frame] };
}
