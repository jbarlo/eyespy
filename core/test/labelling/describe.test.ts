import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOp } from "../../src/labelling/pure.ts";

test("describeOp: each known op", () => {
  const cases: readonly (readonly [{ readonly op: string; readonly [k: string]: unknown }, string])[] = [
    [{ op: "new", obj: "o3", label: "jar", ids: ["1.0", "2.0"] }, "new o3 “jar” 2 dets"],
    [{ op: "add", obj: "o1", ids: ["1.0"] }, "add 1 det to o1"],
    [{ op: "remove", obj: "x", ids: ["1.0", "1.1"] }, "remove 2 dets from x"],
    [{ op: "merge", from: "o2", into: "o1" }, "merge o2 into o1"],
    [{ op: "label", obj: "o1", label: "cup" }, "rename o1 “cup”"],
    [{ op: "delete", obj: "o4" }, "delete o4"],
    [{ op: "reject", ids: ["3.0"] }, "reject 1 det"],
    [{ op: "clip_remove", path: "/v/a.mp4", clip: "abc", frames: [0, 12] }, "remove video a.mp4 (#0–#12)"],
    [{ op: "clip_remove", clip: "abc" }, "remove video abc (#)"],
    [{ op: "undo", of: 5 }, "undo #5"],
    [{ op: "redo", of: 6 }, "redo #6"],
  ];
  for (const [e, want] of cases) assert.equal(describeOp(e), want);
});

test("describeOp: extra fields are fine; a line missing its fields, or an unknown op, is its op name", () => {
  assert.equal(describeOp({ op: "new", obj: "o1", label: "a", seq: 3, ts: 1, undoable: true }), "new o1 “a”");
  assert.equal(describeOp({ op: "merge", into: "o1" }), "merge");
  assert.equal(describeOp({ op: "?" }), "?");
  assert.equal(describeOp({ op: "future_op", obj: "o1" }), "future_op");
});
