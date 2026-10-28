import assert from "node:assert/strict";
import { test } from "node:test";
import type { RGB } from "eyespy-core/pixels";
import { SharpCodec } from "../src/adapters/codec.ts";

const codec = new SharpCodec();
const grey = (w: number, h: number, v: number): RGB => ({ w, h, data: new Uint8Array(w * h * 3).fill(v) });

test("codec: drawText escapes SVG markup in labels (a label is text, never markup) and leaves the input alone", async () => {
  const img = grey(160, 40, 0);
  const item = { x: 4, y: 28, size: 20, fill: [255, 255, 255], stroke: [0, 0, 0], strokeWidth: 2 } as const;
  for (const text of [`<b>&"'</b>`, "</text><rect width='999' height='999' fill='red'/><text>", "café ✓"]) {
    const out = await codec.drawText(img, [{ ...item, text }]);
    assert.equal(out.data.length, img.data.length);
    const lit = out.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    assert.ok(lit > 0, `${text}: something drawn`);
    // an injected full-size red rect would light every pixel's red channel
    assert.ok(lit < img.data.length / 2, `${text}: drawn as text, not as markup`);
  }
  assert.ok(img.data.every((v) => v === 0));
});

test("codec: PNG and JPEG round-trip sizes; grey PNG is lossless", async () => {
  const g = { w: 5, h: 3, data: new Uint8Array(15).map((_, i) => i * 10) };
  assert.deepEqual(await codec.decodeGray(await codec.encodePng(g)), g);
  const rgb = await codec.decode(await codec.encodeJpeg(grey(16, 8, 128), 90));
  assert.equal(rgb.w, 16);
  assert.equal(rgb.h, 8);
  assert.ok(rgb.data.every((v) => Math.abs(v - 128) <= 2));
});
