import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCClientError } from "@trpc/client";
import { OPS } from "eyespy-core/api/pure";
import { classify, createRpc, isNotRunning } from "../src/rpc/index.ts";
import { FakeServer } from "./fakes.ts";

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

test("classify: nothing listening (ENOENT / ECONNREFUSED anywhere in the cause chain) vs the server's message", () => {
  const enoent = new Error("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ENOENT" }) });
  const refused = new TRPCClientError("fetch failed", {
    cause: new Error("x", { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }),
  });
  assert.ok(isNotRunning(enoent));
  assert.deepEqual(classify(refused), { kind: "not-running" });
  assert.deepEqual(classify(new TRPCClientError("no object o99")), { kind: "op", message: "no object o99" });
  assert.deepEqual(classify("weird"), { kind: "op", message: "weird" });
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(isNotRunning(loop), false);
});

test("call: Ok / Err values, one connection per call, closed either way", async () => {
  const server = new FakeServer({
    status: () => STATUS,
    crop: () => {
      throw new TRPCClientError("no detection 9.9");
    },
  });
  const rpc = createRpc({ connect: server.connect, platform: "linux" });
  assert.deepEqual((await rpc.call("/s/sock", "status", {}))._unsafeUnwrapErr(), { kind: "not-running" });
  server.listening = true;
  assert.deepEqual((await rpc.call("/s/sock", "status", {}))._unsafeUnwrap(), STATUS);
  assert.deepEqual((await rpc.call("/s/sock", "crop", { id: "9.9" }))._unsafeUnwrapErr(), {
    kind: "op",
    message: "no detection 9.9",
  });
  server.listening = false;
  assert.deepEqual((await rpc.call("/s/sock", "status", {}))._unsafeUnwrapErr(), { kind: "not-running" });
  assert.equal(server.closed, server.calls.length);
  assert.deepEqual(
    server.calls.map((c) => c.socket),
    server.calls.map(() => "/s/sock"),
  );
});

test("call: a socket path too long for a unix socket is an error before any connection", async () => {
  const server = new FakeServer({ status: () => STATUS });
  server.listening = true;
  const long = `/${"d".repeat(95)}/.eyespy/sock`; // 109 bytes
  assert.deepEqual(
    (await createRpc({ connect: server.connect, platform: "linux" }).call(long, "status", {}))._unsafeUnwrapErr(),
    {
      kind: "socket-too-long",
      socket: long,
    },
  );
  assert.deepEqual(server.calls, []);
  const fits = `/${"d".repeat(94)}/.eyespy/sock`; // 108 bytes
  assert.ok((await createRpc({ connect: server.connect, platform: "linux" }).call(fits, "status", {})).isOk());
  assert.equal(
    (await createRpc({ connect: server.connect, platform: "darwin" }).call(fits, "status", {}))._unsafeUnwrapErr().kind,
    "socket-too-long",
  );
});

test("OPS covers the ops the CLI sends", () => {
  const paths = new Set<string>(OPS.map((o) => o.path));
  for (const p of ["status", "add", "clips.list", "find", "obj.new", "data.history", "shutdown"])
    assert.ok(paths.has(p));
});
