/**
 * Keyframes and videos: the session's keyframes (global numbers; a removed clip leaves a gap), the one shown, and the
 * clips list. `clipsWatched` is set while the Videos panel is open.
 */
import type { Result } from "neverthrow";
import type { FrameSpecError } from "eyespy-core/video/pure";
import { parseFrameSpec } from "eyespy-core/video/pure";
import { slice } from "./slice.ts";
import type { Clip, Frame } from "./types.ts";

export type FramesState = {
  readonly frames: readonly Frame[];
  /** The keyframe shown, as a global number. */
  readonly current: number;
  readonly clips: readonly Clip[] | null;
  readonly clipsWatched: boolean;
};

export const createFramesStore = () =>
  slice<FramesState>(() => ({ frames: [], current: 0, clips: null, clipsWatched: false }));

/** The keyframe number closest to `i` that exists (0 when there are none). */
export function nearestFrame(frames: readonly Frame[], i: number): number {
  return frames.reduce(
    (best, f) => (Math.abs(f.frame - i) < Math.abs(best - i) ? f.frame : best),
    frames[0]?.frame ?? 0,
  );
}

/**
 * The existing keyframe numbers in a spec like "0-5,9", in spec order, once each, by parseFrameSpec's rules. It keeps
 * only keyframes that exist, since a removed clip leaves a gap.
 */
export function parseSpec(spec: string, frames: readonly Frame[]): Result<readonly number[], FrameSpecError> {
  const have: ReadonlySet<number> = new Set(frames.map((f) => f.frame));
  return parseFrameSpec(spec, (frames.at(-1)?.frame ?? -1) + 1).map((fs) =>
    [...new Set(fs)].filter((i) => have.has(i)),
  );
}

/** Keyframe numbers as a compact spec, the inverse of parseSpec. [5, 0, 1, 2, 9] becomes "0-2,5,9". */
export function toSpec(frames: readonly number[]): string {
  const sorted = [...new Set(frames)].toSorted((a, b) => a - b);
  const runs = sorted.reduce<readonly (readonly [number, number])[]>((acc, i) => {
    const last = acc.at(-1);
    return last && last[1] === i - 1 ? [...acc.slice(0, -1), [last[0], i] as const] : [...acc, [i, i] as const];
  }, []);
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(",");
}

/** A bad spec as the CLI words it. */
export const specMessage = (e: FrameSpecError): string => `bad frame spec: ${e.part}`;
