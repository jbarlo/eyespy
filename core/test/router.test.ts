import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TRPCError } from "@trpc/server";
import { openEngine, type Opened } from "./compose.ts";
import { KITCHEN } from "./fakes/index.ts";
import { snapshots } from "./snapshot.ts";
import { errorRecord } from "./steps.ts";

const snap = snapshots("router");
let o: Opened;

before(async () => {
  o = await openEngine();
  await o.caller.add({ video: KITCHEN });
  await o.settle();
  await o.caller.find({ prompt: "jar" });
});
after(() => o.close());

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof TRPCError, `expected a TRPCError, got ${String(e)}`);
    return errorRecord(e);
  }
  return assert.fail("expected the call to fail");
};

test("cfg: unknown keys are a BAD_REQUEST naming them, sorted", async () => {
  const e = await failure(o.caller.dets({ cfg: { zeta: 1, alpha: 2, threshold: 0.5 } }));
  snap.match("cfg unknown keys", e);
  assert.equal(e.code, "BAD_REQUEST");
  assert.equal(e.message, "unknown setting(s) alpha, zeta");
});

test("cfg: overrides apply to one call only, ints are truncated, nothing is saved", async () => {
  const before = o.host.store.text("session.json");
  const m = await o.caller.manifest({ cfg: { group_window: 3.9, threshold: 0.25 } });
  assert.equal(m.meta.config.group_window, 3);
  assert.equal(m.meta.config.threshold, 0.25);
  const next = await o.caller.manifest({});
  assert.equal(next.meta.config.group_window, 8);
  assert.equal(next.meta.config.threshold, 0.5);
  assert.equal(o.host.store.text("session.json"), before);
  snap.match("cfg manifest config", m.meta.config);
});

test("cfg: threshold override filters find like the threshold argument", async () => {
  const viaCfg = await o.caller.find({ prompt: "jar", cfg: { threshold: 0.9 } });
  const viaArg = await o.caller.find({ prompt: "jar", threshold: 0.9 });
  assert.deepEqual(
    viaCfg.hits.map((h) => h.id),
    viaArg.hits.map((h) => h.id),
  );
  const all = await o.caller.find({ prompt: "jar", threshold: 0 });
  assert.ok(all.hits.length > viaCfg.hits.length);
  // the argument wins over the cfg override
  const both = await o.caller.find({ prompt: "jar", threshold: 0, cfg: { threshold: 0.9 } });
  assert.equal(both.hits.length, all.hits.length);
});

test("frames: numbers and strings are the same spec; null and empty mean all frames", async () => {
  const ids = async (frames: string | number | null | undefined) =>
    (await o.caller.dets({ frames, threshold: 0 })).hits.map((h) => h.id);
  assert.deepEqual(await ids(1), await ids("1"));
  assert.deepEqual(await ids(0), await ids("0"));
  const all = await ids(undefined);
  assert.deepEqual(await ids(null), all);
  assert.deepEqual(await ids(""), all);
  snap.match("frames 1", await ids(1));
});

test("errors: user errors on mutations are BAD_REQUEST, zod failures too, with the message kept", async () => {
  const cases = {
    "user error (mutation)": await failure(o.caller.crop({ id: "9.9" })),
    "zod: empty ids": await failure(o.caller.obj.new({ label: "x", ids: [] })),
    "zod: wrong type": await failure(o.caller.find({ prompt: "jar", threshold: "high" as unknown as number })),
    "zod: k not positive": await failure(o.caller.similar({ id: "0.0", k: 0 })),
    "zod: cfg value not a number": await failure(o.caller.dets({ cfg: { threshold: "0.3" as unknown as number } })),
  };
  snap.match("error mapping", cases);
  for (const e of Object.values(cases)) assert.equal(e.code, "BAD_REQUEST");
});

test("errors: user errors in queries (data.*) map like mutations: BAD_REQUEST", async () => {
  const e = await failure(o.caller.data.dets({ frames: "nope" }));
  snap.match("query user error", e);
  assert.equal(e.code, "BAD_REQUEST");
});

test("queries: data.objects answers the same with no input and with {}; data.runs filters by frames", async () => {
  const a = await o.caller.data.objects();
  const b = await o.caller.data.objects({});
  assert.deepEqual(a, b);
  const runs = await o.caller.data.runs({ frames: 0 });
  assert.deepEqual(
    runs.runs.map((r) => r.frame),
    [0],
  );
});

test("shutdown replies first, then stops the engine; later calls fail", async () => {
  const p = await openEngine();
  assert.deepEqual(await p.caller.shutdown(), { ok: true });
  assert.equal(p.exited(), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(p.exited(), true);
  const e = await failure(p.caller.status({}));
  snap.match("after shutdown", e);
});
