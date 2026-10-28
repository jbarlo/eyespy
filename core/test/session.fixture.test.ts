/**
 * The session-fake fixture must equal a fresh build through the fakes byte for byte (UPDATE=1 rewrites it). It has no
 * features (RAM-only in tests) and no out/ renders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openEngine } from "./compose.ts";
import { KITCHEN, MemStore, PANTRY, fakeHost } from "./fakes/index.ts";
import { UPDATE, snapshots } from "./snapshot.ts";
import { recorder } from "./steps.ts";

const DIR = fileURLToPath(new URL("fixtures/session-fake", import.meta.url));
const snap = snapshots("session.fixture");
const KEEP = (k: string) => !k.startsWith("out/");

async function build(): Promise<MemStore> {
  const o = await openEngine();
  const c = o.caller;
  const step = async (f: () => Promise<unknown>) => {
    o.host.clock.advance(1234);
    await f();
    await o.settle();
  };
  try {
    await step(() => c.add({ video: KITCHEN }));
    await step(() => c.add({ video: PANTRY }));
    await step(() => c.find({ prompt: "jar" }));
    await step(() => c.find({ prompt: "container" }));
    await step(() => c.find({ prompt: "box", frames: "3-5" }));
    await step(() => c.find({ prompt: "lid", frames: "0-2" }));
    await step(() => c.obj.new({ label: "red jar", ids: ["0.0", "3.0"] }));
    await step(() => c.obj.new({ label: "orange jar", ids: ["0.1", "1.1"] }));
    await step(() => c.obj.label({ obj: "o2", label: "orange jar (small)" }));
    await step(() => c.obj.new({ label: "green box", ids: ["3.2"] }));
    await step(() => c.reject({ ids: ["0.2"] }));
    await step(() => c.reject({ prompt: "lid" }));
    await step(() => c.undo({}));
    await step(() => c.redo({}));
    await step(() => c.obj.add({ obj: "o1", ids: ["1.0", "2.0"] }));
    return o.host.store;
  } finally {
    o.close();
  }
}

const differing = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => {
    const x = a.get(k),
      y = b.get(k);
    return !x || !y || Buffer.compare(x, y) !== 0;
  });

test("fake fixture: a fresh build equals the committed folder; two builds are identical", async () => {
  const first = await build();
  const second = await build();
  assert.deepEqual(differing(first.files, second.files), [], "two builds differ");
  const built = new Map([...first.files].filter(([k]) => KEEP(k)));
  if (UPDATE) first.toDir(DIR, KEEP);
  const committed = MemStore.fromDir(DIR).files;
  assert.deepEqual(differing(built, committed), [], "fixtures/session-fake is stale (UPDATE=1 to rebuild)");
  const bytes = [...committed.values()].reduce((a, b) => a + b.byteLength, 0);
  assert.ok(bytes < 200_000, `fixture is ${bytes} bytes`);
});

test("fake fixture: ops on the loaded session", async () => {
  const o = await openEngine(fakeHost({ store: MemStore.fromDir(DIR) }));
  const c = o.caller;
  const { ok } = recorder(o, snap.match);
  try {
    await ok("status", {}, (i) => c.status(i));
    await ok("data.objects", undefined, (i) => c.data.objects(i));
    await ok("data.history", undefined, (i) => c.data.history(i));
    await ok("todo", {}, (i) => c.todo(i));
    await ok("todo groups", { groups: true }, (i) => c.todo(i));
    await ok("find jar (all cached)", { prompt: "jar" }, (i) => c.find(i));
    await ok("undo", {}, (i) => c.undo(i));
    await ok("manifest crops", { crops: true }, (i) => c.manifest(i));
  } finally {
    o.close();
  }
});
