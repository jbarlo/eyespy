import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResultAsync } from "neverthrow";
import { createDetections } from "../../src/detections/index.ts";
import type { DetId } from "../../src/detections/index.ts";
import { isDetId } from "../../src/detections/pure.ts";
import type { Diff, Objects, OpEntry, Owner } from "../../src/labelling/index.ts";
import {
  REJECT,
  REJECT_LABEL,
  applyDiff,
  diffObjects,
  historyView,
  invertDiff,
  isOwner,
  stacks,
} from "../../src/labelling/pure.ts";
import { isClipKey } from "../../src/video/pure.ts";
import { det, emb, errv, frame, okv } from "../detections/helpers.ts";
import { MemLabelLog, open, reopen } from "./fakes.ts";

const ctx = { aliasIou: 0.7 };

/** 3 keyframes, detections f.n at disjoint boxes (no aliases). */
const DETS = createDetections({
  detections: [
    det("0.0", { emb: emb(0) }),
    det("1.0", { emb: emb(0, 1, 0.1) }),
    det("2.0", { emb: emb(0, 2, 0.2) }),
    det("0.1", { emb: emb(5) }),
    det("1.1", { emb: emb(5, 6, 0.1) }),
    det("2.1", { emb: emb(9) }),
  ],
  runs: [],
  reserved: new Map(),
});

const did = (s: string): DetId => {
  if (!isDetId(s)) throw new Error(`bad detection id ${s}`);
  return s;
};
const own = (s: string): Owner => {
  if (!isOwner(s)) throw new Error(`bad owner ${s}`);
  return s;
};
type RawObj = { readonly label: string; readonly members: readonly string[] };
const objs = (o: Record<string, RawObj>): Objects =>
  new Map(Object.entries(o).map(([k, v]) => [own(k), { label: v.label, members: v.members.map(did) }] as const));
type RawChange = {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
};
/** A Diff from plain strings. Keys need not be object ids, since some tests use corrupt logs. */
const D = (raw: Record<string, RawChange>): Diff =>
  Object.fromEntries(
    Object.entries(raw).map(([k, c]) => [
      k,
      {
        ...("from" in c ? { from: c.from } : {}),
        ...("to" in c ? { to: c.to } : {}),
        ...(c.add ? { add: c.add.map(did) } : {}),
        ...(c.remove ? { remove: c.remove.map(did) } : {}),
      },
    ]),
  );

/** Objects with members sorted, because undo restores membership but not member order. */
const state = (o: Objects) =>
  Object.fromEntries(
    [...o]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, { label: v.label, members: [...v.members].sort() }]),
  );

const entries = (lines: readonly Record<string, unknown>[]): OpEntry[] =>
  lines.map((l, seq) => ({ op: "?", ...l, seq }));

test("diff/invert/apply round-trip; a diff that doesn't fit changes nothing", () => {
  const a = objs({
    x: { label: "(not an item)", members: ["9.9"] },
    o1: { label: "jar", members: ["0.0", "1.0"] },
    o2: { label: "tub", members: ["0.1"] },
  });
  const b = objs({
    x: { label: "(not an item)", members: ["9.9", "1.0"] },
    o1: { label: "big jar", members: ["0.0"] },
    o3: { label: "lid", members: ["2.0"] },
  });
  const d = diffObjects(a, b);
  assert.deepEqual(d, {
    x: { add: ["1.0"] },
    o1: { from: "jar", to: "big jar", remove: ["1.0"] },
    o2: { from: "tub", to: null, remove: ["0.1"] },
    o3: { from: null, to: "lid", add: ["2.0"] },
  });
  assert.deepEqual(Object.keys(d.o1 ?? {}), ["from", "to", "remove"], "key order is byte order");
  const back = okv(applyDiff(b, invertDiff(d)));
  assert.deepEqual(state(back), state(a));
  assert.deepEqual(state(okv(applyDiff(back, d))), state(b));
  assert.deepEqual(errv(applyDiff(a, invertDiff(d))), { kind: "members-missing", obj: "x", ids: ["1.0"] });
  assert.deepEqual(errv(applyDiff(a, D({ o2: { from: null, to: "tub" } }))), { kind: "exists", obj: "o2" });
  assert.deepEqual(errv(applyDiff(a, D({ o9: { add: [] } }))), { kind: "gone", obj: "o9" });
  assert.deepEqual(errv(applyDiff(a, D({ o1: { from: "lid", to: "x" } }))), {
    kind: "label-mismatch",
    obj: "o1",
    actual: "jar",
    expected: "lid",
  });
  assert.deepEqual(errv(applyDiff(a, D({ o1: { remove: ["2.0"] } }))), {
    kind: "members-missing",
    obj: "o1",
    ids: ["2.0"],
  });
  assert.deepEqual(errv(applyDiff(a, D({ o1: { add: ["0.0"] } }))), {
    kind: "members-present",
    obj: "o1",
    ids: ["0.0"],
  });
  assert.deepEqual(errv(applyDiff(a, D({ jar: { from: null, to: "jar" } }))), { kind: "not-an-object", obj: "jar" });
  // when a member moves between objects, removals apply first, so it is never in two at once
  const moved = okv(applyDiff(a, D({ o2: { add: ["1.0"] }, o1: { remove: ["1.0"] } })));
  assert.deepEqual(moved.get(own("o2"))?.members, ["0.1", "1.0"]);
  // created objects are appended
  assert.deepEqual([...okv(applyDiff(a, D({ o0: { from: null, to: "new" } }))).keys()], ["x", "o1", "o2", "o0"]);
});

test("invert: key order from, to, add, remove", () => {
  const d = D({ o1: { from: "a", to: "b", add: ["1.0"], remove: ["2.0"] }, o2: { from: null, to: "c" } });
  assert.deepEqual(invertDiff(d), {
    o1: { from: "b", to: "a", add: ["2.0"], remove: ["1.0"] },
    o2: { from: "c", to: null },
  });
  assert.deepEqual(Object.keys(invertDiff(d).o1 ?? {}), ["from", "to", "add", "remove"]);
});

test("stacks: undo, redo, new op clears redo, diff-less lines are barriers", () => {
  const e = entries([
    { op: "new", diff: {} },
    { op: "add", diff: {} },
    { op: "undo", of: 1, diff: {} },
    { op: "undo", of: 0, diff: {} },
    { op: "redo", of: 0, diff: {} },
  ]);
  let st = stacks(e);
  assert.deepEqual(st.undo, [0]);
  assert.deepEqual(st.redo, [1]);
  assert.deepEqual([...st.undone], [1]);
  st = stacks([...e, { seq: 5, op: "label", diff: {} }]);
  assert.deepEqual(st.undo, [0, 5]);
  assert.deepEqual(st.redo, []);
  st = stacks([...e, { seq: 5, op: "label" }, { seq: 6, op: "label", diff: {} }]);
  assert.deepEqual(st.undo, [6]);
  assert.deepEqual(stacks(entries([{ op: "?" }])).undo, []);
  // an undo that doesn't match the top (or has no `of`) is a barrier
  assert.deepEqual(
    stacks(
      entries([
        { op: "new", diff: {} },
        { op: "undo", of: 7, diff: {} },
      ]),
    ).undo,
    [],
  );
  assert.deepEqual(stacks(entries([{ op: "undo", diff: {} }])).undo, []);
});

test("every op undoes and redoes, across a reopen", async () => {
  const { lab, log } = open(DETS);
  const states = [state(objs({ x: { label: REJECT_LABEL, members: [] } }))];
  const step = async <T, E>(p: ResultAsync<T, E>) => {
    okv(await p);
    states.push(state(log.objects));
  };
  const o1 = okv(await lab.create("jar", ["0.0", "1.0"], ctx));
  assert.equal(o1.id, "o1");
  states.push(state(log.objects));
  await step(lab.add("o1", ["2.0"], ctx));
  await step(lab.create("tub", ["0.1"], ctx));
  await step(lab.reject(["1.0"], ctx)); // moves 1.0 from o1 to x
  await step(lab.relabel("o2", "tub of butter"));
  await step(lab.merge("o1", "o2"));
  await step(lab.remove("o1", ["0.1"], ctx));
  await step(lab.delete("o1"));
  assert.equal(lab.historyState().undo?.op, "delete");

  for (let k = states.length - 1; k > 4; k--) {
    okv(await lab.undo());
    assert.deepEqual(state(log.objects), states[k - 1], `after undoing to state ${k - 1}`);
  }
  const { lab: lab2 } = reopen(DETS, log);
  assert.deepEqual(state(log.objects), states[4]);
  for (let k = 4; k > 0; k--) {
    okv(await lab2.undo());
    assert.deepEqual(state(log.objects), states[k - 1]);
  }
  assert.deepEqual(errv(await lab2.undo()), { kind: "nothing-to-undo" });
  for (let k = 1; k < states.length; k++) {
    okv(await lab2.redo());
    assert.deepEqual(state(log.objects), states[k]);
  }
  assert.deepEqual(errv(await lab2.redo()), { kind: "nothing-to-redo" });
  const h = lab2.history();
  assert.equal(h.ops.length, 8 + 8 + 8);
  assert.ok(h.ops.every((o) => !o.undone));
  assert.equal(h.ops[0]?.op, "new");
  assert.equal(h.ops[0]?.undoable, true);
  assert.equal(h.ops[8]?.op, "undo");
  assert.equal(h.ops[8]?.of, 7);
  assert.equal(h.ops[8]?.undoable, false);
  assert.ok(!("diff" in (h.ops[0] ?? {})));
  // the stacks folded commit by commit agree with a fold of the whole log
  assert.deepEqual(h, historyView(log.entries));
  assert.deepEqual(lab.history(), historyView(log.entries.slice(0, lab.history().ops.length)));
});

test("a new op after undo drops the redo stack; history marks undone ops; undo replies", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0"], ctx));
  okv(await lab.create("tub", ["0.1"], ctx));
  const u = okv(await lab.undo());
  assert.deepEqual(u, {
    undone: { ts: 1003, op: "new", obj: "o2", label: "tub", ids: ["0.1"], seq: 1 },
    undo: { seq: 0, op: "new" },
    redo: { seq: 1, op: "new" },
  });
  assert.deepEqual(log.entries.at(-1), {
    ts: 1004.5,
    op: "undo",
    of: 1,
    diff: { o2: { from: "tub", to: null, remove: ["0.1"] } },
    seq: 2,
  });
  assert.ok(lab.history().ops[1]?.undone);
  assert.equal(lab.historyState().redo?.seq, 1);
  okv(await lab.relabel("o1", "pickle jar"));
  assert.equal(lab.historyState().redo, null);
  assert.deepEqual(errv(await lab.redo()), { kind: "nothing-to-redo" });
  assert.deepEqual([...log.objects.keys()], [REJECT, "o1"]);
});

test("undo refuses when the objects no longer match the log", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0"], ctx));
  // objects.json changed with no log entry
  const edited = new Map(log.objects);
  edited.set(own("o1"), { label: "edited", members: [did("0.0")] });
  const { lab: lab2 } = open(DETS, { objects: edited, history: [...log.entries], nextObj: log.nextObj }, log);
  const n = log.entries.length;
  assert.deepEqual(errv(await lab2.undo()), {
    kind: "cannot-replay",
    op: "undo",
    seq: 0,
    of: "new",
    reason: { kind: "label-mismatch", obj: "o1", actual: "edited", expected: "jar" },
  });
  assert.equal(
    lab2
      .get("o1")
      .map((o) => o.label)
      .unwrapOr(""),
    "edited",
  );
  assert.equal(log.entries.length, n, "nothing logged");
});

test("lines without a diff are a barrier", async () => {
  const history = entries([{ ts: 1, op: "new", obj: "o1", label: "jar", ids: ["0.0"] }]);
  const { lab, log } = open(DETS, { objects: objs({ o1: { label: "jar", members: ["0.0"] } }), history });
  assert.deepEqual(errv(await lab.undo()), { kind: "nothing-to-undo" });
  assert.equal(lab.history().ops[0]?.undoable, false);
  okv(await lab.relabel("o1", "pickle jar"));
  okv(await lab.undo());
  assert.equal(okv(lab.get("o1")).label, "jar");
  assert.deepEqual([...log.objects.keys()], ["o1", REJECT], "the reject set is added when missing");
});

test("stripFrames: one clip_remove line always, objects left empty deleted (not pre-empty ones), a barrier", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0", "1.0"], ctx));
  okv(await lab.create("mug", ["2.0"], ctx));
  okv(await lab.create("empty", ["2.1"], ctx));
  okv(await lab.remove("o3", ["2.1"], ctx));
  okv(await lab.reject(["1.1"], ctx));
  const key = "0a1b2c3d4e03";
  if (!isClipKey(key)) throw new Error("key");
  const r = okv(await lab.stripFrames({ key, path: "/v/extra.mp4", frames: [frame(1), frame(2)] }));
  assert.deepEqual(r, { stripped: 3, deleted: ["o2"] });
  const { ts: _, seq: _s, ...line } = log.entries.at(-1) ?? { seq: -1, op: "" };
  assert.deepEqual(line, {
    op: "clip_remove",
    clip: key,
    path: "/v/extra.mp4",
    frames: [1, 2],
    deleted: ["o2"],
    changes: {
      x: { remove: ["1.1"] },
      o1: { remove: ["1.0"] },
      o2: { from: "mug", to: null, remove: ["2.0"] },
    },
  });
  assert.deepEqual(Object.keys(line), ["op", "clip", "path", "frames", "deleted", "changes"]);
  assert.deepEqual(okv(lab.get("o3")).members, [], "already empty: kept");
  assert.deepEqual(errv(await lab.undo()), { kind: "nothing-to-undo" });
  assert.deepEqual(lab.history().ops.at(-1)?.objects, []);
  // with nothing left to strip, the op is still logged as a barrier
  const again = okv(await lab.stripFrames({ key, path: "/v/extra.mp4", frames: [frame(1), frame(2)] }));
  assert.deepEqual(again, { stripped: 0, deleted: [] });
  assert.equal(log.entries.at(-1)?.op, "clip_remove");
});

test("object ids are never reused: merge, delete, undo, redo, reopen", async () => {
  const { lab, log } = open(DETS);
  const mk = async (label: string, d: string) => okv(await lab.create(label, [d], ctx)).id;
  assert.equal(await mk("a", "0.0"), "o1");
  assert.equal(await mk("b", "0.1"), "o2");
  okv(await lab.merge("o1", "o2"));
  assert.equal(await mk("c", "1.0"), "o3", "a merged-away id is not reused");
  okv(await lab.delete("o3"));
  assert.equal(await mk("d", "1.1"), "o4", "a deleted id is not reused");
  okv(await lab.undo());
  assert.equal(await mk("e", "1.1"), "o5", "undo never lowers the counter");
  okv(await lab.undo());
  okv(await lab.redo()); // redo of an undone `new` recreates the same id
  assert.equal(okv(lab.get("o5")).label, "e");
  okv(await lab.undo());
  assert.equal(log.nextObj, 6);
  const { lab: lab2 } = reopen(DETS, log);
  assert.equal(okv(await lab2.create("f", ["2.0"], ctx)).id, "o6");
  assert.deepEqual(errv(await lab2.redo()), { kind: "nothing-to-redo" });
});

test("object ids: next_obj, raised above every id in objects.json; the log is not read", async () => {
  // a stored next_obj below what objects.json holds is raised, so an id present in objects.json is skipped
  const { lab, log } = open(DETS, { objects: objs({ o3: { label: "jar", members: [] } }), nextObj: 2 });
  assert.equal(okv(await lab.create("lid", ["1.0"], ctx)).id, "o4");
  assert.equal(log.nextObj, 5);
  // ids the log mentions don't move the counter
  const history = entries([
    { ts: 1, op: "new", obj: "o7", label: "tub", ids: ["0.1"] },
    { ts: 2, op: "delete", obj: "o7" },
  ]);
  const { lab: lab2 } = open(DETS, { history, nextObj: 3 });
  assert.equal(okv(await lab2.create("lid", ["1.0"], ctx)).id, "o3");
});

test("undo, redo and history stay fast over a 50k-entry log (stacks folded once, not per call)", async () => {
  const n = 50_000;
  // relabel o1 to "a" and "b" in turn. Every entry is undoable, so the undo stack is n deep
  const history = entries(
    Array.from({ length: n }, (_, k) => ({
      op: "label",
      obj: "o1",
      diff: { o1: { from: k % 2 ? "b" : "a", to: k % 2 ? "a" : "b" } },
    })),
  );
  const t0 = performance.now();
  const { lab } = open(DETS, { objects: objs({ o1: { label: "a", members: [] } }), history });
  const opened = performance.now() - t0;
  const t1 = performance.now();
  const h = lab.history();
  const viewed = performance.now() - t1;
  assert.equal(h.ops.length, n);
  assert.deepEqual(h.undo, { seq: n - 1, op: "label" });
  const t2 = performance.now();
  for (let k = 0; k < 21; k++) okv(await lab.undo());
  for (let k = 0; k < 10; k++) okv(await lab.redo());
  const replayed = performance.now() - t2;
  assert.deepEqual(lab.historyState(), { undo: { seq: n - 12, op: "label" }, redo: { seq: n - 11, op: "label" } });
  assert.equal(okv(lab.get("o1")).label, "b");
  // an O(n²) refold per call would exceed these budgets at this size
  assert.ok(opened < 500, `open took ${opened.toFixed(1)} ms`);
  assert.ok(viewed < 500, `history took ${viewed.toFixed(1)} ms`);
  assert.ok(replayed < 500, `31 undo/redo took ${replayed.toFixed(1)} ms`);
});

test("no-op ops log nothing, take no undo slot, keep the redo stack", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0", "1.0"], ctx));
  okv(await lab.reject(["2.0"], ctx));
  okv(await lab.undo());
  const n = log.entries.length;
  assert.deepEqual(okv(await lab.reject([], ctx)), { rejected: [] });
  assert.deepEqual(okv(await lab.add("o1", ["1.0"], ctx)), { added: ["1.0"] });
  assert.deepEqual(okv(await lab.remove("o1", ["2.1"], ctx)), { removed: ["2.1"] });
  okv(await lab.relabel("o1", "jar"));
  assert.equal(log.entries.length, n);
  assert.deepEqual(okv(lab.get("o1")).members, ["0.0", "1.0"], "member order untouched");
  assert.equal(lab.historyState().redo?.seq, 1, "redo survives");
  okv(await lab.redo());
  assert.deepEqual(okv(lab.get(REJECT)).members, ["2.0"]);
  // undo of an empty-diff line in the log works
  const old = entries([{ ts: 1, op: "reject", ids: [], diff: {} }]);
  const { lab: l2, log: log2 } = open(DETS, { history: old }, new MemLabelLog(old));
  const u = okv(await l2.undo());
  assert.equal(u.undone.seq, 0);
  assert.deepEqual(log2.entries.at(-1), { ts: 1001.5, op: "undo", of: 0, diff: {}, seq: 1 });
});

test("a failed commit leaves the instance unchanged", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0"], ctx));
  log.failNext = true;
  assert.deepEqual(errv(await lab.create("tub", ["0.1"], ctx)), {
    kind: "host",
    port: "store",
    op: "appendText",
    message: "disk full",
  });
  assert.deepEqual(lab.objectIds(), ["o1"]);
  assert.equal(lab.ownerOf(okv(DETS.get("0.1")).id), undefined);
  assert.equal(lab.history().ops.length, 1);
  log.failNext = true;
  assert.equal(errv(await lab.undo()).kind, "host");
  assert.deepEqual(lab.objectIds(), ["o1"]);
  assert.deepEqual(lab.historyState(), { undo: { seq: 0, op: "new" }, redo: null });
  assert.equal(okv(await lab.create("tub", ["0.1"], ctx)).id, "o2", "the counter did not move");
});

test("errors: unknown ids/objects, merge/delete of the reject set, empty centroid", async () => {
  const { lab, log } = open(DETS);
  okv(await lab.create("jar", ["0.0"], ctx));
  assert.deepEqual(errv(await lab.create("x", ["0.0", "42.0"], ctx)), { kind: "no-detection", id: "42.0" });
  assert.deepEqual(errv(await lab.add("o99", ["bad"], ctx)), { kind: "no-object", id: "o99" }, "object checked first");
  assert.deepEqual(errv(await lab.add("o1", ["bad"], ctx)), { kind: "no-detection", id: "bad" });
  assert.deepEqual(errv(await lab.remove("o99", ["0.0"], ctx)), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.relabel("o99", "x")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.delete("x")), { kind: "delete-reject" });
  assert.deepEqual(errv(await lab.delete("o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.merge("x", "o1")), { kind: "merge-reject" });
  assert.deepEqual(errv(await lab.merge("o1", "x")), { kind: "merge-reject" });
  assert.deepEqual(errv(await lab.merge("o1", "o1")), { kind: "merge-self" });
  assert.deepEqual(errv(await lab.merge("o1", "o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.merge("o98", "o99")), { kind: "no-object", id: "o98" });
  assert.deepEqual(errv(lab.summary("o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(lab.match(["9.9"], 5, ctx)), { kind: "no-detection", id: "9.9" });
  okv(await lab.remove("o1", ["0.0"], ctx));
  assert.deepEqual(errv(lab.centroid("o1")), { kind: "object-no-members", id: "o1" });
  assert.equal(okv(lab.best("o1")), null);
  assert.equal(log.entries.length, 2);
  okv(await lab.relabel("x", "junk"));
  assert.equal(okv(lab.get("x")).label, "junk");
});

test("obj.match ranks objects by centroid similarity, leaving the query out", async () => {
  const { lab } = open(DETS);
  okv(await lab.create("jar", ["0.0", "1.0"], ctx));
  okv(await lab.create("tub", ["0.1"], ctx));
  const m = okv(lab.match(["2.0"], 5, ctx));
  assert.deepEqual(
    m.map((x) => x.obj),
    ["o1", "o2"],
  );
  assert.ok((m[0]?.sim ?? 0) > 0.9 && (m[1]?.sim ?? 1) < 0.1);
  const self = okv(lab.match(["1.0"], 5, ctx));
  assert.equal(self[0]?.obj, "o1");
  assert.equal(self[0]?.closest, "0.0");
  assert.equal(self[0]?.sightings, 1);
  const g = okv(lab.match(["1.1", "0.1"], 5, ctx));
  assert.deepEqual(
    g.map((x) => x.obj),
    ["o1"],
    "an object whose only member is the query is skipped",
  );
  assert.equal(okv(lab.match(["2.0"], 1, ctx)).length, 1);
});

test("summary, owners, unassigned with real detections: aliases expand and collapse", async () => {
  const dets = createDetections({
    detections: [
      det("0.0", { box: [0, 0, 10, 10], score: 0.9, prompt: "jar", t: 0 }),
      det("0.1", { box: [0, 0, 10, 8], score: 0.95, prompt: "container", t: 0 }), // alias of 0.0 (IoU 0.8)
      det("1.0", { box: [0, 0, 10, 10], score: 0.8, prompt: "jar", t: 0.5 }),
      det("1.1", { box: [30, 0, 40, 10], score: 0.4, prompt: "jar", t: 0.5 }),
      det("2.0", { box: [0, 0, 20, 20], score: 0.7, prompt: "box", t: 1 }),
    ],
    runs: [],
    reserved: new Map(),
  });
  const { lab, log } = open(dets);
  const c = okv(await lab.create("jar", ["0.0", "1.0"], ctx));
  assert.deepEqual(c, { id: "o1", added: ["0.0", "0.1", "1.0"] });
  assert.deepEqual(log.entries.at(-1), {
    ts: 1001.5,
    op: "new",
    obj: "o1",
    label: "jar",
    ids: ["0.0", "0.1", "1.0"],
    diff: { o1: { from: null, to: "jar", add: ["0.0", "0.1", "1.0"] } },
    seq: 0,
  });
  assert.deepEqual(okv(lab.summary("o1")), {
    id: "o1",
    label: "jar",
    sightings: 2,
    members: ["0.0", "0.1", "1.0"],
    first_t: 0,
    last_t: 0.5,
    best: "0.0", // 0.9·sqrt(100) > 0.95·sqrt(80)
    prompts: { container: 0.95, jar: 0.9 },
  });
  assert.equal(lab.ownerOf(okv(dets.get("0.1")).id), "o1");
  assert.deepEqual([...lab.owners().keys()], ["0.0", "0.1", "1.0"]);
  assert.deepEqual(
    lab.unassigned({ threshold: 0.5 }, ctx).map((d) => d.id),
    ["2.0"],
  );
  assert.deepEqual(
    lab.unassigned({ threshold: 0 }, ctx).map((d) => d.id),
    ["1.1", "2.0"],
  );
  assert.deepEqual(
    lab.unassigned({ threshold: 0, prompt: "box", frames: new Set([frame(2)]) }, ctx).map((d) => d.id),
    ["2.0"],
  );
  okv(await lab.reject(["1.1"], ctx));
  assert.deepEqual(lab.rejected(), ["1.1"]);
  assert.deepEqual(lab.objectIds(), ["o1"]);
  const cen = okv(lab.centroid("o1"));
  assert.ok(Math.abs(cen[0] ?? 0) > 0.99);
});

const _types: Owner = REJECT;
void _types;
