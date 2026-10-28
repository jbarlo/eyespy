import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySessionJson } from "eyespy-core/storage/pure";
import { sessionStoreContract } from "../../core/test/contract/session-store.ts";
import { STORE_REF } from "../src/protocol.ts";
import { DirStore } from "../src/engine/worker/store.ts";
import { FakeDir, FakeFile } from "./fsaccess.ts";

sessionStoreContract("DirStore", async () => ({ store: await DirStore.open(new FakeDir("s").handle, "s") }));

test("DirStore: keys are files under <session>/.eyespy; locate is a store reference", async () => {
  const dir = new FakeDir("s");
  const s = await DirStore.open(dir.handle, "s");
  await s.writeText("clips/k/meta.json", "{}");
  const f = dir.at(".eyespy/clips/k/meta.json");
  assert.ok(f instanceof FakeFile);
  assert.equal(new TextDecoder().decode(f.data), "{}");
  assert.equal(s.locate("out/a.jpg"), `${STORE_REF}out/a.jpg`);
});

test("DirStore.openOrInit writes an empty session.json only when there is none", async () => {
  const dir = new FakeDir("s");
  const s = await DirStore.openOrInit(dir.handle, "s");
  assert.equal(await s.readText("session.json"), emptySessionJson());
  await s.writeText("session.json", '{"version": 1, "mine": true}');
  const again = await DirStore.openOrInit(dir.handle, "s");
  assert.equal(await again.readText("session.json"), '{"version": 1, "mine": true}');
});
