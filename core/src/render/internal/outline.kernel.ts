/**
 * The outline tracer. It finds the outer boundary of a box-cropped 0/1 mask and thickens it with a stamp. Holes get
 * no outline.
 */
import type { Box } from "../../pixels/index.ts";

/**
 * Offsets stamped on every boundary pixel. Thickness ≤ 1 stamps the pixel itself, 2 the 3×3 square, and t ≥ 3 the
 * disc of radius t − 1 (13 px for 3). They are in row-major order, which fixes the point order.
 */
function stamp(thickness: number): readonly (readonly [number, number])[] {
  const r = thickness === 2 ? 1 : Math.max(0, thickness - 1);
  const out: (readonly [number, number])[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (thickness === 2 || dx * dx + dy * dy <= r * r) out.push([dx, dy]);
  return out;
}

/**
 * Pixels of the outline of `mask` (cropped to `box`) in a W×H frame, as a flat [x, y, ...] list in frame
 * coordinates, each pixel once. A mask pixel is on the boundary if it touches the frame edge or a 4-neighbour is
 * exterior background, meaning background reachable from outside the box.
 *
 * cv2.drawContours instead rasterises the CHAIN_APPROX_SIMPLE polygon with thick lines, so the two can differ at
 * corners.
 */
export function outline(mask: Uint8Array, box: Box, W: number, H: number, thickness: number): Int32Array {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0,
    h = y1 - y0;
  // Background reachable from outside the box (padded by one) is exterior. The rest of the background is holes.
  const pw = w + 2,
    ph = h + 2;
  const ext = new Uint8Array(pw * ph);
  const stack: number[] = [0];
  ext[0] = 1;
  const inside = (px: number, py: number) =>
    px >= 1 && py >= 1 && px <= w && py <= h && mask[(py - 1) * w + px - 1] !== 0;
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % pw,
      py = (p / pw) | 0;
    for (const [dx, dy] of steps) {
      const qx = px + dx,
        qy = py + dy;
      if (qx < 0 || qy < 0 || qx >= pw || qy >= ph) continue;
      const q = qy * pw + qx;
      if (ext[q] || inside(qx, qy)) continue;
      ext[q] = 1;
      stack.push(q);
    }
  }
  const offsets = stamp(thickness);
  const pts: number[] = [];
  const seen = new Set<number>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const fx = x0 + x,
        fy = y0 + y;
      const edge = fx === 0 || fy === 0 || fx === W - 1 || fy === H - 1;
      const px = x + 1,
        py = y + 1;
      const border =
        ext[py * pw + px + 1] || ext[py * pw + px - 1] || ext[(py + 1) * pw + px] || ext[(py - 1) * pw + px];
      if (!border && !edge) continue;
      for (const [dx, dy] of offsets) {
        const qx = fx + dx,
          qy = fy + dy;
        if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const key = qy * W + qx;
        if (seen.has(key)) continue;
        seen.add(key);
        pts.push(qx, qy);
      }
    }
  return Int32Array.from(pts);
}
