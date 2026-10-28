/** Looking around: the shown keyframe, selection, view settings, and the per-frame loads the canvas needs. */
import { masksOf } from "../detections.ts";
import type { DetectionsState } from "../detections.ts";
import { nearestFrame } from "../frames.ts";
import { computePresence } from "../selectors.ts";
import { withItem, withoutItems } from "../slice.ts";
import type { Box, LayerId, ToolId } from "../types.ts";
import { sessionOf } from "./context.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";

export function createViewActions(ctx: Ctx, r: Runner) {
  const { frames, selection, layers, detections } = ctx.stores;
  const { select: sel } = ctx;

  /** Show keyframe `i` (a global number; the nearest existing one if a removed clip left a gap there). */
  function setFrame(i: number) {
    const fr = frames.getState().frames;
    if (!fr.length) return;
    frames.setState({ current: sel.frameByNo().has(i) ? i : nearestFrame(fr, i) });
  }
  /** Step through the keyframes in order (±1 for next or previous, ±Infinity for last or first), across gaps. */
  function stepFrame(d: number) {
    const fr = frames.getState().frames;
    if (!fr.length) return;
    const p = Math.max(0, sel.framePos());
    const f = fr[Math.max(0, Math.min(fr.length - 1, p + d))];
    if (f) frames.setState({ current: f.frame });
  }
  function select(ids: readonly string[], add = false) {
    selection.setState((s) => ({
      ids: add ? [...new Set([...s.ids, ...ids])] : ids,
      obj: ids.length ? null : s.obj,
      searchRect: null,
    }));
  }
  function toggleSelect(id: string) {
    const ids = selection.getState().ids;
    select(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }
  function clearSelection() {
    selection.setState({ ids: [], obj: null, searchRect: null, searchResult: null });
  }
  /** Select an object; if it isn't on the shown keyframe, go to its best view. */
  function focusObject(oid: string | null) {
    selection.setState({ obj: oid, ids: [], searchRect: null });
    const o = oid ? sel.objById().get(oid) : undefined;
    if (!o) return;
    const present = computePresence(oid, sel.objById(), sel.detById());
    if (present.has(frames.getState().current)) return;
    const best = o.best ? sel.detById().get(o.best) : undefined;
    if (best) frames.setState({ current: best.frame });
  }
  function goToDet(id: string, add = false) {
    const d = sel.detById().get(id);
    if (!d) return;
    frames.setState({ current: d.frame });
    select([id], add);
  }

  /** Loads masks (with alias sets) for one frame once; `force` reads them again after a find added detections there. */
  async function loadMasks(frame: number, force = false) {
    const s = sessionOf(ctx);
    if (!s || (!force && detections.getState().maskFrames.has(frame))) return;
    detections.setState((d) => ({ maskFrames: withItem(d.maskFrames, frame) }));
    const res = await s.ops.data.dets({ frames: String(frame), mask: "rle", aliases: true });
    if (sessionOf(ctx) !== s) return;
    if (res.isErr()) {
      detections.setState((d) => ({ maskFrames: withoutItems(d.maskFrames, (f) => f === frame) }));
      r.report(res.error);
      return;
    }
    const got = masksOf(res.value.dets);
    detections.setState((d): Partial<DetectionsState> => ({ masks: new Map([...d.masks, ...got]) }));
  }

  /** Keyframe i's full-resolution bitmap (loads it once; null if it can't be read). */
  function frameBitmap(i: number): Promise<ImageBitmap | null> {
    const key = sel.frameKey(i);
    return key ? ctx.assets.bitmaps.load(key) : Promise.resolve(null);
  }
  /** The bitmap if it's ready (for drawing); otherwise starts loading it and returns null. */
  function frameBitmapNow(i: number): ImageBitmap | null {
    const key = sel.frameKey(i);
    if (!key) return null;
    const b = ctx.assets.bitmaps.peek(key);
    if (b?.width) return b;
    void ctx.assets.bitmaps.load(key);
    return null;
  }
  /**
   * A detection's crop with its box outlined, as a bitmap of `size` CSS px at pixel ratio `dpr`, or null if it can't be
   * read.
   */
  function cropBitmap(
    det: { readonly id: string; readonly frame: number; readonly box: Box },
    size: number,
    dpr = 1,
  ): Promise<ImageBitmap | null> {
    const image = sel.frameKey(det.frame);
    return image ? ctx.assets.crops.load({ image, det: det.id, box: det.box, size, dpr }) : Promise.resolve(null);
  }
  /** Starts loading a filmstrip thumbnail for every keyframe that has none. */
  function requestThumbs() {
    for (const f of frames.getState().frames) {
      const key = sel.frameKey(f.frame);
      if (key && !ctx.assets.thumbs.has(key)) void ctx.assets.thumbs.load(key);
    }
  }

  return {
    setFrame,
    stepFrame,
    select,
    toggleSelect,
    clearSelection,
    focusObject,
    goToDet,
    setHover: (id: string | null) => {
      if (selection.getState().hover !== id) selection.setState({ hover: id });
    },
    setSearchRect: (box: readonly [number, number, number, number]) => {
      clearSelection();
      selection.setState({ searchRect: box });
    },
    setTool: (tool: ToolId) => layers.setState({ tool }),
    setLayer: (id: LayerId, on: boolean) => layers.setState((l) => ({ layers: { ...l.layers, [id]: on } })),
    setThreshold: (threshold: number) => layers.setState({ threshold }),
    setPrompt: (prompt: string) => layers.setState({ prompt }),
    loadMasks,
    frameBitmap,
    frameBitmapNow,
    cropBitmap,
    requestThumbs,
    watchClips: (on: boolean) => frames.setState({ clipsWatched: on }),
  };
}

export type ViewActions = ReturnType<typeof createViewActions>;
