import assert from "node:assert/strict";
import { test } from "node:test";
import { err, ok } from "neverthrow";
import type { FrameNo, FrameSlot } from "../../src/video/pure.ts";
import { bestOfEach, countsOf, isPhoto, simLabel } from "../../src/session/internal/replies.ts";

type Item = { id: number; key: string | null; score: number };

/** Reference version over one Map. */
const bestOfEachOracle = (xs: readonly Item[]) => {
  const m = new Map<string, Item>();
  for (const x of xs) {
    if (x.key === null) continue;
    const b = m.get(x.key);
    if (!b || x.score > b.score) m.set(x.key, x);
  }
  return [...m.values()];
};

let seed = 7;
const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;

test("bestOfEach: highest score per key, the first on ties, keys in first-appearance order, keyless left out", () => {
  const xs: Item[] = [
    { id: 0, key: "a", score: 0.5 },
    { id: 1, key: null, score: 0.99 },
    { id: 2, key: "b", score: 0.7 },
    { id: 3, key: "a", score: 0.9 },
    { id: 4, key: "b", score: 0.7 },
    { id: 5, key: "c", score: 0.1 },
    { id: 6, key: "a", score: 0.9 },
  ];
  assert.deepEqual(
    bestOfEach(
      xs,
      (x) => x.key,
      (x) => x.score,
    ).map((x) => x.id),
    [3, 2, 5],
  );
  assert.deepEqual(
    bestOfEach(
      [],
      () => "k",
      () => 0,
    ),
    [],
  );
});

test("bestOfEach agrees with the Map-per-item reduce on random input with many ties", () => {
  for (let round = 0; round < 50; round++) {
    const xs = Array.from({ length: 1 + rnd(300) }, (_, id): Item => ({
      id,
      key: rnd(10) === 0 ? null : `o${rnd(12)}\u0000${rnd(5)}`,
      score: rnd(6) / 5,
    }));
    assert.deepEqual(
      bestOfEach(
        xs,
        (x) => x.key,
        (x) => x.score,
      ),
      bestOfEachOracle(xs),
    );
  }
});

test("countsOf: occurrences per value, values in first-appearance order", () => {
  assert.deepEqual(countsOf(["jar", "box", "jar", "egg", "box", "jar"]), [
    ["jar", 3],
    ["box", 2],
    ["egg", 1],
  ]);
  assert.deepEqual(countsOf([]), []);
});

test("isPhoto and simLabel: a photo shows its position, a video frame its seconds", () => {
  const slotOf = (kind: "stills" | "video") => ({ clip: { timing: { kind } }, index: 0, t: 2 }) as unknown as FrameSlot;
  const video = (kind: "stills" | "video") => ({ slot: () => ok(slotOf(kind)) });
  const f = 4 as FrameNo;
  assert.equal(isPhoto(video("stills"), f), true);
  assert.equal(isPhoto(video("video"), f), false);
  assert.equal(isPhoto({ slot: () => err({ kind: "no-keyframe" as const, frame: 4 }) }, f), false);
  assert.equal(simLabel({ id: "4.1", t: 2, photo: true, sim: 0.5 }), "4.1 photo 2 sim 0.50");
  assert.equal(simLabel({ id: "4.1", t: 2, sim: 0.5 }), "4.1 2.0s sim 0.50");
});
