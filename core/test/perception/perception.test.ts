import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Detected } from "../../src/perception/index.ts";
import { FEATURE_BYTES, MODEL_FILES, type Features } from "../../src/perception/pure.ts";
import { colorSignature, FakeModelRuntime, type DetectorScript } from "../fakes/index.ts";
import { noise, sha256 } from "../fixtures/numerics/lib.ts";
import { fno, MemFeatureStore, rig } from "./fakes.ts";

type Recorded = {
  instances: { score: number; box: number[]; mask: string }[];
  presence: number;
  heatmap: string | null;
};
const RECORDED = JSON.parse(readFileSync(new URL("recorded.json", import.meta.url), "utf8")) as {
  keyframe: Recorded;
  region: Recorded;
  embed: string[];
  embedCrop: string;
};
const recorded = (d: Detected): Recorded => ({
  instances: d.instances.map((i) => ({ score: i.score, box: [...i.box], mask: sha256(i.mask) })),
  presence: d.presence,
  heatmap: d.heatmap ? sha256(d.heatmap.data) : null,
});

const SCRIPT: DetectorScript = {
  presence: 1.5,
  queries: [
    { rect: [0.1, 0.1, 0.4, 0.5], logit: 2 },
    { rect: [0.11, 0.1, 0.41, 0.5], logit: 1.5 }, // overlaps the first, so NMS drops it
    { rect: [0.6, 0.55, 0.95, 0.9], logit: 3 }, // best score, so sorted first
    { rect: [0.5, 0.0, 0.7, 0.2], logit: -3 }, // under the floor
    { rect: [0.3, 0.7, 0.5, 0.75], logit: 0.5 },
  ],
  semantic: [[0.2, 0.2, 0.6, 0.6]],
};
const OPTS = { scoreFloor: 0.3, nmsIou: 0.5 };
const models = { detector: () => SCRIPT };

test("detect on a keyframe = the recorded find pipeline (floor, sort, upsample, NMS), plus heatmap and presence", async () => {
  const r = rig({ models });
  const img = r.frames.img(0);
  const f = (await r.p.features(fno(0)))._unsafeUnwrap();
  const d = (await r.p.detect(f, "red mug", { w: img.w, h: img.h }, OPTS))._unsafeUnwrap();
  assert.equal(d.instances.length, 3);
  assert.ok(d.instances[0]!.score > d.instances[1]!.score);
  assert.deepEqual(recorded(d), RECORDED.keyframe);
});

test("detect on a region crop (offset) = the recorded search pipeline; same code path as find", async () => {
  const r = rig({ models });
  const img = noise(7, 50, 40);
  const f = (await r.p.encode(img))._unsafeUnwrap();
  const d = (await r.p.detect(f, "jar", { w: 50, h: 40, offset: { x: 30, y: 12 } }, OPTS))._unsafeUnwrap();
  assert.deepEqual(recorded(d), RECORDED.region);
  assert.ok(d.instances.every((i) => i.box[0] >= 30 && i.box[1] >= 12));
});

test("text features are computed once per prompt; models load once", async () => {
  const r = rig({ models });
  const f = (await r.p.features(fno(0)))._unsafeUnwrap();
  for (const prompt of ["a", "b", "a"]) (await r.p.detect(f, prompt, { w: 64, h: 48 }, OPTS))._unsafeUnwrap();
  assert.equal(r.rt.calls[MODEL_FILES.text], 2);
  assert.equal(r.rt.calls[MODEL_FILES.detector.fp32], 3);
  assert.equal(r.rt.loads.filter((x) => x === MODEL_FILES.text).length, 1);
  assert.ok(r.logger.lines.some((l) => /^loaded text_fp16\.onnx in \d+\.\ds$/.test(l)));
});

test("detector precision picks the file; no heatmap when the export has none", async () => {
  const r = rig({ detector: "fp16", models: { detector: () => ({ ...SCRIPT, semantic: null }) } });
  const f = (await r.p.features(fno(0)))._unsafeUnwrap();
  const d = (await r.p.detect(f, "x", { w: 64, h: 48 }, OPTS))._unsafeUnwrap();
  assert.equal(d.heatmap, null);
  assert.equal(r.rt.calls[MODEL_FILES.detector.fp16], 1);
});

test("embed = the recorded appearance vectors (dilated-mask crops through the DINOv2 model); [] loads nothing", async () => {
  const r = rig();
  const img = r.frames.img(1);
  const regions = [
    { box: [3, 4, 30, 20] as const, mask: new Uint8Array(27 * 16).fill(1) },
    { box: [20, 10, 60, 45] as const, mask: Uint8Array.from({ length: 40 * 35 }, (_, k) => (k % 7 < 3 ? 1 : 0)) },
  ];
  assert.deepEqual((await r.p.embed(img, []))._unsafeUnwrap(), []);
  assert.equal(r.rt.loads.length, 0);
  const got = (await r.p.embed(img, regions))._unsafeUnwrap();
  assert.deepEqual(
    got.map((v) => sha256(v)),
    RECORDED.embed,
  );
  const one = (await r.p.embedCrop(img))._unsafeUnwrap();
  assert.equal(sha256(one), RECORDED.embedCrop);
});

test("embed batches by 32", async () => {
  const r = rig({ models: { appearance: colorSignature } });
  const img = r.frames.img(0);
  const regions = Array.from({ length: 33 }, () => ({ box: [0, 0, 4, 4] as const, mask: new Uint8Array(16).fill(1) }));
  assert.equal((await r.p.embed(img, regions))._unsafeUnwrap().length, 33);
  assert.equal(r.rt.calls[MODEL_FILES.appearance], 2);
});

test("features: encoded once, kept in RAM; persist off writes nothing", async () => {
  const r = rig();
  const a = (await r.p.features(fno(1)))._unsafeUnwrap();
  const b = (await r.p.features(fno(1)))._unsafeUnwrap();
  assert.equal(a, b);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 1);
  assert.equal(r.store.calls.write, 0);
  assert.ok(r.p.encoded(fno(1)));
  assert.deepEqual(r.p.pending(), [0, 2]);
  assert.ok(r.logger.lines.includes("encoded frame 1 in 0.0s"));
});

test("persist on: written to the store; after eviction read back instead of re-encoded", async () => {
  const r = rig({ persistFeatures: true, featureCacheMB: 1 }); // capacity 2 frames
  for (const i of [0, 1, 2]) (await r.p.features(fno(i)))._unsafeUnwrap();
  assert.equal(r.store.calls.write, 3);
  assert.equal(r.store.files.get("0a1b2c3d4e01/0")?.byteLength, FEATURE_BYTES);
  const f0 = (await r.p.features(fno(0)))._unsafeUnwrap(); // evicted, so read from the store
  assert.equal(r.rt.calls[MODEL_FILES.vision], 3);
  assert.equal(f0.length * 2, FEATURE_BYTES);
});

test("persist off: an evicted frame stays encoded (no background churn) and a query re-encodes it", async () => {
  const r = rig({ featureCacheMB: 1 });
  for (const i of [0, 1, 2]) (await r.p.features(fno(i)))._unsafeUnwrap();
  assert.deepEqual(r.p.pending(), []);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), false); // RAM is full, so no warming
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.equal(r.rt.calls[MODEL_FILES.vision], 4);
});

test("setPersist switches at runtime", async () => {
  const r = rig();
  assert.equal((await r.p.stats())._unsafeUnwrap().persist, false);
  r.p.setPersist(true);
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.ok(r.store.hasFrame(0));
  assert.equal((await r.p.stats())._unsafeUnwrap().persist, true);
});

async function storedFeatures(): Promise<Uint8Array> {
  const r = rig();
  const f: Features = (await r.p.features(fno(0)))._unsafeUnwrap();
  return new Uint8Array(f.buffer.slice(0));
}

test("scanStore: trusted stored files count as encoded and are read, not encoded", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  store.put(0, bytes);
  store.put(2, bytes);
  const r = rig({ store, persistFeatures: true });
  assert.deepEqual(r.p.pending(), [0, 1, 2]);
  assert.equal((await r.p.scanStore())._unsafeUnwrap(), 2);
  assert.equal(store.calls.read, 0);
  assert.deepEqual(r.p.pending(), [1]);
  const f = (await r.p.features(fno(2)))._unsafeUnwrap();
  assert.deepEqual(new Uint8Array(f.buffer), bytes);
  assert.equal(r.rt.calls[MODEL_FILES.vision] ?? 0, 0);
});

test("scanStore untrusted: stored files ignored, then overwritten as frames are encoded", async () => {
  const store = new MemFeatureStore();
  store.put(0, new Uint8Array(FEATURE_BYTES));
  const r = rig({ store, persistFeatures: true, storedFeatureFormat: null });
  assert.equal((await r.p.scanStore())._unsafeUnwrap(), 0);
  assert.deepEqual(r.p.pending(), [0, 1, 2]);
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.equal(r.rt.calls[MODEL_FILES.vision], 1);
  assert.equal(store.calls.write, 1);
});

const bytesOf = (f: Features): Uint8Array => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
/** Byte equality without assert's diff, which formats every element of a feature-sized array. */
const sameBytes = (f: Features, b: Uint8Array): boolean => Buffer.compare(bytesOf(f), b) === 0;

test("persist off, store untrusted: an evicted frame is re-encoded, never read from the old-format file", async () => {
  const store = new MemFeatureStore();
  const stale = new Uint8Array(FEATURE_BYTES).fill(0xab); // an old-format file of the right size
  for (const i of [0, 1, 2]) store.put(i, stale);
  const r = rig({ store, featureCacheMB: 1, persistFeatures: false, storedFeatureFormat: null });
  const fresh = new Uint8Array((await r.p.features(fno(0)))._unsafeUnwrap().buffer.slice(0));
  (await r.p.features(fno(1)))._unsafeUnwrap();
  (await r.p.features(fno(2)))._unsafeUnwrap(); // capacity 2, so frame 0 is evicted
  const again = (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.ok(sameBytes(again, fresh), `served other bytes (first byte ${bytesOf(again)[0]?.toString(16)})`);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 4);
  assert.equal(store.calls.read, 0);
  // warming skips frame 1 (encoded, evicted, no current file) even though it is the only live frame and RAM has room
  r.p.forget([fno(0), fno(2)]);
  r.frames.live = [1];
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), false);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 4);
  assert.equal(store.calls.read, 0);
});

test("persist on: a file this instance wrote is read back after eviction even when the store was untrusted", async () => {
  const store = new MemFeatureStore();
  for (const i of [0, 1, 2]) store.put(i, new Uint8Array(FEATURE_BYTES).fill(0xab));
  const r = rig({ store, featureCacheMB: 1, persistFeatures: true, storedFeatureFormat: null });
  const fresh = new Uint8Array((await r.p.features(fno(0)))._unsafeUnwrap().buffer.slice(0));
  for (const i of [1, 2]) (await r.p.features(fno(i)))._unsafeUnwrap();
  const again = (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.ok(sameBytes(again, fresh), `served other bytes (first byte ${bytesOf(again)[0]?.toString(16)})`);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 3);
  assert.equal(store.calls.read, 1);
});

test("a stored file of the wrong size is ignored and the frame re-encoded", async () => {
  const store = new MemFeatureStore();
  store.put(1, new Uint8Array(10));
  const r = rig({ store, persistFeatures: true });
  (await r.p.scanStore())._unsafeUnwrap();
  assert.ok(r.p.encoded(fno(1)));
  (await r.p.features(fno(1)))._unsafeUnwrap();
  assert.equal(r.rt.calls[MODEL_FILES.vision], 1);
  assert.equal(store.files.get("0a1b2c3d4e01/1")?.byteLength, FEATURE_BYTES);
});

test("encodeNext: pending frames in order, then warming from the store while RAM has room, then idle", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  store.put(1, bytes);
  const r = rig({ store, persistFeatures: true });
  (await r.p.scanStore())._unsafeUnwrap();
  assert.deepEqual(r.p.pending(), [0, 2]);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), true);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), true);
  assert.deepEqual(r.p.pending(), []);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 2);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), true); // warms frame 1 from the store
  assert.equal(store.calls.read, 1);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), false);
  assert.equal((await r.p.stats())._unsafeUnwrap().inMemory, 3);
});

test("missing frame: encodeNext returns its error once, then moves on; pending empties", async () => {
  const r = rig();
  r.frames.missing.add(0);
  const first = await r.p.encodeNext();
  assert.deepEqual(first._unsafeUnwrapErr(), { kind: "missing-frame-file", frame: 0 });
  assert.deepEqual(r.p.pending(), [1, 2]);
  assert.ok(!r.p.encoded(fno(0)));
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), true);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), true);
  assert.equal((await r.p.encodeNext())._unsafeUnwrap(), false); // warming skips the failed frame too
  assert.deepEqual(r.p.pending(), []);
  assert.equal(r.frames.reads.filter((i) => i === 0).length, 1, "frame 0 was tried once");
  // once the file is back, a query encodes it and clears the mark
  r.frames.missing.delete(0);
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.ok(r.p.encoded(fno(0)));
});

test("forget clears the failed mark (a removed clip revived at the same indices)", async () => {
  const r = rig();
  r.frames.missing.add(2);
  (await r.p.features(fno(2))).match(
    () => assert.fail("expected an error"),
    (e) => assert.equal(e.kind, "missing-frame-file"),
  );
  assert.deepEqual(r.p.pending(), [0, 1]);
  r.frames.missing.delete(2);
  r.p.forget([fno(2)]);
  assert.deepEqual(r.p.pending(), [0, 1, 2]);
});

test("a host failure reading a frame is transient: nothing marked, the frame stays pending", async () => {
  const r = rig();
  r.frames.hostFailing.add(0);
  assert.equal((await r.p.encodeNext())._unsafeUnwrapErr().kind, "host");
  assert.deepEqual(r.p.pending(), [0, 1, 2]);
});

test("forget drops RAM and encoded state", async () => {
  const r = rig();
  (await r.p.features(fno(0)))._unsafeUnwrap();
  r.p.forget([fno(0)]);
  assert.ok(!r.p.encoded(fno(0)));
  assert.equal((await r.p.stats())._unsafeUnwrap().inMemory, 0);
});

test("clearStored deletes live frames' files; frames still in RAM stay encoded; stats count the store", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  store.put(0, bytes);
  store.put(1, bytes);
  store.put(7, bytes); // not a live frame, so untouched
  const r = rig({ store, persistFeatures: true });
  (await r.p.scanStore())._unsafeUnwrap();
  (await r.p.features(fno(0)))._unsafeUnwrap(); // in RAM
  assert.deepEqual((await r.p.stats())._unsafeUnwrap(), {
    persist: true,
    stored: 2,
    keyframes: 3,
    inMemory: 1,
    bytesPerFrame: FEATURE_BYTES,
    storedBytes: 3 * bytes.byteLength, // the stray file of frame 7 counts too
    diskMB: null,
  });
  assert.equal((await r.p.clearStored())._unsafeUnwrap(), 2);
  assert.ok(r.logger.lines.includes("cleared 2 stored feature files"));
  assert.ok(r.p.encoded(fno(0)));
  assert.ok(!r.p.encoded(fno(1)));
  assert.ok(store.hasFrame(7));
  assert.equal((await r.p.stats())._unsafeUnwrap().stored, 0);
});

test("clearStored(frames): only those frames' files go (one clip's), the rest stay stored", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  for (const i of [0, 1, 2]) store.put(i, bytes);
  const r = rig({ store, persistFeatures: true });
  (await r.p.scanStore())._unsafeUnwrap();
  assert.equal((await r.p.clearStored([fno(1), fno(2)]))._unsafeUnwrap(), 2);
  assert.ok(store.hasFrame(0));
  assert.ok(!store.hasFrame(1) && !store.hasFrame(2));
  assert.deepEqual(r.p.pending(), [1, 2], "not in RAM: encoded again when needed");
  assert.equal((await r.p.stats())._unsafeUnwrap().stored, 1);
});

test("store failures are host errors", async () => {
  const store = new MemFeatureStore();
  store.fail = true;
  const r = rig({ store });
  assert.equal((await r.p.stats())._unsafeUnwrapErr().kind, "host");
});

/** A budget with room for exactly `n` feature files. */
const filesMB = (n: number): number => Math.ceil((n * FEATURE_BYTES) / 2 ** 20);

test("disk budget: the least recently used file goes first (a served frame counts as used)", async () => {
  const r = rig({ frames: 4, persistFeatures: true, featureCacheMB: 1, featureDiskMB: filesMB(2) });
  for (const i of [0, 1]) (await r.p.features(fno(i)))._unsafeUnwrap();
  (await r.p.features(fno(0)))._unsafeUnwrap(); // the RAM hit makes frame 0 more recent than 1
  (await r.p.features(fno(2)))._unsafeUnwrap();
  assert.deepEqual(r.store.frames(), [0, 2], "frame 1 was the least recently used");
  assert.ok(r.logger.lines.includes(`evicted 1 stored feature files (disk budget ${filesMB(2)} MB)`));
  (await r.p.features(fno(3)))._unsafeUnwrap();
  assert.deepEqual(r.store.frames(), [2, 3]);
});

test("disk budget: respected after many writes; stats report usage against it", async () => {
  const r = rig({ frames: 8, persistFeatures: true, featureCacheMB: 1, featureDiskMB: filesMB(3) });
  for (let round = 0; round < 3; round++)
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
      (await r.p.features(fno(i)))._unsafeUnwrap();
      assert.ok(r.store.files.size <= 3, `${r.store.files.size} files after frame ${i}`);
    }
  const s = (await r.p.stats())._unsafeUnwrap();
  assert.deepEqual([s.stored, s.storedBytes, s.diskMB], [3, 3 * FEATURE_BYTES, filesMB(3)]);
  assert.ok(s.storedBytes <= filesMB(3) * 2 ** 20);
});

test("disk budget: an evicted frame stays encoded (background leaves it); a query re-encodes and rewrites it", async () => {
  const r = rig({ frames: 3, persistFeatures: true, featureCacheMB: 1, featureDiskMB: filesMB(2) });
  for (let k = 0; k < 6; k++) (await r.p.encodeNext())._unsafeUnwrap();
  assert.deepEqual(r.p.pending(), []);
  assert.deepEqual(r.store.frames(), [1, 2], "frame 0, the oldest, was evicted");
  assert.equal(r.rt.calls[MODEL_FILES.vision], 3, "no churn: warming does not re-encode the evicted frame");
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.equal(r.rt.calls[MODEL_FILES.vision], 4);
  assert.deepEqual(r.store.frames(), [0, 2]);
});

test("disk budget: held frames are never evicted; with no room the encode stays in RAM only", async () => {
  const r = rig({ frames: 4, persistFeatures: true, featureCacheMB: 1, featureDiskMB: filesMB(2) });
  for (const i of [0, 1]) (await r.p.features(fno(i)))._unsafeUnwrap();
  const release = r.p.hold([fno(0), fno(1)]);
  (await r.p.features(fno(2)))._unsafeUnwrap();
  assert.deepEqual(r.store.frames(), [0, 1], "nothing evicted while held");
  assert.ok(r.logger.lines.some((l) => l.startsWith("frame 2 kept in memory only")));
  assert.ok(r.p.encoded(fno(2)));
  release();
  release(); // idempotent, so a second call does not release someone else's hold
  const again = r.p.hold([fno(1)]);
  (await r.p.features(fno(3)))._unsafeUnwrap();
  assert.deepEqual(r.store.frames(), [1, 3], "frame 0 (unheld, oldest) went; frame 1 still held");
  again();
});

test("disk budget: the frame a features call is reading is held against a concurrent budget change", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  for (const i of [0, 1, 2]) store.put(i, bytes);
  const r = rig({ store, persistFeatures: true });
  (await r.p.scanStore())._unsafeUnwrap();
  const read = store.read.bind(store);
  const evicting: ReturnType<typeof r.p.setDiskBudget>[] = [];
  store.read = (ref) => {
    evicting.push(r.p.setDiskBudget(0)); // while frame 1 is being read
    return read(ref);
  };
  (await r.p.features(fno(1)))._unsafeUnwrap();
  await Promise.all(evicting);
  assert.deepEqual(store.frames(), [1], "everything but the frame in flight went");
});

test("disk budget: reopening seeds recency from the files' mtimes and evicts down to the budget", async () => {
  const bytes = await storedFeatures();
  const store = new MemFeatureStore();
  for (const i of [0, 1, 2]) store.put(i, bytes);
  store.mtimes.set("0a1b2c3d4e01/0", 30);
  store.mtimes.set("0a1b2c3d4e01/1", 10);
  store.mtimes.set("0a1b2c3d4e01/2", 20);
  const r = rig({ frames: 4, store, persistFeatures: true, featureCacheMB: 1, featureDiskMB: filesMB(2) });
  assert.equal((await r.p.scanStore())._unsafeUnwrap(), 3);
  assert.deepEqual(store.frames(), [0, 2], "frame 1, the oldest, went at open");
  assert.deepEqual(r.p.pending(), [3], "the evicted frame stays encoded");
  (await r.p.features(fno(3)))._unsafeUnwrap();
  assert.deepEqual(store.frames(), [0, 3], "then frame 2 (older than 0)");
});

test("disk budget: setDiskBudget applies at once, null lifts it", async () => {
  const r = rig({ frames: 5, persistFeatures: true, featureCacheMB: 1 });
  for (const i of [0, 1, 2, 3]) (await r.p.features(fno(i)))._unsafeUnwrap();
  assert.equal((await r.p.setDiskBudget(filesMB(2)))._unsafeUnwrap(), 2);
  assert.deepEqual(r.store.frames(), [2, 3]);
  assert.deepEqual(
    [(await r.p.stats())._unsafeUnwrap().storedBytes, (await r.p.stats())._unsafeUnwrap().diskMB],
    [2 * FEATURE_BYTES, filesMB(2)],
  );
  assert.equal((await r.p.setDiskBudget(null))._unsafeUnwrap(), 0);
  (await r.p.features(fno(4)))._unsafeUnwrap();
  (await r.p.features(fno(0)))._unsafeUnwrap();
  assert.deepEqual(r.store.frames(), [0, 2, 3, 4]);
  assert.equal((await r.p.stats())._unsafeUnwrap().diskMB, null);
});

test("disk budget, untrusted store: old-format files count and go first, and are never read", async () => {
  const store = new MemFeatureStore();
  for (const i of [0, 1, 2]) store.put(i, new Uint8Array(FEATURE_BYTES).fill(0xab));
  const r = rig({
    frames: 4,
    store,
    persistFeatures: true,
    featureCacheMB: 1,
    featureDiskMB: filesMB(3),
    storedFeatureFormat: null,
  });
  assert.equal((await r.p.scanStore())._unsafeUnwrap(), 0);
  assert.equal((await r.p.stats())._unsafeUnwrap().storedBytes, 3 * FEATURE_BYTES);
  (await r.p.features(fno(0)))._unsafeUnwrap(); // rewrites its own old file, so no eviction
  assert.deepEqual(store.frames(), [0, 1, 2]);
  (await r.p.features(fno(3)))._unsafeUnwrap(); // evicts the oldest old-format file
  assert.deepEqual(store.frames(), [0, 2, 3]);
  (await r.p.features(fno(2)))._unsafeUnwrap(); // its file is old-format, so it is encoded, not read
  assert.equal(store.calls.read, 0);
  assert.equal(r.rt.calls[MODEL_FILES.vision], 3);
});

test("forget drops a removed clip's files from the books", async () => {
  const r = rig({ frames: 3, persistFeatures: true });
  for (const i of [0, 1, 2]) (await r.p.features(fno(i)))._unsafeUnwrap();
  r.p.forget([fno(1), fno(2)]);
  assert.equal((await r.p.stats())._unsafeUnwrap().storedBytes, FEATURE_BYTES);
});

test("provenance: the manifest models/runtime block (without host info), cached", async () => {
  const r = rig({ detector: "fp16" });
  const p = (await r.p.provenance())._unsafeUnwrap();
  const sha = async (f: string) => ({ file: f, sha256: await r.rt.sha256(f) });
  assert.equal(
    JSON.stringify(p),
    JSON.stringify({
      models: {
        segmentation: {
          name: "SAM 3",
          format: "onnx",
          export:
            "CardAnvilModels/sam3-ONNX (HF transformers Sam3Model split into vision/text/detector; Sign ops patched)",
          source_weights_sha256: "6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a",
          vision: await sha(MODEL_FILES.vision),
          text: await sha(MODEL_FILES.text),
          detector: await sha(MODEL_FILES.detector.fp16),
          feature_cache: "onnx-cardanvil-vision-fp16/f16-concat-v1",
        },
        appearance: {
          name: "facebook/dinov2-small",
          export: "onnx-community/dinov2-small fp32 + CLS gather",
          ...(await sha(MODEL_FILES.appearance)),
          dim: 384,
        },
      },
      runtime: { runtime: "fake", version: "0.0.0", device: "cpu" },
    }),
  );
  assert.equal((await r.p.provenance())._unsafeUnwrap(), p);
  assert.deepEqual(r.p.formats, { features: "onnx-cardanvil-vision-fp16/f16-concat-v1" });
});

test("a detector export without pred_masks is model-output-missing, not a throw", async () => {
  const rt = new FakeModelRuntime(models);
  const load = rt.load.bind(rt);
  rt.load = async (name) => {
    const m = await load(name);
    if (name !== MODEL_FILES.detector.fp32) return m;
    return {
      run: async (feeds) => {
        const { pred_masks: _, ...rest } = await m.run(feeds);
        return rest;
      },
      release: async () => {},
    };
  };
  const r = rig({ rt });
  const f = (await r.p.features(fno(0)))._unsafeUnwrap();
  const e = (await r.p.detect(f, "x", { w: 64, h: 48 }, OPTS))._unsafeUnwrapErr();
  assert.deepEqual(e, { kind: "model-output-missing", model: MODEL_FILES.detector.fp32, output: "pred_masks" });
});

test("a runtime load failure is a host error and is retried on the next call", async () => {
  const rt = new FakeModelRuntime();
  const load = rt.load.bind(rt);
  let fails = 1;
  rt.load = async (name) => {
    if (fails-- > 0) throw new Error("no gpu");
    return load(name);
  };
  const r = rig({ rt });
  assert.deepEqual((await r.p.encode(noise(1, 8, 8)))._unsafeUnwrapErr(), {
    kind: "host",
    port: "runtime",
    op: "load",
    message: "no gpu",
  });
  (await r.p.encode(noise(1, 8, 8)))._unsafeUnwrap();
});

test("profile: detect laps go to the Logger, timed with the Clock", async () => {
  const r = rig({ models, profile: true });
  const f = (await r.p.features(fno(0)))._unsafeUnwrap();
  (await r.p.detect(f, "red mug", { w: 64, h: 48 }, OPTS))._unsafeUnwrap();
  assert.ok(r.logger.lines.includes('detect "red mug" 64x48: sam 0, masks(3) 0 ms'), r.logger.lines.join("\n"));
  const quiet = rig({ models });
  const g = (await quiet.p.features(fno(0)))._unsafeUnwrap();
  (await quiet.p.detect(g, "x", { w: 64, h: 48 }, OPTS))._unsafeUnwrap();
  assert.ok(!quiet.logger.lines.some((l) => l.startsWith("detect ")));
});
