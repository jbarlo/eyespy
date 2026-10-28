import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_KEYS, CONFIG_META, DEFAULT_CONFIG, parseOverrides } from "../../src/session/pure.ts";

test("CONFIG_KEYS: every setting, in DEFAULT_CONFIG order, each with its meta", () => {
  assert.deepEqual(CONFIG_KEYS, Object.keys(DEFAULT_CONFIG));
  assert.deepEqual(Object.keys(CONFIG_META).toSorted(), CONFIG_KEYS.toSorted());
});

test("CONFIG_META: every setting is described for the CLI (doc) and for people (label, help)", () => {
  for (const k of CONFIG_KEYS) {
    const m = CONFIG_META[k];
    assert.ok(m.doc.trim().length > 10, `${k}: doc`);
    assert.ok(m.label.trim().length > 2 && m.label.length <= 24, `${k}: label (short)`);
    // a sentence or two on what it does and what changing it costs
    assert.ok(m.help.trim().length > 60 && m.help.length <= 360, `${k}: help is ${m.help.length} chars`);
    assert.ok(m.help.endsWith("."), `${k}: help is sentences`);
  }
  assert.equal(new Set(CONFIG_KEYS.map((k) => CONFIG_META[k].label)).size, CONFIG_KEYS.length, "labels are unique");
});

test("parseOverrides: settings kept, int settings truncated; none is {}", () => {
  assert.deepEqual(parseOverrides({ threshold: 0.25, group_window: 3.9 })._unsafeUnwrap(), {
    threshold: 0.25,
    group_window: 3,
  });
  assert.deepEqual(parseOverrides(undefined)._unsafeUnwrap(), {});
  assert.deepEqual(parseOverrides({})._unsafeUnwrap(), {});
});

test("parseOverrides: unknown keys fail, all of them named, sorted", () => {
  assert.deepEqual(parseOverrides({ zeta: 1, threshold: 0.5, alpha: 2 })._unsafeUnwrapErr(), {
    kind: "unknown-settings",
    keys: ["alpha", "zeta"],
  });
  assert.equal(parseOverrides({ toString: 1 }).isErr(), true, "inherited names are not settings");
});
