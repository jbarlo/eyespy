import assert from "node:assert/strict";
import { test } from "node:test";
import { pageParams } from "../src/engine/params.ts";

test("pageParams: absent is undefined, detector only fp16/fp32", () => {
  assert.deepEqual(pageParams(""), {
    models: undefined,
    runtime: undefined,
    session: undefined,
    detector: undefined,
    tracker: undefined,
  });
  const p = pageParams("?models=http://m/&session=s1&detector=fp16&runtime=http://r/");
  assert.equal(p.session, "s1");
  assert.equal(p.detector, "fp16");
  assert.ok(p.models && Object.values(p.models).every((e) => e.url.startsWith("http://m/")));
  assert.ok(p.runtime);
  assert.equal(pageParams("?detector=int8").detector, undefined);
});

test("pageParams: tracker graphs need ?models and ?tracker, and only ever come from that local base", () => {
  assert.equal(pageParams("?tracker").models, undefined);
  assert.equal(pageParams("?tracker").tracker, undefined);
  assert.equal(pageParams("?models=http://m/").tracker, undefined);
  assert.equal(pageParams("?models=http://m/&tracker").tracker, "fp16");
  assert.equal(pageParams("?models=http://m/&tracker=fp32").tracker, "fp32");
  const tracker = (q: string) => Object.keys(pageParams(q).models ?? {}).filter((n) => n.startsWith("tracker/"));
  assert.deepEqual(tracker("?models=http://m/"), []);
  const names = tracker("?models=http://m/&tracker");
  assert.ok(names.length > 0);
  const models = pageParams("?models=http://m/&tracker").models ?? {};
  for (const n of names) assert.equal(models[n]?.url, `http://m/${n}`);
});
