/** The socket edge against a real HTTP server on a unix socket, speaking tRPC's wire format. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRpc } from "../src/rpc/index.ts";
import { connectSocket } from "../src/rpc/node.ts";

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

/** Records each request's method, op and input; `crop` fails the way a tRPC router does. */
const listen = async (socket: string) => {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const op = url.pathname.slice(1);
      seen.push(`${req.method} ${op} ${req.method === "GET" ? url.searchParams.get("input") : body}`);
      res.setHeader("content-type", "application/json");
      if (op === "crop") {
        res.statusCode = 400;
        res.end(
          JSON.stringify({ error: { message: "no detection 9.9", code: -32600, data: { code: "BAD_REQUEST" } } }),
        );
      } else res.end(JSON.stringify({ result: { data: op === "status" ? STATUS : { ok: true } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

test("tRPC over node:http on a unix socket: queries, mutations, op errors, nothing listening", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eyespy-sock-"));
  const socket = path.join(dir, "sock");
  const rpc = createRpc({ connect: connectSocket, platform: process.platform });
  try {
    assert.deepEqual((await rpc.call(socket, "status", {}))._unsafeUnwrapErr(), { kind: "not-running" });
    const server = await listen(socket);
    assert.deepEqual((await rpc.call(socket, "status", {}))._unsafeUnwrap(), STATUS);
    assert.deepEqual((await rpc.call(socket, "data.history", {}))._unsafeUnwrap(), { ok: true });
    assert.deepEqual((await rpc.call(socket, "crop", { id: "9.9" }))._unsafeUnwrapErr(), {
      kind: "op",
      message: "no detection 9.9",
    });
    assert.deepEqual(server.seen, ["POST status {}", "GET data.history {}", 'POST crop {"id":"9.9"}']);
    await server.close();
    // a stale socket file (the server died without removing it) is "not running" too
    await writeFile(socket, "");
    assert.deepEqual((await rpc.call(socket, "status", {}))._unsafeUnwrapErr(), { kind: "not-running" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
