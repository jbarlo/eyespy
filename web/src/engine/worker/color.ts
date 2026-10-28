/**
 * Converts YUV to RGB the way ffmpeg does when it extracts frames to JPEG, so browser keyframes match a frames
 * folder's. ffmpeg's mjpeg path expands limited range to full range (swscale yuv420p to yuvj420p, with no matrix change
 * and no transfer function), and the JPEG decoder applies the BT.601 full-range matrix. Like ffmpeg, this ignores
 * colour tags (BT.709, BT.2020, HLG/PQ). A browser's drawImage(VideoFrame) colour-manages instead (it tone-maps HLG,
 * for example), which looks different.
 */

/** The luma plane of a frame at 8 bits (what the grey stream needs). */
export type Luma = {
  w: number;
  h: number;
  Y: Uint8Array;
  fullRange: boolean;
};

type Yuv = Luma & {
  U: Uint8Array;
  V: Uint8Array;
  cw: number;
  ch: number;
};

/** Planes of a VideoFrame at 8 bits, or null for formats we don't unpack (RGB-like or opaque). */
export async function framePlanes(f: VideoFrame): Promise<Yuv | null> {
  const u = await unpack(f);
  if (!u) return null;
  const { m, cw, ch, plane } = u;
  const [U, V] = m === "NV12" ? [plane(1, cw, ch, 2, 0), plane(1, cw, ch, 2, 1)] : [plane(1, cw, ch), plane(2, cw, ch)];
  return { ...u.luma, U, V, cw, ch };
}

/** The luma plane only (chroma is never unpacked), or null for formats we don't unpack. */
export async function frameLuma(f: VideoFrame): Promise<Luma | null> {
  return (await unpack(f))?.luma ?? null;
}

/** Copy a frame out and unpack its luma; `plane` unpacks any other plane on demand. */
async function unpack(f: VideoFrame) {
  const fmt = f.format;
  if (!fmt) return null;
  const m = /^(I420|I422|I444|NV12)(P10|P12)?A?$/.exec(fmt);
  if (!m) return null;
  const w = f.visibleRect?.width ?? f.codedWidth,
    h = f.visibleRect?.height ?? f.codedHeight;
  const [subX, subY]: [number, number] = m[1] === "I444" ? [1, 1] : m[1] === "I422" ? [2, 1] : [2, 2];
  const cw = Math.ceil(w / subX),
    ch = Math.ceil(h / subY);
  const bits = m[2] === "P10" ? 10 : m[2] === "P12" ? 12 : 8;
  const buf = new Uint8Array(f.allocationSize());
  const layout = await f.copyTo(buf);
  const plane = (k: number, pw: number, ph: number, step = 1, off = 0) => {
    const pl = layout[k];
    if (!pl) throw new Error(`VideoFrame ${fmt} has no plane ${k}`);
    const { offset, stride } = pl;
    // with 8-bit packed rows, the plane is a view of the buffer this call allocated, which nothing else holds
    if (bits === 8 && step === 1 && stride === pw) return buf.subarray(offset, offset + pw * ph);
    const out = new Uint8Array(pw * ph);
    if (bits === 8 && step === 1) {
      for (let y = 0; y < ph; y++) out.set(buf.subarray(offset + y * stride, offset + y * stride + pw), y * pw);
    } else if (bits === 8) {
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++) out[y * pw + x] = buf[offset + y * stride + x * step + off]!;
    } else {
      const dv = new DataView(buf.buffer, buf.byteOffset);
      const sh = bits - 8,
        half = 1 << (sh - 1);
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++)
          out[y * pw + x] = Math.min(
            255,
            (dv.getUint16(offset + y * stride + (x * step + off) * 2, true) + half) >> sh,
          );
    }
    return out;
  };
  const luma: Luma = { w, h, Y: plane(0, w, h), fullRange: !!f.colorSpace?.fullRange };
  return { m: m[1], cw, ch, plane, luma };
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** RGBA from range expansion and the BT.601 full-range matrix, with bilinear chroma upsampling (centre siting). */
export function rgbaJpegStyle(p: Yuv): ImageData {
  const { w, h, cw, ch } = p;
  const out = new Uint8ClampedArray(w * h * 4);
  const ky = p.fullRange ? 1 : 255 / 219,
    oy = p.fullRange ? 0 : 16,
    kc = p.fullRange ? 1 : 255 / 224;
  const sx = cw / w,
    sy = ch / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), ch - 1);
    const y0 = Math.floor(fy),
      y1 = Math.min(y0 + 1, ch - 1),
      wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), cw - 1);
      const x0 = Math.floor(fx),
        x1 = Math.min(x0 + 1, cw - 1),
        wx = fx - x0;
      const at = (P: Uint8Array) =>
        (P[y0 * cw + x0]! * (1 - wx) + P[y0 * cw + x1]! * wx) * (1 - wy) +
        (P[y1 * cw + x0]! * (1 - wx) + P[y1 * cw + x1]! * wx) * wy;
      const yy = (p.Y[y * w + x]! - oy) * ky,
        u = (at(p.U) - 128) * kc,
        v = (at(p.V) - 128) * kc;
      const q = (y * w + x) * 4;
      out[q] = clamp(yy + 1.402 * v);
      out[q + 1] = clamp(yy - 0.344136 * u - 0.714136 * v);
      out[q + 2] = clamp(yy + 1.772 * u);
      out[q + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

/** Full-range luma plane (ffmpeg `-pix_fmt gray` expands limited range). */
export function fullRangeLuma(p: Luma): Uint8Array {
  if (p.fullRange) return p.Y.slice();
  const out = new Uint8Array(p.w * p.h);
  for (let i = 0; i < out.length; i++) out[i] = EXPAND_LUMA[p.Y[i]!]!;
  return out;
}

const EXPAND_LUMA = Uint8Array.from({ length: 256 }, (_, v) => clamp((v - 16) * (255 / 219)));

/** Apply a track matrix [a, b, c, d] (multiples of 90°, flips) to a grey plane: x' = a·x + c·y, y' = b·x + d·y. */
export function orientGray(
  src: Uint8Array,
  w: number,
  h: number,
  m: [number, number, number, number],
): { w: number; h: number; data: Uint8Array } {
  const [a, b, c, d] = m;
  if (a === 1 && b === 0 && c === 0 && d === 1) return { w, h, data: src };
  const xs = [0, a * (w - 1), c * (h - 1), a * (w - 1) + c * (h - 1)],
    ys = [0, b * (w - 1), d * (h - 1), b * (w - 1) + d * (h - 1)];
  const tx = -Math.min(...xs),
    ty = -Math.min(...ys);
  const ow = Math.max(...xs) + tx + 1,
    oh = Math.max(...ys) + ty + 1;
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[(b * x + d * y + ty) * ow + a * x + c * y + tx] = src[y * w + x]!;
  return { w: ow, h: oh, data: out };
}

/** swscale's default (SWS_BICUBIC with B=0, C=0.6, which is Keys a=-0.6) antialiased resize of a grey plane. */
export function resizeGrayBicubic(src: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  const kern = (x: number) => {
    const a = -0.6;
    x = Math.abs(x);
    return x < 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * a : 0;
  };
  const coeffs = (n: number, on: number) => {
    const scale = n / on,
      f = Math.max(scale, 1),
      support = 2 * f;
    return Array.from({ length: on }, (_, o) => {
      const c = (o + 0.5) * scale;
      const lo = Math.max(0, Math.floor(c - support)),
        hi = Math.min(n, Math.ceil(c + support));
      const k: number[] = [];
      let s = 0;
      for (let i = lo; i < hi; i++) {
        const v = kern((i + 0.5 - c) / f);
        k.push(v);
        s += v;
      }
      return { lo, k: k.map((v) => v / s) };
    });
  };
  const H = coeffs(w, ow),
    V = coeffs(h, oh);
  const tmp = new Float32Array(h * ow);
  for (let y = 0; y < h; y++)
    for (let o = 0; o < ow; o++) {
      const { lo, k } = H[o]!;
      let s = 0;
      for (let i = 0; i < k.length; i++) s += k[i]! * src[y * w + lo + i]!;
      tmp[y * ow + o] = s;
    }
  const out = new Uint8Array(ow * oh);
  for (let o = 0; o < oh; o++) {
    const { lo, k } = V[o]!;
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < k.length; i++) s += k[i]! * tmp[(lo + i) * ow + x]!;
      out[o * ow + x] = clamp(s);
    }
  }
  return out;
}
