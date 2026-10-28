import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionLink } from "../src/commands/session.ts";
import type { SessionFlags } from "../src/commands/session.ts";
import { createLocator } from "../src/locate/index.ts";
import { createRpc } from "../src/rpc/index.ts";
import { createServerProcess } from "../src/serverproc/index.ts";
import { FakeServer, FakeSpawner, MemFs } from "./fakes.ts";

const EMPTY = JSON.stringify({ version: 1, config: {}, clips: [] }, null, 1);
const STATUS = {
  root: "/s",
  clips: [],
  keyframes: 0,
  encoded: 0,
  prompts: [],
  detections: 0,
  objects: 0,
  rejected: 0,
  todo: 0,
  assigned: 0,
};
const ADDED = { clip: "a", keyframes: 3, first: 0, captured: null, revived: false } as never;

const world = (flags: Partial<SessionFlags> = {}) => {
  const fs = new MemFs()
    .put("/s/.eyespy/session.json", EMPTY)
    .put("/v/a/000001.jpg", "frame 1 bytes")
    .put("/v/a/000002.jpg", "frame 2 bytes");
  const server = new FakeServer({ status: () => STATUS, add: () => ADDED, shutdown: () => ({ ok: true }) });
  const spawner = new FakeSpawner({ onSpawn: () => (server.listening = true) });
  const notices: string[] = [];
  const rpc = createRpc({ connect: server.connect, platform: "linux" });
  const deps = {
    locator: createLocator({ fs, env: { cwd: "/s", cacheDir: "/cache/eyespy" } }),
    server: createServerProcess(
      {
        spawner,
        fs,
        sleep: async () => {},
        notice: (l) => notices.push(l),
        answers: (socket) =>
          rpc.call(socket, "status", {}).match(
            () => true,
            (e) => e.kind === "op",
          ),
      },
      { command: "eyespy-server", cwd: "/code" },
    ),
    rpc,
    notice: (l: string) => notices.push(l),
  };
  const link = createSessionLink(deps, { videos: [], cfg: {}, ...flags });
  return { fs, server, spawner, notices, link };
};

test("call: starts the server when nothing listens, then sends the op with the call's cfg overrides", async () => {
  const w = world({ cfg: { presence: 0.9 }, idleMinutes: 2 });
  assert.deepEqual((await w.link.call("status", {}))._unsafeUnwrap(), STATUS);
  assert.deepEqual(w.notices, ["starting eyespy server..."]);
  assert.deepEqual(w.spawner.spawned[0]?.argv, ["--session", "/s", "--idle-minutes", "2"]);
  const sent = w.server.calls.filter((c) => c.path === "status").map((c) => c.input);
  assert.deepEqual(sent.at(0), { cfg: { presence: 0.9 } }, "the first attempt carries cfg");
  assert.deepEqual(sent.at(-1), { cfg: { presence: 0.9 } });
  assert.ok((await w.link.call("status", {})).isOk());
  assert.equal(w.spawner.spawned.length, 1);
});

test("call: errors from locate are worded", async () => {
  const w = world({ session: "/nope" });
  assert.deepEqual((await w.link.call("status", {}))._unsafeUnwrapErr(), { message: "no eyespy session at /nope" });
});

test("headless: missing clips are added once, before the first op, each line on stderr", async () => {
  const w = world({ videos: ["/v/a"] });
  w.server.listening = true;
  assert.ok((await w.link.call("status", {})).isOk());
  assert.equal(w.fs.hashes, 2, "each frame is hashed once, for both the session key and the check");
  assert.ok((await w.link.call("status", {})).isOk());
  assert.deepEqual(
    w.server.calls.map((c) => c.path),
    ["add", "status", "status"],
  );
  assert.deepEqual(w.server.calls[0]?.input, { video: "/v/a", fps: null, cfg: {} });
  assert.match(w.server.calls[0]?.socket ?? "", /^\/cache\/eyespy\/[0-9a-f]{12}\/\.eyespy\/sock$/);
  assert.deepEqual(w.notices, ["added a: keyframes #0–#2; encoding in background"]);
});

test("stop: not running, or shut down and wait for the socket to go", async () => {
  const w = world();
  assert.equal((await w.link.stop())._unsafeUnwrap(), "not running");
  w.server.listening = true;
  assert.equal((await w.link.stop())._unsafeUnwrap(), "stopped");
  assert.equal(w.server.calls.at(-1)?.path, "shutdown");
  assert.equal(w.spawner.spawned.length, 0);
});

test("a session path too long for a unix socket: one clear error, no server started", async () => {
  const root = `/${"d".repeat(100)}`;
  const w = world({ session: root });
  w.fs.put(`${root}/.eyespy/session.json`, EMPTY);
  const message = `the session path is too long for a unix socket: ${root}/.eyespy/sock`;
  assert.deepEqual((await w.link.call("status", {}))._unsafeUnwrapErr(), { message });
  assert.deepEqual((await w.link.stop())._unsafeUnwrapErr(), { message });
  assert.deepEqual(w.spawner.spawned, []);
  assert.deepEqual(w.server.calls, []);
});

test("init: creates the session, adds clips through its own server", async () => {
  const w = world();
  w.fs.dirs.add("/new");
  const r = await w.link.init("/new", ["/v/a"]);
  assert.equal(r._unsafeUnwrap(), "session created in /new\nadded a: keyframes #0–#2; encoding in background");
  assert.equal(w.server.calls.at(-1)?.socket, "/new/.eyespy/sock");
  assert.deepEqual((await w.link.init("/new", []))._unsafeUnwrapErr(), { message: "already a session: /new" });
  assert.deepEqual((await w.link.addClip("/v/zz"))._unsafeUnwrapErr(), { message: "no such file: /v/zz" });
});

test("--fps goes with every add of the call (add, init -a, -i); a file named with -i is refused before any op", async () => {
  const w = world({ fps: 4 });
  w.server.listening = true;
  assert.ok((await w.link.addClip("/v/a")).isOk());
  assert.deepEqual(w.server.calls.at(-1)?.input, { video: "/v/a", fps: 4, cfg: {} });
  const h = world({ videos: ["/v/clip.mov"] });
  h.fs.put("/v/clip.mov", "a video");
  h.server.listening = true;
  assert.deepEqual((await h.link.call("status", {}))._unsafeUnwrapErr(), {
    message: "/v/clip.mov is a file; a clip is a folder of frames (extract them first, see the README)",
  });
  assert.deepEqual(h.server.calls, []);
});
