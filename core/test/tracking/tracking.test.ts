import assert from "node:assert/strict";
import { test } from "node:test";
import { createTracking } from "../../src/tracking/index.ts";
import type { Tracking } from "../../src/tracking/index.ts";
import { MASK_SIZE, MODEL_FILES, TRUNK_LEN } from "../../src/perception/pure.ts";
import type { Model, ModelRuntime, Tensor } from "../../src/ports/index.ts";
import { MEMORY_LEN, startTrack, type TrackDirection, type TrackMemory } from "../../src/tracking/pure.ts";
import { selectMemory } from "../../src/tracking/internal/bank.ts";
import { memoryTokens } from "../../src/tracking/internal/inputs.kernel.ts";
import { FakeClock, FakeLogger, FakeModelRuntime, type TrackerRun } from "../fakes/index.ts";

const FP32 = MODEL_FILES.tracker.graphs.fp32;
const MASK = new Uint8Array(MASK_SIZE * MASK_SIZE).fill(1);
const TRUNK = new Uint16Array(TRUNK_LEN);

const tracking = (rt: ModelRuntime, precision: "fp16" | "fp32" = "fp32"): Tracking =>
  createTracking({ runtime: rt, clock: new FakeClock(), logger: new FakeLogger() }, { precision });

const value = <T, E>(r: { isOk(): boolean; _unsafeUnwrap(): T; _unsafeUnwrapErr(): E }): T => {
  if (!r.isOk()) assert.fail(`expected ok, got ${JSON.stringify(r._unsafeUnwrapErr())}`);
  return r._unsafeUnwrap();
};

const data = (run: TrackerRun | undefined, name: string): Float32Array => {
  const d = run?.feeds[name]?.data;
  assert.ok(d instanceof Float32Array, `${name} is float32`);
  return d;
};

const tokensOf = (at: number, fill: number) => ({
  at,
  tokens: new Float32Array(MEMORY_LEN).fill(fill),
  pointer: new Float32Array(256).fill(fill),
});
const seedAt = (at: number, clipFrames = 100) => ({ ...tokensOf(at, 1000), clipFrames });

test("a seed's memory comes from the binarised mask with score +10, and its pointer from the decoder", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
  mask[5] = 255;
  mask[6] = 1;
  const seed = value(await t.seed(frame, mask, 3, 10));
  assert.deepEqual(
    rt.trackerRuns.map((r) => r.file),
    [FP32.neck, FP32.maskEmbed, FP32.decoder, FP32.memenc],
  );
  const [, embed, decoder, memenc] = rt.trackerRuns;
  assert.deepEqual(data(embed, "mask").subarray(4, 8), Float32Array.of(0, 1, 1, 0));
  // The decoder reads the frame's own features, so no no-memory embedding is added.
  assert.equal(data(decoder, "feat"), frame.f72);
  assert.deepEqual(data(memenc, "mask").subarray(4, 8), Float32Array.of(-10, 10, 10, -10));
  assert.deepEqual(data(memenc, "score"), Float32Array.of(10));
  assert.deepEqual(data(memenc, "binarize"), Float32Array.of(1));
  assert.equal(seed.at, 3);
  assert.equal(seed.clipFrames, 10);
  assert.equal(seed.pointer[0], 1);
  assert.equal(seed.tokens[0], 1);
  assert.equal(seed.tokens.length, MEMORY_LEN);
});

test("memory tokens go token by token and are rounded to bfloat16 as upstream stores them", () => {
  const mem = new Float32Array(MEMORY_LEN);
  mem[0] = 1 + 2 ** -8; // a tie between bfloat16 neighbours 1 and 1 + 2^-7: to even
  mem[1] = 1 + 3 * 2 ** -8; // a tie: to even, 1 + 2^-6
  mem[2] = 1.004; // just above the first tie: up
  mem[3] = -1.004;
  mem[72 * 72] = 0.5; // channel 1 of token 0
  const t = memoryTokens(mem);
  assert.deepEqual(
    [0, 1, 2, 3].map((token) => t[token * 64]),
    [1, 1 + 2 ** -6, 1 + 2 ** -7, -(1 + 2 ** -7)],
  );
  assert.equal(t[1], 0.5);
});

test("an empty seed mask is an error and runs nothing", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const runs = rt.trackerRuns.length;
  const r = await t.seed(frame, new Uint8Array(MASK_SIZE * MASK_SIZE), 0, 10);
  assert.deepEqual(r._unsafeUnwrapErr(), { kind: "track-seed-empty" });
  assert.equal(rt.trackerRuns.length, runs);
});

test("a seed outside the clip is an error", async () => {
  const t = tracking(new FakeModelRuntime());
  const frame = value(await t.frame(TRUNK));
  const r = await t.seed(frame, MASK, 10, 10);
  assert.equal(r._unsafeUnwrapErr().kind, "track-frame-order");
});

test("the fp16 neck reads the trunk's bits as they are, with no copy", async () => {
  const rt = new FakeModelRuntime();
  const trunk = new Uint16Array(TRUNK_LEN);
  trunk[0] = 0x4000; // 2.0
  const frame = value(await tracking(rt, "fp16").frame(trunk));
  assert.equal(frame.f72[0], 2);
  const fed = rt.trackerRuns[0]?.feeds.trunk;
  assert.equal(fed?.type, "float16");
  assert.equal(fed?.data, trunk);
});

test("the fp32 neck reads the trunk widened to float32", async () => {
  const rt = new FakeModelRuntime();
  const trunk = new Uint16Array(TRUNK_LEN);
  trunk[0] = 0x4000; // 2.0
  const frame = value(await tracking(rt).frame(trunk));
  assert.equal(frame.f72[0], 2);
  assert.deepEqual(rt.trackerRuns[0]?.feeds.trunk?.dims, [1, 1024, 72, 72]);
});

test("precision picks the graph set", async () => {
  const rt = new FakeModelRuntime();
  value(await tracking(rt, "fp16").frame(TRUNK));
  assert.deepEqual(rt.loads, [MODEL_FILES.tracker.graphs.fp16.neck]);
});

test("a propagate runs the four layers one by one, each on the last one's output, then decoder and memory", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  rt.trackerRuns = [];
  const step = value(await t.propagate(frame, startTrack(seed, "forward"), 1));
  assert.deepEqual(
    rt.trackerRuns.map((r) => r.file),
    [MODEL_FILES.tracker.tables, ...FP32.attention, FP32.decoder, FP32.memenc],
  );
  const [, l0, l1, l2, l3, decoder, memenc] = rt.trackerRuns;
  assert.equal(l0?.feeds.x?.data, frame.f72);
  assert.deepEqual(l0?.feeds.x?.dims, [1, 256, 72, 72]);
  for (const l of [l1, l2, l3]) assert.deepEqual(l?.feeds.x?.dims, [1, 5184, 256]);
  assert.deepEqual(data(decoder, "dense").subarray(0, 2), Float32Array.of(0.5, 0.5));
  assert.deepEqual(data(memenc, "binarize"), Float32Array.of(0));
  assert.deepEqual(data(memenc, "score"), Float32Array.of(1.5));
  assert.equal(step.score, 1.5);
  assert.ok(Math.abs(step.iou - 0.8) < 1e-6);
  assert.equal(step.logits[0], 1);
  assert.equal(step.memory.recent.length, 1);
  assert.equal(step.memory.recent[0]?.at, 1);
});

test("attention reads the seed's block, then two recent blocks oldest first, each with its temporal row", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  let m: TrackMemory = startTrack(seed, "forward");
  for (const at of [1, 2, 3, 4]) {
    rt.trackerRuns = [];
    m = value(await t.propagate(frame, m, at)).memory;
  }
  // The seed encoded memory 1, frames 1..4 encoded 2..5. Frame 4 read the seed, frame 2 (row 1), frame 3 (row 0).
  const l0 = rt.trackerRuns.find((r) => r.file === FP32.attention[0]);
  assert.deepEqual(l0?.feeds.spatial?.dims, [1, 3 * 5184, 64]);
  const at = (name: string, block: number) => data(l0, name)[block * MEMORY_LEN];
  assert.deepEqual([at("spatial", 0), at("spatial", 1), at("spatial", 2)], [1, 3, 4]);
  assert.deepEqual([at("spatial_pos", 0), at("spatial_pos", 1), at("spatial_pos", 2)], [7, 2, 1]);
  // Pointers: the seed's, then newest first. Decoder calls: 1 is the seed, 2..4 frames 1..3.
  assert.deepEqual(l0?.feeds.pointer?.dims, [1, 16, 64]);
  const ptr = data(l0, "pointer");
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => ptr[k * 256]),
    [1, 4, 3, 2],
  );
  const pos = data(l0, "pointer_pos");
  const sine = (offset: number) => Math.fround(Math.sin(offset / 9));
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => pos[k * 256]),
    [sine(4), sine(1), sine(2), sine(3)],
  );
  // A pointer's four tokens share one position.
  assert.equal(pos[64], pos[0]);
  assert.equal(pos[3 * 64], pos[0]);
});

test("reverse mirrors forward: same memory order and offsets, frames counted down", async () => {
  const run = async (direction: TrackDirection, frames: readonly number[], start: number) => {
    const rt = new FakeModelRuntime();
    const t = tracking(rt);
    const frame = value(await t.frame(TRUNK));
    const seed = value(await t.seed(frame, MASK, start, 20));
    let m: TrackMemory = startTrack(seed, direction);
    for (const at of frames) {
      rt.trackerRuns = [];
      m = value(await t.propagate(frame, m, at)).memory;
    }
    const l0 = rt.trackerRuns.find((r) => r.file === FP32.attention[0]);
    return { spatial: data(l0, "spatial"), spatialPos: data(l0, "spatial_pos"), pos: data(l0, "pointer_pos"), m };
  };
  const fwd = await run("forward", [6, 7, 8], 5);
  const rev = await run("reverse", [4, 3, 2], 5);
  assert.deepEqual(rev.spatial, fwd.spatial);
  assert.deepEqual(rev.spatialPos, fwd.spatialPos);
  assert.deepEqual(rev.pos, fwd.pos);
  assert.deepEqual(
    rev.m.recent.map((f) => f.at),
    [4, 3, 2],
  );
});

test("a track refuses frames behind it or outside the clip, in both directions", async () => {
  const t = tracking(new FakeModelRuntime());
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 5, 8));
  const cases: readonly [TrackDirection, number][] = [
    ["forward", 5],
    ["forward", 4],
    ["forward", 8],
    ["forward", 5.5],
    ["reverse", 5],
    ["reverse", 6],
    ["reverse", -1],
  ];
  for (const [d, at] of cases) {
    const r = await t.propagate(frame, startTrack(seed, d), at);
    assert.deepEqual(r._unsafeUnwrapErr(), { kind: "track-frame-order", at, last: 5, clipFrames: 8 });
  }
  const m = value(await t.propagate(frame, startTrack(seed, "forward"), 6)).memory;
  const again = await t.propagate(frame, m, 6);
  assert.deepEqual(again._unsafeUnwrapErr(), { kind: "track-frame-order", at: 6, last: 6, clipFrames: 8 });
});

test("the bank keeps tokens of two frames and pointers of fifteen, and at most 16 pointers are read", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 100));
  let m: TrackMemory = startTrack(seed, "forward");
  for (let at = 1; at <= 30; at++) m = value(await t.propagate(frame, m, at)).memory;
  assert.equal(m.recent.length, 15);
  assert.deepEqual(
    m.recent.map((f) => f.at),
    Array.from({ length: 15 }, (_, k) => 16 + k),
  );
  assert.deepEqual(
    m.recent.filter((f) => f.tokens).map((f) => f.at),
    [29, 30],
  );
  const sel = selectMemory(m, 31);
  assert.equal(sel.blocks.length, 3);
  assert.equal(sel.pointers.length, 16);
  assert.equal(sel.maxOffset, 15);
  assert.equal(sel.pointers[0]?.offset, 31);
});

test("selection: a short clip scales pointer offsets by its length, and a gap leaves a block out", () => {
  const m: TrackMemory = {
    direction: "forward",
    seed: seedAt(0, 6),
    recent: [tokensOf(1, 1), tokensOf(2, 2)],
  };
  assert.equal(selectMemory(m, 3).maxOffset, 5);
  const gap = selectMemory(m, 4);
  assert.deepEqual(
    gap.blocks.map((b) => b.row),
    [6, 1],
  );
  assert.deepEqual(
    gap.pointers.map((p) => p.offset),
    [4, 2, 3],
  );
  const far = selectMemory(m, 5);
  assert.deepEqual(
    far.blocks.map((b) => b.row),
    [6],
  );
  // Past the clip's span a pointer drops out. The seed's stays, whatever its offset.
  assert.deepEqual(
    far.pointers.map((p) => p.offset),
    [5, 3, 4],
  );
  const big: TrackMemory = { ...m, seed: seedAt(0, 6), recent: [tokensOf(1, 1)] };
  assert.deepEqual(
    selectMemory(big, 6).pointers.map((p) => p.offset),
    [6, 5],
  );
  assert.deepEqual(
    selectMemory(big, 7).pointers.map((p) => p.offset),
    [7],
  );
});

test("a track saved between frames continues exactly: the state is plain data", async () => {
  const go = async (save: (m: TrackMemory) => TrackMemory) => {
    const rt = new FakeModelRuntime();
    const t = tracking(rt);
    const frame = value(await t.frame(TRUNK));
    const seed = value(await t.seed(frame, MASK, 0, 10));
    let m = startTrack(seed, "forward");
    for (const at of [1, 2, 3]) m = save(value(await t.propagate(frame, m, at)).memory);
    rt.trackerRuns = [];
    value(await t.propagate(frame, m, 4));
    return rt.trackerRuns.filter((r) => r.file === FP32.attention[0]).map((r) => r.feeds);
  };
  assert.deepEqual(await go(structuredClone), await go((m) => m));
});

test("propagate leaves the state it was given alone", async () => {
  const t = tracking(new FakeModelRuntime());
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  const m0 = startTrack(seed, "forward");
  const m1 = value(await t.propagate(frame, m0, 1)).memory;
  const m2 = value(await t.propagate(frame, m1, 2)).memory;
  const m3 = value(await t.propagate(frame, m1, 2)).memory;
  assert.equal(m0.recent.length, 0);
  assert.equal(m1.recent.length, 1);
  assert.equal(m2.recent.length, 2);
  assert.equal(m3.recent.length, 2);
});

test("an object off the frame still leaves memory, with the decoder's score", async () => {
  const rt = new FakeModelRuntime({ trackerDecoder: (n) => (n === 1 ? { score: -3, logit: -1024 } : {}) });
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  const step = value(await t.propagate(frame, startTrack(seed, "forward"), 1));
  assert.equal(step.score, -3);
  assert.equal(step.logits[0], -1024);
  assert.equal(step.memory.recent.length, 1);
  const memenc = rt.trackerRuns.at(-1);
  assert.equal(memenc?.file, FP32.memenc);
  assert.deepEqual(data(memenc, "score"), Float32Array.of(-3));
});

/** The fake runtime with a run of `file` failing, or with one output taken away. */
class Broken implements ModelRuntime {
  readonly inner = new FakeModelRuntime();
  failLoad = "";
  failRun = "";
  dropOutput: { file: string; name: string } | null = null;
  async load(name: string): Promise<Model> {
    if (name === this.failLoad) throw new Error("no such file");
    const m = await this.inner.load(name);
    return {
      run: async (feeds) => {
        if (name === this.failRun) throw new Error("device lost");
        const r: Record<string, Tensor> = { ...(await m.run(feeds)) };
        if (this.dropOutput?.file === name) delete r[this.dropOutput.name];
        return r;
      },
    };
  }
  readText = (name: string) => this.inner.readText(name);
  describe = () => this.inner.describe();
  sha256 = (name: string) => this.inner.sha256(name);
}

test("a failed run or load is a host failure, and the next call retries", async () => {
  const rt = new Broken();
  const t = tracking(rt);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  const m = startTrack(seed, "forward");
  rt.failRun = FP32.attention[2];
  const r = await t.propagate(frame, m, 1);
  assert.deepEqual(r._unsafeUnwrapErr(), { kind: "host", port: "runtime", op: "run", message: "device lost" });
  rt.failRun = "";
  value(await t.propagate(frame, m, 1));

  const rt2 = new Broken();
  rt2.failLoad = MODEL_FILES.tracker.tables;
  const t2 = tracking(rt2);
  const f2 = value(await t2.frame(TRUNK));
  const s2 = value(await t2.seed(f2, MASK, 0, 10));
  assert.equal((await t2.propagate(f2, startTrack(s2, "forward"), 1))._unsafeUnwrapErr().kind, "host");
  rt2.failLoad = "";
  value(await t2.propagate(f2, startTrack(s2, "forward"), 1));
});

test("a missing output names its graph and output", async () => {
  const cases = [
    { file: FP32.neck, name: "f72", stage: "frame" },
    { file: FP32.maskEmbed, name: "dense", stage: "seed" },
    { file: FP32.memenc, name: "mem", stage: "seed" },
    { file: FP32.decoder, name: "pointer", stage: "seed" },
    { file: MODEL_FILES.tracker.tables, name: "no_mask", stage: "propagate" },
    { file: FP32.attention[1], name: "y", stage: "propagate" },
  ];
  for (const { file, name, stage } of cases) {
    const rt = new Broken();
    const t = tracking(rt);
    if (stage === "frame") rt.dropOutput = { file, name };
    const fr = await t.frame(TRUNK);
    if (stage === "frame") {
      assert.deepEqual(fr._unsafeUnwrapErr(), { kind: "model-output-missing", model: file, output: name });
      continue;
    }
    const frame = value(fr);
    if (stage === "seed") rt.dropOutput = { file, name };
    const s = await t.seed(frame, MASK, 0, 10);
    if (stage === "seed") {
      assert.deepEqual(s._unsafeUnwrapErr(), { kind: "model-output-missing", model: file, output: name });
      continue;
    }
    rt.dropOutput = { file, name };
    const p = await t.propagate(frame, startTrack(value(s), "forward"), 1);
    assert.deepEqual(p._unsafeUnwrapErr(), { kind: "model-output-missing", model: file, output: name });
  }
});

test("wrong input lengths are bugs", async () => {
  const t = tracking(new FakeModelRuntime());
  assert.throws(() => t.frame(new Uint16Array(4)), /trunk/);
  const frame = value(await t.frame(TRUNK));
  assert.throws(() => t.seed(frame, new Uint8Array(4), 0, 10), /seed mask/);
});

test("graphs load once, on first use, and the tables run once", async () => {
  const rt = new FakeModelRuntime();
  const t = tracking(rt);
  assert.deepEqual(rt.loads, []);
  const frame = value(await t.frame(TRUNK));
  const seed = value(await t.seed(frame, MASK, 0, 10));
  let m = startTrack(seed, "forward");
  for (const at of [1, 2]) m = value(await t.propagate(frame, m, at)).memory;
  assert.equal(new Set(rt.loads).size, rt.loads.length);
  assert.equal(rt.calls[MODEL_FILES.tracker.tables], 1);
  assert.equal(rt.calls[FP32.attention[0]], 2);
});
