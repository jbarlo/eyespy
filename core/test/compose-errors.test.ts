import assert from "node:assert/strict";
import { test } from "node:test";
import { describeComposeError } from "../src/api/index.ts";
import type { ComposeError } from "../src/compose.ts";

test("describeComposeError words storage failures, then defers to the error table", () => {
  const cases: readonly (readonly [ComposeError, string])[] = [
    [{ kind: "no-session", root: "/s" }, "no session.json in /s"],
    [{ kind: "bad-session-json", message: "Unexpected token" }, "session.json: Unexpected token"],
    [{ kind: "unsupported-version", version: 2 }, "session.json version 2 is not supported (eyespy reads version 1)"],
    [{ kind: "bad-record", file: "runs.json", message: "bad" }, "runs.json: bad"],
    [{ kind: "host", port: "store", op: "read", message: "EACCES" }, "EACCES"],
    [{ kind: "no-frames" }, "no frames"],
  ];
  for (const [e, text] of cases) assert.equal(describeComposeError(e), text);
});
