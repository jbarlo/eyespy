/** Pins the text agents parse, row by row. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outputs } from "eyespy-core/api";
import { hitLine, hitsBlock, json, objLine, ranges, reply } from "../src/format/index.ts";
import type { Hit, Obj } from "../src/format/index.ts";

// only validation makes brands (DetId, FrameNo, ObjectId), so fixtures cast through `never` once, here
const hit = (o: object): Hit => ({ prompts: ["jar"], area: 100, ...o }) as never;
const H1 = hit({ id: "3.1", frame: 3, t: 1.25, score: 0.876, box: [10, 20, 110, 220] });
const H2 = hit({
  id: "12.10",
  frame: 12,
  t: 10,
  score: 0.5,
  box: [0, 0, 5, 5],
  prompts: ["jar", "glass jar"],
  object: "o1",
});
const OBJ: Obj = {
  id: "o1",
  label: "glass jar",
  sightings: 2,
  members: ["3.1", "12.10"],
  first_t: 1.25,
  last_t: 10,
  best: "3.1",
  prompts: { jar: 0.876, "glass jar": 0.5 },
} as never;
const EMPTY_OBJ: Obj = {
  ...OBJ,
  id: "o12",
  sightings: 0,
  members: [],
  first_t: null,
  last_t: null,
  best: null,
  prompts: {},
} as never;

test("rows", () => {
  assert.equal(hitLine(H1), "3.1       1.3s  0.88  [10,20,110,220]         jar");
  assert.equal(hitLine({ ...H1, t: 3, photo: true }), "3.1     photo 3  0.88  [10,20,110,220]         jar");
  assert.equal(hitLine(H2), "12.10    10.0s  0.50  [0,0,5,5]               jar, glass jar  → o1");
  assert.equal(hitLine({ ...H1, prompts: [], sim: 0.4567 }), "3.1       1.3s  0.88  [10,20,110,220]         sim=0.46");
  assert.equal(objLine(OBJ), "o1    glass jar  (2 sightings, 1.3–10.0s, best 3.1)  [jar 0.88, glass jar 0.50]");
  assert.equal(objLine(EMPTY_OBJ), "o12   glass jar  (0 sightings, undefined–undefineds, best null)  []");
  assert.equal(ranges([1, 2, 3, 7, 9, 10]), "1-3,7,9-10");
  assert.equal(ranges([]), "");
  assert.equal(ranges([4, 4]), "4,4");
});

test("hits blocks and --json", () => {
  assert.equal(hitsBlock({ hits: [], image: null }), "(no detections)");
  assert.equal(hitsBlock({ hits: [H1], image: "/s/out.jpg" }, "head"), `head\n${hitLine(H1)}\nimage: /s/out.jpg`);
  assert.equal(hitsBlock({ image: "/s/gaps.jpg" }), "image: /s/gaps.jpg");
  assert.equal(json({ a: 1 }), '{\n "ok": true,\n "a": 1\n}');
});

test("find, search, semantic, sheet", () => {
  const find: Outputs["find"] = {
    prompt: "jar",
    seconds: 1.5,
    presence: { 0: 0.9, 1: 0.1, 2: 0.8, 3: 0.7 },
    present: [0, 2, 3],
    image: "/s/f.jpg",
    hits: [H1, H2],
  } as never;
  assert.equal(
    reply.find(find, "jar"),
    `"jar": 2 hits on 2 frames in 1.5s\npresent on 3/4 frames: 0,2-3\n${hitLine(H1)}\n${hitLine(H2)}\nimage: /s/f.jpg`,
  );
  const search: Outputs["search"] = {
    frame: 3,
    box: [1, 2, 3, 4],
    prompt: "lid",
    presence: 0.42,
    hits: [H1],
    similar: [{ ...H2, sim: 0.7 }],
  } as never;
  assert.equal(
    reply.search(search),
    `region 1,2,3,4 on #3 (cropped and upscaled)\n"lid": 1 hits, presence 0.42\n${hitLine(H1)}\nlooks like:\n` +
      `${hitLine({ ...H2, sim: 0.7 })}  sim 0.70`,
  );
  const sem: Outputs["semantic"] = {
    prompt: "jar",
    image: "/s/h.jpg",
    area: { 0: 0.12345 },
    presence: { 0: 0.5 },
  };
  assert.equal(reply.semantic(sem), "#0    presence 0.50  active 12.3% of frame\nimage: /s/h.jpg");
  const sheet: Outputs["sheet"] = {
    image: "/s/sheet.jpg",
    frames: [
      { frame: 0, t: 0 },
      { frame: 1, t: 2.5 },
    ],
  } as never;
  assert.equal(reply.sheet(sheet), "#0=0.0s #1=2.5s\nimage: /s/sheet.jpg");
  const photos: Outputs["sheet"] = {
    image: "/s/sheet.jpg",
    frames: [
      { frame: 0, t: 0 },
      { frame: 54, t: 0, photo: true },
    ],
  } as never;
  assert.equal(reply.sheet(photos), "#0=0.0s #54=photo 0\nimage: /s/sheet.jpg");
});

test("videos: added, clips, status, config", () => {
  assert.equal(
    reply.added({ clip: "a.mov", keyframes: 53, first: 0, captured: "2026-01-01", revived: false } as never),
    "added a.mov: keyframes #0–#52, captured 2026-01-01; encoding in background",
  );
  assert.equal(
    reply.added({ clip: "b.mov", keyframes: 1, first: 53, captured: null, revived: true } as never),
    "re-added (removed earlier; same keyframe numbers) b.mov: keyframes #53–#53; encoding in background",
  );
  const clips: Outputs["clips.list"] = {
    clips: [
      {
        key: "0123456789ab",
        path: "/v/a.mov",
        name: "a.mov",
        captured: null,
        keyframes: 53,
        frames: [0, 52],
        encoded: 53,
        detections: 12,
        objects: 2,
        frame_bytes: 2 ** 20,
        feature_bytes: 5 * 2 ** 20,
      },
      {
        key: "ba9876543210",
        path: "/v/b.mov",
        name: "b.mov",
        captured: "2026-01-01",
        keyframes: 1,
        frames: [53, 53],
        encoded: 0,
        detections: 0,
        objects: 0,
        frame_bytes: 0,
        feature_bytes: 0,
        removed: 1,
      },
    ],
  } as never; // brands (ClipKey, FrameNo)
  assert.equal(
    reply.clipsTable(clips),
    "0123456789ab  #0–#52     53 keyframes   12 dets, 2 objects, 6 MB              -  /v/a.mov\n" +
      "ba9876543210  #53–#53    1 keyframes    removed                               2026-01-01  /v/b.mov",
  );
  assert.equal(reply.clipsTable({ clips: [] }), "(no clips; eyespy add <frames> [--fps n])");
  const status: Outputs["status"] = {
    root: "/s",
    clips: [{ path: "/v/a.mov", key: "0123456789ab", keyframes: 53 }],
    keyframes: 53,
    encoded: 40,
    prompts: [],
    detections: 9,
    objects: 1,
    rejected: 2,
    todo: 6,
    assigned: 1,
  } as never;
  assert.equal(
    reply.status(status),
    "session /s\n  /v/a.mov (53 keyframes)\nencoded 40/53 keyframes, 9 detections\nobjects 1, assigned 1, rejected 2, todo 6\nprompts: none",
  );
  const cfg: Outputs["config"] = {
    config: { threshold: 0.55, presence: 0.5 },
    defaults: { threshold: 0.5, presence: 0.5 },
  } as never;
  assert.equal(reply.config(cfg, undefined), "threshold        0.55  (default 0.5)\npresence         0.5");
  assert.equal(reply.config(cfg, "presence"), "presence         0.5");
});

test("label, todo, history, manifest", () => {
  const shown: Outputs["obj.show"] = { ...OBJ, total: 5, offset: 0, image: "/s/o.jpg", hits: [H1, H2] };
  assert.equal(
    reply.objShow(shown, 0),
    `${objLine(OBJ)}\nshowing 0–1 of 5 (one per alias group)\n${hitLine(H1)}\n${hitLine(H2)}\nimage: /s/o.jpg`,
  );
  const match: Outputs["obj.match"] = {
    ids: ["3.1"],
    current: ["o1"],
    matches: [{ obj: "o1", label: "glass jar", sim: 0.912, closest: "12.10", closest_sim: 0.88, sightings: 2 }],
  } as never;
  assert.equal(reply.objMatch(match), "currently in o1\no1    sim 0.91  closest 12.10 (0.88)  2 sightings  glass jar");
  assert.equal(reply.objMatch({ ids: [], current: [], matches: [] }), "(no objects yet)");
  assert.equal(reply.todo({ total: 3, image: null, hits: [H1] }), `3 unassigned (showing 1)\n${hitLine(H1)}`);
  assert.equal(
    reply.todoGroups(
      {
        total: 3,
        groups_total: 2,
        image: "/s/g.jpg",
        groups: [{ group: "g0", ids: ["3.1", "12.10"], frames: "3-12" }],
      } as never,
      0,
    ),
    "3 unassigned in 2 groups (showing 0–0)\ng0   #3-12   3.1 12.10\nimage: /s/g.jpg",
  );
  const history: Outputs["data.history"] = {
    undo: { seq: 2, op: "label" },
    redo: null,
    ops: [
      { seq: 1, op: "new", ts: 1761400000, obj: "o1", label: "jar", undoable: true, undone: false, objects: ["o1"] },
      { seq: 2, op: "label", obj: "o1", label: "glass jar", undoable: true, undone: true, objects: ["o1"] },
    ],
  };
  assert.equal(
    reply.history(history, 20),
    '#1    10-25 13:46:40  new     {"obj":"o1","label":"jar"}\n' +
      '#2      label   {"obj":"o1","label":"glass jar"}  (undone)\n' +
      "undo: #2 label   redo: -",
  );
  assert.equal(reply.history(history, 1).split("\n").length, 2);
  const manifest: Outputs["manifest"] = {
    meta: {} as never,
    items: [{ label: "glass jar", count: 2 }],
    objects: [OBJ],
    image: null,
  };
  assert.equal(reply.manifest(manifest), `  2  glass jar\n\n${objLine(OBJ)}`);
  assert.equal(reply.manifest({ ...manifest, items: [] }), "(no objects yet)");
  assert.equal(reply.exported(manifest, "/w/e.json"), "wrote 1 objects to /w/e.json");
});
