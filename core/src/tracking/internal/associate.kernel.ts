/**
 * Which detections on a frame are objects the tracks already hold. A track's own mask can't be trusted on its word: one
 * that lost its object and jumped onto another looks just like a match, as far as the masks go. What gives it away is
 * its score. The thresholds come from the spike's street runs against their 5 fps reference (s6/assoc_pairs_spike.json):
 * of the pairs agreeing with the reference 5% scored under 3.13, of the jumped pairs a quarter under 1.82, the sedan's
 * under 1.25. Wrongly refusing a match costs an extra track that ends up a merge suggestion. Wrongly accepting one loses
 * an object for good. So a doubtful match is refused.
 */

/** A track scoring below this can't explain a detection away. */
export const COVER_SCORE = 2;
/** The same object when masks overlap this much in IoU. */
const SAME_IOU = 0.5;
/** Or when this share of the smaller lies in the larger, and the smaller is at least SAME_RATIO of the larger. */
const SAME_OVERLAP = 0.7;
const SAME_RATIO = 0.5;
/** A detection smaller than this many pixels of the plane is too small to seed. */
const MIN_SEED_AREA = 30;

export type AssocDet<Id extends string = string> = {
  readonly id: Id;
  readonly score: number;
  readonly plane: Uint8Array;
};
export type AssocTrack = { readonly id: string; readonly score: number; readonly mask: Uint8Array };

export type Association<Id extends string = string> = {
  /** Each detection and track at most once, the best pairs first. */
  readonly matches: readonly { readonly det: Id; readonly track: string; readonly iou: number }[];
  /** Detections on the same thing as a better one, usually under another prompt. `of` is the better one. */
  readonly dups: readonly { readonly det: Id; readonly of: Id }[];
  /** Detections no track holds. Best score first. */
  readonly seeds: readonly Id[];
  readonly small: readonly Id[];
  /** Pairs the masks agree on, of a track scoring too low to count. */
  readonly weak: readonly {
    readonly det: Id;
    readonly track: string;
    readonly iou: number;
    readonly score: number;
  }[];
};

/** Pixels of each of two planes and of their overlap. */
function counts(a: Uint8Array, b: Uint8Array): { readonly a: number; readonly b: number; readonly both: number } {
  let na = 0,
    nb = 0,
    both = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0,
      y = b[i] ? 1 : 0;
    na += x;
    nb += y;
    both += x & y;
  }
  return { a: na, b: nb, both };
}

const area = (a: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] ? 1 : 0;
  return n;
};

/** Mask IoU, 0 for two empty masks. */
export function planeIou(a: Uint8Array, b: Uint8Array): number {
  const c = counts(a, b);
  const union = c.a + c.b - c.both;
  return union ? c.both / union : 0;
}

/** Whether two masks show one object, and their IoU. */
function sameObject(a: Uint8Array, b: Uint8Array): { readonly same: boolean; readonly iou: number } {
  const c = counts(a, b);
  const union = c.a + c.b - c.both;
  if (!union || !c.both) return { same: false, iou: 0 };
  const iou = c.both / union;
  const small = Math.min(c.a, c.b);
  return {
    same: iou >= SAME_IOU || (c.both / small >= SAME_OVERLAP && small / Math.max(c.a, c.b) >= SAME_RATIO),
    iou,
  };
}

/** Sorts out one frame's detections against the tracks' masks on that frame. */
export function associate<Id extends string>(
  dets: readonly AssocDet<Id>[],
  tracks: readonly AssocTrack[],
): Association<Id> {
  const best = dets.toSorted((a, b) => b.score - a.score);
  const small = best.filter((d) => area(d.plane) < MIN_SEED_AREA).map((d) => d.id);
  const kept: AssocDet<Id>[] = [];
  const dups: { det: Id; of: Id }[] = [];
  for (const d of best) {
    if (small.includes(d.id)) continue;
    const of = kept.find((k) => sameObject(k.plane, d.plane).same);
    if (of) dups.push({ det: d.id, of: of.id });
    else kept.push(d);
  }

  const pairs: { det: Id; track: string; iou: number }[] = [];
  const weak: { det: Id; track: string; iou: number; score: number }[] = [];
  for (const d of kept)
    for (const t of tracks) {
      const s = sameObject(d.plane, t.mask);
      if (!s.same) continue;
      if (t.score >= COVER_SCORE) pairs.push({ det: d.id, track: t.id, iou: s.iou });
      else weak.push({ det: d.id, track: t.id, iou: s.iou, score: t.score });
    }
  // Greedy by IoU: the best pair takes both, and what it beat looks for its next best.
  const matches: { det: Id; track: string; iou: number }[] = [];
  const usedDets = new Set<Id>();
  const usedTracks = new Set<string>();
  for (const p of pairs.toSorted((a, b) => b.iou - a.iou)) {
    if (usedDets.has(p.det) || usedTracks.has(p.track)) continue;
    usedDets.add(p.det);
    usedTracks.add(p.track);
    matches.push(p);
  }
  return { matches, dups, seeds: kept.filter((d) => !usedDets.has(d.id)).map((d) => d.id), small, weak };
}

/** The tracks in groups: pairs that stayed on one object for at least `minFrames` frames join their tracks' groups. */
export function convergedGroups(
  ids: readonly string[],
  pairs: readonly { readonly a: string; readonly b: string; readonly frames: number }[],
  minFrames: number,
): readonly (readonly string[])[] {
  const parent = new Map(ids.map((id) => [id, id]));
  const root = (id: string): string => {
    let r = id;
    for (let p = parent.get(r); p !== undefined && p !== r; p = parent.get(r)) r = p;
    return r;
  };
  for (const p of pairs)
    if (p.frames >= minFrames && parent.has(p.a) && parent.has(p.b)) parent.set(root(p.b), root(p.a));
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()];
}
