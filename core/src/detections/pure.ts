/**
 * Detection identity, shapes and pure functions, which any code may import as values. The "frame.n" id format is
 * private to this module and storage. Everyone else uses `frameOf` and `ordinalOf`.
 */
import { at, invariant } from "../invariant/index.ts";
import type { Appearance, Instance } from "../perception/pure.ts";
import { similarity } from "../perception/pure.ts";
import type { Box, Shape } from "../pixels/index.ts";
import { fromRunLengths, paintMasks, runLengths } from "../pixels/index.ts";
import type { FrameNo } from "../video/pure.ts";
import { isFrameNo } from "../video/pure.ts";
import { groupIndices } from "./internal/groups.kernel.ts";

/** "frame.n" names the n-th detection ever minted on that global keyframe. Ids are never renumbered. */
export type DetId = string & { readonly brand: "detections.DetId" };
export const isDetId = (s: string): s is DetId => /^\d+\.\d+$/.test(s);
export const detId = (frame: FrameNo, n: number): DetId => {
  const s = `${frame}.${n}`;
  invariant(isDetId(s), () => `bad detection id ${s}`);
  return s;
};
export const frameOf = (id: DetId): FrameNo => {
  const f = Number(id.slice(0, id.indexOf(".")));
  invariant(isFrameNo(f), () => `bad frame in detection id ${id}`);
  return f;
};
export const ordinalOf = (id: DetId): number => Number(id.slice(id.indexOf(".") + 1));
/** Sorts by frame, then ordinal, which is the order data.dets and `dets` list detections in. @internal */
export const compareDetIds = (a: DetId, b: DetId): number => frameOf(a) - frameOf(b) || ordinalOf(a) - ordinalOf(b);
/**
 * compareDetIds over Detections, without parsing ids on each comparison. The frame is a field, and it parses the
 * ordinal only for two detections of one frame.
 */
export const compareDetections = (a: Pick<Detection, "id" | "frame">, b: Pick<Detection, "id" | "frame">): number =>
  a.frame - b.frame || ordinalOf(a.id) - ordinalOf(b.id);

/** One SAM 3 call, with a prompt on a frame, and for region search a region crop. */
export type Run = { readonly frame: FrameNo; readonly prompt: string; readonly region: Box | null };
/** The public name of a run in replies, "prompt" or "prompt@x0,y0,x1,y1". The `i|` prefix belongs to storage. */
export const runLabel = (run: Run): string =>
  run.region === null ? run.prompt : `${run.prompt}@${run.region.join(",")}`;

/** A stored semantic heatmap, opaque here. Storage mints it and resolves it to a file. */
export type HeatmapRef = string & { readonly brand: "detections.HeatmapRef" };
/** A heatmap ref is a plain file name with no path separators, and not "." or "..". Storage resolves it inside sem/. */
export const isHeatmapRef = (s: string): s is HeatmapRef => /^[^/\\]+$/.test(s) && s !== "." && s !== "..";

/** A run as recorded, with its detections, presence and heatmap. */
export type RunRecord = Run & {
  readonly ids: readonly DetId[];
  readonly presence: number;
  readonly heatmap: HeatmapRef | null;
};

export type Detection = {
  readonly id: DetId;
  readonly frame: FrameNo;
  readonly t: number;
  readonly prompt: string;
  /** The region crop the run searched, null for a whole-frame find. */
  readonly region: Box | null;
  readonly score: number;
  readonly box: Box;
  /** 0/1 values, cropped to the box. */
  readonly mask: Uint8Array;
  readonly area: number;
  readonly emb: Appearance;
};

/** Joins look-alike detections (similarity >= link) within `window` frames. */
export type Groups = (dets: readonly Detection[], link: number, window: number) => readonly (readonly Detection[])[];
/** The best `k` candidates by descending similarity to `q`, each with its similarity. Ties keep input order. */
export type Ranked = (
  cands: readonly Detection[],
  q: Appearance,
  k: number,
) => readonly { readonly d: Detection; readonly sim: number }[];
/** The item with the highest `viewQuality`, the first on ties, or null for none. */
export type BestView = <D extends Pick<Detection, "score" | "area">>(dets: readonly D[]) => D | null;
/** A frame mask ([h, w] shape) of every pixel the given detections cover. */
export type Covered = (dets: readonly Detection[], shape: Shape) => Uint8Array;
/** pixels' `runLengths`. */
export type Rle = (mask: Uint8Array) => readonly number[];
/** pixels' `fromRunLengths`. */
export type Unrle = (counts: readonly number[], size: number) => Uint8Array;
/** The Detection fields an Instance gives: score, box, mask and the area perception counted. */
export type FromInstance = (i: Instance) => Pick<Detection, "score" | "box" | "mask" | "area">;

export const groups: Groups = (dets, link, window) =>
  groupIndices(
    dets.map((d) => d.emb),
    dets.map((d) => d.frame),
    link,
    window,
  ).map((g) => g.map((k) => at(dets, k)));

export const ranked: Ranked = (cands, q, k) =>
  cands
    .map((d) => ({ d, sim: similarity(d.emb, q) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);

/** The value a best view maximises, score · sqrt(area). */
export const viewQuality = (d: Pick<Detection, "score" | "area">): number => d.score * Math.sqrt(d.area);

export const bestView: BestView = <D extends Pick<Detection, "score" | "area">>(dets: readonly D[]) =>
  dets.reduce<D | null>((b, d) => (b === null || viewQuality(d) > viewQuality(b) ? d : b), null);

export const covered: Covered = (dets, shape) => paintMasks(dets, shape);

export const rle: Rle = (mask) => runLengths(mask);

export const unrle: Unrle = (counts, size) => fromRunLengths(counts, size);

export const fromInstance: FromInstance = (i) => ({
  score: i.score,
  box: i.box,
  mask: i.mask,
  area: i.area,
});
