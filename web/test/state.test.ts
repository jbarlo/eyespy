import assert from "node:assert/strict";
import { test } from "node:test";
import { masksOf } from "../src/state/detections.ts";
import { parseSpec, toSpec } from "../src/state/frames.ts";
import type { DetRow } from "../src/state/types.ts";
import { AGREED, det, frame, sessionHandlers, settle, setup, UserError } from "./fakes.ts";

test("open: loads the session, ready, threshold from config, remembers the OPFS name, polls", async () => {
  const { app, engine, storage, clock } = setup({
    handlers: sessionHandlers({ config: () => ({ config: { threshold: 0.6 } }) }),
  });
  const api = await app.actions.openSession({ opfs: "s1" });
  assert.ok(api);
  const e = app.stores.engine.getState();
  assert.equal(e.phase, "ready");
  assert.equal(e.label, "s1");
  assert.equal(e.session?.info.device, "webgpu fake");
  assert.deepEqual(
    app.stores.frames.getState().frames.map((f) => f.frame),
    [0, 1, 2, 5, 6],
  );
  assert.equal(app.stores.detections.getState().dets.length, 8);
  assert.equal(app.stores.objects.getState().objects[0]?.id, "o1");
  assert.equal(app.stores.layers.getState().threshold, 0.6);
  assert.equal(storage.prefs.data.session, "s1");
  assert.equal(engine.opened[0]?.req.detector, "fp32");
  assert.equal(clock.pending(), 1, "status poll installed");
});

test("open failure: phase failed, the error is a notice", async () => {
  const { app, engine } = setup();
  engine.failNextOpen("no WebGPU adapter");
  assert.equal(await app.actions.openSession({ opfs: "s1" }), null);
  assert.equal(app.stores.engine.getState().phase, "failed");
  assert.equal(app.stores.engine.getState().error, "no WebGPU adapter");
  assert.deepEqual(
    app.stores.notices.getState().notices.map((n) => n.text),
    ["no WebGPU adapter"],
  );
});

test("no WebGPU: no licence question, no engine, no notice; the phase says which case", async () => {
  for (const webgpu of ["no-webgpu", "no-adapter"] as const) {
    const { app, engine, host } = setup({ webgpu, agreed: false });
    assert.equal(await app.actions.openSession({ opfs: "s1" }), null);
    const e = app.stores.engine.getState();
    assert.equal(e.phase, webgpu);
    assert.match(e.error ?? "", /WebGPU/);
    assert.equal(app.stores.licence.getState().ask, null, "no licence dialog for models that can't run");
    assert.equal(engine.opened.length, 0);
    assert.deepEqual(app.stores.notices.getState().notices, []);
    assert.equal(await app.actions.openSession({ opfs: "s2" }), null);
    assert.equal(app.stores.engine.getState().phase, webgpu);
    assert.equal(host.checks, 1, "the browser is asked once per page load");
  }
});

test("WebGPU checked once: a later switch resets the old session at once", async () => {
  const { app, engine, host } = setup();
  await app.actions.openSession({ opfs: "s1" });
  const opening = app.actions.openSession({ opfs: "s2" });
  assert.equal(engine.opened[0]?.disposed, true, "disposed before the first await");
  assert.ok(await opening);
  assert.equal(host.checks, 1);
});

test("switch: the old engine is disposed, session stores and asset caches reset, its poll stopped", async () => {
  const { app, engine, clock, img } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.select(["0.2"]);
  app.actions.setFrame(5);
  await app.actions.loadMasks(5);
  const bm = await app.actions.frameBitmap(5);
  app.actions.requestThumbs();
  await settle();
  assert.ok(bm && app.stores.detections.getState().masks.size > 0);
  assert.ok(img.urls.length >= 5);
  app.actions.setLayer("rejects", true);
  app.actions.watchClips(true);

  const switched = app.actions.openSession({ opfs: "s2" });
  // while s2 starts, nothing of s1 is left
  assert.equal(engine.opened[0]?.disposed, true);
  assert.deepEqual(app.stores.selection.getState().ids, []);
  assert.equal(app.stores.frames.getState().frames.length, 0);
  assert.equal(app.stores.detections.getState().masks.size, 0);
  assert.equal(app.stores.engine.getState().phase, "starting");
  assert.ok(
    img.made.every((b) => b.closed),
    "every bitmap closed",
  );
  assert.ok(
    img.urls.every((u) => u.revoked),
    "every thumbnail URL revoked",
  );
  assert.equal(app.stores.layers.getState().layers.rejects, true, "view preferences are app-scoped");
  assert.equal(app.stores.frames.getState().clipsWatched, true, "the Videos panel is still open");
  assert.equal(app.stores.frames.getState().clips, null);
  await switched;
  assert.equal(clock.pending(), 1, "only the new session's poll");
  assert.equal(app.stores.engine.getState().label, "s2");
});

test("a start that finishes after another open began is disposed unseen", async () => {
  const { app, engine } = setup();
  const release = engine.hold();
  const first = app.actions.openSession({ opfs: "slow" });
  await settle();
  release();
  const second = app.actions.openSession({ opfs: "fast" });
  assert.equal(await first, null);
  assert.ok(await second);
  assert.equal(engine.opened[0]?.disposed, true);
  assert.equal(app.stores.engine.getState().label, "fast");
});

test("a start in flight across a close and a new open is disposed unseen", async () => {
  const { app, engine } = setup();
  const release = engine.hold();
  const first = app.actions.openSession({ opfs: "slow" });
  await settle();
  app.actions.closeSession();
  const second = app.actions.openSession({ opfs: "fast" });
  await settle();
  release();
  assert.equal(await first, null);
  assert.ok(await second);
  assert.equal(engine.opened[0]?.disposed, true);
  assert.equal(engine.opened[1]?.disposed, false);
  assert.equal(app.stores.engine.getState().label, "fast");
});

test("a start in flight when the session closes is disposed unseen", async () => {
  const { app, engine } = setup();
  const release = engine.hold();
  const first = app.actions.openSession({ opfs: "slow" });
  await settle();
  app.actions.closeSession();
  release();
  assert.equal(await first, null);
  assert.equal(engine.opened[0]?.disposed, true);
  assert.equal(app.stores.engine.getState().session, null);
});

test("a thumbnail still being made when the session closes is revoked when it arrives", async () => {
  const { app, img } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.requestThumbs(); // thumbs load one at a time, so most are still queued
  app.actions.closeSession();
  await settle(30);
  assert.ok(img.urls.every((u) => u.revoked));
  assert.equal(app.assets.thumbs.size(), 0);
});

test("busy is a queue: concurrent actions don't clear each other's entry", async () => {
  const { app, engine } = setup({ handlers: sessionHandlers({ undo: () => ({}), redo: () => ({}) }) });
  await app.actions.openSession({ opfs: "s1" });
  const release = engine.hold();
  const a = app.actions.undo();
  const b = app.actions.redo();
  assert.deepEqual(
    app.stores.notices.getState().busy.map((t) => t.label),
    ["Undo", "Redo"],
  );
  release();
  await a;
  await b;
  assert.equal(app.stores.notices.getState().busy.length, 0);
});

test("engine errors arrive as values and become notices; the action resolves undefined", async () => {
  const { app } = setup({
    handlers: sessionHandlers({
      "obj.label": () => {
        throw new UserError("no object o9");
      },
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  assert.equal(await app.actions.rename("o9", "x"), undefined);
  assert.deepEqual(
    app.stores.notices.getState().notices.map((n) => [n.text, n.info]),
    [["no object o9", false]],
  );
  assert.equal(app.stores.notices.getState().busy.length, 0);
});

test("calls of a disposed session fail quietly (no notice)", async () => {
  const { app, engine } = setup({ handlers: sessionHandlers({ undo: () => ({}) }) });
  await app.actions.openSession({ opfs: "s1" });
  const release = engine.hold();
  const u = app.actions.undo();
  engine.opened[0]!.disposed = true;
  release();
  await u;
  assert.equal(app.stores.notices.getState().notices.length, 0);
});

test("frames: setFrame snaps to the nearest keyframe across a gap; stepping skips it", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.setFrame(4);
  assert.equal(app.stores.frames.getState().current, 5);
  app.actions.setFrame(3);
  assert.equal(app.stores.frames.getState().current, 2);
  app.actions.stepFrame(1);
  assert.equal(app.stores.frames.getState().current, 5);
  app.actions.stepFrame(-Infinity);
  assert.equal(app.stores.frames.getState().current, 0);
  app.actions.stepFrame(Infinity);
  assert.equal(app.stores.frames.getState().current, 6);
});

test("visible: one region per object, todo above the threshold collapsed by aliases, rejects on request", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.setFrame(0);
  const ids = () => app.select.visible().map((v) => `${v.kind}:${v.det.id}`);
  assert.deepEqual(ids(), ["object:0.1", "todo:0.2", "todo:0.3"]);
  await app.actions.loadMasks(0); // loads the alias sets, where 0.3 is the same region as 0.2
  assert.deepEqual(ids(), ["object:0.1", "todo:0.2"]);
  app.actions.setThreshold(0.3);
  assert.deepEqual(ids(), ["object:0.1", "todo:0.2", "todo:0.4"]);
  app.actions.setLayer("rejects", true);
  app.actions.setLayer("objects", false);
  assert.deepEqual(ids(), ["todo:0.2", "todo:0.4", "reject:0.5"]);
});

test("selectors are memoised: unrelated changes (hover) keep the same reference", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  const v1 = app.select.visible();
  const p1 = app.select.presenceFrames();
  app.actions.setHover("0.2");
  app.actions.setPrompt("lid");
  assert.equal(app.select.visible(), v1);
  assert.equal(app.select.presenceFrames(), p1);
  app.actions.setThreshold(0.1);
  assert.notEqual(app.select.visible(), v1);
});

test("focus and presence: the selected object, else the first selected detection's; focusObject jumps", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  app.actions.select(["0.2", "1.0"]);
  assert.equal(app.select.focusObj(), "o1");
  assert.deepEqual([...app.select.presenceFrames()].sort(), [0, 1]);
  app.actions.setFrame(5);
  app.actions.focusObject("o1");
  assert.equal(app.stores.frames.getState().current, 0, "went to the best view (0.1)");
  assert.deepEqual(app.stores.selection.getState().ids, []);
  app.actions.clearSelection();
  assert.equal(app.select.focusObj(), null);
  assert.equal(app.select.presenceFrames().size, 0);
});

test("find: one frame per call holding the scope, the shown frame first, results refreshed, cancellable", async () => {
  const { app, engine } = setup({
    handlers: sessionHandlers({ find: (i: { frames: string }) => ({ hits: i.frames === "5" ? [1, 2] : [1] }) }),
  });
  await app.actions.openSession({ opfs: "s1" });
  app.actions.setFrame(5);
  const r = await app.actions.find(" jar ", "all");
  assert.deepEqual(r, { hits: 6, frames: 5, cancelled: false });
  const order = engine.calls.filter((c) => c.path === "find").map((c) => (c.input as { frames: string }).frames);
  assert.deepEqual(order, ["5", "6", "2", "1", "0"]);
  const holds = engine.calls.filter((c) => c.path === "find").map((c) => (c.input as { hold?: string }).hold);
  assert.deepEqual(holds, Array(5).fill("0-2,5-6"), "each call holds the whole scope from disk-budget eviction");
  assert.equal(app.stores.notices.getState().busy.length, 0);

  const release = engine.hold();
  const p = app.actions.find("jar", "0-2");
  const task = app.stores.notices.getState().busy[0];
  assert.ok(task);
  assert.ok(task.label.startsWith("Finding") && task.cancellable);
  app.actions.cancelTask(task.id);
  release();
  const c = await p;
  assert.equal(c?.cancelled, true);
  assert.ok((c?.hits ?? 0) <= 1);
});

test("triage: a group becomes the selection at its clearest view; the label follows it", async () => {
  const { app } = setup({
    handlers: sessionHandlers({
      todo: (i: { offset: number }) =>
        i.offset > 0
          ? { total: 2, groups_total: 1, image: null, groups: [] }
          : { total: 2, groups_total: 1, image: null, groups: [{ group: "g0", ids: ["5.0", "0.2"], frames: "0-5" }] },
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.startTriage();
  assert.deepEqual(app.stores.selection.getState().ids, ["5.0", "0.2"]);
  assert.equal(app.stores.frames.getState().current, 5);
  assert.equal(app.stores.triage.getState().newLabel, "jar");
  assert.equal(app.stores.triage.getState().page?.groupsTotal, 1);
  await app.actions.skipGroup(1); // past the end, so back to the last group
  assert.equal(app.stores.triage.getState().page?.offset, 0);
  app.actions.stopTriage();
  assert.equal(app.stores.triage.getState().page, null);
  assert.deepEqual(app.stores.selection.getState().ids, []);
});

test("selection reaction: objects are ranked for a new selection; an edit clears the ranking", async () => {
  const { app } = setup({ handlers: sessionHandlers({ "obj.add": () => ({}) }) });
  await app.actions.openSession({ opfs: "s1" });
  app.actions.select(["0.2"]);
  await settle();
  assert.equal(app.stores.selection.getState().matches?.list[0]?.obj, "o1");
  assert.equal(app.stores.triage.getState().newLabel, "jar");
  await app.actions.assign("o1");
  await settle();
  // re-ranked for the same selection after the edit cleared it
  assert.equal(app.stores.selection.getState().matches?.key, "0.2");
});

test("removeClip: confirm first; then selection, masks and assets of the clip are dropped", async () => {
  let removed = false;
  const base = sessionHandlers();
  const run = (f: number) => ({ frame: f, prompt: "jar", semantic: `eyespy-store:sem/${f}-jar.png` });
  const { app, img } = setup({
    handlers: sessionHandlers({
      "clips.remove": () => ((removed = true), { frames: [5, 6] }),
      "data.runs": () => ({ runs: removed ? [run(0)] : [run(0), run(5)] }),
      "data.frames": () => ({ frames: (removed ? [0, 1, 2] : [0, 1, 2, 5, 6]).map(frame) }),
      "data.dets": (i: { mask?: string; frames?: string }) => {
        const all = base["data.dets"]!(i as never, { path: "", session: 0 }) as { dets: { frame: number }[] };
        return removed ? { dets: all.dets.filter((d) => d.frame < 5) } : all;
      },
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.frameBitmap(5);
  await app.actions.frameBitmap(0);
  await app.actions.loadMasks(5);
  await app.assets.heat.load("sem/0-jar.png");
  await app.assets.heat.load("sem/5-jar.png");
  app.actions.select(["5.0", "0.2"]);
  const clip = { key: "kb", name: "b.mp4", frames: [5, 6], detections: 1, objects: 0 } as never;
  const p = app.actions.removeClip(clip);
  const ask = app.stores.notices.getState().confirm;
  assert.ok(ask);
  assert.ok(ask.message.startsWith("Remove b.mp4 (keyframes #5–#6)"));
  ask.answer(true);
  await p;
  assert.deepEqual(app.stores.selection.getState().ids, ["0.2"]);
  assert.equal(app.stores.detections.getState().masks.has("5.0"), false);
  assert.equal(app.stores.detections.getState().maskFrames.has(5), false);
  assert.equal(app.assets.bitmaps.peek("clips/kb/frames/5.jpg"), undefined);
  assert.ok(app.assets.bitmaps.peek("clips/ka/frames/0.jpg"));
  assert.equal(img.made.find((b) => b.key.endsWith("/5.jpg"))?.closed, true);
  // a later find on a revived keyframe writes its heatmap under the same key, so the old bitmap must not stay
  assert.equal(app.assets.heat.peek("sem/5-jar.png"), undefined);
  assert.ok(app.assets.heat.peek("sem/0-jar.png"));
});

test("events: downloads tracked, failure logs become notices, the log tail is bounded", async () => {
  const { app, engine } = setup();
  await app.actions.openSession({ opfs: "s1" });
  const onEvent = engine.opened[0]!.req.onEvent;
  onEvent({ kind: "download", name: "m.onnx", loaded: 1, total: 2, done: false, source: "network" });
  assert.deepEqual(app.stores.engine.getState().downloads["m.onnx"], {
    loaded: 1,
    total: 2,
    done: false,
    source: "network",
  });
  onEvent({ kind: "log", text: "find failed: boom\nstack" });
  assert.equal(app.stores.notices.getState().notices.at(-1)?.text, "find failed: boom");
  for (let k = 0; k < 250; k++) onEvent({ kind: "log", text: `line ${k}` });
  assert.equal(app.stores.engine.getState().logs.length, 200);
  await app.actions.openSession({ opfs: "s2" });
  onEvent({ kind: "log", text: "background: stale" });
  assert.ok(!app.stores.notices.getState().notices.some((n) => n.text.includes("stale")));
});

/** A session whose add fails the way the worker's WebVideo does for an undecodable video: the event, then the Err. */
function undecodable() {
  const video = { file: "IMG_1.MOV", codec: "hvc1.2.4.L123.B0", codecName: "HEVC/H.265", reason: "no decoder" };
  const s = setup({
    handlers: sessionHandlers({
      add: async () => {
        s.engine.opened.at(-1)!.req.onEvent({ kind: "unsupported", ...video });
        throw new UserError("IMG_1.MOV: no decoder.");
      },
    }),
  });
  return { ...s, video, file: new File([new Uint8Array(4)], "IMG_1.MOV") };
}

test("a video the browser can't decode: only the can't-decode dialog (no notice), the add fails, Close shuts it", async () => {
  const { app, video, file } = undecodable();
  await app.actions.openSession({ opfs: "s1" });
  assert.equal(app.stores.notices.getState().unsupported, null);
  assert.equal(await app.actions.addVideo(file), "unsupported");
  assert.deepEqual(app.stores.notices.getState().unsupported, video);
  assert.deepEqual(app.stores.notices.getState().notices, []);
  assert.equal(app.stores.notices.getState().busy.length, 0);
  app.actions.closeUnsupported();
  assert.equal(app.stores.notices.getState().unsupported, null);
});

test("other add failures are still notices", async () => {
  const { app } = setup({
    handlers: sessionHandlers({
      add: async () => {
        throw new UserError("a.mp4: disk full");
      },
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  assert.equal(await app.actions.addVideo(new File([new Uint8Array(4)], "a.mp4")), "failed");
  assert.equal(app.stores.notices.getState().unsupported, null);
  assert.match(app.stores.notices.getState().notices.at(-1)?.text ?? "", /disk full/);
});

test("new session from an undecodable video: the dialog, the previous session again, the new one deleted", async () => {
  const { app, engine, storage, video, file } = undecodable();
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.newSessionFromVideo(file);
  assert.deepEqual(
    engine.opened.map((o) => [o.req.session, o.disposed]),
    [
      [{ opfs: "s1" }, true],
      [{ opfs: "IMG_1" }, true],
      [{ opfs: "s1" }, false],
    ],
  );
  assert.deepEqual(storage.deleted, ["IMG_1"]);
  assert.deepEqual(app.stores.engine.getState().location, { opfs: "s1" });
  assert.equal(app.stores.engine.getState().phase, "ready");
  assert.deepEqual(app.stores.notices.getState().unsupported, video);
  assert.deepEqual(app.stores.notices.getState().notices, []);
});

test("new session from a video that adds fine keeps the session", async () => {
  const { app, storage } = setup({ handlers: sessionHandlers({ add: () => ({ first: 0, keyframes: 1 }) }) });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.newSessionFromVideo(new File([new Uint8Array(4)], "ok.mp4"));
  assert.deepEqual(app.stores.engine.getState().location, { opfs: "ok" });
  assert.deepEqual(storage.deleted, []);
});

test("notices: a few kept, notes dismiss themselves", async () => {
  const { app, clock } = setup();
  for (let k = 0; k < 7; k++) app.actions.notify(`e${k}`);
  assert.deepEqual(
    app.stores.notices.getState().notices.map((n) => n.text),
    ["e2", "e3", "e4", "e5", "e6"],
  );
  app.actions.notify("note", true);
  assert.equal(app.stores.notices.getState().notices.at(-1)?.text, "note");
  clock.advance(12_000);
  assert.ok(!app.stores.notices.getState().notices.some((n) => n.text === "note"));
});

test("poll: refreshes status and frames while encoding, skipped while busy", async () => {
  let encoded = 2;
  const { app, clock, engine } = setup({
    handlers: sessionHandlers({
      status: () => ({
        keyframes: 5,
        encoded,
        detections: 0,
        objects: 0,
        todo: 0,
        assigned: 0,
        rejected: 0,
        prompts: [],
      }),
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  const polls = () => engine.calls.filter((c) => c.path === "status").length;
  const before = polls();
  encoded = 5;
  clock.advance(2500);
  await settle();
  assert.equal(polls(), before + 1);
  assert.equal(app.stores.engine.getState().status?.encoded, 5);
  clock.advance(2500);
  await settle();
  assert.equal(polls(), before + 1, "done encoding: no more polls");
});

test("settings: preferences persist; the detector URL parameter wins", async () => {
  const { app, storage } = setup({ prefs: { detector: "fp32", persistFeatures: "0" }, query: { detector: "fp16" } });
  assert.equal(app.stores.settings.getState().detector, "fp16");
  assert.equal(app.stores.settings.getState().persistFeatures, false);
  app.actions.setDetector("fp32");
  assert.equal(storage.prefs.data.detector, "fp32");
  await app.actions.setPersistFeatures(true);
  assert.equal(storage.prefs.data.persistFeatures, "1");
});

test("settings: features on disk with a 4 GB budget unless chosen otherwise; explicit choices are kept", async () => {
  const fresh = setup();
  assert.equal(fresh.app.stores.settings.getState().persistFeatures, true, "default on (a profile that never chose)");
  assert.equal(fresh.app.stores.settings.getState().featureDiskMB, 4096);
  assert.equal(fresh.app.stores.settings.getState().featureCacheMB, 2048);
  await fresh.app.actions.openSession({ opfs: "s1" });
  const req = fresh.engine.opened[0]?.req;
  assert.deepEqual([req?.persistFeatures, req?.featureDiskMB, req?.featureCacheMB], [true, 4096, 2048]);
  assert.deepEqual(
    Object.keys(fresh.storage.prefs.data).filter((k) => !(k in AGREED)),
    ["session"],
    "defaults write no preference",
  );
  const off = setup({ prefs: { persistFeatures: "0" } });
  assert.equal(off.app.stores.settings.getState().persistFeatures, false, "a profile that turned it off keeps it");
  await off.app.actions.openSession({ opfs: "s1" });
  assert.equal(off.engine.opened[0]?.req.persistFeatures, false);
  const chose = setup({ prefs: { persistFeatures: "1", featureCacheMB: "4096", featureDiskMB: "unlimited" } });
  assert.equal(chose.app.stores.settings.getState().persistFeatures, true, "a profile that turned it on keeps it");
  await chose.app.actions.openSession({ opfs: "s1" });
  assert.deepEqual(
    [chose.engine.opened[0]?.req.persistFeatures, chose.engine.opened[0]?.req.featureCacheMB],
    [true, 4096],
  );
  assert.equal(chose.engine.opened[0]?.req.featureDiskMB, null, "unlimited");
  for (const [stored, mb] of [
    ["8192", 8192],
    ["16384", 16384],
    ["1000", 4096], // not offered, so the default
    ["junk", 4096],
  ] as const)
    assert.equal(setup({ prefs: { featureDiskMB: stored } }).app.stores.settings.getState().featureDiskMB, mb, stored);
  chose.app.actions.setFeatureCacheMB(1000); // not offered, so the default
  assert.equal(chose.storage.prefs.data.featureCacheMB, "2048");
  assert.equal(setup({ prefs: { featureCacheMB: "junk" } }).app.stores.settings.getState().featureCacheMB, 2048);
});

test("settings: the disk budget is kept and applied to the open session at once (no reopen)", async () => {
  const { app, engine, storage } = setup({
    handlers: sessionHandlers({ features: () => ({ evicted: 7, persist: true, stored: 3 }) }),
  });
  assert.equal(await app.actions.setFeatureDiskMB(1024), 0, "no session open: only the preference");
  assert.equal(storage.prefs.data.featureDiskMB, "1024");
  await app.actions.openSession({ opfs: "s1" });
  assert.equal(engine.opened[0]?.req.featureDiskMB, 1024);
  const lists = engine.calls.filter((c) => c.path === "clips.list").length;
  assert.equal(await app.actions.setFeatureDiskMB(2048), 7);
  assert.deepEqual(engine.calls.filter((c) => c.path === "features").at(-1)?.input, { diskMB: 2048 });
  assert.ok(engine.calls.filter((c) => c.path === "clips.list").length > lists, "the Videos panel's sizes reloaded");
  await app.actions.setFeatureDiskMB(null);
  assert.deepEqual(engine.calls.filter((c) => c.path === "features").at(-1)?.input, { diskMB: "unlimited" });
  assert.equal(storage.prefs.data.featureDiskMB, "unlimited");
  assert.equal(app.stores.settings.getState().featureDiskMB, null);
});

test("storage persistence: asked once on the first open; the answer is in settings; ask again on demand", async () => {
  const { app, storage } = setup();
  assert.equal(app.stores.settings.getState().persisted, null);
  await app.actions.openSession({ opfs: "s1" });
  await settle();
  assert.equal(storage.persistCalls, 1);
  assert.equal(app.stores.settings.getState().persisted, false);
  await app.actions.openSession({ opfs: "s2" });
  await settle();
  assert.equal(storage.persistCalls, 1, "not again on the next open");
  storage.grant = true;
  assert.equal(await app.actions.requestPersist(), true);
  assert.equal(app.stores.settings.getState().persisted, true);
});

test("drop features: one clip's through the engine, the open session's through the engine, another's directly", async () => {
  const { app, engine, storage } = setup({
    handlers: sessionHandlers({ features: () => ({ cleared: 3, persist: false, stored: 0 }) }),
  });
  await app.actions.openSession({ opfs: "s1" });
  const clip = { key: "ka", name: "a.mp4" } as Parameters<typeof app.actions.dropClipFeatures>[0]; // brand stand-in
  assert.equal(await app.actions.dropClipFeatures(clip), 3);
  assert.deepEqual(engine.calls.filter((c) => c.path === "features").at(-1)?.input, { clear: true, clip: "ka" });
  assert.ok(engine.calls.filter((c) => c.path === "clips.list").length >= 2, "the Videos panel's sizes reloaded");
  assert.equal(await app.actions.dropSessionFeatures("s1"), 3);
  assert.deepEqual(engine.calls.filter((c) => c.path === "features").at(-1)?.input, { clear: true });
  assert.deepEqual(storage.cleared, []);
  assert.equal(await app.actions.dropSessionFeatures("other"), 1);
  assert.deepEqual(storage.cleared, ["other"]);
});

test("storageSummary: the open OPFS session is marked; features vs the rest", async () => {
  const { app } = setup();
  await app.actions.openSession({ opfs: "s1" });
  const s = await app.actions.storageSummary();
  assert.deepEqual(
    s?.sessions.map((x) => [x.name, x.open, x.features, x.other]),
    [
      ["s1", true, 200, 100],
      ["other", false, 0, 10],
    ],
  );
  assert.equal(s?.features, 200);
});

test("setSetting: a session setting through the config op; the threshold also moves the slider", async () => {
  const { app, engine } = setup({
    handlers: sessionHandlers({
      config: (i: { key?: string; value?: number }) => ({ config: { threshold: i.key ? Number(i.value) : 0.5 } }),
    }),
  });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.setSetting("threshold", 0.7);
  assert.deepEqual(engine.calls.filter((c) => c.path === "config").at(-1)?.input, { key: "threshold", value: 0.7 });
  assert.equal(app.stores.engine.getState().config.threshold, 0.7);
  assert.equal(app.stores.layers.getState().threshold, 0.7);
});

test("export: the manifest without its image ref goes to a download", async () => {
  const { app, host } = setup({
    handlers: sessionHandlers({ manifest: () => ({ objects: [1], image: "eyespy-store:out/x.jpg" }) }),
  });
  await app.actions.openSession({ opfs: "s1" });
  await app.actions.exportManifest();
  assert.equal(host.downloads[0]?.name, "eyespy-s1-manifest.json");
  assert.deepEqual(JSON.parse(host.downloads[0]?.text ?? ""), { objects: [1] });
});

test("dets helper sanity", () => {
  assert.equal(det("12.3").frame, 12);
});

test("toSpec: keyframe numbers as runs, sorted, once each (parseSpec reads it back)", () => {
  assert.equal(toSpec([5, 0, 1, 2, 9, 2]), "0-2,5,9");
  assert.equal(toSpec([7]), "7");
  assert.equal(toSpec([]), "");
  const fr = [0, 1, 2, 5, 6].map(frame);
  assert.deepEqual(parseSpec(toSpec([6, 0, 1, 5]), fr)._unsafeUnwrap(), [0, 1, 5, 6]);
});

test("parseSpec: core's frame specs over the existing keyframes, in spec order, once each", () => {
  const fr = [0, 1, 2, 5, 6].map(frame);
  assert.deepEqual(parseSpec("0-5,9", fr)._unsafeUnwrap(), [0, 1, 2, 5]);
  assert.deepEqual(parseSpec("6", fr)._unsafeUnwrap(), [6]);
  assert.deepEqual(parseSpec("2,1,2", fr)._unsafeUnwrap(), [2, 1]);
  assert.deepEqual(parseSpec("3-4", fr)._unsafeUnwrap(), [], "a removed clip's gap");
  assert.deepEqual(parseSpec("", fr)._unsafeUnwrap(), [0, 1, 2, 5, 6], "empty is every frame (as the CLI)");
  // junk parts, "1-" and "2-0" are errors (core's rules)
  for (const [spec, part] of [
    ["x,4", "x"],
    ["1-", "1-"],
    ["2-0", "2-0"],
    ["0,,1", "0,,1"],
  ] as const)
    assert.deepEqual(parseSpec(spec, fr)._unsafeUnwrapErr(), { kind: "bad-frame-spec", part }, spec);
});

test("find: a bad spec is a notice in the CLI's words; nothing is searched", async () => {
  const { app, engine } = setup({ handlers: sessionHandlers({ find: () => ({ hits: [] }) }) });
  await app.actions.openSession({ opfs: "s1" });
  assert.equal(await app.actions.find("jar", "1-"), undefined);
  assert.equal(engine.calls.filter((c) => c.path === "find").length, 0);
  assert.deepEqual(
    app.stores.notices.getState().notices.map((n) => n.text),
    ["bad frame spec: 1-"],
  );
});

test("masksOf: typed data.dets rows; rle masks kept with their aliases, png/none rows left out", () => {
  const rows = [
    { ...det("0.0"), mask: { format: "rle", w: 2, h: 1, counts: [1, 1] }, aliases: ["0.0", "0.1"] },
    { ...det("0.1"), mask: { format: "rle", w: 1, h: 1, counts: [0, 1] } },
    { ...det("0.2"), mask: { format: "png", w: 1, h: 1, image: "eyespy-store:out/masks/0.2.png" } },
    det("0.3"),
  ] as unknown as readonly DetRow[]; // test data: plain strings stand in for the brands
  const m = masksOf(rows);
  assert.deepEqual([...m.keys()], ["0.0", "0.1"]);
  assert.deepEqual(m.get("0.0")?.aliases, ["0.0", "0.1"]);
  assert.deepEqual(m.get("0.1")?.aliases, [], "no aliases asked for");
  assert.deepEqual(m.get("0.0")?.rle.counts, [1, 1]);
});
