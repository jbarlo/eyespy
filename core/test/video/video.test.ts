/** Expectations match the session.ops snapshot. Kitchen has 3 keyframes from #0, pantry from #3, extra from #6. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/session/pure.ts";
import type { Clip, FrameNo, VideoError } from "../../src/video/index.ts";
import { isFrameNo } from "../../src/video/pure.ts";
import { EXTRA, fakeContentKey, KITCHEN, OTHER_KITCHEN, PANTRY, WORLD } from "../fakes/index.ts";
import type { Scene } from "../fakes/scene.ts";
import { MemFrames, wire } from "./fakes.ts";

const THRESH = { keyframeThresh: DEFAULT_CONFIG.keyframe_thresh };
const fno = (n: number): FrameNo => {
  assert.ok(isFrameNo(n));
  return n;
};
const sceneKey = (path: string) => WORLD.clips.find((c) => c.path === path)!.key;

async function twoClips() {
  const w = wire();
  const k = (await w.video.addClip("kitchen.mp4", THRESH))._unsafeUnwrap();
  const p = (await w.video.addClip(PANTRY, THRESH))._unsafeUnwrap();
  return { ...w, k, p };
}

test("addClip: keyframes picked, extracted, appended at the end of the numbering", async () => {
  const { video, source, frames, logger, k, p } = await twoClips();
  const pickedTimes = [0, 0.2, 1]; // the picker on the fake kitchen clip at 0.4
  assert.deepEqual(k.clip.times, pickedTimes);
  assert.deepEqual(
    [k.first, k.revived, k.clip.path, k.clip.key, k.clip.shape, k.clip.captured, k.clip.keyframeThresh],
    [0, false, KITCHEN, fakeContentKey(sceneKey(KITCHEN)), [120, 160], "2026-01-01T10:00:00.000000Z", 0.4],
  );
  assert.equal(k.clip.times.length, 3);
  assert.deepEqual([p.first, p.clip.times.length, p.clip.captured], [3, 3, null]);
  assert.deepEqual(source.extracted, [
    ...k.clip.times.map((t) => [KITCHEN, t]),
    ...p.clip.times.map((t) => [PANTRY, t]),
  ]);
  assert.equal(frames.files.size, 6);
  assert.deepEqual(logger.lines, [`added ${KITCHEN}: 3 keyframes from #0`, `added ${PANTRY}: 3 keyframes from #3`]);
  assert.deepEqual(video.liveFrames(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(video.clipFrames(p.clip.key), [3, 4, 5]);
  assert.deepEqual(video.ref(fno(4))._unsafeUnwrap(), { clipKey: p.clip.key, index: 1 });
  assert.equal(video.t(fno(4))._unsafeUnwrap(), p.clip.times[1]);
  assert.deepEqual(video.shape(fno(4))._unsafeUnwrap(), [120, 160]);
  assert.deepEqual(video.slot(fno(6))._unsafeUnwrapErr(), { kind: "no-keyframe", frame: 6 });
});

test("addClip: errors (already present, no such file); nothing changes", async () => {
  const { video } = await twoClips();
  const again = await video.addClip(KITCHEN, THRESH);
  assert.deepEqual(again._unsafeUnwrapErr(), { kind: "clip-already-present", path: KITCHEN });
  const missing = await video.addClip("nope.mp4", THRESH);
  assert.deepEqual(missing._unsafeUnwrapErr(), { kind: "no-such-file", path: "/videos/nope.mp4" });
  assert.equal(video.clips().length, 2);
});

test("addClip: a store failure is a HostFailure and leaves the timeline alone", async () => {
  const w = wire();
  w.frames.failing.add("write");
  const r = await w.video.addClip(KITCHEN, THRESH);
  assert.deepEqual(r._unsafeUnwrapErr(), { kind: "host", port: "store", op: "write", message: "write failed" });
  assert.deepEqual(w.video.clips(), []);
});

test("tags: the clip stem only when several clips are live", async () => {
  const { video, p } = await twoClips();
  assert.equal(video.tag(fno(0))._unsafeUnwrap(), "#0 kitchen 0.0s");
  assert.equal(video.tag(fno(4))._unsafeUnwrap(), `#4 pantry ${p.clip.times[1]!.toFixed(1)}s`);
  video.removeClip(p.clip.key, new Map())._unsafeUnwrap();
  assert.equal(video.tag(fno(0))._unsafeUnwrap(), "#0 0.0s");
});

test("findClip: key, path, file name; live first; ambiguous and missing", async () => {
  const { video, k, p } = await twoClips();
  const key = (r: string) => video.findClip(r).map((c) => c.key);
  assert.equal(key(k.clip.key)._unsafeUnwrap(), k.clip.key);
  assert.equal(key(PANTRY)._unsafeUnwrap(), p.clip.key);
  assert.equal(key("pantry.mov")._unsafeUnwrap(), p.clip.key);
  assert.equal(key("kitchen.mp4")._unsafeUnwrap(), k.clip.key, "relative ref resolves to the path");
  const o = (await video.addClip(OTHER_KITCHEN, THRESH))._unsafeUnwrap();
  assert.deepEqual(key("x/kitchen.mp4")._unsafeUnwrapErr(), {
    kind: "ambiguous-clip",
    ref: "x/kitchen.mp4",
    keys: [k.clip.key, o.clip.key],
  });
  // a removed clip is found when no live one matches; live ones win otherwise
  video.removeClip(o.clip.key, new Map())._unsafeUnwrap();
  assert.equal(key("x/kitchen.mp4")._unsafeUnwrap(), k.clip.key);
  video.removeClip(p.clip.key, new Map())._unsafeUnwrap();
  assert.equal(key("pantry.mov")._unsafeUnwrap(), p.clip.key);
  assert.deepEqual(key("nope.mp4")._unsafeUnwrapErr(), { kind: "no-clip", ref: "nope.mp4" });
});

test("removeClip: tombstone; indices reserved; counters kept for the clip's frames only", async () => {
  const { video, clock, p } = await twoClips();
  await video.image(fno(3));
  const r = video
    .removeClip(
      p.clip.key,
      new Map([
        [fno(3), 2],
        [fno(0), 9],
        [fno(5), 1],
      ]),
    )
    ._unsafeUnwrap();
  assert.deepEqual(r.frames, [3, 5]);
  assert.deepEqual(r.clip.removed, { at: Math.round(clock.now()) / 1000 });
  assert.deepEqual(
    [...r.clip.reserved],
    [
      [3, 2],
      [5, 1],
    ],
  );
  assert.deepEqual(video.liveFrames(), [0, 1, 2]);
  assert.deepEqual(video.frames("0-5")._unsafeUnwrap(), [0, 1, 2]);
  assert.equal(video.live(3), false);
  assert.equal(video.slot(fno(3)).isOk(), true, "a removed clip's keyframe still has a slot");
  assert.deepEqual(
    [...video.reserved()].toSorted(([a], [b]) => a - b),
    [
      [3, 2],
      [5, 1],
    ],
  );
  assert.deepEqual(
    video.liveClips().map((c) => c.path),
    [KITCHEN],
  );
  const again = video.removeClip(p.clip.key, new Map());
  assert.deepEqual(again._unsafeUnwrapErr(), { kind: "clip-already-removed", path: PANTRY });
  const nope = video.removeClip(fakeContentKey("nope") as Clip["key"], new Map());
  assert.equal(nope._unsafeUnwrapErr().kind, "no-clip");
});

test("revive: same indices and times, frames re-extracted where missing, counters kept; new clips go after", async () => {
  const { video, source, frames, logger, p } = await twoClips();
  video.removeClip(p.clip.key, new Map([[fno(4), 3]]))._unsafeUnwrap();
  const e = (await video.addClip(EXTRA, THRESH))._unsafeUnwrap();
  assert.equal(e.first, 6, "a new clip goes after the removed one's reserved indices");
  assert.equal(e.clip.times.length, 2);
  frames.files.delete(MemFrames.key({ clipKey: p.clip.key, index: 1 })); // the session deleted the clip's files
  frames.files.delete(MemFrames.key({ clipKey: p.clip.key, index: 2 }));
  source.extracted.length = 0;
  const b = (await video.addClip("pantry.mov", THRESH))._unsafeUnwrap();
  assert.deepEqual([b.first, b.revived, b.clip.times, b.clip.removed], [3, true, p.clip.times, null]);
  assert.deepEqual([...b.clip.reserved], [[4, 3]]);
  assert.deepEqual(
    source.extracted,
    p.clip.times.slice(1).map((t) => [PANTRY, t]),
  );
  assert.equal(source.streamed.filter((s) => s === PANTRY).length, 1, "no keyframe picking on revival");
  assert.equal(logger.lines.at(-1), `re-added ${PANTRY}: 3 keyframes at #3 (removed earlier)`);
  assert.deepEqual(video.liveFrames(), [0, 1, 2, 3, 4, 5, 6, 7]);
  // removing again merges the kept counters with the new ones
  const r = video.removeClip(p.clip.key, new Map([[fno(3), 1]]))._unsafeUnwrap();
  assert.deepEqual(
    [...r.clip.reserved].sort(([a], [b]) => a - b),
    [
      [3, 1],
      [4, 3],
    ],
  );
});

test("clips() round-trips: a new instance over them answers the same", async () => {
  const { video, p } = await twoClips();
  video.removeClip(p.clip.key, new Map([[fno(4), 3]]))._unsafeUnwrap();
  const again = wire(video.clips()).video;
  assert.deepEqual(again.clips(), video.clips());
  assert.deepEqual(again.liveFrames(), [0, 1, 2]);
  assert.deepEqual(again.clipFrames(p.clip.key), [3, 4, 5]);
  assert.deepEqual(again.frames("2-4")._unsafeUnwrap(), [2]);
});

test("frames(spec): live frames of a spec; errors are values", async () => {
  const { video } = await twoClips();
  assert.deepEqual(video.frames()._unsafeUnwrap(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(video.frames(4)._unsafeUnwrap(), [4]);
  assert.deepEqual(video.frames("1-3,3")._unsafeUnwrap(), [1, 2, 3, 3]);
  const bad: VideoError = video.frames("x")._unsafeUnwrapErr();
  assert.deepEqual(bad, { kind: "bad-frame-spec", part: "x" });
});

test("image: decoded once into a small LRU; forget drops; failures are values", async () => {
  const w = wire([], new MemFrames(), 2);
  (await w.video.addClip(KITCHEN, THRESH))._unsafeUnwrap();
  const img = (await w.video.image(fno(1)))._unsafeUnwrap();
  assert.deepEqual([img.w, img.h], [160, 120]);
  await w.video.image(fno(1));
  assert.equal(w.frames.reads, 1);
  await w.video.image(fno(0));
  await w.video.image(fno(2)); // evicts 1
  await w.video.image(fno(1));
  assert.equal(w.frames.reads, 4);
  w.video.forget([fno(1)]);
  await w.video.image(fno(1));
  assert.equal(w.frames.reads, 5);
  assert.deepEqual((await w.video.image(fno(9)))._unsafeUnwrapErr(), { kind: "no-keyframe", frame: 9 });
  w.frames.files.clear();
  w.video.forget([fno(0)]);
  assert.deepEqual((await w.video.image(fno(0)))._unsafeUnwrapErr(), { kind: "missing-frame-file", frame: 0 });
  w.frames.files.set(MemFrames.key({ clipKey: w.video.clips()[0]!.key, index: 0 }), new Uint8Array([1, 2]));
  const bad = (await w.video.image(fno(0)))._unsafeUnwrapErr();
  assert.equal(bad.kind === "host" && bad.port, "codec");
});

test("reserved: every clip's counters, the highest per frame", async () => {
  const { k, p } = await twoClips();
  const { video } = wire([
    {
      ...k.clip,
      reserved: new Map([
        [fno(0), 2],
        [fno(1), 5],
      ]),
    },
    // a frame reserved in two clips only happens in a hand-edited session.json; the highest wins
    {
      ...p.clip,
      reserved: new Map([
        [fno(3), 4],
        [fno(0), 7],
      ]),
    },
  ]);
  assert.deepEqual(
    [...video.reserved()].toSorted(([a], [b]) => a - b),
    [
      [0, 7],
      [1, 5],
      [3, 4],
    ],
  );
  assert.equal(wire().video.reserved().size, 0);
});

const kitchen = WORLD.clips.find((c) => c.path === KITCHEN)!;
const FOLDERS: Scene = {
  ...WORLD,
  clips: [
    ...WORLD.clips,
    { ...kitchen, path: "/videos/frames75", key: "frames75", timing: { kind: "rate", fps: 7.5, count: 15 } },
    { ...kitchen, path: "/videos/frames3", key: "frames3", timing: { kind: "rate", fps: 3, count: 6 } },
    { ...kitchen, path: "/videos/photos", key: "photos", timing: { kind: "stills", count: 4 } },
  ],
};

test("timing: video clips are opened without a rate and stay `video`", async () => {
  const { video, source } = wire([], new MemFrames(), undefined, FOLDERS);
  const k = (await video.addClip(KITCHEN, THRESH))._unsafeUnwrap();
  assert.deepEqual(source.opened, [[KITCHEN, { fps: null }]]);
  assert.deepEqual(k.clip.timing, { kind: "video" });
});

test("timing: a rate folder above 5 fps is picked at 5 fps, at the sample times", async () => {
  const { video, source } = wire([], new MemFrames(), undefined, FOLDERS);
  const a = (await video.addClip("frames75", { ...THRESH, fps: 7.5 }))._unsafeUnwrap();
  assert.deepEqual(source.opened, [["/videos/frames75", { fps: 7.5 }]]);
  // the picker takes samples 0, 4 and 5 of the 5 fps stream, so the host seeks keyframes at 0, 0.8 and 1 s
  assert.deepEqual([source.streamed, source.rates], [["/videos/frames75"], [5]]);
  assert.deepEqual(a.clip.times, [0, 0.8, 1]);
  assert.deepEqual(a.clip.timing, { kind: "rate", fps: 7.5 });
  assert.deepEqual(
    source.extracted.map(([, t]) => t),
    [0, 0.8, 1],
  );
  assert.equal(video.tag(fno(2))._unsafeUnwrap(), "#2 1.0s");
});

test("timing: a rate folder at or below 5 fps is sampled at its own rate", async () => {
  const { video, source } = wire([], new MemFrames(), undefined, FOLDERS);
  const a = (await video.addClip("frames3", { ...THRESH, fps: 3 }))._unsafeUnwrap();
  assert.deepEqual(source.rates, [3]);
  assert.ok(a.clip.times.length > 1);
  for (const t of a.clip.times) assert.ok(Math.abs(t * 3 - Math.round(t * 3)) < 0.02, `${t} is a frame time at 3 fps`);
});

test("timing: a folder of photos skips picking; every photo is a keyframe at its position", async () => {
  const { video, source } = wire([], new MemFrames(), undefined, FOLDERS);
  const k = (await video.addClip(KITCHEN, THRESH))._unsafeUnwrap();
  const s = (await video.addClip("photos", THRESH))._unsafeUnwrap();
  assert.deepEqual([s.first, s.clip.times, s.clip.timing], [3, [0, 1, 2, 3], { kind: "stills" }]);
  assert.deepEqual(source.streamed, [KITCHEN], "no grey stream for photos");
  assert.deepEqual(
    source.extracted.slice(k.clip.times.length).map(([, t]) => t),
    [0, 1, 2, 3],
  );
  assert.equal(video.tag(fno(5))._unsafeUnwrap(), "#5 photos photo 2");
  assert.equal(video.tag(fno(1))._unsafeUnwrap(), "#1 kitchen 0.2s");
});

test("timing: revival opens a folder at the rate it was added at, whatever rate is asked now", async () => {
  const { video, source } = wire([], new MemFrames(), undefined, FOLDERS);
  const a = (await video.addClip("frames75", { ...THRESH, fps: 7.5 }))._unsafeUnwrap();
  video.removeClip(a.clip.key, new Map())._unsafeUnwrap();
  const b = (await video.addClip("frames75", { ...THRESH, fps: 30 }))._unsafeUnwrap();
  assert.deepEqual([b.revived, b.clip.times, b.clip.timing], [true, a.clip.times, { kind: "rate", fps: 7.5 }]);
  assert.deepEqual(source.opened.at(-1), ["/videos/frames75", { fps: 7.5 }]);
});

test("addClip: a source key that isn't a clip key is a HostFailure", async () => {
  const w = wire();
  w.source.key = async () => "not-a-key";
  const r = await w.video.addClip(KITCHEN, THRESH);
  assert.deepEqual(r._unsafeUnwrapErr(), {
    kind: "host",
    port: "video",
    op: "key",
    message: "not-a-key is not a clip key (12 hex digits)",
  });
});
