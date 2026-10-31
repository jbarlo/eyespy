import assert from "node:assert/strict";
import { test } from "node:test";
import { clearFeaturesIn, sessionsUsage, webgpuIn, type Dir } from "../src/browser.ts";
import type { FakeFile } from "./fsaccess.ts";
import { FakeDir } from "./fsaccess.ts";

const KEY = "0123456789ab";
const bytes = (n: number) => new Uint8Array(n);

async function sessions() {
  const root = new FakeDir("sessions");
  await root.put(`a/.eyespy/session.json`, bytes(10));
  await root.put(`a/.eyespy/clips/${KEY}/frames/000.jpg`, bytes(100));
  await root.put(`a/.eyespy/clips/${KEY}/feat/000.f16`, bytes(1000));
  await root.put(`a/.eyespy/clips/${KEY}/feat/001.f16`, bytes(1000));
  await root.put(`a/.eyespy/out/feat/x.jpg`, bytes(5)); // a folder named feat that isn't a clip's
  await root.put(`b/.eyespy/clips/${KEY}/feat/000.f16`, bytes(3000));
  await root.put(`stray.txt`, bytes(1));
  return root;
}

const files = (d: FakeDir): FakeFile[] =>
  [...d.children.values()].flatMap((e) => (e instanceof FakeDir ? files(e) : [e]));

test("sessionsUsage: each session's total and feature bytes in one walk (one getFile per file), by name", async () => {
  const root = await sessions();
  assert.deepEqual(await sessionsUsage(root.handle as Dir), [
    { name: "a", total: 2115, features: 2000 },
    { name: "b", total: 3000, features: 3000 },
  ]);
  const inSessions = files(root).filter((f) => f !== root.at("stray.txt"));
  assert.deepEqual(
    inSessions.map((f) => f.reads),
    inSessions.map(() => 1),
  );
});

test("clearFeaturesIn: one session's feature folders", async () => {
  const root = await sessions();
  assert.equal(await clearFeaturesIn(root.handle as Dir, (n) => n === "b"), 1);
  assert.equal(root.at(`b/.eyespy/clips/${KEY}/feat`), undefined);
  assert.ok(root.at(`a/.eyespy/clips/${KEY}/feat/000.f16`));
});

test("clearFeaturesIn removes clips' feature folders of every session but the kept one, nothing else", async () => {
  const root = await sessions();
  assert.equal(await clearFeaturesIn(root.handle as Dir, (n) => n !== "b"), 1);
  assert.equal(root.at(`a/.eyespy/clips/${KEY}/feat`), undefined);
  assert.ok(root.at(`a/.eyespy/clips/${KEY}/frames/000.jpg`));
  assert.ok(root.at(`a/.eyespy/out/feat/x.jpg`));
  assert.ok(root.at(`b/.eyespy/clips/${KEY}/feat/000.f16`));
});

test("webgpuIn: no API, no adapter (null or a throw), an adapter asked for high performance", async () => {
  assert.equal(await webgpuIn(undefined), "no-webgpu");
  assert.equal(await webgpuIn({ requestAdapter: () => Promise.resolve(null) }), "no-adapter");
  assert.equal(
    await webgpuIn({ requestAdapter: () => Promise.reject(new Error("GPU process crashed")) }),
    "no-adapter",
  );
  const asked: unknown[] = [];
  const gpu = {
    requestAdapter: (o: unknown) => {
      asked.push(o);
      return Promise.resolve({});
    },
  };
  assert.equal(await webgpuIn(gpu), "available");
  assert.deepEqual(asked, [{ powerPreference: "high-performance" }]);
});
