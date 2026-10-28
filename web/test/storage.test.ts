import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_BYTES } from "eyespy-core/perception/pure";
import { clipsStorage, keyframesIn, summarizeStorage } from "../src/state/storage.ts";

const usage = {
  usage: 3 * 2 ** 30,
  quota: 12 * 2 ** 30,
  models: 1.8 * 2 ** 30,
  sessions: [
    { name: "small", total: 5_000_000, features: 0 },
    { name: "kitchen", total: 2 * FEATURE_BYTES + 4_000_000, features: 2 * FEATURE_BYTES },
    { name: "pantry", total: 54 * FEATURE_BYTES + 60_000_000, features: 54 * FEATURE_BYTES },
  ],
  persisted: false,
};

test("summarizeStorage: per session features vs the rest and keyframes stored, largest first, open marked", () => {
  const s = summarizeStorage(usage, "kitchen");
  assert.deepEqual(
    s.sessions.map((x) => [x.name, x.keyframes, x.other, x.open]),
    [
      ["pantry", 54, 60_000_000, false],
      ["kitchen", 2, 4_000_000, true],
      ["small", 0, 5_000_000, false],
    ],
  );
  assert.equal(s.features, 56 * FEATURE_BYTES);
  assert.equal(s.sessionsTotal, 56 * FEATURE_BYTES + 69_000_000);
  assert.equal(s.share, 0.25);
  assert.equal(s.models, usage.models);
  assert.equal(s.persisted, false);
});

test("summarizeStorage: no quota reported is no share; a folder session (open null) marks nothing", () => {
  const s = summarizeStorage({ ...usage, quota: 0 }, null);
  assert.equal(s.share, null);
  assert.ok(s.sessions.every((x) => !x.open));
});

test("summarizeStorage: features never exceed the total in 'other' (a file changing mid-walk)", () => {
  const s = summarizeStorage({ ...usage, sessions: [{ name: "x", total: 10, features: 12 }] }, null);
  assert.equal(s.sessions[0]?.other, 0);
});

test("clipsStorage: keyframe images vs features over clips, and the keyframes stored", () => {
  const clips = [
    { frame_bytes: 1_000_000, feature_bytes: 3 * FEATURE_BYTES },
    { frame_bytes: 500_000, feature_bytes: 0 },
  ];
  assert.deepEqual(clipsStorage(clips), {
    frames: 1_500_000,
    features: 3 * FEATURE_BYTES,
    total: 1_500_000 + 3 * FEATURE_BYTES,
    keyframes: 3,
  });
  assert.deepEqual(clipsStorage([]), { frames: 0, features: 0, total: 0, keyframes: 0 });
  assert.equal(keyframesIn(FEATURE_BYTES * 1.4), 1);
});
