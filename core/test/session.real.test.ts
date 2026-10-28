/** Read-only ops on a real session's files (with a removed clip; no frames or features). */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openEngine, openSession } from "./compose.ts";
import { MemStore, changes, fakeHost } from "./fakes/index.ts";
import { snapshots } from "./snapshot.ts";
import { recorder } from "./steps.ts";

const DIR = fileURLToPath(new URL("fixtures/session-real", import.meta.url));
const snap = snapshots("session.real");

test("real session: opening it writes nothing", async () => {
  const host = fakeHost({ store: MemStore.fromDir(DIR) });
  const before = host.store.fingerprint();
  const s = await openSession(host);
  assert.equal(s.meta().clips.length, 2);
  assert.deepEqual(changes(before, host.store.fingerprint()), {});
});

test("real session: read-only ops, then undo/redo of its last op", async () => {
  const o = await openEngine(fakeHost({ store: MemStore.fromDir(DIR) }), {}, { settle: false });
  // the fixture has no frames, so background encoding marks each frame failed and stops. Replies don't depend on it
  o.settle = async () => {};
  const c = o.caller;
  const { ok, err } = recorder(o, snap.match);
  try {
    await ok("status", {}, (i) => c.status(i));
    await ok("clips.list all", { all: true }, (i) => c.clips.list(i));
    await ok("config", {}, (i) => c.config(i));
    await ok("dets", { threshold: 0.9 }, (i) => c.dets(i));
    await ok("data.frames (first 3)", undefined, async (i) => (await c.data.frames(i)).frames.slice(0, 3));
    await ok("data.dets rle + aliases", { frames: "0", aliases: true }, (i) => c.data.dets(i));
    await ok("data.runs", undefined, (i) => c.data.runs(i));
    await ok("data.objects", undefined, (i) => c.data.objects(i));
    await ok("data.history", undefined, (i) => c.data.history(i));
    await ok("obj.match", { ids: ["3.5"] }, (i) => c.obj.match(i));
    await ok("manifest", {}, (i) => c.manifest(i));
    await ok("features", {}, (i) => c.features(i));
    await ok("dets on the removed clip's frame: none", { frames: "50-60", threshold: 0 }, (i) => c.dets(i));
    await err("crop on the removed clip's frame", { id: "53.0" }, (i) => c.crop(i));
    await ok("undo", {}, (i) => c.undo(i));
    await ok("redo", {}, (i) => c.redo(i));
    await ok("data.history after", undefined, async (i) => (await c.data.history(i)).ops.slice(-3));
  } finally {
    o.close();
  }
});

test("real session fixture stays small", () => {
  const total = [...MemStore.fromDir(join(DIR)).files.values()].reduce((a, b) => a + b.byteLength, 0);
  assert.ok(total < 400_000, `${total} bytes`);
});
