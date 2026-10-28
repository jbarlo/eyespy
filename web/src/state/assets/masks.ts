/** Mask rasters for the canvas, drawn client-side from data.dets RLE, in bounded maps. Canvases are browser-only. */
import { unrle } from "eyespy-core/detections/pure";
import { invariant } from "eyespy-core/invariant";
import type { Box, Det, Mask, Rle } from "../types.ts";

type SpriteStyle = "fill" | "edge" | "dark";

export type Sprites = {
  readonly decode: (id: string, r: Rle) => Uint8Array;
  /** Is frame pixel (x, y) inside the detection's mask? */
  readonly hit: (id: string, r: Rle, box: Box, x: number, y: number) => boolean;
  /**
   * A box-sized raster in one colour: `fill` is a tinted inside with a solid edge, `edge` the edge alone, `dark` the
   * whole mask in black. `t` is the edge width in image pixels.
   */
  readonly sprite: (id: string, r: Rle, css: string, style: SpriteStyle, t?: number) => OffscreenCanvas;
  /** Every owned region of a frame darkened, frame-sized (one frame's worth cached). */
  readonly gaps: (
    frame: number,
    w: number,
    h: number,
    dets: readonly Det[],
    masks: ReadonlyMap<string, Mask>,
  ) => OffscreenCanvas;
  readonly prune: (live: ReadonlySet<string>) => void;
  readonly reset: () => void;
};

const MAX_DECODED = 6000;
const MAX_SPRITES = 3000;

const rgb = (css: string) => (css.match(/\d+/g) ?? ["255", "255", "255"]).slice(0, 3).map(Number);

/** Mask pixels within `t` of the outside (square neighbourhood), which form the edge band `t` px wide. */
function edgeBand(m: Uint8Array, w: number, h: number, t: number): Uint8Array {
  // erode with a (2t+1)² square, one axis at a time; the edge is the mask minus the eroded mask
  const rowMin = new Uint8Array(w * h);
  const rowOnes = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    let run = 0; // ones ending at x
    for (let x = 0; x < w; x++) rowOnes[x] = run = m[y * w + x] ? run + 1 : 0;
    // a pixel survives if the run of ones covering [x-t, x+t] is unbroken
    for (let x = 0; x < w; x++) {
      const xe = x + t;
      rowMin[y * w + x] = xe < w && x - t >= 0 && (rowOnes[xe] ?? 0) >= 2 * t + 1 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  const colOnes = new Int32Array(h);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) colOnes[y] = run = rowMin[y * w + x] ? run + 1 : 0;
    for (let y = 0; y < h; y++) {
      const ye = y + t;
      const kept = ye < h && y - t >= 0 && (colOnes[ye] ?? 0) >= 2 * t + 1;
      out[y * w + x] = m[y * w + x] && !kept ? 1 : 0;
    }
  }
  return out;
}

function context(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const g = c.getContext("2d");
  invariant(g, "no 2D canvas context"); // a broken browser, not an expected failure
  return g;
}

/** Drops the oldest entries (insertion order) until the map holds at most `max`. */
function bounded<K, V>(m: Map<K, V>, max: number) {
  for (const k of m.keys()) {
    if (m.size <= max) break;
    m.delete(k);
  }
}

export function createSprites(): Sprites {
  const decoded = new Map<string, Uint8Array>();
  const sprites = new Map<string, OffscreenCanvas>();
  let gapsEntry: { key: string; canvas: OffscreenCanvas } | null = null;

  function decode(id: string, r: Rle): Uint8Array {
    const have = decoded.get(id);
    if (have) return have;
    const m = unrle(r.counts, r.w * r.h);
    decoded.set(id, m);
    bounded(decoded, MAX_DECODED);
    return m;
  }

  function sprite(id: string, r: Rle, css: string, style: SpriteStyle, t = 1): OffscreenCanvas {
    const key = `${id}|${css}|${style}|${t}`;
    const have = sprites.get(key);
    if (have) return have;
    const m = decode(id, r);
    const { w, h } = r;
    const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const img = new ImageData(Math.max(1, w), Math.max(1, h));
    const [R = 0, G = 0, B = 0] = style === "dark" ? [0, 0, 0] : rgb(css);
    const d = img.data;
    const band = style === "dark" ? m : edgeBand(m, w, h, t);
    for (let p = 0; p < w * h; p++) {
      if (!m[p]) continue;
      const edge = band[p];
      d[p * 4] = R;
      d[p * 4 + 1] = G;
      d[p * 4 + 2] = B;
      d[p * 4 + 3] = style === "dark" ? 255 : style === "edge" ? (edge ? 255 : 0) : edge ? 255 : 95;
    }
    context(c).putImageData(img, 0, 0);
    sprites.set(key, c);
    bounded(sprites, MAX_SPRITES);
    return c;
  }

  return {
    decode,
    hit: (id, r, box, x, y) => {
      const [x0, y0, x1, y1] = box;
      if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
      return decode(id, r)[Math.floor(y - y0) * r.w + Math.floor(x - x0)] === 1;
    },
    sprite,
    gaps: (frame, w, h, dets, masks) => {
      const owned = dets.filter((d) => d.object && masks.has(d.id));
      const key = `${frame}|${w}x${h}|${owned.map((d) => d.id).join(",")}`;
      if (gapsEntry?.key === key) return gapsEntry.canvas;
      const c = new OffscreenCanvas(w, h);
      const g = context(c);
      for (const d of owned) {
        const m = masks.get(d.id);
        if (m) g.drawImage(sprite(d.id, m.rle, "#000", "dark"), d.box[0], d.box[1]);
      }
      gapsEntry = { key, canvas: c };
      return c;
    },
    prune: (live) => {
      for (const id of [...decoded.keys()]) if (!live.has(id)) decoded.delete(id);
      for (const k of [...sprites.keys()]) if (!live.has(k.slice(0, k.indexOf("|")))) sprites.delete(k);
      gapsEntry = null;
    },
    reset: () => {
      decoded.clear();
      sprites.clear();
      gapsEntry = null;
    },
  };
}
