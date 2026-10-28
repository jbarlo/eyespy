/** Canvas view math: the frame-to-screen transform (scale and offset in CSS pixels), fit, zoom about a point, pan. */

export type View = { readonly scale: number; readonly x: number; readonly y: number; readonly fitted: boolean };

export const IDENTITY: View = { scale: 1, x: 0, y: 0, fitted: true };

/** The whole frame in a `cw`×`ch` box, centred, with a small margin. */
export function fitView(fw: number, fh: number, cw: number, ch: number): View {
  const s = Math.min(cw / fw, ch / fh) * 0.98;
  return { scale: s, x: (cw - fw * s) / 2, y: (ch - fh * s) / 2, fitted: true };
}

/** Zooms by `factor` keeping the screen point (cx, cy) fixed, within the scale limits. */
export function zoomAt(v: View, factor: number, cx: number, cy: number): View {
  const s = Math.max(0.05, Math.min(40, v.scale * factor));
  const k = s / v.scale;
  return { scale: s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fitted: false };
}

/** The same transform (a refit to the same size gives an equal view). */
export const sameView = (a: View, b: View): boolean =>
  a.scale === b.scale && a.x === b.x && a.y === b.y && a.fitted === b.fitted;

export const panTo = (v: View, x: number, y: number): View => ({ ...v, x, y, fitted: false });

/** Converts a screen point (relative to the canvas) to a frame pixel. */
export const toFrame = (v: View, sx: number, sy: number): readonly [number, number] => [
  (sx - v.x) / v.scale,
  (sy - v.y) / v.scale,
];

/** Converts a frame pixel to a screen point (relative to the canvas). */
export const toScreen = (v: View, x: number, y: number): readonly [number, number] => [
  v.x + x * v.scale,
  v.y + y * v.scale,
];

/** A drag box from two frame points, normalised, as [x0, y0, x1, y1]. */
export const boxOf = (ax: number, ay: number, bx: number, by: number): readonly [number, number, number, number] => [
  Math.min(ax, bx),
  Math.min(ay, by),
  Math.max(ax, bx),
  Math.max(ay, by),
];

/** A box clamped to the frame and rounded to whole pixels. */
export const clampBox = (
  r: readonly [number, number, number, number],
  w: number,
  h: number,
): readonly [number, number, number, number] => {
  const cl = (v: number, m: number) => Math.round(Math.max(0, Math.min(m, v)));
  return [cl(r[0], w), cl(r[1], h), cl(r[2], w), cl(r[3], h)];
};
