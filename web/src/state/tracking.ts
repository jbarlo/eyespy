/**
 * Video tracking as the app shows it, with `?models=<base>&tracker` only: the queue's status, what association proposes,
 * each clip's tracking grid, and the place on that grid being shown. Tracks are what the tracker made of a seed, and they
 * can jump onto another object, so nothing here calls a track that object.
 */
import { CONVERGED_FRAMES, COVER_SCORE } from "eyespy-core/tracking/pure";
import { slice } from "./slice.ts";
import type { Outputs } from "../engine/port.ts";
import type { Rle } from "./types.ts";

export type TrackStatus = Outputs["track"]["status"];
export type TrackRow = TrackStatus["tracks"][number];
export type TrackProposals = Outputs["track"]["proposals"];
export type TrackGrid = Outputs["track"]["frames"];
export type TrackMasks = Outputs["track"]["masks"];
export type TrackSlot = TrackGrid["frames"][number];

export type TrackingState = {
  readonly status: TrackStatus | null;
  readonly proposals: TrackProposals | null;
  readonly grids: ReadonlyMap<string, TrackGrid>;
  /** The place on the shown clip's grid when it lies between keyframes, else null: the shown keyframe's own place. */
  readonly at: number | null;
  /** The masks last read, for one place. */
  readonly masks: TrackMasks | null;
  readonly show: boolean;
};

export const createTrackingStore = () =>
  slice<TrackingState>(() => ({ status: null, proposals: null, grids: new Map(), at: null, masks: null, show: true }));

/** One tracked mask as the canvas draws it. */
export type TrackDraw = {
  /** Sprite id, unique per track and frame. */
  readonly id: string;
  readonly track: string;
  readonly det: string;
  readonly rle: Rle;
  readonly color: string;
  /** Why it looks different from a solid track, or null. */
  readonly unsure: "score" | "overlap" | null;
  readonly score: number;
  readonly label: string;
  /** Over the mask's own w and h. */
  readonly box: readonly [number, number, number, number];
  readonly selected: boolean;
};

/** A track that has a frame at `at`: a mask there, or parked over it. */
const covers = (t: TrackRow, clip: string, at: number): boolean =>
  t.clip === clip && t.seen !== null && t.reverse <= at && at <= t.forward;

/** The tracks of a clip that have read this place, as `track.masks` counts them. */
export const coveringCount = (tracks: readonly TrackRow[], clip: string, at: number): number =>
  tracks.filter((t) => covers(t, clip, at)).length;

/** The box of a run-length mask, row by row: runs alternate off and on, starting with off. */
export function rleBox(counts: readonly number[], w: number): TrackDraw["box"] | null {
  const runs = counts.reduce<{ readonly at: number; readonly on: readonly (readonly [number, number])[] }>(
    (acc, c, k) => ({ at: acc.at + c, on: k % 2 && c > 0 ? [...acc.on, [acc.at, acc.at + c - 1]] : acc.on }),
    { at: 0, on: [] },
  ).on;
  const first = runs[0];
  const last = runs.at(-1);
  if (!first || !last) return null;
  const xs = runs.flatMap(([a, b]) => (Math.floor(a / w) === Math.floor(b / w) ? [a % w, (b % w) + 1] : [0, w]));
  return [Math.min(...xs), Math.floor(first[0] / w), Math.max(...xs), Math.floor(last[1] / w) + 1];
}

/** Whether another track was on the same thing around this place, which is a suggestion, not a fact. */
const overlapAt = (proposals: TrackProposals | null, track: string, at: number): boolean =>
  (proposals?.groups ?? [])
    .flatMap((g) => g.tracks)
    .some(
      (t) =>
        t.track === track &&
        t.converged_with.some((c) => c.frames >= CONVERGED_FRAMES && c.first <= at && at <= c.last),
    );

/** Why a track's mask on this place looks unsure. */
export const unsureAt = (
  proposals: TrackProposals | null,
  track: string,
  at: number,
  score: number,
): TrackDraw["unsure"] => (score < COVER_SCORE ? "score" : overlapAt(proposals, track, at) ? "overlap" : null);

/** Which track holds each detection association placed. */
export const trackOfDet = (proposals: TrackProposals | null): ReadonlyMap<string, string> =>
  new Map<string, string>(
    (proposals?.groups ?? []).flatMap((g) => g.tracks).flatMap((t) => t.dets.map((d) => [d.id, t.track] as const)),
  );

/** What the queue is doing, in the words the panel needs to pick its sentence. */
export type TrackingPhase =
  | { readonly kind: "off" }
  | { readonly kind: "paused" }
  /** The first pass through a clip: its frames are being read once and saved. */
  | { readonly kind: "preparing"; readonly clip: string; readonly read: number; readonly frames: number }
  | { readonly kind: "running" }
  | { readonly kind: "stopped" }
  | { readonly kind: "finished" };

/** Places of a clip some track has reached: their trunks are stored, so later tracks don't have to read them. */
const reached = (tracks: readonly TrackRow[], clip: string): number =>
  new Set(
    tracks
      .filter((t) => t.clip === clip && t.seen !== null)
      .flatMap((t) => Array.from({ length: t.forward - t.reverse + 1 }, (_, k) => t.reverse + k)),
  ).size;

const inQueue = (t: TrackRow) => t.state === "active" && !t.finished;

/** The track the queue runs next among those of the highest priority: the oldest. */
export const nextInLine = (tracks: readonly TrackRow[]): TrackRow | null => {
  const queue = tracks.filter(inQueue);
  const top = Math.max(...queue.map((t) => t.priority));
  return queue.find((t) => t.priority === top) ?? null;
};

export function trackingPhase(status: TrackStatus | null, grids: TrackingState["grids"]): TrackingPhase {
  if (!status || (!status.tracks.length && !status.waiting)) return { kind: "off" };
  const next = nextInLine(status.tracks);
  const left = next !== null || status.waiting > 0;
  if (left && status.paused) return { kind: "paused" };
  if (!left) return { kind: status.tracks.some((t) => t.state === "cancelled") ? "stopped" : "finished" };
  if (!next) return { kind: "running" };
  const frames = grids.get(next.clip)?.frames.length ?? next.total;
  const read = reached(status.tracks, next.clip);
  // no track has finished on this clip yet: reading frames is most of the work
  const first = !status.tracks.some((t) => t.clip === next.clip && t.finished);
  return first && read < frames ? { kind: "preparing", clip: next.clip, read, frames } : { kind: "running" };
}
