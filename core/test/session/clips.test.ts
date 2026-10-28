import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import { openEngine, type Opened } from "../compose.ts";
import { EXTRA, KITCHEN, MemStore, PANTRY, fakeContentKey, fakeHost } from "../fakes/index.ts";

const PANTRY_KEY = fakeContentKey("0a1b2c3d4e02");

/** Kitchen (keyframes 0 to 2) and pantry (3 to 5): jar found everywhere, box on the pantry, objects on both clips. */
async function twoClips(o: Opened) {
  const c = o.caller;
  await c.add({ video: KITCHEN });
  await c.add({ video: PANTRY });
  await o.settle();
  await c.find({ prompt: "jar" });
  await c.find({ prompt: "box", frames: "3-5" });
  const dets = (await c.data.dets({ mask: "none" })).dets;
  const on = (f: number) => dets.filter((d) => d.frame === f).map((d) => d.id);
  const both = await c.obj.new({ label: "jar", ids: [on(0)[0] ?? "", on(3)[0] ?? ""] }); // o1, on both clips
  const pantryOnly = await c.obj.new({ label: "box", ids: [on(4).at(-1) ?? ""] }); // o2, pantry only
  await c.reject({ ids: [on(5)[0] ?? "", on(1).at(-1) ?? ""] });
  return { both, pantryOnly, dets };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof TRPCError);
    return { code: e.code, message: e.message };
  }
  return assert.fail("expected the call to fail");
};

test("remove: a tombstone; frame numbers elsewhere stay; data, files and labels reclaimed; a barrier", async () => {
  const o = await openEngine();
  const c = o.caller;
  try {
    const { both, dets } = await twoClips(o);
    const pantryDets = dets.filter((d) => d.frame >= 3).length;
    const r = await c.clips.remove({ clip: "pantry.mov" });
    assert.deepEqual([r.key, r.frames, r.detections, r.deleted], [PANTRY_KEY, [3, 5], pantryDets, ["o2"]]);
    // the pantry's detections left every object and the rejects. o2 had nothing else, so it is gone
    const objs = await c.data.objects();
    assert.deepEqual(
      objs.objects.map((x) => [x.id, x.members]),
      [["o1", both.members.filter((m) => !m.startsWith("3."))]],
    );
    assert.ok(objs.rejected.every((id) => Number(id.split(".")[0]) < 3));
    assert.deepEqual(
      (await c.data.frames()).frames.map((f) => f.frame),
      [0, 1, 2],
    );
    assert.equal((await c.status({})).keyframes, 3);
    assert.ok((await c.data.dets({ mask: "none" })).dets.every((d) => d.frame < 3));
    assert.ok((await c.data.runs()).runs.every((x) => x.frame < 3));
    assert.deepEqual(await failure(c.search({ frame: 3, box: [0, 0, 50, 50] })), {
      code: "BAD_REQUEST",
      message: "no keyframe 3",
    });
    const all = (await c.clips.list({ all: true })).clips;
    assert.deepEqual(
      all.map((x) => [x.name, x.frames, x.removed !== undefined]),
      [
        ["kitchen.mp4", [0, 2], false],
        ["pantry.mov", [3, 5], true],
      ],
    );
    for (const k of o.host.store.files.keys())
      assert.ok(!k.startsWith(`clips/${PANTRY_KEY}/`) && !/^dets\/[345]\./.test(k) && !/^sem\/000[345]-/.test(k), k);
    // history holds one logged op, not undoable (a barrier)
    const h = await c.data.history();
    assert.deepEqual([h.ops.at(-1)?.op, h.ops.at(-1)?.undoable], ["clip_remove", false]);
    assert.deepEqual(await failure(c.undo({})), { code: "BAD_REQUEST", message: "nothing to undo" });
    assert.deepEqual(await failure(c.clips.remove({ clip: PANTRY_KEY })), {
      code: "BAD_REQUEST",
      message: `${PANTRY} was already removed`,
    });
    const p = await openEngine(fakeHost({ store: o.host.store }));
    try {
      assert.deepEqual(
        (await p.caller.data.frames()).frames.map((f) => f.frame),
        [0, 1, 2],
      );
      assert.deepEqual(await p.caller.data.objects(), objs);
    } finally {
      p.close();
    }
  } finally {
    o.close();
  }
});

test("revive: a new clip goes after the reserved indices; re-adding comes back at the same ones, ids continue", async () => {
  const o = await openEngine();
  const c = o.caller;
  try {
    const { dets } = await twoClips(o);
    const onPantry = dets.filter((d) => d.frame === 3).map((d) => Number(d.id.split(".")[1]));
    await c.clips.remove({ clip: PANTRY });
    const extra = await c.add({ video: EXTRA });
    assert.equal(extra.first, 6, "after the removed clip's reserved indices");
    o.host.video.extracted = [];
    const back = await c.add({ video: "pantry.mov" });
    assert.deepEqual([back.first, back.keyframes, back.revived], [3, 3, true]);
    assert.deepEqual(
      o.host.video.extracted.map(([, t]) => t),
      [0, 0.6, 1.6],
      "frames re-extracted at the stored times",
    );
    await o.settle();
    assert.deepEqual(await failure(c.add({ video: PANTRY })), {
      code: "BAD_REQUEST",
      message: `${PANTRY} is already in this session`,
    });
    // its old detections stay gone; new ones on its frames continue after the removed ids
    assert.ok((await c.data.dets({ frames: "3-5", mask: "none" })).dets.length === 0);
    const again = await c.find({ prompt: "jar", frames: "3", threshold: 0 });
    assert.ok(again.hits.length > 0);
    assert.ok(again.hits.every((h) => Number(h.id.split(".")[1]) > Math.max(...onPantry)));
  } finally {
    o.close();
  }
});

test("a removal interrupted after its tombstone is finished at the next open", async () => {
  const o = await openEngine();
  const store = o.host.store;
  try {
    await twoClips(o);
  } finally {
    o.close();
  }
  // the process died after writing the tombstone, so the pantry's detections, labels and files are still there
  const meta = JSON.parse(store.text("session.json")) as { clips: { removed?: number }[] };
  const pantry = meta.clips[1];
  assert.ok(pantry);
  pantry.removed = 1767323000;
  store.files.set("session.json", new TextEncoder().encode(JSON.stringify(meta, null, 1)));
  const copy = new MemStore();
  copy.files = new Map(store.files);
  const p = await openEngine(fakeHost({ store: copy }));
  try {
    const c = p.caller;
    assert.ok((await c.data.dets({ mask: "none" })).dets.every((d) => d.frame < 3));
    const objs = await c.data.objects();
    assert.ok(objs.objects.every((x) => x.members.every((m) => Number(m.split(".")[0]) < 3)));
    assert.deepEqual(
      objs.objects.map((x) => x.id),
      ["o1"],
    );
    assert.equal((await c.data.history()).ops.at(-1)?.op, "clip_remove");
    assert.ok(![...p.host.store.files.keys()].some((k) => k.startsWith(`clips/${PANTRY_KEY}/`)));
  } finally {
    p.close();
  }
});

test("features {clear, clip}: drops one clip's stored features, keeps its detections and labels", async () => {
  const o = await openEngine(undefined, { persistFeatures: true });
  const c = o.caller;
  const featureFiles = () => [...o.host.store.files.keys()].filter((k) => k.includes("/feat/"));
  try {
    const { both } = await twoClips(o);
    const pantry = featureFiles().filter((k) => k.startsWith(`clips/${PANTRY_KEY}/`));
    assert.equal(pantry.length, 3);
    assert.equal(featureFiles().length, 6);
    const dets = (await c.data.dets({ mask: "none" })).dets.length;
    // turn persist off first, so background work doesn't write the dropped files again
    await c.features({ persist: false });
    const r = await c.features({ clear: true, clip: "pantry.mov" });
    assert.deepEqual([r.cleared, r.stored], [3, 3], "the kitchen's stay");
    assert.deepEqual(
      featureFiles().filter((k) => k.startsWith(`clips/${PANTRY_KEY}/`)),
      [],
    );
    assert.equal((await c.data.dets({ mask: "none" })).dets.length, dets);
    assert.deepEqual((await c.data.objects()).objects.find((x) => x.id === "o1")?.members, both.members);
    assert.equal((await failure(c.features({ clear: true, clip: "nope.mov" }))).code, "BAD_REQUEST");
  } finally {
    o.close();
  }
});
