/** Stable per-key colours and the JET colormap. Clients draw with the same colours, so the values are fixed. */
import type { Rgb3 } from "../../ports/index.ts";

function crc32(s: string): number {
  let c = ~0;
  for (const b of new TextEncoder().encode(s)) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** Each channel is in [60, 255). crc32(key) seeds an xorshift32 (13, 17, 5). */
export function color(key: string): Rgb3 {
  let x = crc32(key) || 1;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
  const r = 60 + Math.floor(next() * 195);
  const g = 60 + Math.floor(next() * 195);
  const b = 60 + Math.floor(next() * 195);
  return [r, g, b];
}

/**
 * The piecewise-linear JET formula, rounded. `t[v*3 .. v*3+2]` is the RGB for grey level v. cv2's COLORMAP_JET is
 * its own table and differs by 1 on some entries.
 */
function jetTable(): Uint8Array {
  const t = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const c = (k: number) => Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - k))));
    t[v * 3] = c(3);
    t[v * 3 + 1] = c(2);
    t[v * 3 + 2] = c(1);
  }
  return t;
}

/** The one JET table. */
export const JET = jetTable();
