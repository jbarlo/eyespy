import type { ResultAsync } from "neverthrow";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { Gray, RGB } from "../../src/pixels/index.ts";
import type { ImageCodec, TextItem } from "../../src/ports/index.ts";
import type { FrameSource } from "../../src/render/index.ts";
import type { FrameNo } from "../../src/video/pure.ts";
import { isFrameNo } from "../../src/video/pure.ts";
import { noise } from "../fixtures/numerics/lib.ts";

const MAGIC = [0x52, 0x41, 0x57, 0x33]; // "RAW3"

/**
 * Deterministic ImageCodec. Its "JPEG" is a raw header then the pixels, so written sheets decode back exactly.
 * drawText records the items and marks each anchor pixel with the fill colour, so the pixel goldens show label
 * placement.
 */
export class FakeCodec implements ImageCodec {
  readonly texts: TextItem[][] = [];

  async decode(bytes: Uint8Array): Promise<RGB> {
    if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error("FakeCodec.decode: not a fake image");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint16(4, true), h: dv.getUint16(6, true), data: bytes.slice(9) };
  }
  async decodeGray(): Promise<Gray> {
    throw new Error("FakeCodec.decodeGray: not used by the renderer");
  }
  /** "RAW3", w, h (u16 LE), quality, then the pixels. */
  async encodeJpeg(img: RGB, quality: number): Promise<Uint8Array> {
    const out = new Uint8Array(9 + img.data.length);
    out.set(MAGIC);
    const dv = new DataView(out.buffer);
    dv.setUint16(4, img.w, true);
    dv.setUint16(6, img.h, true);
    out[8] = quality;
    out.set(img.data, 9);
    return out;
  }
  async encodePng(): Promise<Uint8Array> {
    throw new Error("FakeCodec.encodePng: not used by the renderer");
  }
  async drawText(img: RGB, items: TextItem[]): Promise<RGB> {
    this.texts.push(items);
    const out = { w: img.w, h: img.h, data: img.data.slice() };
    for (const t of items) {
      const x = Math.trunc(t.x),
        y = Math.trunc(t.y);
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      out.data.set(t.fill, (y * img.w + x) * 3);
    }
    return out;
  }
}

export function fno(n: number): FrameNo {
  if (!isFrameNo(n)) throw new Error(`not a frame number: ${n}`);
  return n;
}

/**
 * Frame i is noise(1000 + i) at w×h, tagged "clip#i". `missing` frames fail both image and tag. `reads` lists every
 * image() call. There is no cache, so each call decodes.
 */
export function fakeFrames(w: number, h: number, missing: readonly number[] = []): FrameSource & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    image: (i: FrameNo) => {
      reads.push(i);
      return missing.includes(i)
        ? errAsync({ kind: "missing-frame-file" as const, frame: i })
        : okAsync<RGB>(noise(1000 + i, w, h));
    },
    tag: (i: FrameNo) => (missing.includes(i) ? err({ kind: "no-keyframe" as const, frame: i }) : ok(`clip#${i}`)),
  };
}

export async function unwrap<T, E>(p: ResultAsync<T, E>): Promise<T> {
  const res = await p;
  if (res.isErr()) throw new Error(`unexpected Err: ${JSON.stringify(res.error)}`);
  return res.value;
}
