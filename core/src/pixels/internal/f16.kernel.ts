/**
 * Conversion between float16 and float32, bit-exact with numpy astype. The array conversion reads float bits
 * through a Uint32Array view instead of a Float32Array round trip per value.
 */

const F16 = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    t[h] =
      e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024);
  }
  return t;
})();

/** Writes into `out`, or a new array by default, and returns it. */
export function f16ToF32(h: Uint16Array, out: Float32Array = new Float32Array(h.length)): Float32Array {
  for (let i = 0; i < h.length; i++) out[i] = F16[h[i]!]!;
  return out;
}

/** Turns float32 bits into float16 bits, rounding to nearest even like numpy and torch .half(). */
function halfOfBits(x: number): number {
  const sign = (x >>> 16) & 0x8000;
  let e = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  e = e - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let r = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && r & 1)) r++;
    return sign | r;
  }
  let r = (e << 10) | (m >>> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && r & 1)) r++;
  return sign | r;
}

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
/** One number rounded to float32, then to float16 bits. */
export function f32ToF16Bits(v: number): number {
  f32buf[0] = v;
  return halfOfBits(u32buf[0]!);
}

/**
 * Writes into `out`, or a new array by default, and returns it. Values in float16's normal range (float32
 * exponent 113 to 142) take a branch-free path. It rebiases, then rounds to nearest even by adding 0xfff plus the
 * lowest kept bit. A carry out of the mantissa bumps the exponent, up to 0x7c00 (infinity), as halfOfBits does.
 */
export function f32ToF16(a: Float32Array, out: Uint16Array = new Uint16Array(a.length)): Uint16Array {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  for (let i = 0; i < u.length; i++) {
    const x = u[i]!;
    if ((((x >>> 23) & 0xff) - 113) >>> 0 < 30) {
      const t = (x & 0x7fffffff) - (112 << 23);
      out[i] = ((x >>> 16) & 0x8000) | ((t + 0xfff + ((t >>> 13) & 1)) >>> 13);
    } else out[i] = halfOfBits(x);
  }
  return out;
}
