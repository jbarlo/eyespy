import assert from "node:assert/strict";
import { test } from "node:test";
import { clearFeaturesIn, platformIn, sessionsUsage, webgpuIn, type Dir } from "../src/browser.ts";
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

test("platformIn: engine and OS from userAgentData or the UA string; every iPhone and iPad browser is WebKit", () => {
  const cases = [
    [
      {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        userAgentData: { platform: "Linux" },
      },
      { engine: "chromium", os: "linux" },
    ],
    [
      {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
      },
      { engine: "chromium", os: "windows" },
    ],
    [
      {
        userAgent:
          "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
      { engine: "chromium", os: "chromeos" },
    ],
    [
      { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0" },
      { engine: "gecko", os: "linux" },
    ],
    [
      { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:147.0) Gecko/147.0 Firefox/147.0" },
      { engine: "gecko", os: "android" },
    ],
    [
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
      },
      { engine: "webkit", os: "macos" },
    ],
    [
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
      { engine: "webkit", os: "ios" },
    ],
    [
      {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.0.0 Mobile/15E148 Safari/604.1",
      },
      { engine: "webkit", os: "ios" },
    ],
    [{ userAgent: "curl/8.0" }, { engine: "other", os: "other" }],
  ] as const;
  for (const [nav, want] of cases) assert.deepEqual(platformIn(nav), want, nav.userAgent);
});
