/** Includes the cv2 double-windowing quirk that phaseCorrelateFrames reproduces with its `passesA` argument. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { pickKeyframes } from "../../src/video/internal/keyframes.ts";
import {
  hanning,
  laplacianVar,
  phaseCorrelateFrames,
  pickTimes,
  streamHeight,
} from "../../src/video/internal/keyframes.kernel.ts";
import { type Known, json, npz, parity } from "../fixtures/numerics/lib.ts";

type Meta = {
  w: number;
  h: number;
  n: number;
  fps: number;
  inplace_window_quirk: boolean;
  hanning_f32_bits: Record<string, number[]>;
  sharp: number[];
  shifts: [number, number][];
  shifts_single_window: [number, number][];
  picks: Record<string, number[]>;
};
const meta = json<Meta>("keyframes.json");
const stream = npz("keyframes.npz")("stream").data as Uint8Array;
const { w, h, n } = meta;
const frame = (i: number) => stream.subarray(i * w * h, (i + 1) * w * h);
/** Recorded kernel outputs on this stream. */
const RECORDED = JSON.parse(readFileSync(new URL("recorded-keyframes.json", import.meta.url), "utf8")) as {
  sharp: number[];
  shifts: [number, number][];
  shifts_single_window: [number, number][];
};

test("the goldens were made with cv2.phaseCorrelate windowing in place (the quirk being reproduced)", () => {
  assert.equal(meta.inplace_window_quirk, true);
  assert.equal(stream.length, n * w * h);
});

const HANNING_KNOWN: Record<string, Known> = {
  "64x48": { n: 392, maxDiff: 1, why: "sqrt in float32 of the float32-rounded product (cv2) vs sqrt in double" },
};
for (const [size, bits] of Object.entries(meta.hanning_f32_bits))
  test(`hanning ${size} = cv2.createHanningWindow(CV_32F)`, () => {
    const [ww, hh] = size.split("x").map(Number) as [number, number];
    parity(new Uint32Array(hanning(ww, hh).buffer), bits, HANNING_KNOWN[size]);
  });

test("laplacianVar = cv2.Laplacian(CV_32F).var() per frame (rel 1e-5), bit-identical to the recorded outputs", () => {
  for (let i = 0; i < n; i++) {
    const v = laplacianVar(frame(i), w, h);
    assert.ok(Math.abs(v - meta.sharp[i]!) <= 1e-5 * meta.sharp[i]!, `frame ${i}: ${v} vs ${meta.sharp[i]}`);
    assert.ok(Object.is(v, RECORDED.sharp[i]));
  }
});

const SHIFT_TOL = 5e-5;
const win = hanning(w, h);
for (const [name, ref, passes, recordedShifts] of [
  [
    "as in pick_keyframes (first argument windowed twice after the first pair)",
    meta.shifts,
    (i: number) => (i >= 2 ? 2 : 1),
    RECORDED.shifts,
  ],
  ["fresh frames (windowed once)", meta.shifts_single_window, () => 1, RECORDED.shifts_single_window],
] as const)
  test(`phaseCorrelateFrames ${name} = cv2.phaseCorrelate, bit-identical to the recorded outputs`, () => {
    let max = 0;
    for (let i = 1; i < n; i++) {
      const [dx, dy] = phaseCorrelateFrames(frame(i - 1), frame(i), w, h, win, passes(i));
      const [rx, ry] = ref[i - 1]!;
      max = Math.max(max, Math.abs(dx - rx), Math.abs(dy - ry));
      assert.deepEqual([dx, dy], recordedShifts[i - 1]);
    }
    assert.ok(max <= SHIFT_TOL, `max shift diff ${max}`);
  });

test("the double windowing matters: single-window shifts differ from the pick_keyframes ones", () => {
  const d = meta.shifts.slice(1).map(([x], i) => Math.abs(x - meta.shifts_single_window[i + 1]![0]));
  assert.ok(Math.max(...d) > 10 * SHIFT_TOL);
});

for (const [thresh, picks] of Object.entries(meta.picks)) {
  test(`pickTimes thresh ${thresh} = eyespy_server.pick_keyframes`, () => {
    assert.deepEqual(pickTimes(stream, w, h, Number(thresh), meta.fps), picks);
  });
  test(`pickKeyframes (over a ClipSource) thresh ${thresh} = eyespy_server.pick_keyframes`, async () => {
    const reads = {
      grayStream: async (_ref: string, fps: number, ow: number, oh: number) => {
        assert.deepEqual([fps, ow, oh], [meta.fps, w, h]);
        return stream;
      },
    };
    const got = await pickKeyframes(reads, "synthetic", { w, h }, Number(thresh), meta.fps, w);
    assert.deepEqual(got._unsafeUnwrap(), picks);
  });
}

test("an empty stream still picks the first frame", () => {
  assert.deepEqual(pickTimes(new Uint8Array(0), 8, 6, 0.1, 5), [0]);
});

test("grey stream height: even, aspect kept", () => {
  assert.equal(streamHeight(1920, 1080, 360), 202);
  assert.equal(streamHeight(1080, 1920, 360), 640);
  assert.equal(streamHeight(160, 120, 360), 270);
});

test("pickKeyframes: a grey-stream failure is a HostFailure", async () => {
  const r = await pickKeyframes(
    { grayStream: () => Promise.reject(new Error("decoder exited 1")) },
    "x",
    { w: 16, h: 16 },
    0.1,
  );
  assert.deepEqual(r._unsafeUnwrapErr(), {
    kind: "host",
    port: "video",
    op: "grayStream",
    message: "decoder exited 1",
  });
});
