import assert from "node:assert/strict";
import { test } from "node:test";
import type { Gray, RGB } from "../../src/pixels/index.ts";
import { isNonEmpty } from "../../src/pixels/index.ts";
import { resizeGray } from "../../src/render/internal/resize.kernel.ts";
import type { Region, TextDrawer } from "../../src/render/index.ts";
import { createRenderer } from "../../src/render/index.ts";
import { CROP_COLS, CROP_TILE, JET } from "../../src/render/pure.ts";
import { noise, noiseBytes, sha256 } from "../fixtures/numerics/lib.ts";
import { FakeCodec, fakeFrames, fno, unwrap } from "./fakes.ts";

const W = 30,
  H = 24;
const square = (frame: number, id: string, x0 = 4, y0 = 4, s = 8): Region => ({
  id,
  frame: fno(frame),
  t: frame * 0.5,
  score: 0.9,
  box: [x0, y0, x0 + s, y0 + s],
  mask: new Uint8Array(s * s).fill(1),
});
const mk = (missing: readonly number[] = []) => {
  const text = new FakeCodec();
  const frames = fakeFrames(W, H, missing);
  return { text, frames, r: createRenderer({ frames, text }) };
};

/** The heat tint written out directly, as the reference. */
function referenceHeat(img: RGB, g: Gray, active: number, cov: Uint8Array | null) {
  const heat8 = resizeGray(g, img.w, img.h).data;
  const n = img.w * img.h;
  let on = 0;
  const data = new Uint8Array(n * 3);
  for (let p = 0; p < n; p++) {
    const heat = cov && cov[p] ? 0 : Math.fround(heat8[p]! / 255);
    if (heat > active) on++;
    const cm = Math.trunc(Math.fround(heat * 255)) * 3;
    const a = heat * 0.6;
    for (let k = 0; k < 3; k++) data[p * 3 + k] = Math.trunc(img.data[p * 3 + k]! * (1 - a) + JET[cm + k]! * a);
  }
  return { data, fraction: on / n };
}

test("JET is the pinned table (sha256)", () =>
  assert.equal(sha256(JET), "4e4ef99de7513c679a42ec081fce5fcc0db274b3acdc5bf2cfaca600be2e6908"));

test("heatTint: reference arithmetic, any heat size, with and without covered", () => {
  const { r } = mk();
  const img = noise(7, W, H);
  const cov = Uint8Array.from(noiseBytes(9, W * H), (v) => (v > 128 ? 1 : 0));
  for (const [hw, hh] of [
    [W, H],
    [12, 10],
    [64, 50],
  ] as const) {
    const heat: Gray = { w: hw, h: hh, data: noiseBytes(hw * 100 + hh, hw * hh) };
    for (const covered of [null, cov]) {
      const got = r.heatTint(img, heat, { active: 0.4, covered });
      const want = referenceHeat(img, heat, 0.4, covered);
      assert.deepEqual([got.image.w, got.image.h], [W, H]);
      assert.deepEqual(got.image.data, want.data);
      assert.equal(got.activeFraction, want.fraction);
    }
  }
  const before = img.data.slice();
  r.heatTint(img, { w: 2, h: 2, data: new Uint8Array([0, 255, 128, 64]) }, { active: 0.5 });
  assert.deepEqual(img.data, before, "input untouched");
});

test("darken: covered pixels scaled and truncated, input untouched", () => {
  const { r } = mk();
  const img = noise(3, 4, 2);
  const before = img.data.slice();
  const cov = new Uint8Array([1, 0, 0, 1, 0, 0, 0, 1]);
  const out = r.darken(img, cov, 0.15);
  assert.deepEqual(img.data, before);
  for (let p = 0; p < 8; p++)
    for (let k = 0; k < 3; k++)
      assert.equal(out.data[p * 3 + k], cov[p] ? Math.trunc(before[p * 3 + k]! * 0.15) : before[p * 3 + k]);
});

test("scale: scaleRGB (rounded size, cv2 INTER_LINEAR; recorded outputs)", () => {
  const { r } = mk();
  const img = noise(11, 37, 23);
  const RECORDED: [number, number, number, string][] = [
    [0.25, 9, 6, "e1d1d4a4065087048cccbdfbc4a18f9426c881e7328152b32d0ffae1be02f731"],
    [0.35, 13, 8, "518e5118fdecb844e2f722296bc76c2bc4c1451e8762b767df92975ea9f96cf6"],
    [0.6, 22, 14, "83399e30998e9b7eb53a04c24671138ad1a46a320e16a23679383d9fe1a28953"],
    [1, 37, 23, "58fdeb7e3f48dde469e83c503abef2c0e779c37f9bead368da337873466630c6"],
    [1.5, 56, 35, "00f862ac92df5bec65d347db32516ef599431da1aa86598f87734ac12a0409e8"],
  ];
  for (const [s, w, h, sha] of RECORDED) {
    const out = r.scale(img, s);
    assert.deepEqual([out.w, out.h, sha256(out.data)], [w, h, sha], `scale ${s}`);
  }
});

test("overlay: a missing frame is a FrameAccessError, nothing drawn", async () => {
  const { r, text } = mk([3]);
  const res = await r.overlay(fno(3), [square(3, "3.1")], { scale: 0.5 });
  assert.ok(res.isErr());
  assert.deepEqual(res.error, { kind: "missing-frame-file", frame: 3 });
  assert.equal(text.texts.length, 0);
});

test("tagged: a frame without a keyframe is a no-keyframe error", async () => {
  const { r } = mk([4]);
  const res = await r.tagged(noise(1, 4, 4), fno(4));
  assert.ok(res.isErr());
  assert.equal(res.error.kind, "no-keyframe");
});

test("drawText rejecting (or throwing) becomes a codec HostFailure", async () => {
  for (const drawText of [
    () => Promise.reject(new Error("font missing")),
    () => {
      throw new Error("font missing");
    },
  ] satisfies TextDrawer["drawText"][]) {
    const r = createRenderer({ frames: fakeFrames(W, H), text: { drawText } });
    const res = await r.cropTiles([square(0, "0.1")]);
    assert.ok(res.isErr());
    assert.deepEqual(res.error, { kind: "host", port: "codec", op: "drawText", message: "font missing" });
  }
});

test("cropTiles: frames read one at a time in first-use order, labels drawn in tile order; stops at the first failing frame, before any label", async () => {
  const { r, frames, text } = mk([1]);
  const res = await r.cropTiles([square(0, "0.1"), square(1, "1.1"), square(2, "2.1")]);
  assert.ok(res.isErr());
  assert.deepEqual(res.error, { kind: "missing-frame-file", frame: 1 });
  assert.deepEqual(frames.reads, [0, 1]);
  assert.equal(text.texts.length, 0);
  const ok = mk();
  const tiles = await unwrap(ok.r.cropTiles([square(2, "a"), square(0, "b")], ["first"]));
  assert.equal(tiles.length, 2);
  assert.deepEqual(ok.frames.reads, [2, 0]);
  assert.deepEqual(
    ok.text.texts.map((t) => t.map((i) => i.text)),
    [["first"], ["b 0.0s 0.90"]],
  );
});

test("cropSheet: each frame is read once however the tiles interleave frames; tiles stay in order", async () => {
  const { r, frames, text } = mk();
  const frameOf = [2, 0, 2, 1, 0, 2, 1, 0, 2, 0];
  const regions = frameOf.map((f, k) => square(f, `${f}.${k}`, k, k % 5, 8));
  const sheet = await unwrap(r.cropSheet(regions, undefined, null));
  assert.deepEqual(frames.reads, [2, 0, 1]);
  assert.deepEqual(
    text.texts.map((t) => t[0]?.text.split(" ")[0]),
    regions.map((d) => d.id),
  );
  // the same sheet tile by tile (one cropTiles call per region)
  const one = mk();
  const tiles: RGB[] = [];
  for (const d of regions) tiles.push(...(await unwrap(one.r.cropTiles([d]))));
  assert.ok(sheet && isNonEmpty(tiles));
  assert.deepEqual(sheet.data, one.r.grid(tiles, CROP_COLS).data);
});

test("groupSheet: a frame shared by several groups is read once", async () => {
  const { r, frames } = mk();
  const groups = [0, 1, 2].map((g) => ({
    id: `g${g}`,
    regions: Array.from({ length: CROP_COLS }, (_, k) => square((g + k) % 4, `${g}.${k}`)),
  }));
  assert.ok(await unwrap(r.groupSheet(groups)));
  assert.deepEqual(frames.reads, [0, 1, 2, 3]);
});

test("cropSheet: limit null draws all; empty is null", async () => {
  const { r } = mk();
  const regions = Array.from({ length: 10 }, (_, k) => square(k % 3, `${k % 3}.${k}`));
  const all = await unwrap(r.cropSheet(regions, undefined, null));
  assert.deepEqual([all?.w, all?.h], [CROP_COLS * CROP_TILE, 2 * CROP_TILE]);
  const two = await unwrap(r.cropSheet(regions, undefined, 2));
  assert.deepEqual([two?.w, two?.h], [2 * CROP_TILE, CROP_TILE]);
  assert.equal(await unwrap(r.cropSheet(regions, undefined, 0)), null);
});

test("groupSheet: a photo's tile reads photo <position>", async () => {
  const { r, text } = mk();
  await unwrap(r.groupSheet([{ id: "g0", regions: [square(0, "0.0"), { ...square(1, "1.0"), t: 3, photo: true }] }]));
  assert.equal(text.texts[1]?.[0]?.text, "1.0 photo 3");
});

test("groupSheet: a row per group (first CROP_COLS views), n = the group's size, empty group = blank row", async () => {
  const { r, text } = mk();
  const big = Array.from({ length: CROP_COLS + 3 }, (_, k) => square(k % 3, `${k % 3}.${k}`));
  const img = await unwrap(
    r.groupSheet([
      { id: "g0", regions: big },
      { id: "g1", regions: [] },
    ]),
  );
  assert.deepEqual([img?.w, img?.h], [CROP_COLS * CROP_TILE, 2 * CROP_TILE]);
  assert.equal(text.texts.length, CROP_COLS);
  assert.equal(text.texts[0]?.[0]?.text, `g0 n=${big.length} 0.0`);
  assert.equal(text.texts[1]?.[0]?.text, `1.1 ${big[1]?.t.toFixed(1)}s`);
  const second = img ? img.data.subarray(CROP_TILE * CROP_COLS * CROP_TILE * 3) : new Uint8Array(1);
  assert.ok(
    second.every((v) => v === 0),
    "empty group row is black",
  );
});

test("grid: a single row is not padded; several rows pad the last with black", () => {
  const { r } = mk();
  const t = noise(1, 4, 3);
  const one = r.grid([t, t, t], 6);
  assert.deepEqual([one.w, one.h], [12, 3]);
  const two = r.grid([t, t, t], 2);
  assert.deepEqual([two.w, two.h], [8, 6]);
  const pad = two.data.subarray((3 * 8 + 4) * 3, (3 * 8 + 8) * 3);
  assert.ok(pad.every((v) => v === 0));
});

test("overlay: regions blend in order (later blend covers an earlier outline), input frame untouched", async () => {
  const { r } = mk();
  const a = square(0, "a", 4, 4, 8),
    b = square(0, "b", 8, 8, 8);
  const ab = await unwrap(r.overlay(fno(0), [a, b], { scale: 1 }));
  const ba = await unwrap(r.overlay(fno(0), [b, a], { scale: 1 }));
  assert.notDeepEqual(ab.data, ba.data);
  const src = noise(1000, W, H);
  const plain = await unwrap(r.overlay(fno(0), [], { scale: 1 }));
  // no regions, scale 1, and the tag anchor (8, 34) lies below this 24 px frame, so the frame comes back as is
  assert.deepEqual(plain.data, src.data);
});
