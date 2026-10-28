/** ImageCodec over OffscreenCanvas, so it works in a worker, with the browser's JPEG and PNG codecs and canvas text. */
import type { Gray, RGB } from "eyespy-core/pixels";
import type { ImageCodec, TextItem } from "eyespy-core/ports";

function rgbToRgba(img: { w: number; h: number; data: Uint8Array }, channels: 1 | 3): ImageData {
  const n = img.w * img.h;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    if (channels === 3) {
      out[p * 4] = img.data[p * 3]!;
      out[p * 4 + 1] = img.data[p * 3 + 1]!;
      out[p * 4 + 2] = img.data[p * 3 + 2]!;
    } else out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = img.data[p]!;
    out[p * 4 + 3] = 255;
  }
  return new ImageData(out, img.w, img.h);
}

function rgbaToRgb(d: Uint8ClampedArray, w: number, h: number): RGB {
  const n = w * h;
  const out = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    out[p * 3] = d[p * 4]!;
    out[p * 3 + 1] = d[p * 4 + 1]!;
    out[p * 3 + 2] = d[p * 4 + 2]!;
  }
  return { w, h, data: out };
}

function ctx2d(w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!g) throw new Error("no 2d canvas context");
  return { c, g };
}

async function bitmap(bytes: Uint8Array) {
  // no colour management, so decoded pixels stay as stored, like sharp/libvips
  return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
}

// Our own 8-bit greyscale PNG writer: one byte per pixel, as the Node store writes, where a canvas writes RGBA.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function encodeGrayPng(img: Gray): Promise<Uint8Array> {
  const raw = new Uint8Array((img.w + 1) * img.h);
  for (let y = 0; y < img.h; y++) raw.set(img.data.subarray(y * img.w, (y + 1) * img.w), y * (img.w + 1) + 1); // filter 0
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, img.w);
  v.setUint32(4, img.h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function encodeJpegRGB(img: RGB, quality: number): Promise<Uint8Array> {
  const { c, g } = ctx2d(img.w, img.h);
  g.putImageData(rgbToRgba(img, 3), 0, 0);
  const b = await c.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return new Uint8Array(await b.arrayBuffer());
}

export class CanvasCodec implements ImageCodec {
  async decode(bytes: Uint8Array): Promise<RGB> {
    const bm = await bitmap(bytes);
    const w = bm.width,
      h = bm.height;
    const { g } = ctx2d(w, h);
    g.drawImage(bm, 0, 0);
    bm.close();
    return rgbaToRgb(g.getImageData(0, 0, w, h).data, w, h);
  }
  async decodeGray(bytes: Uint8Array): Promise<Gray> {
    const bm = await bitmap(bytes);
    const { g } = ctx2d(bm.width, bm.height);
    g.drawImage(bm, 0, 0);
    const w = bm.width,
      h = bm.height;
    bm.close();
    const d = g.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let p = 0; p < out.length; p++) out[p] = d[p * 4]!;
    return { w, h, data: out };
  }
  encodeJpeg(img: RGB, quality: number) {
    return encodeJpegRGB(img, quality);
  }
  encodePng(img: Gray) {
    return encodeGrayPng(img);
  }
  async drawText(img: RGB, items: readonly TextItem[]): Promise<RGB> {
    if (!items.length) return img;
    const { g } = ctx2d(img.w, img.h);
    g.putImageData(rgbToRgba(img, 3), 0, 0);
    g.lineJoin = "round";
    g.textBaseline = "alphabetic";
    for (const t of items) {
      g.font = `bold ${t.size}px "DejaVu Sans", "Liberation Sans", Arial, sans-serif`;
      g.lineWidth = t.strokeWidth;
      g.strokeStyle = `rgb(${t.stroke.join(",")})`;
      g.fillStyle = `rgb(${t.fill.join(",")})`;
      g.strokeText(t.text, t.x, t.y); // stroke, then fill, as paint-order does in the Node codec's SVG
      g.fillText(t.text, t.x, t.y);
    }
    return rgbaToRgb(g.getImageData(0, 0, img.w, img.h).data, img.w, img.h);
  }
}
