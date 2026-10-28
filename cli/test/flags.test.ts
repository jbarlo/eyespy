/** The global flags: specs derived from CONFIG_META, and the parse of what jimkit-cli hands over (untyped). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_KEYS } from "eyespy-core/session/pure";
import { CONFIG_FLAGS, globalOptions, parseGlobals } from "../src/commands/flags.ts";

test("every setting but threshold and idle_minutes gets an override flag, in CONFIG_KEYS order", () => {
  assert.deepEqual(
    CONFIG_FLAGS.map(([, key]) => key),
    CONFIG_KEYS.filter((k) => k !== "threshold" && k !== "idle_minutes"),
  );
  assert.ok(CONFIG_FLAGS.some(([flag, key]) => flag === "nmsIou" && key === "nms_iou"));
  const names = Object.keys(globalOptions);
  assert.deepEqual(names.slice(0, 4), ["json", "session", "video", "fps"]);
  assert.equal(names.at(-1), "idleMinutes");
  assert.deepEqual(
    names.slice(4, -1),
    CONFIG_FLAGS.map(([flag]) => flag),
  );
});

test("defaults: no session, no videos, no overrides, text output", () => {
  assert.deepEqual(parseGlobals({ json: false })._unsafeUnwrap(), {
    json: false,
    session: undefined,
    videos: [],
    cfg: {},
    idleMinutes: undefined,
    fps: undefined,
  });
  assert.equal(parseGlobals({})._unsafeUnwrap().json, false);
});

test("numbers arrive as strings (jimkit-cli skips global option types); overrides keyed by setting", () => {
  const g = parseGlobals({ json: true, session: "s", presence: "0.9", nmsIou: 0.3, idleMinutes: "5" })._unsafeUnwrap();
  assert.deepEqual(g, {
    json: true,
    session: "s",
    videos: [],
    cfg: { presence: 0.9, nms_iou: 0.3 },
    idleMinutes: 5,
    fps: undefined,
  });
});

test("--fps: a frame rate above 0", () => {
  assert.equal(parseGlobals({ fps: "29.97" })._unsafeUnwrap().fps, 29.97);
  assert.equal(parseGlobals({ fps: 4 })._unsafeUnwrap().fps, 4);
  const bad = { message: "--fps needs a frame rate above 0 (up to 1000)" };
  assert.deepEqual(parseGlobals({ fps: "0" })._unsafeUnwrapErr(), bad);
  assert.deepEqual(parseGlobals({ fps: "-5" })._unsafeUnwrapErr(), bad);
  assert.deepEqual(parseGlobals({ fps: "x" })._unsafeUnwrapErr(), { message: "--fps needs a number" });
});

test("a flag that isn't a number is an error naming it", () => {
  assert.deepEqual(parseGlobals({ presence: "abc" })._unsafeUnwrapErr(), { message: "--presence needs a number" });
  assert.deepEqual(parseGlobals({ idleMinutes: "x" })._unsafeUnwrapErr(), { message: "--idleMinutes needs a number" });
  assert.ok(parseGlobals({ session: 3 }).isErr());
});

test("-i: comma-separated, a string or a list, empty parts dropped", () => {
  assert.deepEqual(parseGlobals({ video: "a.mov,b.mov" })._unsafeUnwrap().videos, ["a.mov", "b.mov"]);
  assert.deepEqual(parseGlobals({ video: ["a.mov", "b.mov,,c.mov"] })._unsafeUnwrap().videos, [
    "a.mov",
    "b.mov",
    "c.mov",
  ]);
});
