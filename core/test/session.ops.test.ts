/**
 * Runs every router op on a fresh session over the fakes and records replies, ops.jsonl lines, files written and
 * text drawn, one snapshot per step (UPDATE=1 re-records them).
 */
import { test } from "node:test";
import { openEngine } from "./compose.ts";
import { EXTRA, OTHER_KITCHEN, fakeContentKey } from "./fakes/index.ts";
import { snapshots } from "./snapshot.ts";
import { recorder } from "./steps.ts";

const snap = snapshots("session.ops");

test("router ops on a fresh session: replies, op lines, files", async () => {
  const o = await openEngine();
  const c = o.caller;
  const { ok, err } = recorder(o, snap.match);
  try {
    await ok("status (empty)", {}, (i) => c.status(i));
    await ok("add kitchen (relative ref)", { video: "kitchen.mp4" }, (i) => c.add(i));
    await ok("add pantry", { video: "/videos/pantry.mov" }, (i) => c.add(i));
    await err("add kitchen again", { video: "/videos/kitchen.mp4" }, (i) => c.add(i));
    await err("add missing file", { video: "nope.mp4" }, (i) => c.add(i));
    await ok("clips.list", {}, (i) => c.clips.list(i));
    await ok("status (2 clips)", {}, (i) => c.status(i));

    await ok("config (read)", {}, (i) => c.config(i));
    await ok("config set group_sim", { key: "group_sim", value: "0.6" }, (i) => c.config(i));
    await ok("config set int key truncates", { key: "group_window", value: 3.7 }, (i) => c.config(i));
    await ok("config set back to default", { key: "group_window", value: 8 }, (i) => c.config(i));
    await ok("config key without value", { key: "threshold" }, (i) => c.config(i));
    await err("config unknown key", { key: "nope", value: 1 }, (i) => c.config(i));
    await err("config non-number", { key: "threshold", value: "abc" }, (i) => c.config(i));
    await err("config blank", { key: "threshold", value: " " }, (i) => c.config(i));

    await ok("sheet", {}, (i) => c.sheet(i));
    await ok("sheet frames", { frames: "0,4" }, (i) => c.sheet(i));
    await err("sheet no frames", { frames: "9" }, (i) => c.sheet(i));

    await ok("find jar", { prompt: "jar" }, (i) => c.find(i));
    await ok("find jar cached", { prompt: "jar", frames: "0-1" }, (i) => c.find(i));
    await ok("find container crops", { prompt: "container", crops: true }, (i) => c.find(i));
    await ok("find box on pantry", { prompt: "box", frames: "3-5" }, (i) => c.find(i));
    await ok("find lid, numeric frames", { prompt: "lid", frames: 0 }, (i) => c.find(i));
    await ok("find threshold", { prompt: "jar", threshold: 0.9 }, (i) => c.find(i));
    await ok("find cfg threshold", { prompt: "jar", cfg: { threshold: 0.9 } }, (i) => c.find(i));
    await ok("find cfg presence", { prompt: "jar", frames: "0-2", cfg: { presence: 0.99 } }, (i) => c.find(i));
    await ok("find raw prompt kept as typed", { prompt: "Glass  JAR", frames: "0" }, (i) => c.find(i));
    await err("find cfg unknown", { prompt: "jar", cfg: { nope: 1, also: 2 } }, (i) => c.find(i));

    // Frame specs go through dets because it renders nothing.
    for (const frames of ["", "0", "0-2", "2-0", "1-", "0,4", " 1 , 3 ", "1-3,3", "0-99", "99"])
      await (frames === "2-0" || frames === "1-" ? err : ok)(
        `frame spec ${JSON.stringify(frames)}`,
        { frames, threshold: 0 },
        (i) => c.dets(i),
      );
    for (const frames of ["-1", "abc", "1.5", "1-x", "0,,1"])
      await err(`frame spec ${JSON.stringify(frames)}`, { frames }, (i) => c.dets(i));

    const region = [10, 20, 90, 90] as [number, number, number, number];
    await ok("search prompt + similar", { frame: 1, box: region, prompt: "jar" }, (i) => c.search(i));
    await ok("search cached run", { frame: 1, box: region, prompt: "jar", similar: false }, (i) => c.search(i));
    await ok(
      "search similar only, reversed box",
      { frame: 4, box: [110, 110, 50, 30] as [number, number, number, number], k: 3 },
      (i) => c.search(i),
    );
    await ok("search unknown prompt", { frame: 4, box: region, prompt: "teapot", similar: false }, (i) => c.search(i));
    await err("search too small", { frame: 1, box: [0, 0, 15, 40] as [number, number, number, number] }, (i) =>
      c.search(i),
    );
    await err("search no frame", { frame: 99, box: region }, (i) => c.search(i));

    await ok("semantic jar", { prompt: "jar" }, (i) => c.semantic(i));
    await ok("semantic box on pantry", { prompt: "box", frames: "3-5" }, (i) => c.semantic(i));
    await ok("semantic mug (new runs, no hits)", { prompt: "mug", frames: "0" }, (i) => c.semantic(i));
    await ok("show", {}, (i) => c.show(i));
    await ok("show one frame crops", { frames: "0", crops: true }, (i) => c.show(i));
    await ok("show low threshold", { frames: "0", threshold: 0.3 }, (i) => c.show(i));
    await ok("crop", { id: "0.0" }, (i) => c.crop(i));
    await ok("similar", { id: "0.0" }, (i) => c.similar(i));
    await ok("similar k", { id: "3.2", k: 2 }, (i) => c.similar(i));
    await ok("dets", {}, (i) => c.dets(i));
    await ok("dets prompt crops", { prompt: "container", crops: true }, (i) => c.dets(i));
    await ok("dets frames threshold", { frames: "3-5", threshold: 0.85 }, (i) => c.dets(i));

    await ok("obj.new (aliases expand)", { label: "red jar", ids: ["0.0", "1.0"] }, (i) => c.obj.new(i));
    await ok("obj.add", { obj: "o1", ids: ["2.0", "3.0"] }, (i) => c.obj.add(i));
    await ok("obj.remove", { obj: "o1", ids: ["3.0"] }, (i) => c.obj.remove(i));
    await ok("obj.new second", { label: "orange jar", ids: ["0.1"] }, (i) => c.obj.new(i));
    await ok("obj.label unicode", { obj: "o2", label: "второй jar (café)" }, (i) => c.obj.label(i));
    await ok("obj.new takes from another object", { label: "tmp", ids: ["1.1", "0.1"] }, (i) => c.obj.new(i));
    await ok("obj.merge", { into: "o2", from: "o3" }, (i) => c.obj.merge(i));
    await ok("obj.new box", { label: "box", ids: ["3.2", "4.2"] }, (i) => c.obj.new(i));
    await ok("obj.delete", { obj: "o4" }, (i) => c.obj.delete(i));
    await ok("obj.show", { obj: "o1" }, (i) => c.obj.show(i));
    await ok("obj.show frames", { obj: "o1", frames: "0-1" }, (i) => c.obj.show(i));
    await ok("obj.show offset", { obj: "o1", offset: 1 }, (i) => c.obj.show(i));
    await ok("obj.suggest", { obj: "o1" }, (i) => c.obj.suggest(i));
    await ok("obj.suggest k threshold", { obj: "o2", k: 2, threshold: 0.3 }, (i) => c.obj.suggest(i));
    await ok("obj.match", { ids: ["3.0"] }, (i) => c.obj.match(i));
    await ok("obj.match own member, k", { ids: ["0.0", "4.0"], k: 1 }, (i) => c.obj.match(i));

    await ok("reject ids", { ids: ["5.2"] }, (i) => c.reject(i));
    await ok("reject takes from an object", { ids: ["1.1"] }, (i) => c.reject(i));
    await ok("reject prompt leftovers", { prompt: "lid" }, (i) => c.reject(i));
    await ok("reject nothing", {}, (i) => c.reject(i));
    await ok("show objects", { objects: true }, (i) => c.show(i));
    await ok("show rejects", { rejects: true }, (i) => c.show(i));

    await ok("todo", {}, (i) => c.todo(i));
    await ok("todo limit", { limit: 2 }, (i) => c.todo(i));
    await ok("todo crops", { crops: true }, (i) => c.todo(i));
    await ok("todo prompt", { prompt: "container" }, (i) => c.todo(i));
    await ok("todo frames", { frames: "3-5" }, (i) => c.todo(i));
    await ok("todo low threshold", { threshold: 0.3 }, (i) => c.todo(i));
    await ok("todo groups", { groups: true }, (i) => c.todo(i));
    await ok("todo groups offset", { groups: true, offset: 1 }, (i) => c.todo(i));
    await ok("todo groups cfg", { groups: true, cfg: { group_sim: 0.99, group_window: 1 } }, (i) => c.todo(i));
    await ok("gaps", {}, (i) => c.gaps(i));
    await ok("gaps frame", { frames: "0" }, (i) => c.gaps(i));

    await ok("data.history", undefined, (i) => c.data.history(i));
    await ok("reject nothing again (no line, no undo slot)", {}, (i) => c.reject(i));
    await ok("undo again", {}, (i) => c.undo(i));
    await ok("redo", {}, (i) => c.redo(i));
    await ok("data.history after undo/redo", undefined, (i) => c.data.history(i));
    await ok("new op clears redo", { obj: "o2", label: "orange jar" }, (i) => c.obj.label(i));
    await err("redo nothing", {}, (i) => c.redo(i));

    await ok("manifest", {}, (i) => c.manifest(i));
    await ok("manifest crops", { crops: true }, (i) => c.manifest(i));
    await ok("features", {}, (i) => c.features(i));
    await ok("features persist on", { persist: true }, (i) => c.features(i));
    await ok("find after persist (encodes nothing new)", { prompt: "jar", frames: "0" }, (i) => c.find(i));
    await ok("features clear", { clear: true }, (i) => c.features(i));
    await ok("features persist off", { persist: false }, (i) => c.features(i));

    await ok("data.frames", undefined, (i) => c.data.frames(i));
    await ok("data.dets", undefined, (i) => c.data.dets(i));
    await ok("data.dets png", { mask: "png" as const, frames: "0" }, (i) => c.data.dets(i));
    await ok("data.dets png again (cached file)", { mask: "png" as const, frames: "0" }, (i) => c.data.dets(i));
    await ok("data.dets none aliases", { mask: "none" as const, aliases: true, prompt: "jar" }, (i) => c.data.dets(i));
    await ok("data.dets threshold", { threshold: 0.9, mask: "none" as const }, (i) => c.data.dets(i));
    await ok("data.runs", undefined, (i) => c.data.runs(i));
    await ok("data.runs filtered", { prompt: "jar", frames: "3-5" }, (i) => c.data.runs(i));
    await ok("data.objects", undefined, (i) => c.data.objects(i));
    await ok("status", {}, (i) => c.status(i));

    await ok("add extra", { video: EXTRA }, (i) => c.add(i));
    await ok("find mug", { prompt: "mug" }, (i) => c.find(i));
    await ok("find jar on extra", { prompt: "jar", frames: "6-9", threshold: 0.3 }, (i) => c.find(i));
    await ok("obj.add extra det", { obj: "o1", ids: ["6.1"] }, (i) => c.obj.add(i));
    await ok("obj.new extra only", { label: "mug", ids: ["6.0"] }, (i) => c.obj.new(i));
    await ok("reject extra det", { ids: ["7.0"] }, (i) => c.reject(i));
    await ok("clips.list (3)", {}, (i) => c.clips.list(i));
    await ok("clips.remove extra", { clip: "extra.mp4" }, (i) => c.clips.remove(i));
    await err("clips.remove again", { clip: fakeContentKey("0a1b2c3d4e03") }, (i) => c.clips.remove(i));
    await err("clips.remove unknown", { clip: "nope.mp4" }, (i) => c.clips.remove(i));
    await ok("clips.list after remove", {}, (i) => c.clips.list(i));
    await ok("clips.list all", { all: true }, (i) => c.clips.list(i));
    await ok("status after remove", {}, (i) => c.status(i));
    await ok("data.frames after remove", undefined, (i) => c.data.frames(i));
    await ok("data.objects after remove", undefined, (i) => c.data.objects(i));
    await err("undo across clip_remove", {}, (i) => c.undo(i));
    await err("search removed frame", { frame: 6, box: region }, (i) => c.search(i));
    await ok("sheet skips removed frames", { frames: "4-7" }, (i) => c.sheet(i));
    await ok("add extra again (revive)", { video: "extra.mp4" }, (i) => c.add(i));
    await ok("find mug on revived frames", { prompt: "mug", frames: "6-9" }, (i) => c.find(i));
    await ok("data.dets revived", { frames: "6-9", mask: "none" as const }, (i) => c.data.dets(i));
    await ok("add other kitchen", { video: OTHER_KITCHEN }, (i) => c.add(i));
    await err("clips.remove ambiguous name", { clip: "elsewhere/kitchen.mp4" }, (i) => c.clips.remove(i));
    await ok("clips.remove by key", { clip: fakeContentKey("0a1b2c3d4e04") }, (i) => c.clips.remove(i));
    await ok("manifest after removals", {}, (i) => c.manifest(i));

    await err("crop unknown id", { id: "99.9" }, (i) => c.crop(i));
    await err("similar unknown id", { id: "0.99" }, (i) => c.similar(i));
    await err("obj.new unknown id", { label: "x", ids: ["0.0", "42.0"] }, (i) => c.obj.new(i));
    await err("obj.add unknown object", { obj: "o99", ids: ["0.0"] }, (i) => c.obj.add(i));
    await err("obj.remove unknown object", { obj: "o99", ids: ["0.0"] }, (i) => c.obj.remove(i));
    await err("obj.label unknown object", { obj: "o99", label: "x" }, (i) => c.obj.label(i));
    await err("obj.show unknown object", { obj: "o99" }, (i) => c.obj.show(i));
    await err("obj.delete reject set", { obj: "x" }, (i) => c.obj.delete(i));
    await err("obj.delete unknown", { obj: "o99" }, (i) => c.obj.delete(i));
    await err("obj.merge into rejects", { into: "x", from: "o1" }, (i) => c.obj.merge(i));
    await err("obj.merge itself", { into: "o1", from: "o1" }, (i) => c.obj.merge(i));
    await err("obj.merge unknown", { into: "o1", from: "o99" }, (i) => c.obj.merge(i));
    await err("obj.match unknown id", { ids: ["9.9"] }, (i) => c.obj.match(i));
    const empty = (await ok("obj.new for emptying", { label: "empty", ids: ["2.1"] }, (i) => c.obj.new(i))).id;
    await ok("obj.remove all members", { obj: empty, ids: ["2.1"] }, (i) => c.obj.remove(i));
    await err("obj.suggest empty object", { obj: empty }, (i) => c.obj.suggest(i));
    await ok("obj.show empty object", { obj: empty }, (i) => c.obj.show(i));
    await err("obj.new no ids (zod)", { label: "x", ids: [] }, (i) => c.obj.new(i));
    await err("find empty prompt (zod)", { prompt: "" }, (i) => c.find(i));
    await err("data.dets bad frames (query: mapped like mutations)", { frames: "x" }, (i) => c.data.dets(i));

    await ok("data.history final", undefined, (i) => c.data.history(i));

    const s = o.host.store;
    snap.match("files: session.json", s.text("session.json"));
    snap.match("files: runs.json", s.text("runs.json"));
    snap.match("files: dets.json", s.text("dets.json"));
    snap.match("files: objects.json", s.text("objects.json"));
    snap.match("files: ops.jsonl", s.text("ops.jsonl").split("\n"));
    snap.match("files: dets/0.0.npz (hex)", Buffer.from((await s.read("dets/0.0.npz")) ?? []).toString("hex"));
    snap.match("files: list", [...s.files.keys()].sort());
  } finally {
    o.close();
  }
});
