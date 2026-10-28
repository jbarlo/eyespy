/** Uses composeEngine, because composition reads session.json's `features` stamp to decide whether to trust features. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_FORMAT, MODEL_FILES } from "../../src/perception/pure.ts";
import { newHost, openEngine } from "../compose.ts";
import { KITCHEN, fakeHost, type MemStore } from "../fakes/index.ts";

const PERSIST = { persistFeatures: true };
const featureFiles = (store: MemStore) => [...store.files.keys()].filter((k) => /\/feat\//.test(k)).sort();
const stamp = (store: MemStore) => (JSON.parse(store.text("session.json")) as { features?: string }).features;

/** A session with KITCHEN added and every keyframe encoded and persisted; returns its store and keyframe count. */
async function encodedSession(): Promise<{ store: MemStore; keyframes: number }> {
  const host = newHost();
  const o = await openEngine(host, PERSIST);
  try {
    await o.caller.add({ video: KITCHEN });
    await o.settle();
    const keyframes = (await o.caller.status({})).keyframes;
    assert.ok(keyframes > 0);
    assert.equal(host.models.calls[MODEL_FILES.vision], keyframes);
    assert.equal(featureFiles(host.store).length, keyframes);
    assert.equal(stamp(host.store), FEATURE_FORMAT);
    return { store: host.store, keyframes };
  } finally {
    o.close();
  }
}

test("reopen: features stamped with this code's format are trusted: no vision run, not for a find either", async () => {
  const { store } = await encodedSession();
  const before = new Map(featureFiles(store).map((k) => [k, store.files.get(k)]));
  const host = fakeHost({ store });
  const o = await openEngine(host, PERSIST);
  try {
    await o.caller.find({ prompt: "jar" });
    await o.settle();
    assert.equal(host.models.calls[MODEL_FILES.vision] ?? 0, 0);
    assert.ok((host.models.calls[MODEL_FILES.detector.fp32] ?? 0) > 0); // the find did run, on stored features
    for (const [k, v] of before) assert.equal(store.files.get(k), v, `${k} untouched`);
  } finally {
    o.close();
  }
});

test("reopen: an old features stamp → every keyframe re-encoded, files overwritten, format stamped again", async () => {
  const { store, keyframes } = await encodedSession();
  const meta = JSON.parse(store.text("session.json")) as Record<string, unknown>;
  store.files.set(
    "session.json",
    new TextEncoder().encode(JSON.stringify({ ...meta, features: "an-older-feature-format" }, null, 1)),
  );
  const before = new Map(featureFiles(store).map((k) => [k, store.files.get(k)]));
  const host = fakeHost({ store });
  const o = await openEngine(host, PERSIST);
  try {
    await o.settle();
    assert.equal(host.models.calls[MODEL_FILES.vision], keyframes);
    for (const [k, v] of before) assert.notEqual(store.files.get(k), v, `${k} rewritten`);
    assert.equal(stamp(store), FEATURE_FORMAT);
  } finally {
    o.close();
  }
});
