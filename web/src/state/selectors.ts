/**
 * Derived data across stores, memoised on their inputs (same reference until an input changes).
 *
 * Per-frame results keep their references across changes elsewhere. `detsByFrame` reuses each frame's list while its
 * rows are unchanged. `frameMasks` and `visible` depend on the current frame's masks only, so a mask load or a find on
 * another frame doesn't change what the canvas shows.
 */
import { STORE_REF } from "../protocol.ts";
import { memo } from "./memo.cache.ts";
import { objColor, REJECT_COLOR, REJECTED, TODO_COLOR } from "./objects.ts";
import { keepMap, sameData, sameRefs } from "./share.ts";
import type { Stores } from "./stores.ts";
import type { Det, Frame, Layers, Mask, Obj, Visible } from "./types.ts";

/** A store reference's key ("clips/..." for "eyespy-store:clips/..."), or null for anything else. */
export const refKey = (ref: string | null | undefined): string | null =>
  ref?.startsWith(STORE_REF) ? ref.slice(STORE_REF.length) : null;

const byId = <T extends { readonly id: string }>(xs: readonly T[]): ReadonlyMap<string, T> =>
  new Map(xs.map((x) => [x.id, x]));

const groupByFrame = (ds: readonly Det[]): ReadonlyMap<number, readonly Det[]> => Map.groupBy(ds, (d) => d.frame);

/** The new grouping with every frame's list whose rows are unchanged replaced by its previous list. */
function keepGroups(
  prev: ReadonlyMap<number, readonly Det[]>,
  next: ReadonlyMap<number, readonly Det[]>,
): ReadonlyMap<number, readonly Det[]> {
  const kept = new Map(
    [...next].map(([f, list]) => {
      const old = prev.get(f);
      return [f, old && sameRefs(old, list) ? old : list] as const;
    }),
  );
  return keepMap(prev, kept);
}

const sameVisible = (a: readonly Visible[], b: readonly Visible[]) =>
  a.length === b.length && a.every((v, i) => v.det === b[i]?.det && v.kind === b[i]?.kind && v.color === b[i]?.color);

/** The masks of these detections (the ones loaded). */
const masksFor = (ds: readonly Det[] | undefined, masks: ReadonlyMap<string, Mask>): ReadonlyMap<string, Mask> =>
  new Map(
    (ds ?? []).flatMap((d) => {
      const m = masks.get(d.id);
      return m ? [[d.id, m] as const] : [];
    }),
  );

/** Masks equal to the previous entry for the same id keep the previous object (a forced re-read of the same data). */
function keepMasks(prev: ReadonlyMap<string, Mask>, next: ReadonlyMap<string, Mask>): ReadonlyMap<string, Mask> {
  const kept = new Map(
    [...next].map(([id, m]) => {
      const old = prev.get(id);
      return [id, old && sameData(old, m) ? old : m] as const;
    }),
  );
  return keepMap(prev, kept);
}

/** The best-scoring detection per object. */
const bestPerObject = (ds: readonly Det[]): readonly (readonly [string, Det])[] =>
  [...Map.groupBy(ds, (d) => d.object ?? "")].flatMap(([o, list]) => {
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    return o && o !== REJECTED ? [[o, best] as const] : [];
  });

/** One detection per alias group, best score first. Aliases are same-frame detections of the same region. */
function collapseAliases(list: readonly Det[], masks: ReadonlyMap<string, Mask>): readonly Det[] {
  return list
    .toSorted((a, b) => b.score - a.score)
    .reduce<{ seen: ReadonlySet<string>; out: readonly Det[] }>(
      (acc, d) =>
        acc.seen.has(d.id)
          ? acc
          : { seen: new Set([...acc.seen, ...(masks.get(d.id)?.aliases ?? [])]), out: [...acc.out, d] },
      { seen: new Set(), out: [] },
    ).out;
}

/** What the canvas draws on a frame, by layer: one region per object, one per alias group otherwise. */
export function computeVisible(
  ds: readonly Det[],
  layers: Layers,
  threshold: number,
  masks: ReadonlyMap<string, Mask>,
): readonly Visible[] {
  const objects: readonly Visible[] = layers.objects
    ? bestPerObject(ds).map(([o, det]) => ({ det, kind: "object", color: objColor(o) }))
    : [];
  const todo: readonly Visible[] = layers.todo
    ? collapseAliases(
        ds.filter((d) => !d.object && d.score >= threshold),
        masks,
      ).map((det) => ({ det, kind: "todo", color: TODO_COLOR }))
    : [];
  const rejects: readonly Visible[] = layers.rejects
    ? collapseAliases(
        ds.filter((d) => d.object === REJECTED),
        masks,
      ).map((det) => ({ det, kind: "reject", color: REJECT_COLOR }))
    : [];
  return [...objects, ...todo, ...rejects];
}

/** The object whose presence the filmstrip marks: the selected object, else the first selected detection's object. */
function computeFocus(obj: string | null, ids: readonly string[], dets: ReadonlyMap<string, Det>) {
  if (obj) return obj;
  const owner = ids.map((id) => dets.get(id)?.object).find((o) => o && o !== REJECTED);
  return owner ?? null;
}

export function computePresence(
  focus: string | null,
  objs: ReadonlyMap<string, Obj>,
  dets: ReadonlyMap<string, Det>,
): ReadonlySet<number> {
  const o = focus ? objs.get(focus) : undefined;
  return new Set((o?.members ?? []).flatMap((m) => dets.get(m)?.frame ?? []));
}

export function createSelectors(s: Stores) {
  const frames = () => s.frames.getState();
  const dets = () => s.detections.getState();
  const frameByNo = memo(
    () => [frames().frames],
    (fr): ReadonlyMap<number, Frame> => new Map(fr.map((f) => [f.frame, f])),
  );
  const detById = memo(() => [dets().dets], byId);
  const detsByFrame = memo(() => [dets().dets], groupByFrame, keepGroups);
  const objById = memo(() => [s.objects.getState().objects], byId);
  const focusObj = memo(() => [s.selection.getState().obj, s.selection.getState().ids, detById()], computeFocus);
  const frameMasks = memo(() => [detsByFrame().get(frames().current), dets().masks], masksFor, keepMasks);
  return {
    frameByNo,
    /** Position of the current keyframe in `frames` (slider, stepping), -1 if none. */
    framePos: memo(
      () => [frames().frames, frames().current],
      (fr, cur) => fr.findIndex((f) => f.frame === cur),
    ),
    currentFrame: memo(
      () => [frameByNo(), frames().current],
      (m, cur): Frame | null => m.get(cur) ?? null,
    ),
    detById,
    detsByFrame,
    objById,
    focusObj,
    presenceFrames: memo(() => [focusObj(), objById(), detById()], computePresence),
    /** The current frame's loaded masks by detection id (same reference while they are unchanged). */
    frameMasks,
    visible: memo(
      () => [
        detsByFrame().get(frames().current),
        s.layers.getState().layers,
        s.layers.getState().threshold,
        frameMasks(),
      ],
      (ds, layers, th, masks) => computeVisible(ds ?? [], layers, th, masks),
      (prev, next) => (sameVisible(prev, next) ? prev : next),
    ),
    /** The store key of keyframe `i`'s image. */
    frameKey: (i: number) => refKey(frameByNo().get(i)?.image),
  };
}

export type Selectors = ReturnType<typeof createSelectors>;
