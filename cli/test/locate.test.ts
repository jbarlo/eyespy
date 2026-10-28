import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Result } from "neverthrow";
import { createLocator } from "../src/locate/index.ts";
import type { LocateError } from "../src/locate/index.ts";
import { MemFs } from "./fakes.ts";

const EMPTY = JSON.stringify({ version: 1, config: {}, clips: [] }, null, 1);
const at = (fs: MemFs, cwd = "/home/u/work") => createLocator({ fs, env: { cwd, cacheDir: "/cache/eyespy" } });

const failed = async <T>(r: PromiseLike<Result<T, LocateError>>) => {
  const res = await r;
  assert.ok(res.isErr(), "expected an error");
  return res._unsafeUnwrapErr();
};

test("walks up to the nearest session, like git", async () => {
  const fs = new MemFs()
    .put("/home/u/.eyespy/session.json", EMPTY)
    .put("/home/u/work/inner/.eyespy/session.json", EMPTY);
  fs.dirs.add("/home/u/work/inner/deep");
  assert.equal(
    (await at(fs, "/home/u/work/inner/deep").find({ videos: [] }))._unsafeUnwrap().root,
    "/home/u/work/inner",
  );
  assert.equal((await at(fs, "/home/u/work").find({ videos: [] }))._unsafeUnwrap().root, "/home/u");
  assert.deepEqual(await failed(at(new MemFs()).find({ videos: [] })), { kind: "not-in-session" });
});

test("-C names the session directly (relative to the working directory)", async () => {
  const fs = new MemFs().put("/home/u/work/s/.eyespy/session.json", EMPTY);
  assert.equal((await at(fs).find({ session: "s", videos: [] }))._unsafeUnwrap().root, "/home/u/work/s");
  assert.deepEqual(await failed(at(fs).find({ session: "nope", videos: [] })), { kind: "no-session-at", dir: "nope" });
});

test("init writes storage's empty session.json and refuses an existing session", async () => {
  const fs = new MemFs();
  assert.equal((await at(fs).init("new"))._unsafeUnwrap(), "/home/u/work/new");
  assert.equal(fs.text("/home/u/work/new/.eyespy/session.json"), EMPTY);
  assert.deepEqual(await failed(at(fs).init("new")), { kind: "already-session", root: "/home/u/work/new" });
  assert.equal((await at(fs, "/x").init(undefined))._unsafeUnwrap(), "/x");
});

const sha1 = (b: string | Uint8Array) => createHash("sha1").update(b).digest("hex");
/** A frame folder's content key (core's framesKey), for frames given in natural order. */
const framesKeyOf = (frames: readonly (readonly [string, string])[]) =>
  sha1(frames.map(([name, bytes]) => `${sha1(bytes)}  ${name}\n`).join("")).slice(0, 12);
const putFrames = (fs: MemFs, dir: string, frames: readonly (readonly [string, string])[]) =>
  frames.reduce((f, [name, bytes]) => f.put(`${dir}/${name}`, bytes), fs);

const A = [
  ["frame10.jpg", "a10"],
  ["frame2.jpg", "a2"],
] as const;
const B = [["1.png", "b1"]] as const;

test("headless: one cached session per set of clip contents, in any order", async () => {
  const fs = putFrames(putFrames(new MemFs(), "/v/a", A), "/v/b", B).put("/v/a/.DS_Store", "ignored");
  const keyA = framesKeyOf([A[1], A[0]]); // natural order: frame2 before frame10
  const key = sha1([keyA, framesKeyOf(B)].sort().join(",")).slice(0, 12);
  const root = (await at(fs).find({ videos: ["/v/b", "/v/a"] }))._unsafeUnwrap().root;
  assert.equal(root, `/cache/eyespy/${key}`);
  assert.equal(fs.text(`${root}/.eyespy/session.json`), EMPTY);
  const kept = JSON.stringify({ version: 1, config: { presence: 0.7 }, clips: [] });
  fs.put(`${root}/.eyespy/session.json`, kept);
  // the same frames in another folder give the same session
  putFrames(fs, "/moved/a", A);
  assert.equal((await at(fs).find({ videos: ["/moved/a", "/v/b"] }))._unsafeUnwrap().root, root);
  assert.equal(fs.text(`${root}/.eyespy/session.json`), kept);
  assert.deepEqual(await failed(at(fs).find({ videos: ["/v/a", "/v/gone"] })), {
    kind: "no-such-file",
    path: "/v/gone",
  });
});

test("headless: clips that aren't folders of frames are refused with a sentence", async () => {
  const fs = putFrames(new MemFs(), "/v/a", A).put("/v/clip.mov", "video bytes").put("/v/mixed/1.jpg", "x");
  fs.put("/v/mixed/notes.txt", "hi");
  fs.dirs.add("/v/empty");
  const refused = async (v: string) => {
    const e = await failed(at(fs).find({ videos: ["/v/a", v] }));
    assert.equal(e.kind, "not-a-clip");
    return "message" in e ? e.message : "";
  };
  assert.equal(
    await refused("/v/clip.mov"),
    "/v/clip.mov is a file; a clip is a folder of frames (extract them first, see the README)",
  );
  assert.equal(await refused("/v/empty"), "no frames in /v/empty (a clip is a folder of JPEG or PNG images)");
  assert.match(await refused("/v/mixed"), /has files that aren't JPEG or PNG frames: notes\.txt/);
});

test("headless: the clips the cached session has no live clip of, each frame hashed once", async () => {
  const clip = (key: string, removed?: number) => ({
    path: `/v/${key}`,
    key,
    times: [0],
    shape: [10, 10],
    ...(removed !== undefined ? { removed } : {}),
  });
  const meta = { version: 1, config: {}, clips: [clip(framesKeyOf([A[1], A[0]])), clip(framesKeyOf(B), 1700000000)] };
  const videos = ["/v/a", "/v/b"];
  const fs = putFrames(putFrames(new MemFs(), "/v/a", A), "/v/b", B);
  const fresh = (await at(fs).find({ videos }))._unsafeUnwrap();
  assert.deepEqual(fresh.missing, videos);
  fs.put(`${fresh.root}/.eyespy/session.json`, JSON.stringify(meta));
  const before = fs.hashes;
  assert.deepEqual((await at(fs).find({ videos }))._unsafeUnwrap(), { root: fresh.root, missing: ["/v/b"] });
  assert.equal(fs.hashes - before, 3, "each frame of each clip, once");
  fs.put(`${fresh.root}/.eyespy/session.json`, "{");
  assert.equal((await failed(at(fs).find({ videos }))).kind, "bad-session");
});

test("video: absolute path of an existing file", async () => {
  const fs = new MemFs().put("/home/u/work/c.mov", "x");
  assert.equal((await at(fs).video("c.mov"))._unsafeUnwrap(), "/home/u/work/c.mov");
  assert.deepEqual(await failed(at(fs).video("d.mov")), { kind: "no-such-file", path: "d.mov" });
});
