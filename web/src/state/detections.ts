/**
 * What the models saw: detections (no masks), SAM 3 runs (heatmap refs), and masks with their alias sets, loaded per
 * frame (`maskFrames` lists frames loaded or loading). Removing a clip drops the masks for its frames.
 */
import { slice } from "./slice.ts";
import type { DetRow, Det, Mask, Run } from "./types.ts";

export type DetectionsState = {
  readonly dets: readonly Det[];
  readonly runs: readonly Run[];
  readonly masks: ReadonlyMap<string, Mask>;
  readonly maskFrames: ReadonlySet<number>;
};

export const createDetectionsStore = () =>
  slice<DetectionsState>(() => ({ dets: [], runs: [], masks: new Map(), maskFrames: new Set() }));

/** Turns data.dets rows (mask: "rle", aliases: true) into masks by detection id, skipping rows without an rle mask. */
export function masksOf(rows: readonly DetRow[]): ReadonlyMap<string, Mask> {
  return new Map(
    rows.flatMap((d) => (d.mask?.format === "rle" ? [[d.id, { rle: d.mask, aliases: d.aliases ?? [] }] as const] : [])),
  );
}
