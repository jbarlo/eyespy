import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import { openEngine } from "../compose.ts";
import { KITCHEN } from "../fakes/index.ts";

type RunsJson = Record<string, { ids: string[]; presence: number; sem: string | null }>;

const text = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b ?? new Uint8Array())) as unknown;

/** A session with kitchen added and "jar" found on keyframe 0; closed, so its store can be edited. */
async function foundJar() {
  const o = await openEngine();
  await o.caller.add({ video: KITCHEN });
  await o.settle();
  const found = await o.caller.find({ prompt: "jar", frames: "0", threshold: 0 });
  o.close();
  const runs = text(o.host.store.files.get("runs.json")) as RunsJson;
  const run = runs["0|jar"];
  assert.ok(run && run.presence !== null && run.sem !== null && run.ids.length > 0, "fixture: a run with presence");
  return { host: o.host, found, runs, run, sem: `sem/${run.sem}` };
}

test("semantic on a run whose heatmap file was deleted: missing-heatmap, nothing re-detected", async () => {
  const { host, run, sem } = await foundJar();
  host.store.files.delete(sem);
  const detectsBefore = host.models.detections.length;
  const o = await openEngine(host);
  try {
    const e = await o.caller.semantic({ prompt: "jar", frames: "0" }).then(
      () => assert.fail("expected missing-heatmap"),
      (x: unknown) => x,
    );
    assert.ok(e instanceof TRPCError);
    assert.deepEqual([e.code, e.message], ["BAD_REQUEST", `missing sem/${run.sem}`]);
    assert.equal(host.models.detections.length, detectsBefore);
  } finally {
    o.close();
  }
});
