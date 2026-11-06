/** The association rule, and what a parked track does around a keyframe that waits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MASK_SIZE } from "../../src/perception/pure.ts";
import {
  EMPTY_TRACK_INDEX,
  associate,
  convergedGroups,
  nextAssociation,
  nextUnit,
  parkRule,
  type PendingFrame,
  type TrackIndex,
  type TrackRecord,
} from "../../src/tracking/pure.ts";
import type { DetId } from "../../src/detections/pure.ts";
import type { ClipKey, FrameNo } from "../../src/video/pure.ts";

/** A rectangle on the tracker's plane. */
const rect = (x0: number, y0: number, x1: number, y1: number): Uint8Array => {
  const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
  for (let y = y0; y < y1; y++) out.fill(1, y * MASK_SIZE + x0, y * MASK_SIZE + x1);
  return out;
};
const det = (id: string, plane: Uint8Array, score = 0.9) => ({ id, plane, score });
const track = (id: string, mask: Uint8Array, score = 6) => ({ id, mask, score });

test("the same object: IoU of 0.5 or more", () => {
  const r = associate([det("d", rect(10, 10, 30, 30))], [track("t", rect(12, 10, 32, 30))]);
  assert.deepEqual(
    r.matches.map((m) => [m.det, m.track]),
    [["d", "t"]],
  );
  assert.deepEqual(r.seeds, []);
});

test("the same object: mostly inside and not much smaller, which is below IoU 0.5", () => {
  // Detection 20×20 = 400. Track 20×30 = 600, holding 0.75 of it, so the ratio is 0.67 and IoU is 300 / 700.
  const r = associate([det("d", rect(10, 10, 30, 30))], [track("t", rect(10, 15, 30, 45))]);
  assert.equal(r.matches[0]?.track, "t");
  assert.ok((r.matches[0]?.iou ?? 1) < 0.5);
});

test("a small detection inside a large track is another object: the size ratio says so", () => {
  // As street f51: a car of 47 pixels inside a track of 142, all of it covered, IoU about 0.3.
  const r = associate([det("car", rect(10, 10, 20, 15))], [track("cluster", rect(5, 5, 25, 25))]);
  assert.deepEqual(r.matches, []);
  assert.deepEqual(r.seeds, ["car"]);
});

test("the sedan: a far track that jumped onto it covers it well but scores low, and can't stop its seed", () => {
  // As street f49 with the keyframe-only track: 103 pixels, track 94 on it, IoU 0.73, track score 1.25.
  const sedan = rect(100, 100, 111, 110);
  const jumped = rect(101, 100, 111, 110);
  const r = associate([det("sedan", sedan)], [track("far", jumped, 1.25)]);
  assert.deepEqual(r.matches, []);
  assert.deepEqual(r.seeds, ["sedan"]);
  assert.equal(r.weak[0]?.track, "far");
  assert.equal(r.weak[0]?.score, 1.25);
});

test("the same masks with a sure track are a match, which is why a jump that scores well isn't caught", () => {
  const sedan = rect(100, 100, 111, 110);
  const r = associate([det("sedan", sedan)], [track("far", rect(101, 100, 111, 110), 3.88)]);
  assert.equal(r.matches[0]?.track, "far");
});

test("one to one: of two detections on a track the better fit keeps it, and the other seeds", () => {
  const t = rect(10, 10, 40, 40);
  const fair = rect(14, 10, 44, 34);
  const r = associate([det("fair", fair, 0.95)], [track("t", t)]);
  assert.equal(r.matches[0]?.det, "fair", "alone it matches");
  const one = associate(
    [det("left", rect(10, 10, 34, 30), 0.95), det("right", rect(32, 10, 60, 30), 0.8)],
    [track("t", rect(30, 10, 60, 30))],
  );
  assert.deepEqual(
    one.matches.map((m) => m.det),
    ["right"],
  );
  assert.deepEqual(one.seeds, ["left"]);
});

test("one to one: of two tracks on a detection the better fit takes it, and the other stays free", () => {
  const d = rect(10, 10, 40, 40);
  const r = associate(
    [det("d", d), det("e", rect(100, 100, 130, 130))],
    [
      track("loose", rect(14, 10, 44, 40)),
      track("tight", rect(11, 10, 41, 40)),
      track("e-track", rect(100, 100, 130, 130)),
    ],
  );
  assert.deepEqual(r.matches.map((m) => [m.det, m.track]).toSorted(), [
    ["d", "tight"],
    ["e", "e-track"],
  ]);
});

test("a competition between detections and tracks goes to the best pairs, whatever the order", () => {
  const a = rect(10, 10, 40, 40);
  const b = rect(24, 10, 54, 40);
  const fits = (dets: Parameters<typeof associate>[0]) =>
    associate(dets, [track("ta", rect(10, 10, 40, 40)), track("tb", rect(24, 10, 54, 40))])
      .matches.map((m) => [m.det, m.track])
      .toSorted();
  // a and b overlap by less than either rule, and each has its own exact track.
  assert.deepEqual(fits([det("a", a), det("b", b)]), [
    ["a", "ta"],
    ["b", "tb"],
  ]);
  assert.deepEqual(fits([det("b", b), det("a", a)]), [
    ["a", "ta"],
    ["b", "tb"],
  ]);
});

test("bottle and jar on one thing: the better detection stands for both, once", () => {
  const thing = rect(50, 50, 80, 110);
  const r = associate([det("jar", rect(51, 50, 80, 110), 0.7), det("bottle", thing, 0.9)], []);
  assert.deepEqual(r.seeds, ["bottle"]);
  assert.deepEqual(r.dups, [{ det: "jar", of: "bottle" }]);
});

test("too small to seed", () => {
  const r = associate([det("speck", rect(5, 5, 9, 9))], []);
  assert.deepEqual(r.small, ["speck"]);
  assert.deepEqual(r.seeds, []);
});

test("converged tracks group from two frames on, and a chain is one group", () => {
  const pairs = [
    { a: "t1", b: "t2", frames: 3 },
    { a: "t2", b: "t3", frames: 2 },
    { a: "t4", b: "t5", frames: 1 },
  ];
  assert.deepEqual(convergedGroups(["t1", "t2", "t3", "t4", "t5"], pairs, 2), [["t1", "t2", "t3"], ["t4"], ["t5"]]);
});

const clip = "0a1b2c3d4e01" as ClipKey;
const record = (over: Partial<TrackRecord>): TrackRecord => ({
  id: "t1",
  det: "0.1" as DetId,
  clip,
  seedAt: 0,
  clipFrames: 40,
  first: 0,
  last: 39,
  priority: 0,
  state: "active",
  failure: null,
  seeded: true,
  forward: 0,
  reverse: 0,
  ...parkRule(2, 1.5),
  forwardMisses: 0,
  reverseMisses: 0,
  skipped: 0,
  seenFirst: 0,
  seenLast: 0,
  seenCount: 1,
  auto: false,
  ...over,
});
const pendingAt = (at: number): PendingFrame => ({
  clip,
  at,
  frame: at as FrameNo,
  threshold: 0.5,
  maxTracks: 32,
  ...parkRule(2, 1.5),
});
const indexOf = (tracks: readonly TrackRecord[], pending: readonly PendingFrame[] = []): TrackIndex => ({
  ...EMPTY_TRACK_INDEX,
  tracks,
  pending,
});

test("the park schedule: a parked leg jumps 3 frames, and not past its shot", () => {
  const parked = record({ forward: 10, forwardMisses: 1 });
  assert.equal(nextUnit(indexOf([parked]), null)?.at, 13);
  assert.equal(nextUnit(indexOf([record({ forward: 10 })]), null)?.at, 11, "not parked");
  assert.equal(nextUnit(indexOf([record({ ...parked, last: 12, forward: 11 })]), null)?.at, 12, "the end of its shot");
  const back = record({ seedAt: 20, forward: 39, reverse: 20, reverseMisses: 1, forwardMisses: 0 });
  assert.equal(nextUnit(indexOf([back]), null)?.at, 17);
});

test("a parked leg stops on a keyframe that waits, and goes on from there on the schedule", () => {
  const parked = record({ forward: 10, forwardMisses: 1 });
  const held = indexOf([parked], [pendingAt(12)]);
  assert.equal(nextUnit(held, null)?.at, 12);
  assert.equal(nextUnit(indexOf([parked], [pendingAt(13)]), null)?.at, 13, "the schedule lands there anyway");
  assert.equal(nextUnit(indexOf([parked], [pendingAt(20)]), null)?.at, 13, "too far off to matter yet");
  const back = record({ seedAt: 20, forward: 39, reverse: 20, reverseMisses: 1 });
  assert.equal(nextUnit(indexOf([back], [pendingAt(18)]), null)?.at, 18);
});

test("association waits until every active track of the shot has covered the frame", () => {
  const p = pendingAt(5);
  assert.equal(nextAssociation(indexOf([record({ forward: 4 })], [p])), null);
  assert.equal(nextAssociation(indexOf([record({ forward: 5 })], [p])), p);
  assert.equal(nextAssociation(indexOf([record({ forward: 4, state: "cancelled" })], [p])), p, "not a cancelled one");
  assert.equal(nextAssociation(indexOf([record({ forward: 4, last: 4 })], [p])), p, "not one of another shot");
  assert.equal(nextAssociation(indexOf([record({ seedAt: 8, forward: 8, reverse: 8 })], [p])), null, "backward too");
  assert.equal(nextAssociation(indexOf([], [p, pendingAt(9)])), p, "the first of a clip goes first");
});
