/**
 * Both committed sessions load and re-save byte for byte. session-real has a removed clip and non-ASCII labels.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { OpLine } from "../../src/labelling/pure.ts";
import { encodeLine } from "../../src/storage/internal/oplog.ts";
import { zipTime } from "../compose.ts";
import { MemStore } from "../fakes/index.ts";
import { FAKE, REAL, RecordingStore, TestClock, must, opened, text } from "./helpers.ts";

/** Key-order-independent JSON digest (sha256 of the canonical JSON, 32 hex). */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canon(v)))
    .digest("hex")
    .slice(0, 32);

/**
 * The decoded state of each fixture: detections [id, frame, t, prompt, score, box, area, mask, emb], runs.json,
 * objects.json, the parsed ops.jsonl and next_obj, as canonical-JSON digests.
 */
const DECODED = {
  "session-real": {
    dets: "765e23ed62b991a41f1af2f2d804bd8c",
    runs: "3df44bbf29fe96a535bebf51433aef3c",
    objects: "84cbd6e33a501f0d97c44a3e1494f01b",
    history: "d4eb58c28dc6a94ecf365cefa83b7f04",
    nextObj: 4,
  },
  "session-fake": {
    dets: "85315fba40a97e48ed6a2a39d5ec1ccf",
    runs: "f28e47fb70177de4c1557354f68f6f1b",
    objects: "eb0dc5b1137719e4067019321043d380",
    history: "6738d686f75da660c1871e5ccc279292",
    nextObj: 4,
  },
};

for (const [name, dir, count] of [
  ["session-real", REAL, 88],
  ["session-fake", FAKE, 30],
] as const) {
  test(`${name}: load and re-save through the folder gives identical bytes`, async () => {
    const store = RecordingStore.from(dir);
    const originals = new Map(store.files);
    const clock = new TestClock();
    const { folder, records } = await opened(store, clock);
    assert.equal(records.detections.length, count);
    await must(folder.meta.write(records.meta));
    await must(folder.detections.writeIndex(records.detections, records.runs));
    for (const d of records.detections) {
      clock.ms = zipTime(originals.get(`dets/${d.id}.npz`) ?? new Uint8Array());
      await must(folder.detections.writeDetection(d));
    }
    clock.ms = Date.UTC(2026, 9, 24, 12, 0, 0, 500);
    const entry = await must(
      folder.labels.commit({
        objects: records.objects,
        nextObj: records.nextObj,
        line: { op: "reject", ids: [], diff: {} },
      }),
    );
    assert.equal(entry.seq, records.history.length);
    assert.deepEqual([...store.files.keys()].sort(), [...originals.keys()].sort());
    for (const [k, v] of originals) if (k !== "ops.jsonl") assert.deepEqual(store.files.get(k), v, `${k} changed`);
    const before = text(originals.get("ops.jsonl"));
    const after = text(store.files.get("ops.jsonl"));
    assert.equal(after, before + `{"ts": 1792843200.5, "op": "reject", "ids": [], "diff": {}}\n`);
    // next_obj unchanged: session.json is not rewritten by the commit
    assert.ok(!store.calls.slice(-3).includes("writeText session.json"));
  });

  test(`${name}: decoded records equal the recorded state`, async () => {
    const { records } = await opened(MemStore.fromDir(dir));
    const runKey = (r: (typeof records.runs)[number]) =>
      `${r.frame}|${r.region === null ? r.prompt : `${r.prompt}@${r.region.join(",")}`}`;
    const got = {
      dets: digest(
        records.detections.map((d) => [d.id, d.frame, d.t, d.prompt, d.score, d.box, d.area, [...d.mask], [...d.emb]]),
      ),
      runs: digest(
        Object.fromEntries(records.runs.map((r) => [runKey(r), { ids: r.ids, presence: r.presence, sem: r.heatmap }])),
      ),
      objects: digest(Object.fromEntries(records.objects)),
      history: digest(records.history),
      nextObj: records.nextObj,
    };
    assert.deepEqual(got, DECODED[name]);
    assert.deepEqual(records.meta.config, {});
  });

  test(`${name}: every ops.jsonl line re-encodes to its bytes (keys given in reverse order)`, async () => {
    const { records } = await opened(MemStore.fromDir(dir));
    const lines = text(MemStore.fromDir(dir).files.get("ops.jsonl")).split("\n").filter(Boolean);
    assert.equal(lines.length, records.history.length);
    for (const [i, e] of records.history.entries()) {
      const { ts, seq: _seq, ...rest } = e;
      // scramble: the encoder must not depend on the order the line object was built in
      const line = Object.fromEntries(Object.entries(rest).reverse()) as unknown as OpLine;
      assert.equal(encodeLine(line, ts ?? 0, i).text, lines[i] + "\n", `line ${i}`);
    }
  });
}

test("session-real: the removed clip's tombstone and counters", async () => {
  const { records } = await opened(MemStore.fromDir(REAL));
  const removed = records.meta.clips.filter((c) => c.removed !== null);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.removed?.at, 1792897278.293);
  assert.deepEqual([...(removed[0]?.reserved ?? [])], [[53, 13]]);
  assert.deepEqual(records.meta.clips[0]?.reserved.size, 0);
  assert.deepEqual(records.meta.formats, { features: "onnx-cardanvil-vision-fp16/f16-concat-v1" });
});
