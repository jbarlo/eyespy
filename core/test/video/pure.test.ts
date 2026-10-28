import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CONTENT_KEY_RANGE,
  contentKey,
  contentKeyOf,
  describeFramesError,
  frameAt,
  sampleAt,
  sampleCount,
  frameFiles,
  framesKey,
  naturalCompare,
  parseFrameSpec,
} from "../../src/video/pure.ts";

const parse = (spec: string | number | null, n: number): readonly number[] | string =>
  parseFrameSpec(spec, n).match(
    (fs) => fs,
    (e) => `bad frame spec: ${e.part}`,
  );

/** Answers at n = 6, as in the fake world. Each is the frames or the error message. */
const SAME: readonly [string | number | null, number[] | string][] = [
  ["", [0, 1, 2, 3, 4, 5]],
  [null, [0, 1, 2, 3, 4, 5]],
  [0, [0]],
  [3, [3]],
  ["0", [0]],
  ["0-2", [0, 1, 2]],
  ["0,4", [0, 4]],
  [" 1 , 3 ", [1, 3]],
  ["1-3,3", [1, 2, 3, 3]],
  ["0-99", [0, 1, 2, 3, 4, 5]],
  ["99", []],
  ["1 - 3", [1, 2, 3]],
  ["007", []],
  ["5-5", [5]],
  ["-1", "bad frame spec: -1"],
  ["abc", "bad frame spec: abc"],
  ["1.5", "bad frame spec: 1.5"],
  ["1-x", "bad frame spec: 1-x"],
  ["x-1", "bad frame spec: x-1"],
  ["1-2-3", "bad frame spec: 1-2-3"],
  [" ", "bad frame spec:  "],
  ["3,1", [3, 1]],
];
for (const [spec, want] of SAME)
  test(`frame spec ${JSON.stringify(spec)}`, () => {
    assert.deepEqual(parse(spec, 6), want);
  });

/** Open ranges, reversed ranges and empty parts are errors that name the part (or the whole spec). */
const STRICT: readonly [string, string][] = [
  ["1-", "bad frame spec: 1-"],
  ["2-0", "bad frame spec: 2-0"],
  ["0,,1", "bad frame spec: 0,,1"],
  ["0,", "bad frame spec: 0,"],
];
for (const [spec, want] of STRICT)
  test(`frame spec ${JSON.stringify(spec)}: ${want}`, () => {
    assert.deepEqual(parse(spec, 6), want);
  });

test("frame spec: huge ranges don't loop over every number", () => {
  assert.deepEqual(parse("2-100000000000", 4), [2, 3]);
  assert.deepEqual(parse("", 0), []);
});

const nodeKey = (file: Uint8Array) => {
  const n = Math.min(CONTENT_KEY_RANGE, file.length);
  return createHash("sha1")
    .update(String(file.length))
    .update(file.subarray(0, n))
    .update(
      file.subarray(Math.max(0, file.length - CONTENT_KEY_RANGE), Math.max(0, file.length - CONTENT_KEY_RANGE) + n),
    )
    .digest("hex")
    .slice(0, 12);
};
const fileOf = (size: number, seed: number) =>
  Uint8Array.from({ length: size }, (_, i) => Math.imul(i ^ seed, 2654435761) >>> 24);
const sourceOf = (file: Uint8Array) => {
  const reads: [number, number][] = [];
  return {
    reads,
    size: async () => file.length,
    readRange: async (_ref: string, a: number, b: number) => {
      reads.push([a, b]);
      return file.slice(a, b);
    },
  };
};

for (const [name, size] of [
  ["empty", 0],
  ["small (head = tail = whole file)", 1000],
  ["1.5 MiB (head and tail overlap)", (3 << 20) / 2],
  ["3 MiB", 3 << 20],
] as const)
  test(`contentKeyOf ${name} = the Node adapter's sha1(size + head + tail)[:12]`, async () => {
    const file = fileOf(size, 7);
    const src = sourceOf(file);
    const key = (await contentKeyOf(src, "f"))._unsafeUnwrap();
    assert.equal(key, nodeKey(file));
    const n = Math.min(CONTENT_KEY_RANGE, size);
    assert.deepEqual(src.reads, [
      [0, n],
      [Math.max(0, size - CONTENT_KEY_RANGE), Math.max(0, size - CONTENT_KEY_RANGE) + n],
    ]);
  });

test("contentKey: a fixed vector (sha1 of '3abcabc')", async () => {
  const abc = new TextEncoder().encode("abc");
  assert.equal(await contentKey(3, abc, abc), createHash("sha1").update("3abcabc").digest("hex").slice(0, 12));
});

test("contentKeyOf: host failures are values", async () => {
  const r = await contentKeyOf(
    { size: () => Promise.reject(new Error("ENOENT")), readRange: async () => new Uint8Array() },
    "f",
  );
  assert.deepEqual(r._unsafeUnwrapErr(), { kind: "host", port: "video", op: "size", message: "ENOENT" });
});

test("frameFiles: JPEG/PNG in natural order, hidden files ignored", () => {
  const names = ["f10.jpg", "f2.JPG", "f1.png", ".DS_Store", "f02.jpeg", "f100.jpg"];
  assert.deepEqual(frameFiles(names)._unsafeUnwrap(), ["f1.png", "f2.JPG", "f02.jpeg", "f10.jpg", "f100.jpg"]);
  assert.deepEqual(frameFiles(["000010.jpg", "000009.jpg"])._unsafeUnwrap(), ["000009.jpg", "000010.jpg"]);
  assert.deepEqual(frameFiles(["b.jpg", "a10b.jpg", "a9z.jpg"])._unsafeUnwrap(), ["a9z.jpg", "a10b.jpg", "b.jpg"]);
});

test("frameFiles: other files and empty folders are errors, with a sentence", () => {
  const bad = frameFiles(["1.jpg", "notes.txt", "clip.mov", "2.jpg", "a.gif", "z.webp"])._unsafeUnwrapErr();
  assert.deepEqual(bad, { kind: "not-frames", names: ["a.gif", "clip.mov", "notes.txt"] });
  assert.equal(
    describeFramesError("/f", bad),
    "/f has files that aren't JPEG or PNG frames: a.gif, clip.mov, notes.txt (a clip is a folder of images only)",
  );
  assert.deepEqual(frameFiles([".hidden"])._unsafeUnwrapErr(), { kind: "no-frames" });
  assert.equal(
    describeFramesError("/f", { kind: "no-frames" }),
    "no frames in /f (a clip is a folder of JPEG or PNG images)",
  );
});

test("naturalCompare: numbers by value, then by length", () => {
  assert.ok(naturalCompare("x2", "x10") < 0);
  assert.ok(naturalCompare("x1", "x01") < 0);
  assert.ok(naturalCompare("x99999999999999999999", "x100000000000000000000") < 0);
  assert.equal(naturalCompare("a", "a"), 0);
});

test("framesKey: sha1 of the sha1sum-style manifest, first 12 hex digits", async () => {
  const frames = [
    { name: "1.jpg", sha1: "a".repeat(40) },
    { name: "2.jpg", sha1: "b".repeat(40) },
  ];
  const manifest = `${"a".repeat(40)}  1.jpg\n${"b".repeat(40)}  2.jpg\n`;
  assert.equal(await framesKey(frames), createHash("sha1").update(manifest).digest("hex").slice(0, 12));
  // the key covers names and order
  assert.notEqual(await framesKey(frames), await framesKey(frames.toReversed()));
  assert.notEqual(await framesKey(frames), await framesKey([{ name: "x.jpg", sha1: "a".repeat(40) }, frames[1]!]));
});

test("frameAt: the first frame at or after t (an accurate seek), clamped", () => {
  assert.equal(frameAt(0, 30, 100), 0);
  assert.equal(frameAt(1.2, 30, 100), 36);
  assert.equal(frameAt(0.2, 29.97, 100), 6); // 5 is at 0.167, 6 at 0.2002
  assert.equal(frameAt(1, 29.97, 100), 30); // 1.001
  assert.equal(frameAt(0.21, 30, 100), 7); // 6 is at 0.2, 7 at 0.233
  assert.equal(frameAt(99, 30, 100), 99);
  assert.equal(frameAt(-1, 30, 100), 0);
  // a time recorded to 2 decimals finds its frame again at up to 100 fps
  for (const fps of [1, 4, 5, 12.5, 24, 29.97, 60, 100])
    for (let i = 0; i < 300; i++) assert.equal(frameAt(Math.round((i / fps) * 100) / 100, fps, 1000), i);
});

test("sampleAt / sampleCount: ffmpeg's fps filter (last frame whose time rounds to the slot)", () => {
  // for 30 fps sampled at 5, frames k with round(k / 6) = n are 6n-3 to 6n+2. The last is 6n+2 (first slot 0 to 2)
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => sampleAt(n, 5, 30, 1000)),
    [2, 8, 14, 20],
  );
  // for 29.97 fps sampled at 5, slot 1 ends at 1.5 · 5.994 = 8.99, which is frame 8
  assert.equal(sampleAt(1, 5, 29.97, 1000), 8);
  // at its own rate every sample is its frame
  for (const fps of [1, 3, 4, 5]) for (let n = 0; n < 50; n++) assert.equal(sampleAt(n, fps, fps, 1000), n);
  assert.equal(sampleAt(10, 5, 30, 20), 19, "clamped to the folder");
  assert.equal(sampleCount(5, 30, 600), 100);
  assert.equal(sampleCount(5, 29.97, 600), 100);
  assert.equal(sampleCount(4, 4, 7), 7);
  assert.equal(sampleCount(5, 30, 1), 1);
});
