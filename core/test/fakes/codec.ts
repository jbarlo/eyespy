/**
 * Lossless, reproducible JPEG and PNG stand-ins: magic, size and quality, then zlib of the pixels. drawText leaves pixels alone
 * and records its items, because the agent reads labels and the snapshots hold them.
 */
import { unzlibSync, zlibSync } from "fflate";
import type { Gray, RGB } from "../../src/pixels/index.ts";
import type { ImageCodec, TextItem } from "../../src/ports/index.ts";

const JPG = [0x46, 0x4a, 0x50, 0x47]; // "FJPG"
const PNG = [0x46, 0x50, 0x4e, 0x47]; // "FPNG"
const HEADER = 9; // magic, w (u16 LE), h (u16 LE), quality (u8)

function pack(magic: number[], w: number, h: number, q: number, data: Uint8Array): Uint8Array {
  const z = zlibSync(data, { level: 6 });
  const out = new Uint8Array(HEADER + z.length);
  out.set(magic, 0);
  out.set([w & 0xff, w >> 8, h & 0xff, h >> 8, q], 4);
  out.set(z, HEADER);
  return out;
}

function unpack(magic: number[], bytes: Uint8Array, channels: number): { w: number; h: number; data: Uint8Array } {
  if (bytes.length < HEADER || magic.some((m, k) => bytes[k] !== m))
    throw new Error(`fake codec: not a ${String.fromCharCode(...magic)} image`);
  const b = (k: number) => bytes[k] ?? 0;
  const w = b(4) | (b(5) << 8),
    h = b(6) | (b(7) << 8);
  const data = unzlibSync(bytes.subarray(HEADER));
  if (data.length !== w * h * channels) throw new Error(`fake codec: ${data.length} bytes for ${w}×${h}×${channels}`);
  return { w, h, data };
}

/** The fake "JPEG" bytes of an image (what FakeVideo.frameJpeg returns and FakeCodec.encodeJpeg writes). */
export const fakeJpeg = (img: RGB, quality = 90): Uint8Array => pack(JPG, img.w, img.h, quality, img.data);
export const fakePng = (img: Gray): Uint8Array => pack(PNG, img.w, img.h, 0, img.data);

export class FakeCodec implements ImageCodec {
  texts: TextItem[][] = [];

  async decode(bytes: Uint8Array): Promise<RGB> {
    return unpack(JPG, bytes, 3);
  }
  async decodeGray(bytes: Uint8Array): Promise<Gray> {
    return unpack(PNG, bytes, 1);
  }
  async encodeJpeg(img: RGB, quality: number): Promise<Uint8Array> {
    return fakeJpeg(img, quality);
  }
  async encodePng(img: Gray): Promise<Uint8Array> {
    return fakePng(img);
  }
  async drawText(img: RGB, items: TextItem[]): Promise<RGB> {
    this.texts.push(items.map((t) => ({ ...t })));
    return { w: img.w, h: img.h, data: img.data.slice() };
  }

  /** Returns the strings drawn since the last call and clears the list. */
  takeTexts(): string[] {
    const out = this.texts.flat().map((t) => t.text);
    this.texts = [];
    return out;
  }
}
