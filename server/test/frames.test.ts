/** FramesFolder: ordering, EXIF rotation, rate subsampling, photos, the content key, and refused folders. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { exifCaptured, FramesFolder } from "../src/adapters/frames.ts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "eyespy-frames-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let dirs = 0;
const folder = (files: Record<string, Uint8Array | string>): string => {
  const dir = path.join(TMP, `f${dirs++}`);
  mkdirSync(dir);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
  return dir;
};

/** A w×h image of one grey level. */
const solid = (w: number, h: number, v: number) =>
  sharp(Buffer.alloc(w * h * 3, v), { raw: { width: w, height: h, channels: 3 } });
const png = async (w: number, h: number, v: number) => new Uint8Array(await solid(w, h, v).png().toBuffer());
const jpeg = async (w: number, h: number, v: number) =>
  new Uint8Array(await solid(w, h, v).jpeg({ quality: 95 }).toBuffer());
/** Mean of a grey stream's sample n (w×h each). */
const mean = (raw: Uint8Array, n: number, w: number, h: number) =>
  raw.subarray(n * w * h, (n + 1) * w * h).reduce((a, b) => a + b, 0) / (w * h);
const levels = (raw: Uint8Array, w: number, h: number) =>
  Array.from({ length: raw.length / (w * h) }, (_, n) => Math.round(mean(raw, n, w, h)));

test("frames: natural order (2 before 10), dotfiles and subfolders ignored, photos are stills", async () => {
  const dir = folder({
    "img10.png": await png(16, 8, 100),
    "img2.png": await png(16, 8, 20),
    "img1.png": await png(16, 8, 10),
    ".DS_Store": "junk",
  });
  mkdirSync(path.join(dir, "sub"));
  const v = new FramesFolder();
  const f = await v.open(dir, { fps: null });
  assert.deepEqual(f, { w: 16, h: 8, captured: null, timing: { kind: "stills", count: 3 } });
  assert.deepEqual(levels(await v.grayStream(dir, 5, 8, 4), 8, 4), [10, 20, 100]);
  // positions pick the photo; out of range clamps
  const at = async (t: number) => (await sharp(await v.frameJpeg(dir, t)).stats()).channels[0]!.mean;
  assert.ok(Math.abs((await at(1)) - 20) < 2);
  assert.ok(Math.abs((await at(2)) - 100) < 2);
  assert.ok(Math.abs((await at(9)) - 100) < 2);
});

test("frames: a rate folder above 5 fps is sampled as ffmpeg's fps filter; frameJpeg seeks the frame at/after t", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 30; i++) files[`${String(i + 1).padStart(6, "0")}.png`] = await png(16, 8, i * 8);
  const dir = folder(files);
  const v = new FramesFolder();
  assert.deepEqual(await v.open(dir, { fps: 30 }), {
    w: 16,
    h: 8,
    captured: null,
    timing: { kind: "rate", fps: 30, count: 30 },
  });
  // 5 fps over 30 frames at 30 fps picks the last frame that rounds to each slot: 2, 8, 14, 20, 26
  assert.deepEqual(levels(await v.grayStream(dir, 5, 8, 4), 8, 4), [16, 64, 112, 160, 208]);
  // at its own rate it picks every frame
  assert.equal((await v.grayStream(dir, 30, 8, 4)).length, 30 * 8 * 4);
  const at = async (t: number) => (await sharp(await v.frameJpeg(dir, t)).stats()).channels[0]!.mean;
  assert.ok(Math.abs((await at(0.4)) - 12 * 8) < 2);
  assert.ok(Math.abs((await at(0.41)) - 13 * 8) < 2); // 12 is at 0.4, 13 at 0.433
  await assert.rejects(v.grayStream(dir, 60, 8, 4), /grey stream at 60 fps from frames at 30 fps/);
});

test("frames: EXIF orientation is applied (size swapped, grey stream and keyframe upright)", async () => {
  // a 40×20 JPEG stored sideways. Orientation 6 means rotate 90° clockwise to display, giving 20×40 upright.
  const left = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: await solid(20, 20, 255).png().toBuffer(), left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const dir = folder({ "a.jpg": new Uint8Array(left), "b.jpg": new Uint8Array(left) });
  const v = new FramesFolder();
  const f = await v.open(dir, { fps: 2 });
  assert.deepEqual([f.w, f.h], [20, 40]);
  // stored left half (white) is the top half once rotated clockwise
  const g = await v.grayStream(dir, 2, 20, 40);
  const top = g.subarray(0, 20 * 20).reduce((a, b) => a + b, 0) / 400;
  const bottom = g.subarray(20 * 20, 20 * 40).reduce((a, b) => a + b, 0) / 400;
  assert.ok(top > 200 && bottom < 50, `top ${top}, bottom ${bottom}`);
  const kf = await v.frameJpeg(dir, 0);
  const m = await sharp(kf).metadata();
  assert.deepEqual([m.format, m.width, m.height, m.orientation ?? 1], ["jpeg", 20, 40, 1]);
});

test("frames: an upright JPEG keyframe is the file itself; a PNG is re-encoded as JPEG", async () => {
  const j = await jpeg(16, 8, 77);
  const dir = folder({ "1.jpg": j, "2.png": await png(16, 8, 30) });
  const v = new FramesFolder();
  await v.open(dir, { fps: 1 });
  assert.deepEqual(await v.frameJpeg(dir, 0), j);
  assert.equal((await sharp(await v.frameJpeg(dir, 1)).metadata()).format, "jpeg");
});

test("frames: content key = sha1 of the sha1sum manifest; same frames elsewhere, same key", async () => {
  const a = await png(8, 8, 1),
    b = await png(8, 8, 2);
  const one = folder({ "1.png": a, "2.png": b });
  const two = folder({ "2.png": b, "1.png": a, ".hidden": "x" });
  const v = new FramesFolder();
  const key = await v.key(one);
  const sha = (x: Uint8Array) => createHash("sha1").update(x).digest("hex");
  const manifest = `${sha(a)}  1.png\n${sha(b)}  2.png\n`;
  assert.equal(key, createHash("sha1").update(manifest).digest("hex").slice(0, 12));
  assert.equal(await v.key(two), key);
  assert.equal(await v.key(one), key, "stable across calls");
  assert.notEqual(await v.key(folder({ "1.png": a, "3.png": b })), key, "names count");
  assert.notEqual(await v.key(folder({ "1.png": b, "2.png": a })), key, "bytes count");
  const raw = readFileSync(path.join(one, "2.png"));
  raw.writeUInt8(raw.readUInt8(raw.length - 20) ^ 1, raw.length - 20);
  assert.notEqual(await v.key(folder({ "1.png": a, "2.png": raw })), key, "one byte counts");
});

test("frames: JPEG and PNG mixed in one folder are fine when they are one size", async () => {
  const dir = folder({ "1.jpg": await jpeg(16, 8, 50), "2.png": await png(16, 8, 150) });
  const v = new FramesFolder();
  await v.open(dir, { fps: 4 });
  assert.deepEqual(
    levels(await v.grayStream(dir, 4, 8, 4), 8, 4).map((x) => Math.round(x / 10)),
    [5, 15],
  );
});

test("frames: capture time from the first frame's EXIF DateTimeOriginal (+ offset), else null", async () => {
  const stamped = (exif: Record<string, string>) =>
    solid(16, 8, 9)
      .jpeg()
      .withExif({ IFD2: exif })
      .toBuffer()
      .then((b) => new Uint8Array(b));
  const v = new FramesFolder();
  const at = (files: Record<string, Uint8Array>) => v.open(folder(files), { fps: null }).then((f) => f.captured);
  const a = await stamped({ DateTimeOriginal: "2026:10:23 01:23:51" });
  const b = await stamped({ DateTimeOriginal: "2026:10:24 09:00:00", OffsetTimeOriginal: "+01:00" });
  assert.equal(await at({ "1.jpg": a, "2.jpg": b }), "2026-10-23T01:23:51");
  assert.equal(await at({ "1.jpg": b, "2.jpg": a }), "2026-10-24T09:00:00+01:00");
  assert.equal(await at({ "1.jpg": await jpeg(16, 8, 1), "2.jpg": a }), null, "only the first frame counts");
  assert.equal(await at({ "1.png": await png(16, 8, 1) }), null);
  assert.equal(exifCaptured(new Uint8Array([1, 2, 3])), null);
  assert.equal(exifCaptured(undefined), null);
});

test("frames: folders that aren't clips are refused with a sentence", async () => {
  const v = new FramesFolder();
  const p = await png(16, 8, 0);
  const refuses = (dir: string, re: RegExp, fps: number | null = null) => assert.rejects(v.open(dir, { fps }), re);
  await refuses(folder({}), /^Error: no frames in .*\(a clip is a folder of JPEG or PNG images\)/);
  await refuses(folder({ "1.png": p, "notes.txt": "hi" }), /has files that aren't JPEG or PNG frames: notes\.txt/);
  const file = path.join(folder({ "clip.mov": "not a video" }), "clip.mov");
  await refuses(file, /clip\.mov is a file; a clip is a folder of frames \(extract them first, see the README\)/);
  await refuses(folder({ "1.png": p, "2.jpg": "garbage" }), /2\.jpg in .*: not a readable image/);
  const webp = new Uint8Array(await solid(16, 8, 0).webp().toBuffer());
  await refuses(folder({ "1.png": p, "2.jpg": webp }), /2\.jpg in .*: a webp image, not JPEG or PNG/);
  await refuses(
    folder({ "1.png": p, "2.png": await png(8, 16, 0) }),
    /frames in .* differ in size: 1\.png is 16×8, 2\.png is 8×16 \(upright\); a clip's frames are all one size/,
  );
  await refuses(folder({ "1.png": p }), /fps must be a positive number, got 0/, 0);
  await assert.rejects(v.key(folder({ "a.txt": "x" })), /has files that aren't JPEG or PNG frames: a\.txt/);
  await assert.rejects(v.frameJpeg(folder({ "1.png": p }), 0), /was not opened/);
});
