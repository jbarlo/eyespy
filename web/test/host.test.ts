import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { newHost } from "../../core/test/compose.ts";
import type { FakeHost } from "../../core/test/fakes/index.ts";
import type { FromWorker, InitOptions } from "../src/protocol.ts";
import { PRODUCTION_MODELS, PRODUCTION_RUNTIME } from "../src/engine/manifest.ts";
import { EngineHost, type AdapterDeps, type OpenAdapters } from "../src/engine/worker/host.ts";

type Sent = { readonly m: FromWorker; readonly transfer: readonly Transferable[] };

const OPTS: InitOptions = { models: PRODUCTION_MODELS, runtime: PRODUCTION_RUNTIME, session: { opfs: "t" } };

/** A host over a fake session; `sent` records every post, `deps` what the adapters were handed. */
function harness(t: TestContext, fake: FakeHost = newHost()) {
  const sent: Sent[] = [];
  const state: { deps: AdapterDeps | null; prepared: (string[] | undefined)[] } = { deps: null, prepared: [] };
  const open: OpenAdapters = async (_o, deps) => {
    state.deps = deps;
    return {
      root: "fake",
      device: "cpu",
      ports: { runtime: fake.models, store: fake.store, video: fake.video, codec: fake.codec },
      register: (file) => `ref:${file.name}`,
      prepare: async (names) => void state.prepared.push(names),
    };
  };
  const host = new EngineHost((m, transfer = []) => sent.push({ m, transfer }), open);
  // the engine's idle check is a real interval: shut every session down so the test process can end
  t.after(() => host.handle({ t: "rpc", id: -1, path: "shutdown", kind: "mutation", input: {} }));
  const reply = (id: number) => {
    const r = sent.find((s) => s.m.t === "reply" && s.m.id === id);
    assert.ok(r && r.m.t === "reply", `no reply ${id}`);
    return { ...r.m, transfer: r.transfer };
  };
  return { host, sent, state, reply, fake };
}

const errorOf = (r: { error?: { code: string; message: string } }) => {
  assert.ok(r.error, "expected an error reply");
  return r.error;
};

test("init opens the session once; a second init is an error", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "init", id: 1, opts: OPTS });
  assert.deepEqual(h.reply(1).result, { root: "fake", device: "cpu" });
  assert.ok(h.sent.some((s) => s.m.t === "event" && s.m.ev.kind === "ready"));
  await h.host.handle({ t: "init", id: 2, opts: OPTS });
  assert.match(errorOf(h.reply(2)).message, /already initialised/);
});

test("rpc: known op answers; unknown path NOT_FOUND; kind mismatch BAD_REQUEST; before init an error", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "rpc", id: 1, path: "status", kind: "mutation", input: {} });
  assert.match(errorOf(h.reply(1)).message, /not initialised/);
  await h.host.handle({ t: "init", id: 2, opts: OPTS });
  await h.host.handle({ t: "rpc", id: 3, path: "status", kind: "mutation", input: {} });
  assert.equal(h.reply(3).error, undefined);
  assert.equal(typeof h.reply(3).result, "object");
  await h.host.handle({ t: "rpc", id: 4, path: "data.frames", kind: "query" }); // a query without input
  assert.equal(h.reply(4).error, undefined);
  await h.host.handle({ t: "rpc", id: 5, path: "nope.op", kind: "mutation", input: {} });
  assert.equal(errorOf(h.reply(5)).code, "NOT_FOUND");
  await h.host.handle({ t: "rpc", id: 6, path: "data.frames", kind: "mutation", input: {} });
  assert.equal(errorOf(h.reply(6)).code, "BAD_REQUEST");
});

test("file: the bytes come back with their buffer in the transfer list; a missing file is null", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "init", id: 1, opts: OPTS });
  await h.fake.store.write("out/a.jpg", new Uint8Array([1, 2, 3]));
  await h.host.handle({ t: "file", id: 2, key: "out/a.jpg" });
  const r = h.reply(2);
  assert.ok(r.result instanceof Uint8Array);
  assert.deepEqual([...r.result], [1, 2, 3]);
  assert.deepEqual(r.transfer, [r.result.buffer]);
  await h.host.handle({ t: "file", id: 3, key: "out/none.jpg" });
  assert.equal(h.reply(3).result, null);
  assert.deepEqual(h.reply(3).transfer, []);
});

test("register and prepare go to the adapters", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "init", id: 1, opts: OPTS });
  await h.host.handle({ t: "register", id: 2, file: new File([new Uint8Array(4)], "v.mp4") });
  assert.equal(h.reply(2).result, "ref:v.mp4");
  await h.host.handle({ t: "prepare", id: 3, names: ["sam3"] });
  assert.equal(h.reply(3).result, true);
  assert.deepEqual(h.state.prepared, [["sam3"]]);
});

test("adapter events reach the page as they are (the unsupported-video notice among them)", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "init", id: 1, opts: OPTS });
  const ev = {
    kind: "unsupported",
    file: "v.mov",
    codec: "hvc1.2.4.L123.B0",
    codecName: "HEVC/H.265",
    reason: "r",
  } as const;
  h.state.deps?.emit(ev);
  assert.deepEqual(h.sent.at(-1)?.m, { t: "event", ev });
});

test("a malformed message is answered BAD_REQUEST when it has an id, else only logged", async (t) => {
  const h = harness(t);
  await h.host.handle({ t: "rpc", id: 7, kind: "mutation" }); // no path
  assert.equal(errorOf(h.reply(7)).code, "BAD_REQUEST");
  await h.host.handle("garbage");
  assert.equal(h.sent.filter((s) => s.m.t === "reply").length, 1);
  assert.ok(h.sent.some((s) => s.m.t === "event" && s.m.ev.kind === "log" && /malformed/.test(s.m.ev.text)));
});

test("a session that can't be opened replies with describeComposeError's words", async (t) => {
  const fake = newHost();
  await fake.store.writeText("session.json", JSON.stringify({ version: 2, config: {}, clips: [] }));
  const h = harness(t, fake);
  await h.host.handle({ t: "init", id: 1, opts: OPTS });
  assert.equal(
    errorOf(h.reply(1)).message,
    "cannot open fake: session.json version 2 is not supported (eyespy reads version 1)",
  );
});
