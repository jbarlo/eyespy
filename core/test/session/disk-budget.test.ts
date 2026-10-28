import assert from "node:assert/strict";
import { test } from "node:test";
import { openEngine } from "../compose.ts";
import { KITCHEN, PANTRY } from "../fakes/index.ts";
import { FEATURE_BYTES, MODEL_FILES } from "../../src/perception/pure.ts";

/** Room for exactly two feature files. */
const TWO_FILES_MB = Math.ceil((2 * FEATURE_BYTES) / 2 ** 20);

test("find over more keyframes than the budget: its frames are held, only the unstored one is encoded", async () => {
  // RAM for 2 frames, disk for 2 files, 3 keyframes
  const o = await openEngine(undefined, { persistFeatures: true, featureCacheMB: 1, featureDiskMB: TWO_FILES_MB });
  const featureFiles = () => [...o.host.store.files.keys()].filter((k) => k.includes("/feat/")).sort();
  try {
    await o.caller.add({ video: KITCHEN });
    await o.settle();
    const stored = featureFiles();
    assert.equal(stored.length, 2, "background encoding stayed within the budget");
    assert.ok(
      stored.every((k) => !k.endsWith("/000.f16")),
      "frame 0, encoded first, was evicted",
    );
    const encodes = o.host.models.calls[MODEL_FILES.vision] ?? 0;
    await o.caller.find({ prompt: "jar" });
    assert.equal((o.host.models.calls[MODEL_FILES.vision] ?? 0) - encodes, 1, "frame 0 encoded, 1 and 2 read");
    assert.deepEqual(featureFiles(), stored, "frame 0 kept in memory only: 1 and 2 were held by the find");
    assert.ok(o.host.logger.lines.some((l) => l.includes("frame 0 kept in memory only")));
  } finally {
    o.close();
  }
});

test("features {diskMB}: a lower budget evicts at once, the reply shows usage against it; unlimited lifts it", async () => {
  const o = await openEngine(undefined, { persistFeatures: true });
  try {
    await o.caller.add({ video: KITCHEN });
    await o.settle();
    const before = await o.caller.features({});
    assert.deepEqual([before.stored, before.storedBytes, before.diskMB], [3, 3 * FEATURE_BYTES, null]);
    const lower = await o.caller.features({ diskMB: 60 }); // one file
    assert.deepEqual([lower.evicted, lower.stored, lower.storedBytes, lower.diskMB], [2, 1, FEATURE_BYTES, 60]);
    const none = await o.caller.features({ diskMB: "unlimited" });
    assert.deepEqual([none.evicted, none.stored, none.diskMB], [0, 1, null]);
  } finally {
    o.close();
  }
});

test("reopen: recency comes from the store's mtimes and the budget applies at open", async () => {
  const o = await openEngine(undefined, { persistFeatures: true });
  await o.caller.add({ video: KITCHEN });
  await o.settle();
  o.close();
  const files = [...o.host.store.files.keys()].filter((k) => k.includes("/feat/")).sort();
  assert.equal(files.length, 3);
  // frame 1 most recently written, frame 2 least
  const [f0, f1, f2] = files;
  o.host.store.mtimes.set(f0 ?? "", 2000);
  o.host.store.mtimes.set(f1 ?? "", 3000);
  o.host.store.mtimes.set(f2 ?? "", 1000);
  const again = await openEngine(o.host, { persistFeatures: true, featureDiskMB: TWO_FILES_MB });
  try {
    const r = await again.caller.features({});
    assert.deepEqual([r.stored, r.storedBytes], [2, 2 * FEATURE_BYTES]);
    assert.deepEqual(
      [...again.host.store.files.keys()].filter((k) => k.includes("/feat/")).sort(),
      [f0, f1],
      "the least recently written file (frame 2) went",
    );
  } finally {
    again.close();
  }
});

/** Vision encodes per sweep of one-frame finds over 6 keyframes, with room for 4 files and 2 frames in RAM. */
async function perFrameSweeps(hold: string | undefined): Promise<readonly number[]> {
  const FOUR_FILES_MB = Math.ceil((4 * FEATURE_BYTES) / 2 ** 20);
  const o = await openEngine(undefined, { persistFeatures: true, featureCacheMB: 1, featureDiskMB: FOUR_FILES_MB });
  try {
    await o.caller.add({ video: KITCHEN });
    await o.caller.add({ video: PANTRY });
    await o.settle(); // encodes keyframes 0 to 5 once and stores 2 to 5
    const encodes = () => o.host.models.calls[MODEL_FILES.vision] ?? 0;
    const perSweep: number[] = [];
    for (const prompt of ["jar", "box", "lid"]) {
      // a new prompt each sweep, so every frame needs its features (a cached run would not)
      const before = encodes();
      for (const f of [0, 1, 2, 3, 4, 5]) await o.caller.find({ prompt, frames: String(f), hold });
      perSweep.push(encodes() - before);
    }
    return perSweep;
  } finally {
    o.close();
  }
}

test("a one-frame-per-call sweep over budget + 2 keyframes holding its scope re-encodes only those 2", async () => {
  assert.deepEqual(await perFrameSweeps("0-5"), [2, 2, 2], "only the overflow, every sweep");
  // without `hold`, each call evicts the file the next call needs. In this LRU worst case every keyframe re-encodes
  assert.deepEqual(await perFrameSweeps(undefined), [6, 6, 6]);
});
