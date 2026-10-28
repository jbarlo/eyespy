/** Canvas drawing from a scene snapshot, with no store reads. */
import type { Box, Det, Frame, Layers, Mask, Obj, Sprites, Visible } from "../../state/index.ts";
import { REJECT_COLOR } from "../../state/index.ts";
import { sameView } from "./view.ts";
import type { View } from "./view.ts";

export type Scene = {
  readonly frame: Frame | null;
  readonly bitmap: ImageBitmap | null;
  readonly view: View;
  readonly dpr: number;
  readonly layers: Layers;
  /** Every detection on the frame (gaps, selection outlines). */
  readonly dets: readonly Det[];
  readonly visible: readonly Visible[];
  /** The frame's loaded masks by detection id. */
  readonly masks: ReadonlyMap<string, Mask>;
  readonly hover: Det | null;
  readonly selected: ReadonlySet<string>;
  readonly objects: ReadonlyMap<string, Obj>;
  readonly heat: ImageBitmap | null;
  /** Drag boxes with their colours (rect select in progress, the region-search box). */
  readonly boxes: readonly (readonly [Box, string])[];
};

const WHITE = "rgb(255,255,255)";
const SELECTED = "rgb(56,189,248)";

/** An edge `w` screen pixels wide, in image pixels at this view (the sprites' edge width). */
const bandAt = (v: View, w: number) => Math.max(1, Math.min(12, Math.round(w * (1 / v.scale))));
/** The fill sprites' edge width at this view (sprite warm-up uses the same key as the draw). */
export const fillBand = (v: View) => bandAt(v, 1.5);

const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((x) => b.has(x));
const sameLayers = (a: Layers, b: Layers) =>
  a.objects === b.objects &&
  a.todo === b.todo &&
  a.rejects === b.rejects &&
  a.semantic === b.semantic &&
  a.gaps === b.gaps;
const sameBoxes = (a: Scene["boxes"], b: Scene["boxes"]) =>
  a.length === b.length && a.every(([r, css], i) => r === b[i]?.[0] && css === b[i]?.[1]);

/** True when drawing `b` paints the same pixels as `a`, with every field the same reference or equal by value. */
export function sameScene(a: Scene, b: Scene): boolean {
  return (
    a.frame === b.frame &&
    a.bitmap === b.bitmap &&
    sameView(a.view, b.view) &&
    a.dpr === b.dpr &&
    sameLayers(a.layers, b.layers) &&
    a.dets === b.dets &&
    a.visible === b.visible &&
    a.masks === b.masks &&
    a.hover === b.hover &&
    sameSet(a.selected, b.selected) &&
    a.objects === b.objects &&
    a.heat === b.heat &&
    sameBoxes(a.boxes, b.boxes)
  );
}

/** Draw the scene; true when the keyframe image itself was drawn (not the loading placeholder). */
export function drawScene(c: HTMLCanvasElement, g: CanvasRenderingContext2D, s: Scene, sprites: Sprites): boolean {
  const f = s.frame;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!f) return false;
  const v = s.view;
  g.setTransform(s.dpr * v.scale, 0, 0, s.dpr * v.scale, s.dpr * v.x, s.dpr * v.y);
  const px = 1 / v.scale; // one screen pixel in image units
  const band = (w: number) => bandAt(v, w); // edge widths, in image pixels
  if (s.bitmap) g.drawImage(s.bitmap, 0, 0, f.w, f.h);
  else {
    g.fillStyle = "#2228";
    g.fillRect(0, 0, f.w, f.h);
  }
  if (s.layers.gaps) {
    g.globalAlpha = 0.85;
    g.drawImage(sprites.gaps(f.frame, f.w, f.h, s.dets, s.masks), 0, 0);
    g.globalAlpha = 1;
  }
  g.imageSmoothingEnabled = false;
  for (const { det: d, color, kind } of s.visible) {
    const m = s.masks.get(d.id);
    if (m) g.drawImage(sprites.sprite(d.id, m.rle, color, "fill", band(1.5)), d.box[0], d.box[1]);
    else {
      g.strokeStyle = color;
      g.lineWidth = 2 * px;
      g.strokeRect(d.box[0], d.box[1], d.box[2] - d.box[0], d.box[3] - d.box[1]);
    }
    if (kind === "reject") {
      g.strokeStyle = REJECT_COLOR;
      g.lineWidth = 2 * px;
      g.beginPath();
      g.moveTo(d.box[0], d.box[1]);
      g.lineTo(d.box[2], d.box[3]);
      g.stroke();
    }
  }
  // the heatmap goes over the mask fills (semi-transparent, so frame and masks still read through it); outlines,
  // hover, selection and labels go on top of it
  if (s.heat) {
    g.globalAlpha = 0.55;
    g.imageSmoothingEnabled = true;
    g.drawImage(s.heat, 0, 0, f.w, f.h);
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = false;
  }
  const outline = (d: Det, css: string, w: number) => {
    const m = s.masks.get(d.id);
    if (m) g.drawImage(sprites.sprite(d.id, m.rle, css, "edge", band(w + 1)), d.box[0], d.box[1]);
    g.strokeStyle = css;
    g.lineWidth = w * px;
    g.setLineDash([6 * px, 4 * px]);
    g.strokeRect(d.box[0], d.box[1], d.box[2] - d.box[0], d.box[3] - d.box[1]);
    g.setLineDash([]);
  };
  const hov = s.hover;
  if (hov && hov.frame === f.frame) {
    const m = s.masks.get(hov.id);
    if (m) g.drawImage(sprites.sprite(hov.id, m.rle, WHITE, "fill", band(1.5)), hov.box[0], hov.box[1]);
    outline(hov, WHITE, 1.5);
  }
  for (const d of s.dets) if (s.selected.has(d.id)) outline(d, SELECTED, 2);
  const font = 12 * px;
  g.font = `600 ${font}px system-ui, sans-serif`;
  g.textBaseline = "top";
  for (const { det: d, kind, color } of s.visible) {
    if (kind !== "object" || !d.object) continue;
    const text = `${d.object} ${s.objects.get(d.object)?.label ?? ""}`.slice(0, 32);
    const tw = g.measureText(text).width;
    g.fillStyle = "rgba(0,0,0,0.7)";
    g.fillRect(d.box[0], d.box[1] - font * 1.4, tw + 8 * px, font * 1.4);
    g.fillStyle = color;
    g.fillText(text, d.box[0] + 4 * px, d.box[1] - font * 1.25);
  }
  for (const [r, css] of s.boxes) {
    g.strokeStyle = css;
    g.lineWidth = 2 * px;
    g.setLineDash([8 * px, 6 * px]);
    g.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    g.setLineDash([]);
  }
  return s.bitmap !== null;
}

/** Size the canvas backing store to its box at the device pixel ratio. */
export function sizeCanvas(c: HTMLCanvasElement, w: number, h: number, dpr: number) {
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
}
