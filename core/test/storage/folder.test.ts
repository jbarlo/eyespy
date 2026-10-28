import assert from "node:assert/strict";
import { test } from "node:test";
import type { Detection } from "../../src/detections/pure.ts";
import type { Obj, Objects, Owner } from "../../src/labelling/pure.ts";
import type { Clip, ClipKey, FrameNo, FrameRef } from "../../src/video/pure.ts";
import type { SessionMeta } from "../../src/session/ports.ts";
import { createSessionFolder } from "../../src/storage/index.ts";
import { SESSION_FILE, SESSION_MARKER, emptySessionJson, parseMetaText } from "../../src/storage/pure.ts";
import { EMPTY_SESSION_JSON, MemStore } from "../fakes/index.ts";
import { EMPTY, REAL, RecordingStore, TestClock, must, opened, sessionJson, storeWith } from "./helpers.ts";

const KEY = "0a1b2c3d4e01" as ClipKey;
const clip = (over: Partial<Clip> = {}): Clip => ({
  path: "/v/a.mp4",
  key: KEY,
  times: [0, 0.5],
  timing: { kind: "video" },
  shape: [120, 160],
  captured: null,
  keyframeThresh: 0.4,
  removed: null,
  reserved: new Map(),
  ...over,
});
const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  version: 1,
  config: {},
  clips: [],
  formats: { features: null },
  ...over,
});

test("marker helpers: emptySessionJson is what `eyespy init` writes and parses back", () => {
  assert.equal(emptySessionJson(), EMPTY_SESSION_JSON);
  assert.equal(SESSION_MARKER, ".eyespy");
  assert.equal(SESSION_FILE, "session.json");
  assert.deepEqual(parseMetaText(emptySessionJson())._unsafeUnwrap(), { ...meta(), nextObj: null });
});

test("open: no session.json is no-session (never created); bad JSON, schema and version are errors", async () => {
  const open = (files: Record<string, string>) =>
    createSessionFolder({ store: storeWith(files), clock: new TestClock() }).open();
  const none = new RecordingStore();
  assert.deepEqual((await createSessionFolder({ store: none, clock: new TestClock() }).open())._unsafeUnwrapErr(), {
    kind: "no-session",
    root: "mem",
  });
  assert.deepEqual(none.calls, []);
  assert.equal((await open({ "session.json": "{" }))._unsafeUnwrapErr().kind, "bad-session-json");
  assert.deepEqual((await open({ "session.json": '{"version": 2, "clips": []}' }))._unsafeUnwrapErr(), {
    kind: "unsupported-version",
    version: 2,
  });
  const badClip = JSON.stringify({ version: 1, clips: [{ path: "x", key: "nothex", times: [], shape: [1, 1] }] });
  assert.match(JSON.stringify((await open({ "session.json": badClip }))._unsafeUnwrapErr()), /clips\.0: key/);
  const badCfg = JSON.stringify({ version: 1, config: { threshold: "high" }, clips: [] });
  assert.deepEqual((await open({ "session.json": badCfg }))._unsafeUnwrapErr(), {
    kind: "bad-session-json",
    message: "config.threshold: not a number",
  });
  assert.equal(
    (await open({ "session.json": EMPTY, "objects.json": '{"o1": {"label": 3}}' }))._unsafeUnwrapErr().kind,
    "bad-record",
  );
  assert.equal(
    (await open({ "session.json": EMPTY, "runs.json": '{"nokey": {"ids": []}}' }))._unsafeUnwrapErr().kind,
    "bad-record",
  );
  const dets = JSON.stringify([{ id: "0.0", frame: 0, t: 0, run: "a", prompt: "a", score: 1, box: [0, 0, 1, 1] }]);
  assert.deepEqual((await open({ "session.json": EMPTY, "dets.json": dets }))._unsafeUnwrapErr(), {
    kind: "missing-detection-file",
    id: "0.0",
  });
});

test("open: an empty session gets the reject set, counter 1, empty history", async () => {
  const { records } = await opened(storeWith({ "session.json": EMPTY }));
  assert.deepEqual([...records.objects], [["x", { label: "(not an item)", members: [] }]]);
  assert.equal(records.nextObj, 1);
  assert.deepEqual(records.history, []);
  assert.deepEqual(records.runs, []);
});

test("MetaStore: fields in format order; unknown keys ignored and not written; config defaults dropped", async () => {
  const raw = {
    version: 1,
    zzz: { note: "not a session.json field" },
    clips: [{ captured: null, path: "/v/a.mp4", key: KEY, times: [0, 0.5], shape: [120, 160], extra: 7 }],
    config: { threshold: 0.5, knob: [1, 2] },
  };
  const store = storeWith({ "session.json": JSON.stringify(raw, null, 1) });
  const { folder, records } = await opened(store);
  assert.deepEqual(records.meta.config, { threshold: 0.5 });
  assert.equal(records.meta.clips[0]?.keyframeThresh, null);
  await must(
    folder.meta.write(
      meta({
        config: { threshold: 0.5, score_floor: 0.2 },
        clips: [
          records.meta.clips[0] ?? clip(),
          clip({ key: "0a1b2c3d4e02" as ClipKey, path: "/v/b.mov", captured: "2026" }),
        ],
        formats: { features: "F" },
      }),
    ),
  );
  assert.equal(
    store.text("session.json"),
    JSON.stringify(
      {
        version: 1,
        config: { score_floor: 0.2 },
        clips: [
          { path: "/v/a.mp4", key: KEY, times: [0, 0.5], shape: [120, 160], captured: null },
          {
            path: "/v/b.mov",
            key: "0a1b2c3d4e02",
            times: [0, 0.5],
            shape: [120, 160],
            captured: "2026",
            keyframe_thresh: 0.4,
          },
        ],
        // a session.json without next_obj gets the counter 1 with its next write
        next_obj: 1,
        features: "F",
      },
      null,
      1,
    ),
  );
});

test("MetaStore: fps <-> rate timing, stills: true <-> stills, neither = video (version stays 1)", async () => {
  const store = storeWith({ "session.json": EMPTY });
  const { folder } = await opened(store);
  const clips = [
    clip(),
    clip({ key: "0a1b2c3d4e02" as ClipKey, path: "/f/a", times: [0, 1.2], timing: { kind: "rate", fps: 4 } }),
    clip({ key: "0a1b2c3d4e03" as ClipKey, path: "/f/photos", times: [0, 1, 2], timing: { kind: "stills" } }),
  ];
  await must(folder.meta.write(meta({ clips })));
  const stored = sessionJson(store);
  assert.match(store.text("session.json") ?? "", /^\{\n "version": 1,/);
  const fields = stored.clips.map((c) => Object.keys(c).join(","));
  assert.deepEqual(fields, [
    "path,key,times,shape,captured,keyframe_thresh",
    "path,key,times,fps,shape,captured,keyframe_thresh",
    "path,key,times,stills,shape,captured,keyframe_thresh",
  ]);
  const { records } = await opened(store);
  assert.deepEqual(
    records.meta.clips.map((c) => c.timing),
    [{ kind: "video" }, { kind: "rate", fps: 4 }, { kind: "stills" }],
  );
  const both = { version: 1, clips: [{ path: "/f", key: KEY, times: [0], shape: [1, 1], fps: 4, stills: true }] };
  const bad = parseMetaText(JSON.stringify(both));
  assert.deepEqual(bad._unsafeUnwrapErr(), { kind: "bad-session-json", message: "clips.0: both fps and stills" });
});

test("MetaStore: removed <-> removed.at, next_n <-> reserved on every clip (a revived clip keeps it); re-removal", async () => {
  const store = storeWith({ "session.json": EMPTY });
  const { folder } = await opened(store);
  const reserved = new Map([
    [1 as FrameNo, 4],
    [0 as FrameNo, 2],
  ]);
  const stored = () => sessionJson(store).clips[0] as Record<string, unknown>;
  const order = ["path", "key", "times", "shape", "captured", "keyframe_thresh"];
  await must(folder.meta.write(meta({ clips: [clip({ removed: { at: 1792897278.293 }, reserved })] })));
  assert.deepEqual(Object.keys(stored()), [...order, "removed", "next_n"]);
  assert.deepEqual(stored().next_n, { "0": 2, "1": 4 });
  // after a revive, `removed` goes and next_n stays in place
  await must(folder.meta.write(meta({ clips: [clip({ reserved })] })));
  assert.deepEqual(Object.keys(stored()), [...order, "next_n"]);
  const reopened = await opened(store);
  assert.equal(reopened.records.meta.clips[0]?.removed, null);
  assert.deepEqual(
    [...(reopened.records.meta.clips[0]?.reserved ?? [])],
    [
      [0, 2],
      [1, 4],
    ],
  );
  // removed again: next_n changes in place and `removed` returns to its canonical place, not after next_n
  await must(
    reopened.folder.meta.write(meta({ clips: [clip({ removed: { at: 5 }, reserved: new Map([[0 as FrameNo, 3]]) })] })),
  );
  assert.deepEqual(Object.keys(stored()).slice(-2), ["removed", "next_n"]);
  assert.deepEqual(stored().next_n, { "0": 3 });
  // without counters there is no next_n
  await must(reopened.folder.meta.write(meta({ clips: [clip({ removed: { at: 5 } })] })));
  assert.equal(stored().next_n, undefined);
});

test("open: next_obj is the stored counter, or 1 when absent (written with the next save)", async () => {
  const fresh = storeWith({ "session.json": EMPTY });
  const { folder, records } = await opened(fresh);
  assert.equal(records.nextObj, 1);
  assert.equal(fresh.text("session.json"), EMPTY); // nothing written on open
  await must(folder.meta.write(meta()));
  assert.equal(sessionJson(fresh).next_obj, 1);
  const stored = storeWith({ "session.json": JSON.stringify({ version: 1, clips: [], next_obj: 4 }) });
  assert.equal((await opened(stored)).records.nextObj, 4);
});

test("LabelLog.commit: next_obj -> objects.json -> op line; ts from the clock; keys in union order; raw UTF-8", async () => {
  const store = storeWith({ "session.json": EMPTY });
  const clock = new TestClock(1792897236000);
  const { folder } = await opened(store, clock);
  store.calls = [];
  const objects: Objects = new Map<Owner, Obj>([
    ["x", { label: "(not an item)", members: [] }],
    ["o1" as Owner, { label: "второй jar (café)", members: ["0.1" as never] }],
  ]);
  // built in a scrambled key order on purpose
  const line = {
    diff: { o1: { add: ["0.1"], to: "второй jar (café)", from: null } },
    ids: ["0.1"],
    label: "второй jar (café)",
    obj: "o1",
    op: "new",
  } as never;
  const entry = await must(folder.labels.commit({ objects, nextObj: 2, line }));
  assert.deepEqual(store.calls, ["writeText session.json", "writeText objects.json", "appendText ops.jsonl"]);
  // whole-second ts without ".0" and non-ASCII unescaped
  assert.equal(
    store.text("ops.jsonl"),
    '{"ts": 1792897236, "op": "new", "obj": "o1", "label": "второй jar (café)", "ids": ["0.1"], "diff": {"o1": {"from": null, "to": "второй jar (café)", "add": ["0.1"]}}}\n',
  );
  assert.deepEqual(Object.keys(entry), ["ts", "op", "obj", "label", "ids", "diff", "seq"]);
  assert.equal(entry.seq, 0);
  assert.equal(sessionJson(store).next_obj, 2);
  assert.equal(store.text("objects.json"), JSON.stringify(Object.fromEntries(objects), null, 1));
  // with an unchanged counter, session.json stays untouched and seq continues
  store.calls = [];
  clock.ms += 1234;
  const e2 = await must(folder.labels.commit({ objects, nextObj: 2, line: { op: "reject", ids: [], diff: {} } }));
  assert.deepEqual(store.calls, ["writeText objects.json", "appendText ops.jsonl"]);
  assert.equal(e2.seq, 1);
  assert.equal(e2.ts, 1792897237.234);
});

test("LabelLog.commit: clip_remove line bytes; a failed step stops the rest and is a HostFailure value", async () => {
  const store = storeWith({ "session.json": EMPTY, "ops.jsonl": '{"op": "add"}' });
  const { folder, records } = await opened(store);
  await must(
    folder.labels.commit({
      objects: records.objects,
      nextObj: records.nextObj,
      line: {
        op: "clip_remove",
        clip: KEY,
        path: "/v/a.mp4",
        frames: [0 as FrameNo, 1 as FrameNo],
        deleted: [],
        changes: { x: { remove: ["0.1" as never] } },
      },
    }),
  );
  // the file had no trailing newline: the new line starts on its own line
  assert.equal(
    store.text("ops.jsonl"),
    '{"op": "add"}\n{"ts": 1767323045, "op": "clip_remove", "clip": "0a1b2c3d4e01", "path": "/v/a.mp4", "frames": [0, 1], "deleted": [], "changes": {"x": {"remove": ["0.1"]}}}\n',
  );
  store.failOn = "writeText objects.json";
  store.calls = [];
  const r = await folder.labels.commit({
    objects: records.objects,
    nextObj: 5,
    line: { op: "reject", ids: [], diff: {} },
  });
  assert.deepEqual(r._unsafeUnwrapErr(), {
    kind: "host",
    port: "store",
    op: "writeText",
    message: "disk full: objects.json",
  });
  assert.deepEqual(store.calls, ["writeText session.json", "writeText objects.json"]);
  // the failed commit wrote session.json first, so the next commit with the same counter doesn't rewrite it
  store.failOn = null;
  store.calls = [];
  const ok = await folder.labels.commit({
    objects: records.objects,
    nextObj: 5,
    line: { op: "reject", ids: [], diff: {} },
  });
  assert.equal(ok._unsafeUnwrap().seq, 2);
  assert.deepEqual(store.calls, ["writeText objects.json", "appendText ops.jsonl"]);
});

test("ops.jsonl parse: non-object lines are barriers, unknown lines kept as is, mistyped fields dropped", async () => {
  const log = [
    "not json",
    "[1, 2]",
    '{"ts": 1700000000.123456, "op": "new", "obj": "o1", "label": "\\u0432", "ids": ["0.0"]}',
    '{"op": "add", "diff": {"o1": {"add": [5]}}, "extra": {"a": 1}}',
    "",
    '{"op": 3, "ts": "noon"}',
  ].join("\n");
  const { records } = await opened(storeWith({ "session.json": EMPTY, "ops.jsonl": log }));
  assert.deepEqual(records.history, [
    { op: "?", seq: 0 },
    { op: "?", seq: 1 },
    { ts: 1700000000.123456, op: "new", obj: "o1", label: "в", ids: ["0.0"], seq: 2 },
    { op: "add", extra: { a: 1 }, seq: 3 },
    { op: "?", seq: 4 },
  ]);
});

test("frames, features, outputs, masks, heatmaps, clip files: keys, locators, missing = null", async () => {
  const store = storeWith({ "session.json": EMPTY });
  const { folder } = await opened(store);
  const ref: FrameRef = { clipKey: KEY, index: 7 };
  assert.equal(await must(folder.frames.read(ref)), null);
  assert.equal(await must(folder.frames.has(ref)), false);
  await must(folder.frames.write(ref, Uint8Array.of(1, 2)));
  assert.equal(folder.frames.locate(ref), `clips/${KEY}/frames/007.jpg`);
  assert.equal(await must(folder.frames.size(ref)), 2);
  await must(folder.features.write({ clipKey: KEY, index: 1234 }, Uint8Array.of(9)));
  assert.ok(store.files.has(`clips/${KEY}/feat/1234.f16`));
  assert.equal(await must(folder.features.has({ clipKey: KEY, index: 1234 })), true);
  await must(folder.features.remove({ clipKey: KEY, index: 1234 }));
  assert.equal(await must(folder.features.size({ clipKey: KEY, index: 1234 })), null);
  assert.equal(await must(folder.outputs.writeImage("find-jar", Uint8Array.of(1))), "out/find-jar.jpg");
  assert.equal(await must(folder.detections.maskImage("3.1" as never)), null);
  assert.equal(await must(folder.detections.writeMaskImage("3.1" as never, Uint8Array.of(1))), "out/masks/3.1.png");
  assert.equal(await must(folder.detections.maskImage("3.1" as never)), "out/masks/3.1.png");
  // heatmap names exactly as the fixtures have them
  const ref2 = await must(folder.heatmaps.write(0 as FrameNo, "jar", Uint8Array.of(5)));
  assert.equal(ref2, "0000-f92e777f43.png");
  assert.equal(folder.heatmaps.locate(ref2), "sem/0000-f92e777f43.png");
  assert.deepEqual(await must(folder.heatmaps.read(ref2)), Uint8Array.of(5));
  await must(folder.heatmaps.remove(ref2));
  assert.equal(await must(folder.heatmaps.read(ref2)), null);
  await must(folder.removeClipFiles(KEY));
  assert.deepEqual(
    [...store.files.keys()].filter((k) => k.startsWith("clips/")),
    [],
  );
});

test("detections: writeDetection/removeDetection keys; region runs round-trip; any other run string is a bad-record", async () => {
  const store = MemStore.fromDir(REAL);
  const { folder, records } = await opened(store, new TestClock());
  const d0 = records.detections[0]!;
  const region: Detection = { ...d0, id: "0.99" as never, region: [10, 20, 300, 400], prompt: "lid" };
  await must(folder.detections.writeDetection(region));
  await must(folder.detections.writeIndex([...records.detections, region], records.runs));
  const written = JSON.parse(store.text("dets.json")) as { id: string; run: string }[];
  assert.equal(written.find((m) => m.id === "0.99")?.run, "lid@10,20,300,400");
  const again = await opened(store);
  assert.deepEqual(again.records.detections.at(-1)?.region, [10, 20, 300, 400]);
  await must(folder.detections.removeDetection("0.99" as never));
  assert.ok(!store.files.has("dets/0.99.npz"));

  const other = { id: "0.98", frame: 0, t: 0, run: "box:1,2,3,4:lid", prompt: "lid", score: 0.5, box: d0.box };
  store.files.set("dets.json", new TextEncoder().encode(JSON.stringify([...written.slice(0, -1), other], null, 1)));
  store.files.set("dets/0.98.npz", store.files.get(`dets/${d0.id}.npz`)!);
  const refused = await createSessionFolder({ store, clock: new TestClock() }).open();
  assert.deepEqual(refused._unsafeUnwrapErr(), {
    kind: "bad-record",
    file: "dets.json",
    message: '0.98: run "box:1,2,3,4:lid" is not a run of prompt "lid"',
  });
});
