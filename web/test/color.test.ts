import assert from "node:assert/strict";
import { test } from "node:test";
import { frameLuma, framePlanes, fullRangeLuma } from "../src/engine/worker/color.ts";

type Plane = { offset: number; stride: number };

/** A fake VideoFrame over hand-laid bytes. */
const frame = (format: string, w: number, h: number, bytes: Uint8Array, layout: Plane[], fullRange = false) =>
  ({
    format,
    codedWidth: w,
    codedHeight: h,
    visibleRect: { width: w, height: h },
    colorSpace: { fullRange },
    allocationSize: () => bytes.length,
    copyTo: async (buf: Uint8Array) => {
      buf.set(bytes);
      return layout;
    },
  }) as unknown as VideoFrame;

const W = 6,
  H = 4;
const lumaAt = (x: number, y: number) => (x * 37 + y * 11) & 255;

/** I420 at 8 bits with the given luma stride (chroma rows padded likewise). */
function i420(stride: number) {
  const cs = stride / 2;
  const bytes = new Uint8Array(stride * H + 2 * cs * (H / 2)).fill(99); // the padding is 99
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bytes[y * stride + x] = lumaAt(x, y);
  for (let y = 0; y < H / 2; y++)
    for (let x = 0; x < W / 2; x++) {
      bytes[stride * H + y * cs + x] = 10 + x;
      bytes[stride * H + cs * (H / 2) + y * cs + x] = 20 + y;
    }
  return frame("I420", W, H, bytes, [
    { offset: 0, stride },
    { offset: stride * H, stride: cs },
    { offset: stride * H + cs * (H / 2), stride: cs },
  ]);
}

const expectedY = () => Uint8Array.from({ length: W * H }, (_, i) => lumaAt(i % W, Math.floor(i / W)));

test("frameLuma: packed and padded rows give the same plane, without the padding", async () => {
  for (const stride of [W, W + 2]) {
    const p = await frameLuma(i420(stride));
    assert.ok(p);
    assert.deepEqual([p.w, p.h, p.fullRange], [W, H, false]);
    assert.deepEqual(p.Y, expectedY(), `stride ${stride}`);
  }
});

test("framePlanes: chroma planes still unpacked (I420 padded, NV12 interleaved)", async () => {
  const p = await framePlanes(i420(W + 2));
  assert.ok(p);
  assert.deepEqual([...p.U], [10, 11, 12, 10, 11, 12]);
  assert.deepEqual([...p.V], [20, 20, 20, 21, 21, 21]);
  const uv = new Uint8Array(W * (H / 2));
  for (let i = 0; i < uv.length; i += 2) [uv[i], uv[i + 1]] = [1 + i, 2 + i];
  const nv12 = frame("NV12", W, H, new Uint8Array([...expectedY(), ...uv]), [
    { offset: 0, stride: W },
    { offset: W * H, stride: W },
  ]);
  const q = await framePlanes(nv12);
  assert.ok(q);
  assert.deepEqual(q.Y, expectedY());
  assert.deepEqual([...q.U], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...q.V], [2, 4, 6, 8, 10, 12]);
});

test("frameLuma: 10-bit samples round to 8 bits; unknown formats are null", async () => {
  const bytes = new Uint8Array(W * H * 2 + W * H); // luma u16 LE, then chroma (unused)
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < W * H; i++) dv.setUint16(i * 2, i * 40, true);
  const p = await frameLuma(
    frame("I420P10", W, H, bytes, [
      { offset: 0, stride: W * 2 },
      { offset: W * H * 2, stride: W },
      { offset: W * H * 2 + W, stride: W },
    ]),
  );
  assert.ok(p);
  assert.deepEqual(
    [...p.Y],
    Array.from({ length: W * H }, (_, i) => Math.min(255, (i * 40 + 2) >> 2)),
  );
  assert.equal(await frameLuma(frame("RGBA", W, H, new Uint8Array(4), [])), null);
});

test("fullRangeLuma: limited range expands as clamp(round((v - 16) * 255/219)); full range is copied", () => {
  const all = Uint8Array.from({ length: 256 }, (_, v) => v);
  const want = [...all].map((v) => Math.min(255, Math.max(0, Math.round((v - 16) * (255 / 219)))));
  assert.deepEqual([...fullRangeLuma({ w: 16, h: 16, Y: all, fullRange: false })], want);
  const full = fullRangeLuma({ w: 16, h: 16, Y: all, fullRange: true });
  assert.deepEqual(full, all);
  assert.notEqual(full, all);
});
