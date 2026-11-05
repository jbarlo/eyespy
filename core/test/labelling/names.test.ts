/** Word-pair object ids: the bijection, the frozen lists, and sessions that hold both id formats. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDetections } from "../../src/detections/index.ts";
import type { Objects, OpEntry, Owner } from "../../src/labelling/index.ts";
import {
  ADJECTIVES,
  NOUNS,
  PAIRS,
  REJECT,
  counterOf,
  isObjectId,
  isOwner,
  isReject,
  objectName,
} from "../../src/labelling/pure.ts";
import { decodeObjects } from "../../src/storage/internal/records.ts";
import { det, emb, errv, okv } from "../detections/helpers.ts";
import { open, reopen } from "./fakes.ts";

const ctx = { aliasIou: 0.7 };

const DETS = createDetections({
  detections: [det("0.0", { emb: emb(0) }), det("0.1", { emb: emb(5) }), det("1.0", { emb: emb(9) })],
  runs: [],
  reserved: new Map(),
});

/** Objects from plain ids, through the storage decoder, as a session folder would give them. */
const stored = (o: Record<string, { label: string; members: string[] }>): Objects => okv(decodeObjects(o));

const counters = Array.from({ length: PAIRS }, (_, k) => k + 1);

test("the counter maps onto every pair exactly once, and back", () => {
  const names = counters.map(objectName);
  assert.equal(new Set(names).size, PAIRS);
  assert.equal(PAIRS, ADJECTIVES.length * NOUNS.length);
  assert.ok(names.every(isObjectId));
  assert.ok(!names.some(isReject));
  assert.deepEqual(names.map(counterOf), counters);
});

test("neighbouring ids share no word, so they read as unrelated", () => {
  const parts = counters.slice(0, 200).map((n) => objectName(n).split("-"));
  assert.equal(new Set(parts.map((p) => p[0])).size, 200, "no adjective repeats in the first 200");
  assert.equal(new Set(parts.map((p) => p[1])).size, 200, "no noun repeats in the first 200");
});

test("the mapping is frozen: changing it could reuse the id of a deleted object", () => {
  assert.deepEqual(counters.slice(0, 3).map(objectName), ["orderly-dolphin", "dreamy-jay", "sunny-osprey"]);
  assert.equal(objectName(PAIRS), "able-acacia");
  assert.equal(
    createHash("sha256")
      .update(`${ADJECTIVES.join(" ")}\n${NOUNS.join(" ")}`)
      .digest("hex")
      .slice(0, 32),
    "547e4f92c6e9236ffb5e3767ee134069",
  );
});

test("the word lists: short, plain, distinct, and they can't contradict a label", () => {
  // the colours and foods most likely to be typed as a label, or to look like one
  const banned = new Set(
    `amber apple aqua azure beige berry black blue bread bronze brown cherry chicken citrus coral cream crimson duck
    fig fish garlic gold golden gray green grey honey indigo ivory jade khaki kiwi lavender lemon lilac lime magenta
    mango maroon mauve mint mustard navy nut ochre olive onion orange peach pear pepper pink plum purple red rose ruby
    rust saffron sage salmon scarlet silver slate tan teal tomato trout tuna turquoise umber violet walnut white yellow
    zucchini bench bottle bowl box car chair cup dog cat horse jar lamp phone table`.split(/\s+/),
  );
  for (const list of [ADJECTIVES, NOUNS]) {
    assert.equal(list.length, 256);
    assert.equal(new Set(list).size, 256);
    assert.deepEqual(
      list.filter((w) => !/^[a-z]{2,7}$/.test(w)),
      [],
    );
    assert.deepEqual(
      list.filter((w) => banned.has(w)),
      [],
    );
  }
  assert.deepEqual(
    ADJECTIVES.filter((w) => NOUNS.includes(w)),
    [],
  );
});

test("validation takes both formats and nothing else; the reject owner stays apart", () => {
  for (const id of ["o1", "o70000", "calm-otter", "orderly-dolphin"]) assert.ok(isObjectId(id), id);
  for (const id of [
    "x",
    "",
    "o",
    "O1",
    "o-1",
    "1",
    "calm",
    "Calm-Otter",
    "calm_otter",
    "calm-otter-2",
    "calm-",
    "-otter",
  ])
    assert.ok(!isObjectId(id), id);
  assert.ok(!isObjectId(REJECT));
  assert.ok(isOwner(REJECT));
  assert.equal(counterOf(REJECT), null);
  assert.equal(counterOf("not-listed"), null, "a valid shape from no list holds no counter");
  assert.ok(isObjectId("not-listed"), "stored ids stay valid whatever the lists say");
});

test("past the last pair ids go back to o<n>, still unique and still accepted", async () => {
  const { lab, log } = open(DETS, { nextObj: PAIRS });
  assert.equal(okv(await lab.create("a", ["0.0"], ctx)).id, objectName(PAIRS));
  assert.equal(okv(await lab.create("b", ["0.1"], ctx)).id, `o${PAIRS + 1}`);
  assert.equal(okv(await lab.create("c", ["1.0"], ctx)).id, `o${PAIRS + 2}`);
  assert.equal(log.nextObj, PAIRS + 3);
  assert.equal(counterOf(`o${PAIRS + 1}`), PAIRS + 1);
});

test("a legacy session keeps its ids and continues with word pairs, with no migration", async () => {
  const objects = stored({
    x: { label: "(not an item)", members: [] },
    o1: { label: "jar", members: ["0.0"] },
    o2: { label: "tub", members: [] },
  });
  // o3 was deleted before the upgrade: next_obj remembers it
  const { lab, log } = open(DETS, { objects, nextObj: 4 });
  assert.deepEqual(lab.objectIds(), ["o1", "o2"]);
  assert.equal(okv(lab.get("o1")).label, "jar");
  const made = okv(await lab.create("lid", ["0.1"], ctx)).id;
  assert.equal(made, objectName(4));
  assert.equal(log.nextObj, 5);
  assert.deepEqual(lab.objectIds(), ["o1", "o2", made]);
  assert.deepEqual(errv(lab.get("o3")), { kind: "no-object", id: "o3" });
});

test("a session mixing both formats: every op, undo and redo, across a reopen", async () => {
  const objects = stored({ o1: { label: "jar", members: ["0.0"] } });
  const { lab, log } = open(DETS, { objects, nextObj: 2 });
  const word = okv(await lab.create("lid", ["0.1"], ctx)).id;
  assert.equal(word, objectName(2));

  okv(await lab.add("o1", ["1.0"], ctx));
  okv(await lab.relabel(word, "cap"));
  okv(await lab.merge(word, "o1")); // a word id absorbs a legacy id
  assert.deepEqual(lab.objectIds(), [word]);
  assert.deepEqual(okv(lab.get(word)).members, ["0.1", "0.0", "1.0"]);
  okv(await lab.undo());
  assert.deepEqual([...lab.objectIds()].sort(), [word, "o1"].sort());
  assert.equal(lab.ownerOf(okv(DETS.get("0.0")).id), "o1");

  okv(await lab.merge("o1", word)); // and the other way round
  assert.deepEqual(lab.objectIds(), ["o1"]);
  okv(await lab.undo());
  okv(await lab.delete(word));
  okv(await lab.undo());
  assert.equal(okv(lab.get(word)).label, "cap", "undoing a delete brings the same id back");

  const { lab: lab2 } = reopen(DETS, log);
  assert.deepEqual([...lab2.objectIds()].sort(), [word, "o1"].sort());
  okv(await lab2.redo());
  assert.deepEqual(lab2.objectIds(), ["o1"], "the delete again, from the reopened log");
  okv(await lab2.undo());
  assert.equal(okv(await lab2.create("new", ["1.0"], ctx)).id, objectName(3));
});

test("undoing a new, or a delete, never frees its id", async () => {
  const { lab, log } = open(DETS);
  const a = okv(await lab.create("a", ["0.0"], ctx)).id;
  okv(await lab.undo());
  assert.deepEqual(lab.objectIds(), []);
  const b = okv(await lab.create("b", ["0.1"], ctx)).id;
  assert.notEqual(b, a, "an undone new keeps its id to itself");
  okv(await lab.delete(b));
  const c = okv(await lab.create("c", ["1.0"], ctx)).id;
  assert.deepEqual([a, b, c], [objectName(1), objectName(2), objectName(3)]);
  assert.equal(new Set([a, b, c]).size, 3);
  okv(await lab.undo()); // the new of c
  okv(await lab.undo()); // the delete of b
  okv(await lab.redo());
  okv(await lab.redo());
  assert.deepEqual(lab.objectIds(), [c], "redo recreates the id it undid");
  assert.equal(log.nextObj, 4, "undo and redo never move the counter");
});

test("the counter is raised above every word id and legacy id in objects.json", async () => {
  const higher = objectName(10);
  const { lab } = open(DETS, { objects: stored({ [higher]: { label: "a", members: [] } }), nextObj: 2 });
  assert.equal(okv(await lab.create("b", ["0.0"], ctx)).id, objectName(11));

  const { lab: legacy } = open(DETS, { objects: stored({ o70000: { label: "a", members: [] } }), nextObj: 2 });
  assert.equal(okv(await legacy.create("b", ["0.0"], ctx)).id, "o70001");

  // a pair no list holds is kept and can't be generated
  const { lab: odd } = open(DETS, { objects: stored({ "not-listed": { label: "a", members: [] } }), nextObj: 2 });
  assert.equal(okv(await odd.create("b", ["0.0"], ctx)).id, objectName(2));
  assert.deepEqual(odd.objectIds(), ["not-listed", objectName(2)]);
});

test("objects.json with both formats decodes in file order; other keys are refused", () => {
  const objects = stored({
    o1: { label: "jar", members: [] },
    "calm-otter": { label: "lid", members: [] },
    x: { label: "(not an item)", members: [] },
  });
  assert.deepEqual([...objects.keys()], ["o1", "calm-otter", "x"] satisfies string[] as Owner[]);
  const bad = decodeObjects({ "Calm-Otter": { label: "a", members: [] } });
  assert.ok(bad.isErr());
});

test("an op log from before word pairs replays in a session that has them", async () => {
  const history = [
    {
      seq: 0,
      ts: 1,
      op: "new",
      obj: "o1",
      label: "jar",
      ids: ["0.0"],
      diff: { o1: { from: null, to: "jar", add: ["0.0"] } },
    },
  ] as never as readonly OpEntry[];
  const objects = stored({ o1: { label: "jar", members: ["0.0"] } });
  const { lab } = open(DETS, { objects, history, nextObj: 2 });
  okv(await lab.create("lid", ["0.1"], ctx));
  okv(await lab.undo());
  okv(await lab.undo());
  assert.deepEqual(lab.objectIds(), []);
  okv(await lab.redo());
  assert.deepEqual(lab.objectIds(), ["o1"]);
});
