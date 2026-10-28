import assert from "node:assert/strict";
import { test } from "node:test";
import { isFeatureDir } from "../../src/storage/pure.ts";

test("isFeatureDir: only <root>/.eyespy/clips/<clip key>/feat", () => {
  assert.equal(isFeatureDir([".eyespy", "clips", "0123456789ab", "feat"]), true);
  assert.equal(isFeatureDir([".eyespy", "clips", "0123456789ab"]), false);
  assert.equal(isFeatureDir([".eyespy", "clips", "0123456789ab", "frames"]), false);
  assert.equal(isFeatureDir([".eyespy", "clips", "0123456789ab", "feat", "x"]), false);
  assert.equal(isFeatureDir([".eyespy", "clips", "not-a-key", "feat"]), false);
  assert.equal(isFeatureDir(["other", "clips", "0123456789ab", "feat"]), false);
  assert.equal(isFeatureDir(["sessions", ".eyespy", "clips", "0123456789ab", "feat"]), false);
});
