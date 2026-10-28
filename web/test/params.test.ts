import assert from "node:assert/strict";
import { test } from "node:test";
import { pageParams } from "../src/engine/params.ts";

test("pageParams: absent is undefined, detector only fp16/fp32", () => {
  assert.deepEqual(pageParams(""), {
    models: undefined,
    runtime: undefined,
    session: undefined,
    detector: undefined,
  });
  const p = pageParams("?models=http://m/&session=s1&detector=fp16&runtime=http://r/");
  assert.equal(p.session, "s1");
  assert.equal(p.detector, "fp16");
  assert.ok(p.models && Object.values(p.models).every((e) => e.url.startsWith("http://m/")));
  assert.ok(p.runtime);
  assert.equal(pageParams("?detector=int8").detector, undefined);
});
