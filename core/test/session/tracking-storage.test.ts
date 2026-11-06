/** Tracking frames, vision parts, stored trunks and saved tracks, and the production path that has none of them. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_FILES, TRUNK_BYTES } from "../../src/perception/pure.ts";
import { MEMORY_LEN, TRACK_FORMAT, type TrackedFrame } from "../../src/tracking/pure.ts";
import { createSessionFolder } from "../../src/storage/index.ts";
import { trackGridTimes } from "../../src/video/pure.ts";
import { newHost, openEngine, type Opened } from "../compose.ts";
import { FakeClock, MemStore, WORLD, fakeContentKey } from "../fakes/index.ts";

const TRACKER = { tracker: { precision: "fp16" as const }, persistFeatures: true };
const video = WORLD.clips[0]?.path ?? "";
const key = fakeContentKey(WORLD.clips[0]?.key ?? "");
const keys = (o: Opened, part: string) => [...o.host.store.files.keys()].filter((k) => k.includes(part)).toSorted();

type SavedClip = { times: number[]; track_times: number[] };
type Saved = { clips: SavedClip[]; trunks?: string; tracks?: string; config: Record<string, number> };
const sessionJson = (o: Opened) => JSON.parse(o.host.store.text("session.json")) as Saved;
const firstClip = (o: Opened): SavedClip => {
  const c = sessionJson(o).clips[0];
  assert.ok(c);
  return c;
};

test("the grid has every keyframe, and a sample a quarter step from one gives way", () => {
  assert.deepEqual(trackGridTimes([], 2, 2), [0, 0.5, 1, 1.5]);
  assert.deepEqual(trackGridTimes([0, 0.6, 1.5], 2, 2), [0, 0.6, 1, 1.5]);
  assert.deepEqual(trackGridTimes([0.1], 1, 2), [0.1, 0.5]);
});

test("the production path: no tracker or part file is asked for, and nothing about tracking lands on disk", async () => {
  const o = await openEngine(newHost(), { persistFeatures: true });
  await o.caller.add({ video });
  await o.settle();
  await o.caller.find({ prompt: "jar", frames: "0" });
  assert.deepEqual(
    new Set(o.host.models.loads),
    new Set(
      [MODEL_FILES.vision, MODEL_FILES.text, MODEL_FILES.detector.fp32, MODEL_FILES.appearance].filter((f) =>
        o.host.models.loads.includes(f),
      ),
    ),
  );
  assert.ok(o.host.models.loads.includes(MODEL_FILES.vision));
  assert.ok(!o.host.models.loads.some((f) => f.startsWith("tracker/") || f.startsWith("vision/")));
  for (const part of ["/trunk/", "/trackframes/", "/tracks/", "tracks.json"]) assert.deepEqual(keys(o, part), [], part);
  const j = sessionJson(o);
  assert.equal(firstClip(o).track_times, undefined);
  assert.equal(j.trunks, undefined);
  assert.equal(j.tracks, undefined);
  assert.equal(j.config.track_fps, undefined);
  o.close();
});

test("tracker mode: tracking frames are stored, and keyframes, the filmstrip and find don't see them", async () => {
  const plain = await openEngine(newHost(), { persistFeatures: true });
  await plain.caller.add({ video });
  await plain.settle();
  const o = await openEngine(newHost(), TRACKER);
  await o.caller.add({ video });
  await o.settle();
  const clip = firstClip(o);
  assert.ok(clip.track_times.length > clip.times.length, "the grid adds frames");
  for (const t of clip.times) assert.ok(clip.track_times.includes(t), `keyframe ${t} is on the grid`);
  assert.equal(keys(o, "/trackframes/").length, clip.track_times.length - clip.times.length);
  // Same keyframes, same frame list.
  assert.deepEqual(firstClip(plain).times, clip.times);
  const frames = await o.caller.data.frames();
  assert.deepEqual(
    frames.frames.map((f) => f.t),
    (await plain.caller.data.frames()).frames.map((f) => f.t),
  );
  assert.equal(keys(o, "/frames/").length, clip.times.length);
  plain.close();
  o.close();
});

test("tracker mode: a keyframe runs every part and the neck, keeps today's features, and stores its trunk", async () => {
  const plain = await openEngine(newHost(), { persistFeatures: true });
  await plain.caller.add({ video });
  await plain.settle();
  const o = await openEngine(newHost(), TRACKER);
  await o.caller.add({ video });
  await o.settle();
  const n = firstClip(o).times.length;
  const { calls, loads } = o.host.models;
  for (const f of MODEL_FILES.visionParts.parts) assert.equal(calls[f], n, f);
  assert.equal(calls[MODEL_FILES.visionParts.neck], n);
  assert.ok(!loads.includes(MODEL_FILES.vision), "the whole graph stays unloaded");
  // The feature files are byte for byte those of the whole graph.
  const feats = (s: Opened) => keys(s, "/feat/").map((k) => s.host.store.files.get(k));
  assert.equal(feats(o).length, n);
  assert.deepEqual(feats(o), feats(plain));
  assert.deepEqual(new Set(keys(o, "/feat/").map((k) => k.split("/").at(1))).size, 1);
  // Trunks sit beside features, on the grid.
  const grid: number[] = firstClip(o).track_times;
  const times: number[] = firstClip(o).times;
  assert.deepEqual(
    keys(o, "/trunk/").map((k) => Number(/(\d+)\.f16$/.exec(k)?.[1])),
    times.map((t) => grid.indexOf(t)),
  );
  assert.equal(o.host.store.files.get(keys(o, "/trunk/")[0] ?? "")?.byteLength, TRUNK_BYTES);
  assert.ok(sessionJson(o).trunks);
  // Clearing features leaves trunks alone.
  await o.caller.features({ clear: true });
  assert.deepEqual(keys(o, "/feat/"), []);
  assert.equal(keys(o, "/trunk/").length, n);
  // A find runs on them.
  await o.caller.find({ prompt: "jar", frames: "0" });
  plain.close();
  o.close();
});

test("reopening: a clip keeps its grid whatever the rate is now, and a trusted trunk is on the books", async () => {
  const host = newHost();
  const o = await openEngine(host, TRACKER);
  await o.caller.config({ key: "track_fps", value: 2 });
  await o.caller.add({ video });
  await o.settle();
  const grid = firstClip(o).track_times;
  await o.caller.config({ key: "track_fps", value: 5 });
  o.close();
  const again = await openEngine(host, TRACKER);
  assert.deepEqual(firstClip(again).track_times, grid);
  again.close();
});

test("removal takes frames, trunks and tracks along; revival brings the same grid back with no tracks", async () => {
  const host = newHost();
  const o = await openEngine(host, TRACKER);
  await o.caller.add({ video });
  await o.settle();
  const grid = firstClip(o).track_times;
  await o.caller.clips.remove({ clip: video });
  for (const part of ["/trunk/", "/trackframes/", "/feat/", "/frames/"]) assert.deepEqual(keys(o, part), [], part);
  const back = await o.caller.add({ video });
  assert.equal(back.revived, true);
  await o.settle();
  assert.deepEqual(firstClip(o).track_times, grid);
  assert.equal(keys(o, "/trackframes/").length, grid.length - firstClip(o).times.length);
  assert.equal(keys(o, `clips/${key}/tracks`).length, 0);
  o.close();
});

test("a crash during removal: reopening finishes it, and the tracks of the clip go too", async () => {
  const host = newHost();
  const o = await openEngine(host, TRACKER);
  await o.caller.add({ video });
  await o.settle();
  await o.caller.clips.remove({ clip: video });
  o.close();
  // As after a crash that left the index behind: tombstone written, tracks.json still naming the clip.
  host.store.files.set(
    "tracks.json",
    new TextEncoder().encode(
      JSON.stringify({
        paused: false,
        next: 2,
        pending: [],
        pairs: [],
        tracks: [
          {
            id: "t1",
            det: "0.1",
            clip: key,
            seedAt: 0,
            clipFrames: 4,
            first: 0,
            last: 3,
            priority: 0,
            state: "active",
            failure: null,
            seeded: true,
            forward: 1,
            reverse: 0,
            parkAfter: 1,
            recheck: 3,
            forwardMisses: 0,
            reverseMisses: 0,
            skipped: 0,
            seenFirst: 0,
            seenLast: 1,
            seenCount: 2,
            auto: false,
          },
        ],
      }),
    ),
  );
  const again = await openEngine(host, TRACKER);
  assert.deepEqual((JSON.parse(host.store.text("tracks.json")) as { tracks: unknown[] }).tracks, []);
  again.close();
});

test("the track store: tokens come back bit for bit, an unwritten frame reads as null, and the index parses", async () => {
  const store = new MemStore();
  const folder = createSessionFolder({ store, clock: new FakeClock() });
  const at = { clip: "0a1b2c3d4e5f" as never, track: "t1" };
  const tokens = new Float32Array(MEMORY_LEN).map((_, i) => ((i % 251) - 125) * 2 ** -7);
  const f = (a: number, withTokens: boolean): TrackedFrame => ({
    at: a,
    tokens: withTokens ? tokens : null,
    pointer: new Float32Array(256).fill(a + 0.123),
  });
  const recent = [f(3, false), f(4, true), f(5, true)];
  (await folder.tracks.writeMemory(at, "forward", 5, recent))._unsafeUnwrap();
  assert.deepEqual((await folder.tracks.readMemory(at, "forward", 5))._unsafeUnwrap(), recent);
  assert.equal((await folder.tracks.readMemory(at, "reverse", 5))._unsafeUnwrap(), null);
  (await folder.tracks.removeMemory(at, "forward", 5))._unsafeUnwrap();
  assert.equal((await folder.tracks.readMemory(at, "forward", 5))._unsafeUnwrap(), null);

  const seed = { tokens, pointer: new Float32Array(256).fill(1.5) };
  (await folder.tracks.writeSeed(at, seed))._unsafeUnwrap();
  assert.deepEqual((await folder.tracks.readSeed(at))._unsafeUnwrap(), seed);

  const mask = { mask: new Uint8Array(288 * 288).map((_, i) => (i % 7 === 0 ? 1 : 0)), score: 2.5, iou: 0.5 };
  (await folder.tracks.writeMask(at, 3, mask))._unsafeUnwrap();
  assert.deepEqual((await folder.tracks.readMask(at, 3))._unsafeUnwrap(), mask);
  assert.equal((await folder.tracks.readMask(at, 4))._unsafeUnwrap(), null);
  assert.ok([...store.files.keys()].every((k) => k.startsWith("clips/0a1b2c3d4e5f/tracks/t1/")));

  assert.deepEqual((await folder.tracks.readIndex())._unsafeUnwrap(), {
    paused: false,
    next: 1,
    tracks: [],
    pending: [],
    pairs: [],
  });
  store.files.set("tracks.json", new TextEncoder().encode("{broken"));
  assert.equal((await folder.tracks.readIndex())._unsafeUnwrap(), null);
  assert.ok(TRACK_FORMAT);
});

test("preparing: a clip added without tracking gets a grid from its video, with keyframes and numbers unchanged", async () => {
  const host = newHost();
  const plain = await openEngine(host, { persistFeatures: true });
  await plain.caller.add({ video });
  await plain.settle();
  const before = firstClip(plain).times;
  const o = await openEngine(host, TRACKER);
  const listed = (await o.caller.clips.list({})).clips[0];
  assert.equal(listed?.tracking?.keyframes_only, true);
  assert.equal(listed?.tracking?.can_prepare, true);
  const done = await o.caller.track.prepare({ video, clip: key });
  assert.ok(done.frames > before.length);
  assert.deepEqual(firstClip(o).times, before);
  assert.equal(firstClip(o).track_times.length, done.frames);
  const after = (await o.caller.clips.list({})).clips[0];
  assert.equal(after?.tracking?.keyframes_only, false);
  assert.ok((after?.tracking?.frame_bytes ?? 0) > 0);
  const grid = await o.caller.track.frames({ clip: key });
  assert.ok(grid.frames.some((f) => f.keyframe === null && f.image.includes("/trackframes/")));
  assert.ok(grid.frames.some((f) => f.keyframe !== null && f.image.includes("/frames/")));
});

test("preparing: another file is refused, and so is a clip that has tracks on its keyframes", async () => {
  const host = newHost();
  const plain = await openEngine(host, { persistFeatures: true });
  await plain.caller.add({ video });
  await plain.settle();
  const found = await plain.caller.find({ prompt: "jar", frames: "0" });
  const o = await openEngine(host, TRACKER);
  const other = WORLD.clips[1]?.path;
  assert.ok(other);
  await assert.rejects(o.caller.track.prepare({ video: other, clip: key }), /is not this clip's video/);
  await o.caller.track.pause({});
  await o.caller.track.start({ ids: [found.hits[0]?.id ?? ""] });
  await assert.rejects(o.caller.track.prepare({ video, clip: key }), /already has tracks/);
});
