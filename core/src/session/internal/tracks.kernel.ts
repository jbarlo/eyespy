/** Masks between a detection's frame pixels and the tracker's MASK_SIZE² plane. */
import { MASK_SIZE } from "../../perception/pure.ts";
import type { Box } from "../../pixels/index.ts";

/**
 * A detection's mask, over its box in a w×h frame, on the tracker's plane. Each plane pixel takes the frame pixel at
 * its centre. The plane stretches the frame as the encoder's input does.
 */
export function seedPlane(mask: Uint8Array, box: Box, w: number, h: number): Uint8Array {
  const [x0, y0, x1, y1] = box;
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  const bw = x1 - x0;
  for (let py = 0; py < MASK_SIZE; py++) {
    const y = Math.floor(((py + 0.5) * h) / MASK_SIZE);
    if (y < y0 || y >= y1) continue;
    for (let px = 0; px < MASK_SIZE; px++) {
      const x = Math.floor(((px + 0.5) * w) / MASK_SIZE);
      if (x >= x0 && x < x1 && mask[(y - y0) * bw + (x - x0)]) out[py * MASK_SIZE + px] = 1;
    }
  }
  return out;
}

/** Positive logits as a 0 or 1 plane. */
export function binaryPlane(logits: Float32Array): Uint8Array {
  const out = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = logits[i]! > 0 ? 1 : 0;
  return out;
}
