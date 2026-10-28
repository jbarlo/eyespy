import assert from "node:assert/strict";
import { test } from "node:test";
import { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "eyespy-core/api";
import type { FromWorker, ToWorker } from "../src/protocol.ts";
import { EnginePort, resultOps, workerLink, wrap } from "../src/engine/port.ts";
import type { WorkerLike } from "../src/engine/port.ts";

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(m: unknown) {
    this.sent.push(m as ToWorker);
  }
  terminate() {
    this.terminated = true;
  }
  reply(m: FromWorker) {
    this.onmessage?.({ data: m } as MessageEvent);
  }
}

const idOf = (m: ToWorker | undefined) => {
  assert.ok(m && "id" in m);
  return m.id;
};

test("request resolves with the worker's reply and rejects with its error code", async () => {
  const w = new FakeWorker();
  const port = new EnginePort(w);
  const a = port.request({ t: "file", key: "a" });
  const b = port.request({ t: "file", key: "b" });
  w.reply({ t: "reply", id: idOf(w.sent[0]), result: 7 });
  w.reply({ t: "reply", id: idOf(w.sent[1]), error: { message: "nope", code: "BAD_REQUEST" } });
  assert.equal(await a, 7);
  await assert.rejects(b, (e: Error & { code?: string }) => e.message === "nope" && e.code === "BAD_REQUEST");
});

test("dispose terminates the worker and rejects pending and later calls", async () => {
  const w = new FakeWorker();
  const port = new EnginePort(w);
  let events = 0;
  port.on(() => events++);
  const pending = port.request({ t: "rpc", path: "status", kind: "mutation", input: {} });
  port.dispose();
  assert.equal(w.terminated, true);
  await assert.rejects(pending, (e: Error & { code?: string }) => e.code === "DISPOSED");
  await assert.rejects(port.request({ t: "file", key: "x" }), (e: Error & { code?: string }) => e.code === "DISPOSED");
  w.reply({ t: "event", ev: { kind: "log", text: "late" } });
  assert.equal(events, 0);
  port.dispose(); // idempotent
});

test("resultOps: failures become Err values with a kind", async () => {
  const w = new FakeWorker();
  const port = new EnginePort(w);
  const ops = resultOps(createTRPCClient<AppRouter>({ links: [workerLink(port)] }));
  const okCall = ops.data.history();
  const badCall = ops.obj.label({ obj: "o1", label: "x" });
  await new Promise((r) => setTimeout(r, 0));
  const [q, m] = w.sent;
  assert.ok(q?.t === "rpc" && q.path === "data.history" && q.kind === "query");
  assert.ok(m?.t === "rpc" && m.path === "obj.label" && m.kind === "mutation");
  w.reply({ t: "reply", id: q.id, result: { ops: [], undo: null, redo: null } });
  w.reply({ t: "reply", id: m.id, error: { message: "no object o1", code: "BAD_REQUEST" } });
  const r1 = await okCall;
  assert.ok(r1.isOk());
  const r2 = await badCall;
  assert.ok(r2.isErr());
  assert.deepEqual(r2.error, { kind: "user", code: "BAD_REQUEST", message: "no object o1" });
  const dead = ops.status();
  port.dispose();
  const r3 = await dead;
  assert.ok(r3.isErr() && r3.error.kind === "disposed");
});

test("wrap: revoke releases every object URL it handed out", async () => {
  const w = new FakeWorker();
  const port = new EnginePort(w);
  const { api, revoke } = wrap(port, createTRPCClient<AppRouter>({ links: [workerLink(port)] }));
  const u = api.file("clips/k/frames/000.jpg");
  w.reply({ t: "reply", id: idOf(w.sent[0]), result: new Uint8Array([1, 2, 3]) });
  const url = await u;
  assert.ok(url?.startsWith("blob:"));
  const revoked: string[] = [];
  const orig = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (x: string) => void revoked.push(x);
  try {
    revoke();
  } finally {
    URL.revokeObjectURL = orig;
  }
  assert.deepEqual(revoked, [url]);
});
