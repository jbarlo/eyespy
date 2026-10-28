/**
 * The global keyframe numbering as an immutable value. It lists every clip in index order, tombstones included,
 * with a slot per keyframe. Every change rebuilds it.
 */
import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import type { Clip, ClipKey, FrameNo, FrameSlot, NoKeyframe } from "../pure.ts";
import { isFrameNo } from "../pure.ts";
import type { VideoError } from "../types.ts";

export type Timeline = {
  readonly clips: readonly Clip[];
  /** Indexed by FrameNo. */
  readonly slots: readonly FrameSlot[];
  /** First global index of each clip, by position in `clips`. */
  readonly firsts: readonly number[];
};

export const timeline = (clips: readonly Clip[]): Timeline => {
  const slots = clips.flatMap((clip) => clip.times.map((t, index): FrameSlot => ({ clip, index, t })));
  const firsts = clips.reduce<readonly number[]>(
    (acc, c, k) => [...acc, k === 0 ? 0 : (acc[k - 1] ?? 0) + (clips[k - 1]?.times.length ?? 0)],
    [],
  );
  return { clips, slots, firsts };
};

export const withClip = (tl: Timeline, k: number, clip: Clip): Timeline =>
  timeline(tl.clips.map((c, j) => (j === k ? clip : c)));
export const appended = (tl: Timeline, clip: Clip): Timeline => timeline([...tl.clips, clip]);

export const slot = (tl: Timeline, i: number): Result<FrameSlot, NoKeyframe> => {
  const s = Number.isInteger(i) && i >= 0 ? tl.slots[i] : undefined;
  return s ? ok(s) : err({ kind: "no-keyframe", frame: i });
};

export const isLive = (tl: Timeline, i: number): i is FrameNo => {
  const s = Number.isInteger(i) && i >= 0 ? tl.slots[i] : undefined;
  return s !== undefined && s.clip.removed === null;
};

export const liveClips = (tl: Timeline): readonly Clip[] => tl.clips.filter((c) => c.removed === null);

/** Global indices of the clip at position k. */
export const framesAt = (tl: Timeline, k: number): readonly FrameNo[] => {
  const first = tl.firsts[k] ?? 0;
  return (tl.clips[k]?.times ?? []).map((_, j) => first + j).filter(isFrameNo);
};

export const positionOf = (tl: Timeline, key: ClipKey): number => tl.clips.findIndex((c) => c.key === key);

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * "#<i>[ <clip stem>] <t>s", or "#<i>[ <clip stem>] photo <position>" for a folder of photos. The stem appears only
 * if several clips are live.
 */
export const tagOf = (tl: Timeline, s: FrameSlot, i: FrameNo): string => {
  const stem = basename(s.clip.path).replace(/\.[^.]*$/, "");
  const name = liveClips(tl).length > 1 ? ` ${stem}` : "";
  return s.clip.timing.kind === "stills" ? `#${i}${name} photo ${s.t}` : `#${i}${name} ${s.t.toFixed(1)}s`;
};

/**
 * Finds a clip by key, then by path (as given or resolved), then by file name. Each step tries live clips first,
 * then all clips including removed ones. More than one match is an error.
 */
export const find = (tl: Timeline, ref: string, resolved: string): Result<Clip, VideoError> => {
  const matchers: readonly ((c: Clip) => boolean)[] = [
    (c) => c.key === ref,
    (c) => c.path === ref || c.path === resolved,
    (c) => basename(c.path) === basename(ref),
  ];
  const step = (k: number): Result<Clip, VideoError> => {
    const match = matchers[k];
    if (!match) return err({ kind: "no-clip", ref });
    const live = liveClips(tl).filter(match);
    const all = live.length ? live : tl.clips.filter(match);
    const [one, ...more] = all;
    if (one && more.length === 0) return ok(one);
    if (one) return err({ kind: "ambiguous-clip", ref, keys: all.map((c) => c.key) });
    return step(k + 1);
  };
  return step(0);
};
