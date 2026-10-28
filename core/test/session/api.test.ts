import assert from "node:assert/strict";
import { test } from "node:test";
import { ERRORS, OPS, appRouter, describeError, isOpPath, opKind } from "../../src/api/index.ts";
import type { SessionError } from "../../src/session/index.ts";

test("OPS lists every router procedure once, with its kind", () => {
  const procs = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  assert.deepEqual(OPS.map((o) => o.path).toSorted(), Object.keys(procs).toSorted());
  for (const o of OPS) assert.equal(procs[o.path]?._def.type, o.kind, o.path);
  assert.equal(new Set(OPS.map((o) => o.path)).size, OPS.length);
  assert.ok(isOpPath("obj.new") && !isOpPath("obj") && !isOpPath("nope"));
  assert.equal(opKind("data.dets"), "query");
  assert.equal(opKind("find"), "mutation");
});

test("errors: wording; codes; host failures keep the adapter's message", () => {
  const cases: [SessionError, string, string][] = [
    [{ kind: "no-detection", id: "9.9" }, "BAD_REQUEST", "no detection 9.9"],
    [{ kind: "bad-frame-spec", part: "1-" }, "BAD_REQUEST", "bad frame spec: 1-"],
    [
      {
        kind: "cannot-replay",
        op: "undo",
        seq: 4,
        of: "merge",
        reason: { kind: "label-mismatch", obj: "o2", actual: "a", expected: "b" },
      },
      "BAD_REQUEST",
      'cannot undo #4 (merge): object o2 is labelled "a", expected "b"',
    ],
    [
      { kind: "cannot-replay", op: "redo", seq: 1, of: "new", reason: { kind: "not-an-object", obj: "zz" } },
      "BAD_REQUEST",
      'cannot redo #1 (new): "zz" in its diff is not an object id (ops.jsonl was edited by hand?)',
    ],
    [{ kind: "host", port: "video", op: "open", message: "no frames in /f" }, "BAD_REQUEST", "no frames in /f"],
    [{ kind: "host", port: "store", op: "write", message: "ENOSPC" }, "INTERNAL_SERVER_ERROR", "ENOSPC"],
    [{ kind: "shutting-down" }, "INTERNAL_SERVER_ERROR", "server is shutting down"],
  ];
  for (const [e, code, message] of cases) assert.deepEqual(describeError(e), { code, message });
  assert.ok(Object.keys(ERRORS).length >= 29);
});
