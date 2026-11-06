/**
 * The Stage's imperative side, outside React. It subscribes to the stores directly, batches their changes into one draw
 * per task, and handles pointer input with native listeners, so pointer moves never re-render the React tree. It skips
 * a draw that would paint the same scene as the last. It prefetches the next keyframe and, when idle, rasterises its
 * sprites.
 */
import type { StoreApi } from "zustand/vanilla";
import type { App, Box, Det, StageHandle, StageStats, TrackDraw, Visible } from "../../state/index.ts";
import { computeVisible, objName, refKey, REJECTED } from "../../state/index.ts";
import { drawScene, fillBand, sameScene, sizeCanvas } from "./draw.ts";
import type { Scene } from "./draw.ts";
import { toolOf } from "./tools.ts";
import { boxOf, fitView, IDENTITY, panTo, toFrame, toScreen, zoomAt } from "./view.ts";
import type { View } from "./view.ts";

type Tip = { readonly x: number; readonly y: number; readonly lines: readonly string[] };
export type TipState = { readonly tip: Tip | null };

type Drag = {
  mode: "maybe" | "pan" | "rect";
  readonly sx: number;
  readonly sy: number;
  readonly vx: number;
  readonly vy: number;
  readonly fx: number;
  readonly fy: number;
  readonly shift: boolean;
};

const NOTHING: readonly Det[] = [];
const NO_VISIBLE: readonly Visible[] = [];
const DRAG_BOX = "rgb(255,255,255)";

/** A tracked mask's tooltip: it says what it is, and never that it is that object for sure. */
const trackTip = (t: TrackDraw): readonly string[] => [
  `tracked from a detection, not checked · score ${t.score.toFixed(1)}`,
  ...(t.unsure === "score" ? ["less sure: the tracker gave it a low score here"] : []),
  ...(t.unsure === "overlap" ? ["less sure: another track was on the same thing around here"] : []),
];
const SEARCH_BOX = "rgb(34,211,238)";

export function createStageController(o: {
  readonly canvas: HTMLCanvasElement;
  readonly wrap: HTMLDivElement;
  readonly app: App;
  readonly tip: StoreApi<TipState>;
}): { readonly handle: StageHandle; readonly dispose: () => void } {
  const { canvas: c, wrap, app, tip } = o;
  const { stores, select: sel, actions, assets } = app;
  const g = c.getContext("2d");
  let view: View = IDENTITY;
  let drag: Drag | null = null;
  let rect: Box | null = null;
  let space = false;
  let scheduled = false;
  let disposed = false;
  let drawn: Scene | null = null;
  const stats: StageStats = { draws: 0, last: 0, max: 0, total: 0, bitmapFrame: -1 };

  const frame = () => sel.currentFrame();

  function fit() {
    const f = frame();
    if (f) view = fitView(f.w, f.h, wrap.clientWidth, wrap.clientHeight);
  }

  /** The store key of the picture shown between keyframes, or null when a keyframe is shown. */
  const betweenKey = (): string | null => {
    const place = sel.trackPlace();
    return place?.between ? refKey(place.slot.image) : null;
  };

  /** The heatmap for the shown frame and heatmap prompt, if its layer is on (starts loading it if needed). */
  function heat(frameNo: number): ImageBitmap | null {
    const { layers, semPrompt } = stores.layers.getState();
    if (!layers.semantic || !semPrompt) return null;
    const run = stores.detections.getState().runs.find((x) => x.frame === frameNo && x.prompt === semPrompt);
    const key = refKey(run?.semantic);
    if (!key) return null;
    const have = assets.heat.peek(key);
    if (!have) void assets.heat.load(key);
    return have ?? null;
  }

  function scene(): Scene {
    const f = frame();
    const { ids, obj, hover, searchRect } = stores.selection.getState();
    const selected = new Set([...ids, ...((obj && sel.objById().get(obj)?.members) || [])]);
    const between = betweenKey();
    return {
      frame: f,
      // while a frame between keyframes loads, the last picture stays, so scrubbing doesn't flash
      bitmap: between
        ? (actions.imageBitmapNow(between) ?? (drawn?.bitmap?.width ? drawn.bitmap : null))
        : f
          ? actions.frameBitmapNow(f.frame)
          : null,
      view,
      dpr: devicePixelRatio || 1,
      layers: stores.layers.getState().layers,
      dets: between ? NOTHING : (f && sel.detsByFrame().get(f.frame)) || NOTHING,
      visible: between ? NO_VISIBLE : sel.visible(),
      masks: sel.frameMasks(),
      hover: hover ? (sel.detById().get(hover) ?? null) : null,
      selected,
      objects: sel.objById(),
      heat: f && !between ? heat(f.frame) : null,
      boxes: [...(rect ? [[rect, DRAG_BOX] as const] : []), ...(searchRect ? [[searchRect, SEARCH_BOX] as const] : [])],
      tracks: sel.trackDraws(),
    };
  }

  /**
   * Redraws now and records the time in window.eyespyStage.stats, for tests and profiling. Skips the draw when the
   * scene is the one last drawn, unless `force` is set because a resize cleared the canvas.
   */
  function draw(force = false) {
    if (disposed || !g) return;
    const t = performance.now();
    const s = scene();
    if (!force && drawn && sameScene(drawn, s)) return;
    drawn = s;
    if (drawScene(c, g, s, assets.sprites) && s.frame) stats.bitmapFrame = s.frame.frame;
    const dt = performance.now() - t;
    stats.draws++;
    stats.last = dt;
    stats.total += dt;
    stats.max = Math.max(stats.max, dt);
  }

  /** One draw for everything that changed in this task. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      draw();
    });
  }

  /** On a new keyframe or new frames, refits if fitted, then loads its masks and prefetches it and the next one. */
  function onFrames() {
    const f = frame();
    if (!f) return schedule();
    if (view.fitted) fit();
    void actions.loadMasks(f.frame);
    actions.frameBitmapNow(f.frame);
    const next = stores.frames.getState().frames[sel.framePos() + 1];
    if (next) {
      actions.frameBitmapNow(next.frame);
      void actions.loadMasks(next.frame).then(() => warm(next.frame));
    }
    schedule();
  }

  /** Rasterise keyframe `n`'s fill sprites when the browser is idle (the ones its first draw would make). */
  function warm(n: number) {
    if (typeof requestIdleCallback !== "function") return;
    requestIdleCallback(() => {
      if (disposed) return;
      const { masks } = stores.detections.getState();
      const { layers, threshold } = stores.layers.getState();
      const t = fillBand(view);
      for (const { det: d, color } of computeVisible(sel.detsByFrame().get(n) ?? [], layers, threshold, masks)) {
        const m = masks.get(d.id);
        if (m) assets.sprites.sprite(d.id, m.rle, color, "fill", t);
      }
    });
  }

  function zoom(factor: number, cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2) {
    view = zoomAt(view, factor, cx, cy);
    draw();
  }

  const local = (e: { clientX: number; clientY: number }) => {
    const r = c.getBoundingClientRect();
    return toFrame(view, e.clientX - r.left, e.clientY - r.top);
  };

  /** The topmost tracked mask under a frame point. */
  function pickTrack(x: number, y: number): TrackDraw | null {
    const f = frame();
    if (!f) return null;
    return (
      sel
        .trackDraws()
        .findLast((t) =>
          assets.sprites.hit(t.id, t.rle, [0, 0, t.rle.w, t.rle.h], (x / f.w) * t.rle.w, (y / f.h) * t.rle.h),
        ) ?? null
    );
  }

  /** The smallest shown (or selected) region under a frame point. */
  function pick(x: number, y: number): Det | null {
    const f = frame();
    if (!f || betweenKey()) return null;
    const ids = stores.selection.getState().ids;
    const masks = sel.frameMasks();
    const cands = new Map<string, Det>(sel.visible().map((v) => [v.det.id, v.det]));
    for (const d of sel.detsByFrame().get(f.frame) ?? []) if (ids.includes(d.id)) cands.set(d.id, d);
    let best: Det | null = null;
    for (const d of cands.values()) {
      const m = masks.get(d.id);
      const inside = m
        ? assets.sprites.hit(d.id, m.rle, d.box, x, y)
        : x >= d.box[0] && y >= d.box[1] && x < d.box[2] && y < d.box[3];
      if (inside && (!best || d.area < best.area)) best = d;
    }
    return best;
  }

  const onDown = (e: PointerEvent) => {
    c.setPointerCapture(e.pointerId);
    const [fx, fy] = local(e);
    const panning = e.button === 1 || e.button === 2 || space;
    const tool = toolOf(stores.layers.getState().tool);
    drag = {
      mode: panning ? "pan" : tool.drag === "pan" ? "maybe" : "rect",
      sx: e.clientX,
      sy: e.clientY,
      vx: view.x,
      vy: view.y,
      fx,
      fy,
      shift: e.shiftKey,
    };
    tip.setState({ tip: null });
  };

  const onMove = (e: PointerEvent) => {
    const d = drag;
    if (d) {
      const dx = e.clientX - d.sx,
        dy = e.clientY - d.sy;
      if (d.mode === "maybe" && Math.hypot(dx, dy) > 4) d.mode = "pan";
      if (d.mode === "pan") {
        view = panTo(view, d.vx + dx, d.vy + dy);
        draw();
      } else if (d.mode === "rect") {
        const [x, y] = local(e);
        rect = boxOf(d.fx, d.fy, x, y);
        draw();
      }
      return;
    }
    const [x, y] = local(e);
    const p = pick(x, y);
    actions.setHover(p?.id ?? null);
    if (!p) {
      const t = pickTrack(x, y);
      if (t) {
        const r = wrap.getBoundingClientRect();
        tip.setState({
          tip: {
            x: e.clientX - r.left + 14,
            y: e.clientY - r.top + 14,
            lines: [`${t.label} · ${t.track}`, ...trackTip(t)],
          },
        });
      } else if (tip.getState().tip) tip.setState({ tip: null });
      return;
    }
    const o = p.object && p.object !== REJECTED ? sel.objById().get(p.object) : undefined;
    const r = wrap.getBoundingClientRect();
    tip.setState({
      tip: {
        x: e.clientX - r.left + 14,
        y: e.clientY - r.top + 14,
        lines: [
          o ? objName(o) : p.object === REJECTED ? "rejected" : "unassigned",
          `${p.id} · “${p.prompt}” · score ${p.score.toFixed(2)}`,
        ],
      },
    });
  };

  const onUp = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.mode === "maybe") {
      const [x, y] = local(e);
      const p = pick(x, y);
      if (p) {
        if (e.shiftKey) actions.toggleSelect(p.id);
        else actions.select([p.id]);
        return;
      }
      const t = pickTrack(x, y);
      if (t) actions.select([t.det]);
      else if (!e.shiftKey) actions.clearSelection();
      return;
    }
    if (d.mode !== "rect" || !rect) return;
    const r = rect;
    rect = null;
    const f = frame();
    if (r[2] - r[0] < 4 || r[3] - r[1] < 4 || !f) return draw();
    toolOf(stores.layers.getState().tool).onRect?.(r, { app, frame: f, shift: d.shift });
    draw();
  };

  const onLeave = () => {
    actions.setHover(null);
    tip.setState({ tip: null });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const noMenu = (e: Event) => e.preventDefault();
  const typingTarget = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  const kd = (e: KeyboardEvent) => {
    if (e.code === "Space" && !typingTarget(e.target)) space = true;
  };
  const ku = (e: KeyboardEvent) => {
    if (e.code === "Space") space = false;
  };

  c.addEventListener("pointerdown", onDown);
  c.addEventListener("pointermove", onMove);
  c.addEventListener("pointerup", onUp);
  c.addEventListener("pointerleave", onLeave);
  c.addEventListener("wheel", onWheel, { passive: false });
  c.addEventListener("contextmenu", noMenu);
  addEventListener("keydown", kd);
  addEventListener("keyup", ku);
  const ro = new ResizeObserver(() => {
    sizeCanvas(c, wrap.clientWidth, wrap.clientHeight, devicePixelRatio || 1);
    if (view.fitted) fit();
    draw(true);
  });
  ro.observe(wrap);

  // what the canvas shows. Redraw when any of it changes; comparing fields keeps unrelated updates from drawing
  const unsubs = [
    stores.frames.subscribe((s, p) => {
      if (s.frames !== p.frames || s.current !== p.current) onFrames();
    }),
    stores.detections.subscribe((s, p) => {
      if (s.dets !== p.dets || s.masks !== p.masks || s.runs !== p.runs) schedule();
    }),
    stores.objects.subscribe((s, p) => {
      if (s.objects !== p.objects) schedule();
    }),
    stores.selection.subscribe((s, p) => {
      if (s.ids !== p.ids || s.obj !== p.obj || s.hover !== p.hover || s.searchRect !== p.searchRect) schedule();
    }),
    stores.tracking.subscribe((s, p) => {
      if (s.at !== p.at) onFrames();
      if (s.at !== p.at || s.masks !== p.masks || s.show !== p.show || s.grids !== p.grids || s.status !== p.status)
        schedule();
    }),
    stores.layers.subscribe((s, p) => {
      if (s.layers !== p.layers || s.threshold !== p.threshold || s.semPrompt !== p.semPrompt) schedule();
    }),
    assets.subscribe(schedule),
  ];

  const handle: StageHandle = {
    toClient: (x, y) => {
      const r = c.getBoundingClientRect();
      const [sx, sy] = toScreen(view, x, y);
      return { x: r.left + sx, y: r.top + sy };
    },
    zoom,
    fit: () => {
      fit();
      draw();
    },
    stats,
  };
  stores.stage.setState({ handle });
  onFrames();

  return {
    handle,
    dispose: () => {
      disposed = true;
      ro.disconnect();
      for (const off of unsubs) off();
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointerleave", onLeave);
      c.removeEventListener("wheel", onWheel);
      c.removeEventListener("contextmenu", noMenu);
      removeEventListener("keydown", kd);
      removeEventListener("keyup", ku);
      if (stores.stage.getState().handle === handle) stores.stage.setState({ handle: null });
    },
  };
}
