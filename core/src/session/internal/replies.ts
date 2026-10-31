/** Reply pieces the ops share: rounding, detection summaries and look-alike rankings. */
import type { DetId, Detection } from "../../detections/pure.ts";
import { compareDetections, ranked } from "../../detections/pure.ts";
import type { Owner } from "../../labelling/index.ts";
import { round } from "../../labelling/pure.ts";
import type { Appearance } from "../../perception/pure.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { Video } from "../../video/index.ts";
import type { Ctx } from "../pure.ts";
import type { DetSummary } from "../types.ts";
import { got } from "../../invariant/index.ts";

/** Rounds x to n decimals. It is labelling's function, so both modules round alike. */
export { round };

/** The request's threshold, or else the effective config's. */
export const threshold = (ctx: Ctx, req: { readonly threshold?: number | null }): number =>
  req.threshold ?? ctx.cfg.threshold;

/** Whether keyframe i is a photo of a `stills` clip, so its `t` is a position rather than seconds. */
export const isPhoto = (video: Pick<Video, "slot">, i: FrameNo): boolean =>
  video.slot(i).match(
    (s) => s.clip.timing.kind === "stills",
    () => false,
  );

/** A detection as replies list it. `object` is present only if an object owns it, `photo` only on a photo. */
export const summary = (d: Detection, own: ReadonlyMap<DetId, Owner>, video: Pick<Video, "slot">): DetSummary => {
  const o = own.get(d.id);
  return {
    id: d.id,
    frame: d.frame,
    t: d.t,
    ...(isPhoto(video, d.frame) ? { photo: true as const } : {}),
    prompts: [d.prompt],
    score: round(d.score, 3),
    box: d.box,
    area: d.area,
    ...(o ? { object: o } : {}),
  };
};

/** Detections on some frames at or above a score, of one prompt if given, in id order (`dets`, `data.dets`). */
export const selectDets = (
  all: readonly Detection[],
  frames: ReadonlySet<FrameNo>,
  minScore: number,
  prompt?: string | null,
): readonly Detection[] =>
  all
    .filter((d) => frames.has(d.frame) && d.score >= minScore && (!prompt || d.prompt === prompt))
    .sort(compareDetections);

/** The `k` candidates most like `q` (detections.ranked), and their summaries with `sim` as replies list them. */
export const scored = (
  cands: readonly Detection[],
  q: Appearance,
  k: number,
  own: ReadonlyMap<DetId, Owner>,
  video: Pick<Video, "slot">,
): { readonly near: readonly Detection[]; readonly matches: readonly (DetSummary & { readonly sim: number })[] } => {
  const r = ranked(cands, q, k);
  return {
    near: r.map(({ d }) => d),
    matches: r.map(({ d, sim }) => ({ ...summary(d, own, video), sim: round(sim, 3) })),
  };
};

/** The label "<id> <t>s sim <s>", or "<id> photo <position> sim <s>", under each look-alike tile. */
export const simLabel = (o: Pick<DetSummary, "t" | "photo"> & { readonly id: string; readonly sim: number }): string =>
  `${o.id} ${o.photo ? `photo ${o.t}` : `${o.t.toFixed(1)}s`} sim ${o.sim.toFixed(2)}`;

/**
 * The best item of each key (highest score, the first on ties), in the order the keys first appear. Items without
 * a key are left out. It sorts once and copies no map per item.
 */
export const bestOfEach = <T>(
  xs: readonly T[],
  keyOf: (x: T) => string | null,
  scoreOf: (x: T) => number,
): readonly T[] => {
  const keyed = xs.flatMap((x, j) => {
    const key = keyOf(x);
    return key === null ? [] : [{ x, j, key, score: scoreOf(x) }];
  });
  // Sort by ascending score, later items first on ties. A Map keeps the last value, so each key ends on its best.
  const best = new Map(
    [...keyed].sort((a, b) => a.score - b.score || b.j - a.j).map(({ key, x }) => [key, x] as const),
  );
  // a Map keeps each key where it was first inserted
  return [...new Map(keyed.map(({ key }) => [key, got(best, key)] as const)).values()];
};

/** How many times each value occurs, in the order the values first appear. */
export const countsOf = (xs: readonly string[]): readonly (readonly [string, number])[] => {
  const sorted = [...xs].sort();
  // Sorting puts equal values together, so the count is the last index minus the first index plus 1.
  const last = new Map(sorted.map((x, j) => [x, j] as const));
  const first = new Map(sorted.map((x, j) => [x, j] as const).reverse());
  return [...new Set(xs)].map((x) => [x, got(last, x) - got(first, x) + 1] as const);
};
