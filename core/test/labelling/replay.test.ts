/**
 * Replays the session.ops snapshot on createDetections and createLabelling alone, with the detections that
 * the fixture generator dumped. Replies, op lines (with their key order, except `ts`) and history must match it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Detection, HeatmapRef, Run } from "../../src/detections/index.ts";
import { createDetections } from "../../src/detections/index.ts";
import { compareDetIds, groups, ranked } from "../../src/detections/pure.ts";
import type { ResultAsync } from "neverthrow";
import type { HistoryView, LabellingError } from "../../src/labelling/index.ts";
import { REJECT } from "../../src/labelling/pure.ts";
import { isAppearance } from "../../src/perception/pure.ts";
import type { Box } from "../../src/pixels/index.ts";
import { isClipKey } from "../../src/video/pure.ts";
import { SNAPSHOT_DIR } from "../snapshot.ts";
import { errv, frame, ids, okv } from "../detections/helpers.ts";
import { MemLabelLog, open } from "./fakes.ts";

type DetRec = {
  id: string;
  frame: number;
  t: number;
  prompt: string;
  region: Box | null;
  score: number;
  box: Box;
  mask: number[];
  emb: string;
};
type RunRec = { key: string; ids: string[]; presence: number; heatmap: string | null };
type Fixture = {
  base: { detections: DetRec[]; runs: RunRec[] };
  extra: (RunRec & { detections: DetRec[] })[];
  revive: (RunRec & { detections: DetRec[] })[];
};
const here = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(here, "fixtures/session-ops.json"), "utf8")) as Fixture;

type Step = { input: unknown; output?: unknown; error?: { code: string; message: string }; ops: string[] };
const SNAP = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "session.ops.json"), "utf8")) as Record<string, unknown>;
const step = (name: string): Step => {
  const key = Object.keys(SNAP).find((k) => k.slice(4) === name);
  if (!key) throw new Error(`no snapshot step ${name}`);
  return SNAP[key] as Step;
};
const out = <T>(name: string) => step(name).output as T;

const unrle = (counts: number[], n: number) => {
  const m = new Uint8Array(n);
  let p = 0;
  counts.forEach((c, k) => {
    if (k % 2) m.fill(1, p, p + c);
    p += c;
  });
  return m;
};
const appearance = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  const v = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!isAppearance(v)) throw new Error("bad emb");
  return v;
};
const toDet = (r: DetRec): Detection => {
  const [x0, y0, x1, y1] = r.box;
  const mask = unrle(r.mask, (x1 - x0) * (y1 - y0));
  const d = { ...r, frame: frame(r.frame), mask, area: mask.reduce((s, x) => s + x, 0), emb: appearance(r.emb) };
  return d as Detection;
};
const toRun = (key: string): Run => {
  const bar = key.indexOf("|");
  const rest = key.slice(bar + 1);
  const m = /^(.*)@(\d+),(\d+),(\d+),(\d+)$/.exec(rest);
  return m
    ? {
        frame: frame(Number(key.slice(0, bar))),
        prompt: m[1] ?? "",
        region: [2, 3, 4, 5].map((k) => Number(m[k])) as unknown as Box,
      }
    : { frame: frame(Number(key.slice(0, bar))), prompt: rest, region: null };
};
const toRecord = (r: RunRec) => ({
  ...toRun(r.key),
  ids: r.ids.map((id) => toDet({ ...FIX.base.detections[0]!, id }).id),
  presence: r.presence,
  heatmap: r.heatmap as HeatmapRef | null,
});

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const parse = (line: string) => {
  const { ts: _, ...rest } = JSON.parse(line) as Record<string, unknown>;
  return rest;
};
const sansTs = <T extends object>(e: T) => {
  const { ts: _, ...rest } = e as T & { ts?: unknown };
  return rest;
};

const mine = (v: HistoryView) => ({ ...v, ops: v.ops.map((o) => sansTs(o)) });

test("session.ops snapshot replayed on createDetections + createLabelling", async () => {
  const dets = createDetections({
    detections: FIX.base.detections.map(toDet),
    runs: FIX.base.runs.map(toRecord),
    reserved: new Map(),
  });
  const log = new MemLabelLog();
  const { lab } = open(dets, {}, log);
  const ctx = { aliasIou: 0.7 }; // DEFAULT_CONFIG.alias_iou; the snapshot never changes it
  const TH = 0.5;
  const linesBefore = () => log.entries.length;

  /** Key order is compared too: storage writes keys in this order. */
  const sameLine = (name: string) => {
    const want = step(name).ops.map(parse);
    assert.equal(want.length, 1, `${name}: one snapshot line`);
    const { ts: _, seq: _s, ...got } = log.entries.at(-1) ?? { seq: -1, op: "" };
    assert.deepEqual(got, want[0], `${name}: op line`);
    assert.deepEqual(Object.keys(got), Object.keys(want[0] ?? {}), `${name}: key order`);
  };
  const sameSummary = (name: string, id: string) => assert.deepEqual(okv(lab.summary(id)), out(name), name);

  const listed = out<{ hits: { id: string; box: Box; score: number }[] }>("dets").hits;
  const mineListed = dets
    .all()
    .filter((d) => d.score >= TH)
    .toSorted((a, b) => compareDetIds(a.id, b.id));
  assert.deepEqual(
    mineListed.map((d) => [d.id, d.box, r3(d.score)]),
    listed.map((h) => [h.id, h.box, h.score]),
  );

  type Mut = [name: string, run: () => ResultAsync<unknown, LabellingError>, obj: string];
  const muts: Mut[] = [
    ["obj.new (aliases expand)", () => lab.create("red jar", ["0.0", "1.0"], ctx), "o1"],
    ["obj.add", () => lab.add("o1", ["2.0", "3.0"], ctx), "o1"],
    ["obj.remove", () => lab.remove("o1", ["3.0"], ctx), "o1"],
    ["obj.new second", () => lab.create("orange jar", ["0.1"], ctx), "o2"],
    ["obj.label unicode", () => lab.relabel("o2", "второй jar (café)"), "o2"],
    ["obj.new takes from another object", () => lab.create("tmp", ["1.1", "0.1"], ctx), "o3"],
    ["obj.merge", () => lab.merge("o2", "o3"), "o2"],
    ["obj.new box", () => lab.create("box", ["3.2", "4.2"], ctx), "o4"],
  ];
  for (const [name, run, obj] of muts) {
    okv(await run());
    sameLine(name);
    sameSummary(name, obj);
  }
  assert.deepEqual(okv(await lab.delete("o4")), undefined);
  assert.deepEqual({ deleted: "o4" }, out("obj.delete"));
  sameLine("obj.delete");

  // session composes obj.show and obj.suggest. These rebuild them from labelling and detections.
  for (const [name, frames, offset] of [
    ["obj.show", null, 0],
    ["obj.show frames", new Set([0, 1]), 0],
    ["obj.show offset", null, 1],
  ] as const) {
    const o = out<Record<string, unknown> & { total: number; hits: { id: string }[] }>(name);
    const { total, offset: _o, image: _i, hits, ...summary } = o;
    assert.deepEqual(okv(lab.summary("o1")), summary);
    const ms = dets.collapse(
      okv(lab.get("o1"))
        .members.map((m) => okv(dets.get(m)))
        .filter((d) => !frames || frames.has(d.frame)),
      ctx.aliasIou,
    );
    assert.equal(ms.length, total, name);
    assert.deepEqual(
      ids(ms.slice(offset, offset + 64)),
      hits.map((h) => h.id),
      name,
    );
  }

  for (const [name, obj, k, th] of [
    ["obj.suggest", "o1", 8, TH],
    ["obj.suggest k threshold", "o2", 2, 0.3],
  ] as const) {
    const c = okv(lab.centroid(obj));
    const cands = dets.all().filter((d) => d.score >= th && !lab.ownerOf(d.id));
    const want = out<{ matches: { id: string; sim: number }[] }>(name).matches;
    const r = ranked(cands, c, k).map(({ d }) => d);
    assert.deepEqual(
      r.map((d) => d.id),
      want.map((m) => m.id),
      name,
    );
    assert.equal(okv(lab.best(obj))?.id, okv(lab.summary(obj)).best);
  }

  for (const [name, q, k] of [
    ["obj.match", ["3.0"], 5],
    ["obj.match own member, k", ["0.0", "4.0"], 1],
  ] as const) {
    const want = out<{ current: string[]; matches: unknown[] }>(name);
    assert.deepEqual(okv(lab.match(q, k, ctx)), want.matches, name);
    const current = [...new Set(q.map((i) => lab.ownerOf(okv(dets.get(i)).id)).filter((x) => x !== undefined))];
    assert.deepEqual(current, want.current, name);
  }

  assert.deepEqual(okv(await lab.reject(["5.2"], ctx)), out("reject ids"));
  sameLine("reject ids");
  assert.deepEqual(okv(await lab.reject(["1.1"], ctx)), out("reject takes from an object"));
  sameLine("reject takes from an object");
  const lidLeftovers = lab.unassigned({ threshold: 0, prompt: "lid" }, ctx).map((d) => d.id);
  assert.deepEqual(okv(await lab.reject(lidLeftovers, ctx)), out("reject prompt leftovers"));
  sameLine("reject prompt leftovers");
  const n = linesBefore();
  assert.deepEqual(okv(await lab.reject([], ctx)), out("reject nothing"));
  assert.equal(linesBefore(), n, "a no-op is not logged");
  assert.equal(step("reject nothing").ops.length, 0, "the snapshot agrees");

  const rejects = dets.collapse(
    dets.all().filter((d) => lab.ownerOf(d.id) === REJECT),
    ctx.aliasIou,
  );
  assert.deepEqual(
    ids(rejects),
    out<{ hits: { id: string }[] }>("show rejects").hits.map((h) => h.id),
  );

  // group_sim was set to 0.6 earlier in the snapshot.
  for (const [name, q, limit] of [
    ["todo", { threshold: TH }, 64],
    ["todo limit", { threshold: TH }, 2],
    ["todo prompt", { threshold: TH, prompt: "container" }, 64],
    ["todo frames", { threshold: TH, frames: new Set([3, 4, 5].map(frame)) }, 64],
    ["todo low threshold", { threshold: 0.3 }, 64],
  ] as const) {
    const queue = lab.unassigned(q, ctx);
    const want = out<{ total: number; hits: { id: string }[] }>(name);
    assert.equal(queue.length, want.total, name);
    assert.deepEqual(
      ids(queue.slice(0, limit)),
      want.hits.map((h) => h.id),
      name,
    );
  }
  for (const [name, link, window, off] of [
    ["todo groups", 0.6, 8, 0],
    ["todo groups offset", 0.6, 8, 1],
    ["todo groups cfg", 0.99, 1, 0],
  ] as const) {
    const gs = groups(lab.unassigned({ threshold: TH }, ctx), link, window);
    const want = out<{ groups_total: number; groups: unknown[] }>(name);
    assert.equal(gs.length, want.groups_total, name);
    const page = gs.slice(off, off + 12).map((g, k) => ({
      group: `g${off + k}`,
      ids: ids(g),
      frames: `${Math.min(...g.map((d) => d.frame))}-${Math.max(...g.map((d) => d.frame))}`,
    }));
    assert.deepEqual(page, want.groups, name);
  }

  assert.deepEqual(mine(lab.history()), mine(out<HistoryView>("data.history")));
  const u = okv(await lab.undo());
  const wantU = out<{ undone: Record<string, unknown>; undo: unknown; redo: unknown }>("undo again");
  assert.deepEqual(sansTs(u.undone), sansTs(wantU.undone));
  assert.deepEqual(u.undo, wantU.undo);
  assert.deepEqual(u.redo, wantU.redo);
  const undoLine = parse(step("undo again").ops[0] ?? "{}");
  assert.deepEqual(sansTs(log.entries.at(-1) ?? {}), { ...undoLine, seq: 12 });
  const r = okv(await lab.redo());
  const wantR = out<{ redone: Record<string, unknown>; undo: unknown; redo: unknown }>("redo");
  assert.deepEqual(sansTs(r.redone), sansTs(wantR.redone));
  assert.deepEqual(r.undo, wantR.undo);
  assert.equal(r.redo, null);
  sameLine("redo");
  assert.deepEqual(mine(lab.history()), mine(out<HistoryView>("data.history after undo/redo")));
  okv(await lab.relabel("o2", "orange jar"));
  sameLine("new op clears redo");
  sameSummary("new op clears redo", "o2");
  assert.deepEqual(errv(await lab.redo()), { kind: "nothing-to-redo" });

  const mintAll = (runs: Fixture["extra"]) => {
    for (const rec of runs) {
      const ds = rec.detections.map(toDet);
      const m = okv(
        dets.mint({
          run: toRun(rec.key),
          t: ds[0]?.t ?? 0,
          instances: ds.map((d) => ({ score: d.score, box: d.box, mask: d.mask, area: d.area })),
          embs: ds.map((d) => d.emb),
          presence: rec.presence,
          heatmap: rec.heatmap as HeatmapRef | null,
        }),
      );
      assert.deepEqual(ids(m.detections), rec.ids, `minted ids of ${rec.key}`);
    }
  };
  mintAll(FIX.extra);
  okv(await lab.add("o1", ["6.1"], ctx));
  sameLine("obj.add extra det");
  sameSummary("obj.add extra det", "o1");
  okv(await lab.create("mug", ["6.0"], ctx));
  sameLine("obj.new extra only");
  sameSummary("obj.new extra only", "o5");
  assert.deepEqual(okv(await lab.reject(["7.0"], ctx)), out("reject extra det"));
  sameLine("reject extra det");

  const removed = out<{ key: string; removed: string; detections: number; stripped: number; deleted: string[] }>(
    "clips.remove extra",
  );
  if (!isClipKey(removed.key)) throw new Error("clip key");
  const strip = okv(await lab.stripFrames({ key: removed.key, path: removed.removed, frames: [frame(6), frame(7)] }));
  assert.deepEqual(strip, { stripped: removed.stripped, deleted: removed.deleted });
  sameLine("clips.remove extra");
  const dropped = dets.drop([frame(6), frame(7)]);
  assert.equal(dropped.detections.length, removed.detections);
  assert.deepEqual(Object.fromEntries(dropped.counters), { 6: 2, 7: 2 }, "the tombstone's next_n in session.json");
  assert.deepEqual(errv(await lab.undo()), { kind: "nothing-to-undo" }, "clip_remove is a barrier");
  const objsAfter = out<{ objects: unknown[]; rejected: string[] }>("data.objects after remove");
  assert.deepEqual(
    lab.objectIds().map((o) => okv(lab.summary(o))),
    objsAfter.objects,
  );
  assert.deepEqual(lab.rejected(), objsAfter.rejected);

  // Revived runs mint again; ids continue from the kept counters.
  mintAll(FIX.revive);
  assert.deepEqual(
    ids(dets.inFrames(new Set([frame(6), frame(7)]))),
    out<{ dets: { id: string }[] }>("data.dets revived").dets.map((d) => d.id),
  );
  const byKey = out<{ key: string; removed: string }>("clips.remove by key");
  if (!isClipKey(byKey.key)) throw new Error("clip key");
  assert.deepEqual(okv(await lab.stripFrames({ key: byKey.key, path: byKey.removed, frames: [frame(8)] })), {
    stripped: 0,
    deleted: [],
  });
  sameLine("clips.remove by key");

  // Labelling returns error kinds; the snapshot holds api's wording.
  assert.deepEqual(errv(await lab.create("x", ["0.0", "42.0"], ctx)), { kind: "no-detection", id: "42.0" });
  assert.equal(step("obj.new unknown id").error?.message, "no detection 42.0");
  for (const name of ["obj.add unknown object", "obj.remove unknown object"])
    assert.equal(step(name).error?.message, "no object o99");
  assert.deepEqual(errv(await lab.add("o99", ["0.0"], ctx)), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.remove("o99", ["0.0"], ctx)), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.relabel("o99", "x")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(lab.summary("o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.delete("x")), { kind: "delete-reject" });
  assert.deepEqual(errv(await lab.delete("o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(await lab.merge("x", "o1")), { kind: "merge-reject" });
  assert.deepEqual(errv(await lab.merge("o1", "o1")), { kind: "merge-self" });
  assert.deepEqual(errv(await lab.merge("o1", "o99")), { kind: "no-object", id: "o99" });
  assert.deepEqual(errv(lab.match(["9.9"], 5, ctx)), { kind: "no-detection", id: "9.9" });

  const empty = okv(await lab.create("empty", ["2.1"], ctx)).id;
  sameLine("obj.new for emptying");
  sameSummary("obj.new for emptying", empty);
  okv(await lab.remove(empty, ["2.1"], ctx));
  sameLine("obj.remove all members");
  sameSummary("obj.remove all members", empty);
  assert.deepEqual(errv(lab.centroid(empty)), { kind: "object-no-members", id: empty });
  assert.equal(step("obj.suggest empty object").error?.message, `object ${empty} has no members`);

  assert.deepEqual(mine(lab.history()), mine(out<HistoryView>("data.history final")));

  const objectsJson = JSON.parse(String(SNAP["files: objects.json"])) as Record<string, unknown>;
  assert.deepEqual(Object.fromEntries(log.objects), objectsJson);
  assert.deepEqual([...log.objects.keys()], Object.keys(objectsJson));
  assert.equal(log.nextObj, 7);
});
