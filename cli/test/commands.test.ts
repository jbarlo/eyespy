/**
 * Command handlers against a fake session link: the op and input each sends, the text (or --json) it prints, and its
 * usage errors (exit 2). The format tests pin the reply texts themselves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outputs } from "eyespy-core/api";
import * as exportCmd from "../src/commands/export.ts";
import * as findCmd from "../src/commands/find.ts";
import * as historyCmd from "../src/commands/history.ts";
import type { CliError, Env, Outcome } from "../src/commands/kit.ts";
import * as labelCmd from "../src/commands/label.ts";
import * as lookCmd from "../src/commands/look.ts";
import { parseBox } from "../src/commands/options.ts";
import * as videosCmd from "../src/commands/videos.ts";
import * as configCmd from "../src/commands/config.ts";
import { json, reply } from "../src/format/index.ts";
import type { Hit, Obj } from "../src/format/index.ts";
import { FakeFiles, FakeLink } from "./fakes.ts";

// only validation makes brands (DetId, FrameNo, ObjectId), so fixtures cast through `never` once, here
const H1: Hit = { id: "3.1", frame: 3, t: 1.25, score: 0.876, box: [10, 20, 110, 220], prompts: ["jar"] } as never;
const OBJ: Obj = {
  id: "o1",
  label: "jar",
  sightings: 1,
  members: ["3.1"],
  first_t: 1.25,
  last_t: 1.25,
  best: "3.1",
  prompts: { jar: 0.876 },
} as never;
const FIND: Outputs["find"] = {
  prompt: "jar",
  seconds: 1,
  presence: {},
  present: [],
  image: null,
  hits: [H1],
};
const MANIFEST: Outputs["manifest"] = {
  meta: { model: "m" } as never,
  items: [{ label: "jar", count: 1 }],
  objects: [OBJ],
  image: "/s/m.jpg",
};

const envOf = (link: FakeLink, opts: { json?: boolean; files?: FakeFiles } = {}): Env => ({
  json: opts.json ?? false,
  session: link,
  files: opts.files ?? new FakeFiles(),
});
const ok = async (o: Outcome) => (await o)._unsafeUnwrap();
const failed = async (o: Outcome): Promise<CliError> => (await o)._unsafeUnwrapErr();

test("find sends its prompt and options, prints the reply's text or its JSON", async () => {
  const link = new FakeLink({ find: FIND });
  const opts = { frames: "1-3", crops: true, threshold: 0.4 };
  assert.equal(await ok(findCmd.find({ prompt: "jar" }, opts, envOf(link))), reply.find(FIND, "jar"));
  assert.deepEqual(link.calls, [{ path: "find", input: { prompt: "jar", ...opts } }]);
  assert.equal(await ok(findCmd.find({ prompt: "jar" }, {}, envOf(link, { json: true }))), json(FIND));
});

test("search: a box that isn't four numbers is a usage error and sends nothing", async () => {
  const link = new FakeLink({});
  for (const box of ["1,2,3", "a,b,c,d", "1,,2,3", "1,2,3,4,5", ""]) {
    assert.deepEqual(await failed(findCmd.search({ frame: 3, box }, { k: 8 }, envOf(link))), {
      message: "box must be x0,y0,x1,y1",
      exitCode: 2,
    });
  }
  assert.equal(link.calls.length, 0);
});

test("parseBox", () => {
  assert.deepEqual(parseBox("1,2.5,3,4"), [1, 2.5, 3, 4]);
  assert.equal(parseBox("1,,2,3"), null);
  assert.equal(parseBox("1,2,3, "), null);
  assert.equal(parseBox("1,2,3"), null);
});

test("clips: list, rm <clip>, and the usage errors", async () => {
  const list: Outputs["clips.list"] = { clips: [] };
  const link = new FakeLink({
    "clips.list": list,
    "clips.remove": { removed: "a.mov", frames: [0, 2], detections: 1, stripped: 0, deleted: [] } as never,
  });
  assert.equal(await ok(videosCmd.clips({}, { all: true }, envOf(link))), reply.clipsTable(list));
  assert.deepEqual(link.calls[0], { path: "clips.list", input: { all: true } });
  assert.deepEqual(await failed(videosCmd.clips({ action: "ls" }, {}, envOf(link))), {
    message: "unknown clips action ls; use: eyespy clips rm <path|name|key>",
    exitCode: 2,
  });
  assert.deepEqual(await failed(videosCmd.clips({ action: "rm" }, {}, envOf(link))), {
    message: "which clip? eyespy clips rm <path|name|key>",
    exitCode: 2,
  });
  assert.equal(link.calls.length, 1);
  assert.ok((await videosCmd.clips({ action: "rm", clip: "a.mov" }, {}, envOf(link))).isOk());
  assert.deepEqual(link.calls[1], { path: "clips.remove", input: { clip: "a.mov" } });
});

test("init, add and stop go through the session link", async () => {
  const link = new FakeLink();
  assert.equal(await ok(videosCmd.init({ dir: "d" }, { add: ["a.mov"] }, envOf(link))), "session created in d");
  assert.deepEqual(link.inits, [{ dir: "d", clips: ["a.mov"] }]);
  assert.ok((await videosCmd.init({}, {}, envOf(link))).isOk());
  assert.deepEqual(link.inits[1], { dir: undefined, clips: [] });
  assert.equal(await ok(videosCmd.add({ video: "b.mov" }, {}, envOf(link))), "added b.mov");
  assert.equal(await ok(videosCmd.stop({}, {}, envOf(link))), "stopped");
});

test("reject: ids, a prompt, or a usage error", async () => {
  const link = new FakeLink({ reject: { rejected: ["3.1"], objects: [] } as never });
  assert.deepEqual(await failed(labelCmd.reject({}, {}, envOf(link))), {
    message: "give detection ids or --prompt",
    exitCode: 2,
  });
  assert.deepEqual(await failed(labelCmd.reject({ ids: [] }, {}, envOf(link))), {
    message: "give detection ids or --prompt",
    exitCode: 2,
  });
  assert.ok((await labelCmd.reject({}, { prompt: "jar" }, envOf(link))).isOk());
  assert.ok((await labelCmd.reject({ ids: ["3.1"] }, {}, envOf(link))).isOk());
  assert.deepEqual(
    link.calls.map((c) => c.input),
    [
      { ids: [], prompt: "jar" },
      { ids: ["3.1"], prompt: undefined },
    ],
  );
});

test("obj: each subcommand sends its op; delete prints text even with --json", async () => {
  const link = new FakeLink({
    "obj.new": OBJ,
    "obj.merge": OBJ,
    "obj.delete": { deleted: "o1" } as never,
  });
  assert.equal(await ok(labelCmd.objNew({ label: "jar", ids: ["3.1"] }, {}, envOf(link))), reply.obj(OBJ));
  assert.equal(await ok(labelCmd.objMerge({ into: "o1", from: "o2" }, {}, envOf(link, { json: true }))), json(OBJ));
  const deleted = await ok(labelCmd.objDelete({ obj: "o1" }, {}, envOf(link, { json: true })));
  assert.equal(deleted, reply.objDeleted({ deleted: "o1" } as never));
  assert.deepEqual(link.calls, [
    { path: "obj.new", input: { label: "jar", ids: ["3.1"] } },
    { path: "obj.merge", input: { into: "o1", from: "o2" } },
    { path: "obj.delete", input: { obj: "o1" } },
  ]);
});

test("todo: hits or --groups, and a reply of the other kind is an error", async () => {
  const hits: Outputs["todo"] = { total: 1, image: null, hits: [H1] };
  const groups: Outputs["todo"] = { total: 1, groups_total: 1, image: null, groups: [] };
  const opts = { limit: 64, offset: 12 };
  assert.equal(await ok(lookCmd.todo({}, opts, envOf(new FakeLink({ todo: hits })))), reply.todo(hits as never));
  const grouped = new FakeLink({ todo: groups });
  assert.equal(await ok(lookCmd.todo({}, { ...opts, groups: true }, envOf(grouped))), reply.todoGroups(groups, 12));
  assert.deepEqual(grouped.calls[0]?.input, {
    crops: undefined,
    threshold: undefined,
    prompt: undefined,
    limit: 64,
    frames: undefined,
    groups: true,
    offset: 12,
  });
  assert.deepEqual(await failed(lookCmd.todo({}, { ...opts, groups: true }, envOf(new FakeLink({ todo: hits })))), {
    message: "server did not return groups",
  });
  assert.deepEqual(await failed(lookCmd.todo({}, opts, envOf(new FakeLink({ todo: groups })))), {
    message: "server did not return hits",
  });
});

test("export writes the manifest without its image, then says so; a failed write fails the command", async () => {
  const files = new FakeFiles();
  const link = new FakeLink({ manifest: MANIFEST });
  assert.equal(
    await ok(exportCmd.exportManifest({ file: "/w/e.json" }, {}, envOf(link, { files }))),
    reply.exported(MANIFEST, "/w/e.json"),
  );
  const { image: _image, ...rest } = MANIFEST;
  assert.equal(files.written.get("/w/e.json"), JSON.stringify(rest, null, 1) + "\n");
  assert.deepEqual(
    await failed(exportCmd.exportManifest({ file: "/w/e.json" }, {}, envOf(link, { files: new FakeFiles("EACCES") }))),
    { message: "EACCES" },
  );
  assert.equal(await ok(exportCmd.manifest({}, { crops: true }, envOf(link))), reply.manifest(MANIFEST));
  assert.deepEqual(link.calls.at(-1), { path: "manifest", input: { crops: true } });
});

test("history keeps the last n; config passes key and value; a session failure comes through unchanged", async () => {
  const history: Outputs["data.history"] = {
    undo: null,
    redo: null,
    ops: [
      { seq: 1, op: "new", obj: "o1", label: "a", undoable: true, undone: false, objects: ["o1"] },
      { seq: 2, op: "label", obj: "o1", label: "b", undoable: true, undone: false, objects: ["o1"] },
    ],
  };
  const link = new FakeLink({ "data.history": history });
  assert.equal(await ok(historyCmd.history({}, { n: 1 }, envOf(link))), reply.history(history, 1));
  assert.deepEqual(link.calls[0], { path: "data.history", input: {} });
  const cfgLink = new FakeLink({ config: { config: {}, defaults: {} } as never });
  assert.ok((await configCmd.config({ key: "presence", value: "0.7" }, {}, envOf(cfgLink))).isOk());
  assert.deepEqual(cfgLink.calls[0], { path: "config", input: { key: "presence", value: "0.7" } });
  const down = new FakeLink({}, { message: "no eyespy session at /nope" });
  assert.deepEqual(await failed(lookCmd.gaps({}, {}, envOf(down))), { message: "no eyespy session at /nope" });
});
