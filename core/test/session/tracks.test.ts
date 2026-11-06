/** The tracking queue: order, priority, pause, resume after a reload, cancel, a crash in a unit, and clip removal. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { okAsync, type ResultAsync } from "neverthrow";
import { MODEL_FILES } from "../../src/perception/pure.ts";
import type { Session, TrackSummary } from "../../src/session/index.ts";
import { newHost, openEngine, openSession } from "../compose.ts";
import { KITCHEN, WORLD, type FakeHost, type Scene, type TrackerDecoderScript } from "../fakes/index.ts";
import { parkRule } from "../../src/tracking/pure.ts";

const TRACKER = { tracker: { precision: "fp32" as const }, persistFeatures: true };
const FP32 = MODEL_FILES.tracker.graphs.fp32;
const PART0 = MODEL_FILES.visionParts.parts[0] ?? "";

const ctx = (s: Session) => ({ cfg: s.config() });
const ok = async <T, E>(r: ResultAsync<T, E>): Promise<T> => (await r)._unsafeUnwrap();
const status = (s: Session) => ok(s.track.status(ctx(s), {}));

/** A session over a clip with `track_fps` frames a second, encoded, and detections of "jar" on keyframe 0. */
async function ready(host: FakeHost = newHost(), fps = 5) {
  const s = await openSession(host, TRACKER);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: fps }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  const found = await ok(s.find.find(ctx(s), { prompt: "jar", frames: "0" }));
  return { s, host, ids: found.hits.map((h) => h.id) };
}

type Step = { readonly id: string; readonly leg: "seed" | "forward" | "reverse"; readonly at: number };

/** What one background unit did, from the change in status. Null for a unit that only encoded a frame. */
const diff = (a: readonly TrackSummary[], b: readonly TrackSummary[]): Step | null => {
  for (const t of b) {
    const old = a.find((o) => o.id === t.id);
    if (!old) continue;
    if (old.done === 0 && t.done > 0) return { id: t.id, leg: "seed", at: t.seed_at };
    if (old.forward !== t.forward) return { id: t.id, leg: "forward", at: t.forward };
    if (old.reverse !== t.reverse) return { id: t.id, leg: "reverse", at: t.reverse };
  }
  return null;
};

/** Runs up to `n` units and lists what they did. */
async function run(s: Session, n = Infinity) {
  const steps: Step[] = [];
  let encodes = 0;
  for (let k = 0; k < n; k++) {
    const before = (await status(s)).tracks;
    if (!(await ok(s.background()))) break;
    const step = diff(before, (await status(s)).tracks);
    if (step) steps.push(step);
    else encodes++;
  }
  return { steps, encodes };
}

const legs = (steps: readonly Step[]) => steps.map((x) => `${x.id}:${x.leg}:${x.at}`);

test("frames go outward from the seed, and the whole clip gets covered", async () => {
  const { s, ids } = await ready();
  const grid = await ok(s.track.frames(ctx(s), { clip: KITCHEN }));
  const mid = ids[0] ?? "";
  await ok(s.track.start(ctx(s), { ids: [mid] }));
  const [t] = (await status(s)).tracks;
  assert.ok(t);
  assert.equal(t.total, grid.frames.length);
  const { steps } = await run(s);
  assert.deepEqual(legs(steps)[0], `${t.id}:seed:${t.seed_at}`);
  // The seed is on keyframe 0, the first frame, so this one only goes forward.
  assert.deepEqual(
    steps.slice(1).map((x) => x.at),
    Array.from({ length: t.total - 1 }, (_, k) => t.seed_at + k + 1),
  );
  const done = (await status(s)).tracks[0];
  assert.equal(done?.done, t.total);
  assert.equal(done?.finished, true);
  assert.equal(await ok(s.background()), false);
});

test("a seed mid-clip alternates legs, nearest first, and the first track goes before the rest", async () => {
  const host = newHost();
  const s = await openSession(host, TRACKER);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: 5 }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  const frames = await ok(s.track.frames(ctx(s), { clip: KITCHEN }));
  const keyframes = frames.frames.filter((f) => f.keyframe !== null);
  const later = keyframes.at(-1);
  assert.ok(later && later.at > 1 && later.keyframe !== null, "a keyframe past the start");
  const found = await ok(s.find.find(ctx(s), { prompt: "jar", frames: String(later.keyframe) }));
  const [a, b] = found.hits.map((h) => h.id);
  assert.ok(a && b);
  await ok(s.track.start(ctx(s), { ids: [a] }));
  await ok(s.track.start(ctx(s), { ids: [b], first: true }));
  const { steps } = await run(s);
  const t2 = steps.filter((x) => x.id === "t2");
  const lastOfFirst = steps.map((x) => x.id).lastIndexOf("t2");
  assert.ok(
    steps.slice(0, lastOfFirst).every((x) => x.id === "t2"),
    "t2 ran first, whole",
  );
  const dist = t2.map((x) => Math.abs(x.at - later.at));
  assert.deepEqual(
    dist,
    dist.toSorted((x, y) => x - y),
    "outward",
  );
  assert.ok(t2.some((x) => x.leg === "reverse"));
  const st = await status(s);
  assert.ok(st.tracks.every((t) => t.finished));
});

test("equal tracks pass a frame together, so the neck runs once a frame", async () => {
  const { s, host, ids } = await ready();
  assert.ok(ids.length >= 2);
  await ok(s.track.start(ctx(s), { ids }));
  const { steps } = await run(s);
  // Seeds both on one frame, then frame by frame.
  const ats = steps.map((x) => x.at);
  assert.deepEqual(
    ats,
    ats.toSorted((x, y) => x - y),
  );
  const frames = new Set(ats).size;
  assert.equal(host.models.calls[FP32.neck], frames);
});

test("a priority change mid-run takes effect at the next unit", async () => {
  const { s, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 2) }));
  await run(s, 4);
  await ok(s.track.prioritise(ctx(s), { ids: ["t2"] }));
  const { steps } = await run(s);
  const last = steps.map((x) => x.id).lastIndexOf("t2");
  assert.ok(last >= 0 && steps.slice(0, last).every((x) => x.id === "t2"), legs(steps).join(" "));
  await assert.rejects(() => ok(s.track.prioritise(ctx(s), { ids: ["t99"] })));
});

test("encoding is its own unit and only for frames a track needs; stored trunks don't encode again", async () => {
  const { s, host, ids } = await ready();
  const parts0 = host.models.calls[PART0] ?? 0;
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 1) }));
  const a = await run(s, 3);
  const used = host.models.calls[PART0] ?? 0;
  assert.ok(used - parts0 <= 2, "at most the frames these units reached");
  assert.equal(a.steps.length + a.encodes, 3);
  await run(s);
  const all = host.models.calls[PART0] ?? 0;
  const [t] = (await status(s)).tracks;
  const keyframes = (await ok(s.track.frames(ctx(s), { clip: KITCHEN }))).frames.filter(
    (f) => f.keyframe !== null,
  ).length;
  // Non-keyframes once each; keyframes' trunks came with their features.
  assert.equal(all - parts0, (t?.total ?? 0) - keyframes);
  // A second object reads stored trunks.
  await ok(s.track.start(ctx(s), { ids: ids.slice(1, 2) }));
  await run(s);
  assert.equal(host.models.calls[PART0], all);
});

test("a trunk evicted by its disk budget is encoded again when a track needs it", async () => {
  const host = newHost();
  const opts = { ...TRACKER, tracker: { precision: "fp32" as const, trunkDiskMB: 11 } };
  const s = await openSession(host, opts);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: 5 }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  assert.equal([...host.store.files.keys()].filter((f) => f.includes("/trunk/")).length, 1, "room for one");
  const found = await ok(s.find.find(ctx(s), { prompt: "jar", frames: "0" }));
  await ok(s.track.start(ctx(s), { ids: found.hits.map((h) => h.id).slice(0, 1) }));
  const before = host.models.calls[PART0] ?? 0;
  await run(s);
  const t = (await status(s)).tracks[0];
  assert.equal(t?.finished, true);
  assert.ok((host.models.calls[PART0] ?? 0) - before >= (t?.total ?? 0) - 1, "frames were encoded again");
  assert.equal([...host.store.files.keys()].filter((f) => f.includes("/trunk/")).length, 1);
});

test("pause stops every unit, also after a reload; resume continues; nothing is redone", async () => {
  const { s, host, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 1) }));
  await run(s, 4);
  const paused = await ok(s.track.pause(ctx(s), {}));
  assert.equal(paused.paused, true);
  assert.equal(await ok(s.background()), false);
  const att = host.models.calls[FP32.attention[0]] ?? 0;
  assert.ok(att > 0);

  const again = await openSession(host, TRACKER);
  const st = await status(again);
  assert.equal(st.paused, true);
  const reached = st.tracks[0]?.forward ?? 0;
  while (await ok(again.background()));
  assert.equal((await status(again)).tracks[0]?.forward, reached, "paused after the reload");
  await ok(again.track.resume(ctx(again), {}));
  const { steps } = await run(again);
  assert.equal(steps[0]?.at, reached + 1, "continues after the last saved frame");
  assert.deepEqual(new Set(steps.map((x) => x.at)).size, steps.length, "no frame twice");
  assert.equal((await status(again)).tracks[0]?.finished, true);
});

test("resuming after a reload gives the same result as never stopping", async () => {
  const straight = await ready();
  await ok(straight.s.track.start(ctx(straight.s), { ids: straight.ids.slice(0, 1) }));
  await run(straight.s);

  const broken = await ready();
  await ok(broken.s.track.start(ctx(broken.s), { ids: broken.ids.slice(0, 1) }));
  await run(broken.s, 5);
  const reopened = await openSession(broken.host, TRACKER);
  await run(reopened);

  const feeds = (h: FakeHost, n: number) =>
    h.models.trackerRuns
      .filter((r) => r.file === FP32.attention[0])
      .slice(-n)
      .map((r) => ({
        spatial: r.feeds.spatial,
        pointer: r.feeds.pointer,
        pointerPos: r.feeds.pointer_pos,
      }));
  assert.deepEqual(feeds(broken.host, 1), feeds(straight.host, 1));
  const masks = (await status(reopened)).tracks[0];
  assert.equal(masks?.finished, true);
});

test("cancel takes a track out and keeps its frames; starting it again goes on from there", async () => {
  const { s, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 2) }));
  await run(s, 6);
  const c = await ok(s.track.cancel(ctx(s), { ids: ["t1"] }));
  const t1 = c.tracks.find((t) => t.id === "t1");
  assert.equal(t1?.state, "cancelled");
  const { steps } = await run(s);
  assert.ok(steps.every((x) => x.id === "t2"));
  const kept = await ok(s.track.masks(ctx(s), { clip: KITCHEN, at: t1?.seed_at ?? 0 }));
  assert.ok(
    kept.masks.some((m) => m.track === "t1"),
    "finished frames stay",
  );
  const back = await ok(s.track.start(ctx(s), { ids: [ids[0] ?? ""] }));
  const same = back.tracks.filter((t) => t.det === ids[0]);
  assert.equal(same.length, 1, "one track per detection");
  assert.equal(same[0]?.forward, t1?.forward, "keeps what it had");
  const more = await run(s);
  assert.equal(more.steps[0]?.at, (t1?.forward ?? 0) + 1);
  // Cancel with no ids takes all of them.
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 2) }));
  const all = await ok(s.track.cancel(ctx(s), {}));
  assert.ok(all.tracks.filter((t) => !t.finished).every((t) => t.state === "cancelled"));
});

test("a crash between a unit's data and its index: the unit runs again, and no frame counts until it is indexed", async () => {
  const { s, host, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 1) }));
  await run(s, 3);
  const before = (await status(s)).tracks[0];
  assert.ok(before);
  const write = host.store.writeText.bind(host.store);
  let crashed = false;
  host.store.writeText = async (key: string, text: string) => {
    if (key === "tracks.json") {
      crashed = true;
      throw new Error("power cut");
    }
    return write(key, text);
  };
  for (let k = 0; k < 5 && !crashed; k++) await s.background();
  assert.ok(crashed, "a unit reached the index");
  const orphan = `${before.forward + 1}`.padStart(3, "0");
  assert.ok(
    [...host.store.files.keys()].some((f) => f.endsWith(`mask-${orphan}.npz`)),
    "the unit's mask is on disk",
  );
  host.store.writeText = write;

  const again = await openSession(host, TRACKER);
  const st = (await status(again)).tracks[0];
  assert.equal(st?.forward, before.forward, "the index still has the old frame");
  const unseen = await ok(again.track.masks(ctx(again), { clip: KITCHEN, at: before.forward + 1 }));
  assert.deepEqual(unseen.masks, [], "a file the index doesn't name reads as nothing");
  const { steps } = await run(again);
  assert.equal(steps[0]?.at, before.forward + 1);
  assert.equal((await status(again)).tracks[0]?.finished, true);
  const seen = await ok(again.track.masks(ctx(again), { clip: KITCHEN, at: before.forward + 1 }));
  assert.equal(seen.masks.length, 1);
  // Old memory files are gone: one per leg at most.
  const mems = [...host.store.files.keys()].filter((f) => /\/mem-/.test(f));
  assert.ok(mems.length <= 2, mems.join(" "));
});

test("clip removal takes tracks along, and they stay out of the queue; revival starts with none", async () => {
  const { s, host, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 1) }));
  await run(s, 4);
  await ok(s.videos.remove(ctx(s), { clip: KITCHEN }));
  assert.deepEqual((await status(s)).tracks, []);
  assert.deepEqual(
    [...host.store.files.keys()].filter((f) => f.includes("/tracks/")),
    [],
  );
  assert.equal(await ok(s.background()), false);
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  assert.deepEqual((await status(s)).tracks, []);
  const frames = await ok(s.track.frames(ctx(s), { clip: KITCHEN }));
  assert.ok(frames.frames.length > 0);
});

test("a track of a frame that can't be read fails and the queue moves on", async () => {
  const { s, host, ids } = await ready();
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 2) }));
  const gone = [...host.store.files.keys()].filter((f) => f.includes("/trackframes/"));
  for (const f of gone) host.store.files.delete(f);
  const units = await run(s, 50);
  const st = await status(s);
  assert.ok(
    st.tracks.every((t) => t.state === "failed" && t.failure === "missing-track-frame"),
    JSON.stringify(st),
  );
  assert.ok(units.steps.length < 50);
  assert.equal(await ok(s.background()), false);
});

test("objects and undo leave tracks alone, and the reply shows the object as it is now", async () => {
  const { s, ids } = await ready();
  const det = ids[0] ?? "";
  await ok(s.track.start(ctx(s), { ids: [det] }));
  await run(s, 3);
  const obj = await ok(s.label.create(ctx(s), { label: "jar", ids: [det] }));
  assert.equal((await status(s)).tracks[0]?.object, obj.id);
  const reached = (await status(s)).tracks[0]?.forward;
  await ok(s.label.delete(ctx(s), { obj: obj.id }));
  assert.equal((await status(s)).tracks[0]?.object, undefined);
  await ok(s.label.undo(ctx(s), {}));
  assert.equal((await status(s)).tracks[0]?.object, obj.id);
  assert.equal((await status(s)).tracks[0]?.forward, reached);
  assert.equal((await status(s)).tracks[0]?.state, "active");
});

test("tracks stay out of ops.jsonl", async () => {
  const { s, host, ids } = await ready();
  const before = host.store.files.get("ops.jsonl")?.length ?? 0;
  await ok(s.track.start(ctx(s), { ids }));
  await run(s);
  await ok(s.track.pause(ctx(s), {}));
  assert.equal(host.store.files.get("ops.jsonl")?.length ?? 0, before);
});

test("with tracking off every op says so, and the background stays as it was", async () => {
  const o = await openEngine(newHost(), { persistFeatures: true });
  await assert.rejects(() => o.caller.track.status({}), /tracking is off/);
  await assert.rejects(() => o.caller.track.start({ ids: ["0.1"] }), /tracking is off/);
  await assert.rejects(() => o.caller.track.pause({}), /tracking is off/);
  assert.ok(!o.host.store.files.has("tracks.json"));
  o.close();
});

test("through the engine: a queued call runs before the next unit, and pause is told to the engine", async () => {
  const o = await openEngine(newHost(), TRACKER);
  await o.caller.config({ key: "track_fps", value: 5 });
  await o.caller.add({ video: KITCHEN });
  await o.settle();
  await o.caller.track.pause({});
  const found = await o.caller.find({ prompt: "jar", frames: "0" });
  const ids = found.hits.map((h) => h.id).slice(0, 2);
  await o.caller.track.start({ ids });
  const atts = () => o.host.models.calls[FP32.attention[0]] ?? 0;
  assert.equal(atts(), 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(atts(), 0, "no unit while paused");
  await o.caller.track.resume({});
  // Calls made while units run each get in after at most the unit in progress.
  for (let k = 0; k < 3; k++) {
    const before = atts();
    await o.caller.status({});
    assert.ok(atts() - before <= 1, `at most the one unit in progress ran, got ${atts() - before}`);
  }
  await o.caller.track.pause({});
  const stopped = atts();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(atts(), stopped, "pausing stops the units");
  await o.caller.track.resume({});
  for (let k = 0; k < 2000; k++) {
    const st = await o.caller.track.status({});
    if (st.tracks.every((t) => t.finished)) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok((await o.caller.track.status({})).tracks.every((t) => t.finished));
  assert.equal(await o.engine.call(undefined, (s) => okAsync(s.tracking())).then((r) => r._unsafeUnwrap()), false);
  // Idle again, the vision parts are freed as a set.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(o.host.models.releases.includes(PART0));
  assert.ok(o.host.models.releases.includes(MODEL_FILES.visionParts.neck));
  assert.ok(o.host.models.releases.includes(MODEL_FILES.visionParts.parts[31] ?? ""));
  o.close();
});

test("a failing unit backs off and retries; the track doesn't fail", async () => {
  const host = newHost();
  const o = await openEngine(host, TRACKER);
  await o.caller.add({ video: KITCHEN });
  await o.settle();
  const found = await o.caller.find({ prompt: "jar", frames: "0" });
  const rt = host.models;
  const load = rt.load.bind(rt);
  let failures = 0;
  rt.load = async (name: string) => {
    if (name.startsWith("tracker/") && failures < 1) {
      failures++;
      throw new Error("device lost");
    }
    return load(name);
  };
  await o.caller.track.start({ ids: found.hits.map((h) => h.id).slice(0, 1) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(failures, 1);
  assert.equal((await o.caller.track.status({})).tracks[0]?.state, "active");
  o.close();
});

/** The kitchen clip with a cut at `at` seconds in its grey stream. */
const cutScene = (at: number): Scene => ({
  ...WORLD,
  clips: WORLD.clips.map((c) => (c.path === KITCHEN ? { ...c, cuts: [at] } : c)),
});

test("a cut is saved with the grid, joins it from both sides, and ends a leg on each side", async () => {
  const host = newHost({ scene: cutScene(1) });
  const s = await openSession(host, TRACKER);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: 2 }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  const grid = await ok(s.track.frames(ctx(s), { clip: KITCHEN }));
  assert.deepEqual(grid.cuts, [1]);
  const times = grid.frames.map((f) => f.t);
  assert.ok(times.includes(0.8) && times.includes(1), times.join(" "));
  const saved = JSON.parse(host.store.text("session.json")) as { clips: { track_cuts?: number[] }[] };
  assert.deepEqual(saved.clips[0]?.track_cuts, [1]);

  const keyframes = grid.frames.filter((f) => f.keyframe !== null);
  const before = keyframes[0];
  const after = keyframes.at(-1);
  assert.ok(before?.keyframe !== null && after?.keyframe !== null && before && after && after.t >= 1);
  const a = await ok(s.find.find(ctx(s), { prompt: "jar", frames: String(before.keyframe) }));
  const b = await ok(s.find.find(ctx(s), { prompt: "jar", frames: String(after.keyframe) }));
  await ok(s.track.start(ctx(s), { ids: [a.hits[0]?.id ?? "", b.hits[0]?.id ?? ""] }));
  await run(s);
  const [t1, t2] = (await status(s)).tracks;
  const firstAfter = grid.frames.findIndex((f) => f.t === 1);
  assert.equal(t1?.forward, firstAfter - 1, "the leg before the cut ends on the last frame before it");
  assert.equal(t2?.reverse, firstAfter, "the leg after the cut ends on the first frame after it");
  assert.equal(t2?.forward, grid.frames.length - 1);
  assert.ok(t1?.finished && t2?.finished);
  assert.equal(t1.total, firstAfter);
  assert.equal(t2.total, grid.frames.length - firstAfter);
  assert.equal(t1.done, t1.total);
  // No mask of a shot on a frame of the other.
  const across = await ok(s.track.masks(ctx(s), { clip: KITCHEN, at: firstAfter }));
  assert.deepEqual(
    across.masks.map((m) => m.track),
    [t2.id],
  );

  const again = await openSession(host, TRACKER);
  assert.deepEqual((await ok(again.track.frames(ctx(again), { clip: KITCHEN }))).cuts, [1]);
});

test("a clip with no cut has no track_cuts, and a track covers all of it", async () => {
  const { s, host, ids } = await ready();
  const saved = JSON.parse(host.store.text("session.json")) as { clips: { track_cuts?: number[] }[] };
  assert.equal(saved.clips[0]?.track_cuts, undefined);
  assert.deepEqual((await ok(s.track.frames(ctx(s), { clip: KITCHEN }))).cuts, []);
  await ok(s.track.start(ctx(s), { ids: ids.slice(0, 1) }));
  await run(s);
  assert.equal((await status(s)).tracks[0]?.finished, true);
});

/** A longer kitchen clip at 2 fps, so that there are frames to skip. The script answers per decoder call. */
const longScene: Scene = {
  ...WORLD,
  clips: WORLD.clips.map((c) => (c.path === KITCHEN ? { ...c, duration: 10, pan: 4 } : c)),
};
const parkedSession = async (script: TrackerDecoderScript, recheck = 1.5) => {
  const host = newHost({ scene: longScene, models: { trackerDecoder: script } });
  const s = await openSession(host, TRACKER);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: 2 }));
  await ok(s.videos.config(ctx(s), { key: "track_recheck", value: recheck }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  const found = await ok(s.find.find(ctx(s), { prompt: "jar", frames: "0" }));
  return { s, host, id: found.hits[0]?.id ?? "" };
};

test("parkRule: at 2 fps park after a miss and look every 3 frames; 0 never skips", () => {
  assert.deepEqual(parkRule(2, 1.5), { parkAfter: 1, recheck: 3 });
  assert.deepEqual(parkRule(5, 1.5), { parkAfter: 3, recheck: 8 });
  assert.equal(parkRule(2, 0).recheck, 1);
});

test("a track that misses parks on the schedule, and a return keeps its id and goes frame by frame again", async () => {
  // Miss on the first two looks after the seed's decoder calls, then be back for good.
  let looks = 0;
  const { s, id } = await parkedSession(() => {
    looks++;
    return { score: looks >= 2 && looks <= 3 ? -3 : 4 };
  });
  await ok(s.track.start(ctx(s), { ids: [id] }));
  const { steps } = await run(s);
  const at = steps.filter((x) => x.leg === "forward").map((x) => x.at);
  const gaps = at.slice(1).map((a, n) => a - (at[n] ?? 0));
  const firstJump = gaps.indexOf(3);
  assert.ok(firstJump >= 0, `a miss parks it and the next look is 3 frames on: ${gaps.join(" ")}`);
  assert.equal(gaps[firstJump + 1], 3, "missed again, so another jump");
  assert.ok(
    gaps.slice(firstJump + 2).every((g) => g === 1),
    `back, so frame by frame: ${gaps.join(" ")}`,
  );
  const st = await status(s);
  assert.equal(new Set(st.tracks.map((x) => x.id)).size, 1, "one id, no re-seed");
  const t = st.tracks[0];
  assert.ok(t?.finished);
  assert.equal(t.parked, false);
  assert.equal(t.skipped, 4);
  assert.equal(t.done, t.total, "skipped frames count as covered");
  assert.equal(t.seen?.first, t.seed_at);
  assert.equal(t.seen?.last, t.total - 1, "seen again at the end");
});

test("a skipped frame says parked and has no mask; a looked-at miss has an empty mask", async () => {
  const { s, id } = await parkedSession(() => ({ score: -3, logit: -5 }));
  await ok(s.track.start(ctx(s), { ids: [id] }));
  const { steps } = await run(s);
  const looked = new Set(steps.map((x) => x.at));
  const t = (await status(s)).tracks[0];
  assert.ok(t);
  assert.ok(t.skipped > 0);
  assert.equal(t.seen?.count, 1, "only the seed's frame");
  const skipped = Array.from({ length: t.total }, (_, a) => a).find((a) => !looked.has(a));
  const missed = steps.find((x) => x.leg === "forward")?.at;
  assert.ok(skipped !== undefined && missed !== undefined);
  const a = await ok(s.track.masks(ctx(s), { clip: KITCHEN, at: skipped }));
  assert.deepEqual(a.masks, []);
  assert.deepEqual(a.parked, [t.id]);
  const b = await ok(s.track.masks(ctx(s), { clip: KITCHEN, at: missed }));
  assert.deepEqual(b.parked, []);
  assert.equal(b.masks[0]?.track, t.id);
});

test("track_recheck 0 looks at every frame, misses or not", async () => {
  const { s, id } = await parkedSession(() => ({ score: -3 }), 0);
  await ok(s.track.start(ctx(s), { ids: [id] }));
  await run(s);
  const t = (await status(s)).tracks[0];
  assert.equal(t?.skipped, 0);
  assert.equal(t?.finished, true);
});

test("parking survives a reload: the next look lands where it would have", async () => {
  const { s, host, id } = await parkedSession(() => ({ score: -3 }));
  await ok(s.track.start(ctx(s), { ids: [id] }));
  for (let n = 0; n < 8 && !(await status(s)).tracks[0]?.parked; n++) await ok(s.background());
  const before = (await status(s)).tracks[0];
  assert.equal(before?.parked, true);
  const again = await openSession(host, TRACKER);
  assert.deepEqual((await status(again)).tracks[0], before);
  const { steps } = await run(again);
  assert.equal(steps[0]?.at, (before?.forward ?? 0) + 3);
  assert.equal((await status(again)).tracks[0]?.finished, true);
});

type Still = {
  readonly name: string;
  readonly rect: readonly [number, number, number, number];
  readonly prompts: Readonly<Record<string, number>>;
};

/** Kitchen with one still object per name, on a clip long enough for several keyframes. */
const stillScene = (objects: readonly Still[]): Scene => ({
  ...WORLD,
  clips: WORLD.clips.map((c) =>
    c.path === KITCHEN
      ? {
          ...c,
          duration: 4,
          pan: 40,
          objects: objects.map((o, n) => ({
            name: o.name,
            color: [200 - n * 40, 40, 40 + n * 40] as const,
            prompts: o.prompts,
            from: o.rect,
          })),
        }
      : c,
  ),
});
const JAR = { name: "jar", rect: [20, 30, 60, 80] as const, prompts: { jar: 3 } };

/** The object's rectangle on the tracker's plane. The clip is 160×120. */
const onPlane = ([x0, y0, x1, y1]: readonly [number, number, number, number]) => {
  const out = new Uint8Array(288 * 288);
  for (let py = 0; py < 288; py++) {
    const y = Math.floor(((py + 0.5) * 120) / 288);
    if (y < y0 || y >= y1) continue;
    for (let px = 0; px < 288; px++) {
      const x = Math.floor(((px + 0.5) * 160) / 288);
      if (x >= x0 && x < x1) out[py * 288 + px] = 1;
    }
  }
  return out;
};

/** A session with `scene`, where every track follows the jar with this score, and a Find over all keyframes. */
const autoSession = async (scene: Scene, score: number, mask = onPlane(JAR.rect), prompts = ["jar"]) => {
  const host = newHost({ scene, models: { trackerDecoder: () => ({ score, mask }) } });
  const s = await openSession(host, TRACKER);
  await ok(s.videos.config(ctx(s), { key: "track_fps", value: 2 }));
  await ok(s.videos.add(ctx(s), { video: KITCHEN }));
  while (await ok(s.background()));
  for (const prompt of prompts) await ok(s.find.find(ctx(s), { prompt, threshold: 0.3 }));
  return { s, host };
};
const proposals = (s: Session) => ok(s.track.proposals(ctx(s), {}));

test("auto: one object seen on every keyframe is one track, with all its detections on it", async () => {
  const { s, host } = await autoSession(stillScene([JAR]), 5);
  await ok(s.track.auto(ctx(s), {}));
  await run(s);
  const st = await status(s);
  assert.equal(st.tracks.length, 1, JSON.stringify(st.tracks.map((t) => t.id)));
  assert.equal(st.waiting, 0);
  const p = await proposals(s);
  assert.equal(p.groups.length, 1);
  const t = p.groups[0]?.tracks[0];
  const keyframes = (await ok(s.track.frames(ctx(s), { clip: KITCHEN }))).frames.filter((f) => f.keyframe !== null);
  assert.ok(keyframes.length >= 2);
  assert.equal(t?.dets.length, keyframes.length, "one detection per keyframe");
  assert.deepEqual(
    t?.dets.map((d) => d.how),
    ["seed", ...keyframes.slice(1).map(() => "match")],
  );
  assert.equal(t?.auto, true);
  assert.equal(t?.object, undefined, "no object: labelling stays the user's");
  assert.equal(host.store.files.has("ops.jsonl"), false, "not in ops.jsonl");
  assert.ok(host.store.text("assoc.json").includes('"match"'));
  assert.ok((JSON.parse(host.store.text("session.json")) as { assoc?: string }).assoc?.startsWith("assoc-v1"));
});

test("auto: a weak track can't stop a seed, and the tracks that end up on one thing are a suggestion, not a merge", async () => {
  const { s } = await autoSession(stillScene([JAR]), 1.25);
  await ok(s.track.auto(ctx(s), {}));
  await run(s);
  const st = await status(s);
  assert.ok(st.tracks.length >= 2, "each keyframe's detection seeds");
  const p = await proposals(s);
  assert.ok(p.weak_covers >= 1);
  assert.equal(p.groups.length, 1, "shown as one group");
  const [a, b] = p.groups[0]?.tracks ?? [];
  assert.ok(a && b && a.track !== b.track, "still separate tracks");
  assert.ok(a.converged_with.some((c) => c.track === b.track && c.frames >= 2));
  assert.equal(
    st.tracks.every((t) => t.object === undefined),
    true,
  );
});

test("auto: bottle and jar on one thing make one track", async () => {
  const thing = { name: "thing", rect: [20, 30, 60, 80] as const, prompts: { jar: 3, bottle: 2.5 } };
  const { s } = await autoSession(stillScene([thing]), 5, onPlane(thing.rect), ["jar", "bottle"]);
  await ok(s.track.auto(ctx(s), {}));
  await run(s);
  assert.equal((await status(s)).tracks.length, 1);
  const hows = (await proposals(s)).groups[0]?.tracks[0]?.dets.map((d) => d.how) ?? [];
  assert.ok(hows.includes("dup"), hows.join(" "));
});

test("auto: the max-tracks guard keeps the best, says who it left out, and a higher limit picks them up", async () => {
  const many: readonly Still[] = [
    { name: "a", rect: [10, 30, 40, 60] as const, prompts: { jar: 3 } },
    { name: "b", rect: [50, 30, 80, 60] as const, prompts: { jar: 2 } },
    { name: "c", rect: [90, 30, 120, 60] as const, prompts: { jar: 1 } },
  ];
  const { s } = await autoSession(stillScene(many), 5, onPlane(many[0]?.rect ?? [0, 0, 0, 0]));
  await ok(s.videos.config(ctx(s), { key: "auto_tracks", value: 1 }));
  const frames = (await ok(s.track.frames(ctx(s), { clip: KITCHEN }))).frames.flatMap((f) =>
    f.keyframe === null ? [] : [f.keyframe],
  );
  await ok(s.track.auto(ctx(s), { frames: String(frames[0]) }));
  await run(s);
  assert.equal((await status(s)).tracks.length, 1);
  const p = await proposals(s);
  assert.equal(p.groups[0]?.tracks[0]?.score, Math.max(...p.groups[0]!.tracks[0]!.dets.map((d) => d.score)));
  assert.equal(p.left_out.length, 2);
  await ok(s.videos.config(ctx(s), { key: "auto_tracks", value: 3 }));
  await ok(s.track.auto(ctx(s), { frames: String(frames[0]) }));
  await run(s);
  assert.equal((await status(s)).tracks.length, 3);
  assert.deepEqual((await proposals(s)).left_out, []);
});

test("auto: tracks run behind a requested one, and asking for a held detection raises its track", async () => {
  const two: readonly Still[] = [
    { name: "a", rect: [10, 30, 40, 60] as const, prompts: { jar: 3 } },
    { name: "b", rect: [90, 30, 120, 60] as const, prompts: { box: 3 } },
  ];
  const { s } = await autoSession(stillScene(two), 5, onPlane(two[0]?.rect ?? [0, 0, 0, 0]), ["jar", "box"]);
  const frames = (await ok(s.track.frames(ctx(s), { clip: KITCHEN }))).frames.flatMap((f) =>
    f.keyframe === null ? [] : [f.keyframe],
  );
  const first = String(frames[0]);
  const box = (await ok(s.find.find(ctx(s), { prompt: "box", frames: first }))).hits[0]?.id ?? "";
  await ok(s.track.start(ctx(s), { ids: [box] }));
  await ok(s.track.auto(ctx(s), { frames: first }));
  const { steps } = await run(s);
  const lastAsked = steps.map((x) => x.id).lastIndexOf("t1");
  assert.ok(
    steps.slice(0, lastAsked).every((x) => x.id === "t1"),
    "the requested track is whole before the rest start",
  );
  assert.ok(
    steps.some((x) => x.id === "t2"),
    "the rest came after",
  );
  // The jar's detection now has a track. Asking for it gives that one, raised.
  const jar = (await ok(s.find.find(ctx(s), { prompt: "jar", frames: first }))).hits[0]?.id ?? "";
  const after = await ok(s.track.start(ctx(s), { ids: [jar] }));
  assert.equal(after.tracks.length, 2);
  assert.equal(after.tracks.find((t) => t.det === jar)?.priority, 0);
});

test("auto: a reload in the middle goes on to the same tracks and detections as never stopping", async () => {
  const whole = await autoSession(stillScene([JAR]), 5);
  await ok(whole.s.track.auto(ctx(whole.s), {}));
  await run(whole.s);
  const { s, host } = await autoSession(stillScene([JAR]), 5);
  await ok(s.track.auto(ctx(s), {}));
  await run(s, 4);
  assert.ok((await status(s)).waiting > 0, "stopped while keyframes wait");
  const again = await openSession(host, TRACKER);
  assert.ok((await status(again)).waiting > 0, "they are still queued after the reload");
  await run(again);
  const strip = (r: Awaited<ReturnType<typeof proposals>>) =>
    r.groups.map((g) => g.tracks.map((t) => [t.track, t.dets, t.frames]));
  assert.deepEqual(strip(await proposals(again)), strip(await proposals(whole.s)));
});

test("auto: cancelling everything stops what hasn't started, and another stamp means association runs again", async () => {
  const { s, host } = await autoSession(stillScene([JAR]), 5);
  await ok(s.track.auto(ctx(s), {}));
  await run(s, 2);
  const cancelled = await ok(s.track.cancel(ctx(s), {}));
  assert.equal(cancelled.waiting, 0);
  await run(s);
  assert.equal((await status(s)).tracks.length <= 1, true);

  const j = JSON.parse(host.store.text("session.json")) as Record<string, unknown>;
  host.store.files.set("session.json", new TextEncoder().encode(JSON.stringify({ ...j, assoc: "old-rule" })));
  const again = await openSession(host, TRACKER);
  assert.deepEqual(
    (await proposals(again)).groups.flatMap((g) => g.tracks.flatMap((t) => t.dets.filter((d) => d.how !== "seed"))),
    [],
  );
});

test("removing a clip clears what waits for it", async () => {
  const { s } = await autoSession(stillScene([JAR]), 5);
  await ok(s.track.auto(ctx(s), {}));
  await ok(s.videos.remove(ctx(s), { clip: KITCHEN }));
  assert.equal((await status(s)).waiting, 0);
  assert.deepEqual((await proposals(s)).groups, []);
  assert.equal(await ok(s.background()), false);
});
