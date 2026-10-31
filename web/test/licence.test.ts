import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Model } from "eyespy-core/ports";
import { SAM_LICENSE_COPY, samLicenseSha256, sha256File } from "../scripts/notices.ts";
import { guardSamModels, underSamLicense } from "../src/engine/worker/licence.ts";
import { PRODUCTION_MODELS } from "../src/engine/manifest.ts";
import { SAM_LICENSE_REFUSED } from "../src/protocol.ts";
import { LICENCE_PREF, agreedTo, readAgreement, recordAgreement } from "../src/state/licence.ts";
import type { Prefs } from "../src/state/ports.ts";
import viteConfig from "../vite.config.ts";
import { AGREED, SAM_SHA, settle, setup } from "./fakes.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

test("the shipped licence's sha256 is the build constant, and follows the file's bytes", () => {
  const sha = samLicenseSha256();
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(sha, sha256File(path.join(REPO, "third_party/sam3/LICENSE")), "the file copied to " + SAM_LICENSE_COPY);
  const define = (viteConfig as { define?: Record<string, string> }).define ?? {};
  assert.equal(define.__EYESPY_SAM_LICENSE_SHA256__, JSON.stringify(sha));

  const dir = mkdtempSync(path.join(tmpdir(), "eyespy-licence-"));
  const f = path.join(dir, "LICENSE");
  writeFileSync(f, readFileSync(path.join(REPO, "third_party/sam3/LICENSE")));
  assert.equal(sha256File(f), sha);
  writeFileSync(f, readFileSync(f, "utf8").replace(/Last Updated: .*/, "Last Updated: another day"));
  assert.notEqual(sha256File(f), sha, "an edited text is a different licence");
});

const memPrefs = (data: Record<string, string> = {}): Prefs & { data: Record<string, string> } => ({
  data,
  get: (k) => data[k] ?? null,
  set: (k, v) => void (data[k] = v),
});
const throwing: Prefs = {
  get: () => {
    throw new Error("SecurityError: storage is disabled");
  },
  set: () => {
    throw new Error("QuotaExceededError");
  },
};

test("agreement: missing, malformed, other text, this text", () => {
  assert.equal(readAgreement(memPrefs()), null);
  assert.equal(agreedTo(memPrefs(), SAM_SHA), false, "missing");
  assert.equal(agreedTo(memPrefs({ [LICENCE_PREF]: "{not json" }), SAM_SHA), false, "malformed");
  assert.equal(agreedTo(memPrefs({ [LICENCE_PREF]: JSON.stringify({ sha256: SAM_SHA }) }), SAM_SHA), false, "no date");
  assert.equal(agreedTo(memPrefs({ [LICENCE_PREF]: "true" }), SAM_SHA), false, "not a record");
  const old = memPrefs({ [LICENCE_PREF]: JSON.stringify({ sha256: "0".repeat(64), at: "2026-01-01T00:00:00Z" }) });
  assert.equal(agreedTo(old, SAM_SHA), false, "agreed to another licence text");
  assert.equal(agreedTo(memPrefs({ ...AGREED }), SAM_SHA), true);
});

test("agreement: recorded as {sha256, at}; storage that throws never counts as agreed", () => {
  const p = memPrefs();
  assert.equal(recordAgreement(p, SAM_SHA, new Date("2026-10-26T12:00:00Z")), true);
  assert.deepEqual(JSON.parse(p.data[LICENCE_PREF] ?? ""), { sha256: SAM_SHA, at: "2026-10-26T12:00:00.000Z" });
  assert.equal(agreedTo(p, SAM_SHA), true);
  assert.equal(agreedTo(throwing, SAM_SHA), false);
  assert.equal(readAgreement(throwing), null);
  assert.equal(recordAgreement(throwing, SAM_SHA, new Date()), false, "not kept");
  const forgetful: Prefs = { get: () => null, set: () => {} }; // as when the browser adapter swallows a failed write
  assert.equal(recordAgreement(forgetful, SAM_SHA, new Date()), false);
});

function fakeRuntime() {
  const calls: string[] = [];
  const model: Model = { run: async () => ({}) };
  const rt = {
    load: async (n: string) => (calls.push(`load ${n}`), model),
    readText: async (n: string) => (calls.push(`readText ${n}`), "{}"),
    prepare: async (names?: string[]) => void calls.push(`prepare ${names?.join(",") ?? "all"}`),
    describe: () => ({ runtime: "fake", version: "0", device: "cpu" }),
    sha256: async (n: string) => `sha of ${n}`,
  };
  return { rt, calls };
}

const NAMES = Object.keys(PRODUCTION_MODELS);

test("worker: without the agreement every SAM 3 file is refused before any fetch or cache read", async () => {
  assert.deepEqual(
    NAMES.filter((n) => !underSamLicense(n)),
    ["dinov2-small/model_cls.onnx"],
    "only DINOv2 (Apache-2.0) is free of the SAM License",
  );
  const { rt, calls } = fakeRuntime();
  const g = guardSamModels(rt, NAMES, false);
  for (const n of NAMES.filter(underSamLicense)) {
    await assert.rejects(g.load(n), new RegExp(`^Error: ${SAM_LICENSE_REFUSED}: ${n.replace(".", "\\.")}`));
    await assert.rejects(g.readText(n), new RegExp(SAM_LICENSE_REFUSED));
    await assert.rejects(g.prepare([n]), new RegExp(SAM_LICENSE_REFUSED));
  }
  await assert.rejects(g.prepare(), new RegExp(SAM_LICENSE_REFUSED), "prepare() means the whole manifest");
  await assert.rejects(g.load("unknown.onnx"), new RegExp(SAM_LICENSE_REFUSED), "unknown files count as SAM 3");
  assert.deepEqual(calls, [], "nothing reached the runtime (no download, no OPFS read)");

  await g.load("dinov2-small/model_cls.onnx");
  await g.prepare(["dinov2-small/model_cls.onnx"]);
  assert.equal(await g.sha256("vision_fp16.onnx"), "sha of vision_fp16.onnx", "the manifest hash is no read");
  assert.deepEqual(calls, ["load dinov2-small/model_cls.onnx", "prepare dinov2-small/model_cls.onnx"]);
});

test("worker: with the agreement everything passes through", async () => {
  const { rt, calls } = fakeRuntime();
  const g = guardSamModels(rt, NAMES, true);
  await g.load("vision_fp16.onnx");
  assert.equal(await g.readText("tokenizer.json"), "{}");
  await g.prepare();
  assert.deepEqual(calls, ["load vision_fp16.onnx", "readText tokenizer.json", "prepare all"]);
});

test("gate: a fresh profile gets the licence dialog before any engine starts; I agree records it", async () => {
  const { app, engine, storage } = setup({ agreed: false });
  const opening = app.actions.openSession({ opfs: "s1" });
  await settle();
  const ask = app.stores.licence.getState().ask;
  assert.ok(ask, "the dialog is open");
  assert.equal(engine.opened.length, 0, "no engine (no download, no cached model) before the answer");
  ask.answer(true);
  assert.ok(await opening);
  assert.equal(engine.opened[0]?.req.samLicenseAgreed, true);
  assert.equal(app.stores.licence.getState().sam, "agreed");
  assert.equal(app.stores.licence.getState().ask, null);
  assert.equal(readAgreement(storage.prefs)?.sha256, SAM_SHA);
  // a switch doesn't ask again
  await app.actions.openSession({ opfs: "s2" });
  assert.equal(engine.opened[1]?.req.samLicenseAgreed, true);
});

test("gate: an agreement to an older licence text asks again before the cached models are used", async () => {
  const old = JSON.stringify({ sha256: "0".repeat(64), at: "2026-01-01T00:00:00.000Z" });
  const { app, engine } = setup({ agreed: false, prefs: { [LICENCE_PREF]: old } });
  const opening = app.actions.openSession({ opfs: "s1" });
  await settle();
  assert.ok(app.stores.licence.getState().ask);
  assert.equal(engine.opened.length, 0);
  app.stores.licence.getState().ask?.answer(true);
  await opening;
  assert.equal(engine.opened[0]?.req.samLicenseAgreed, true);
});

test("gate: a matching agreement opens straight away", async () => {
  const { app, engine } = setup();
  assert.ok(await app.actions.openSession({ opfs: "s1" }));
  assert.equal(app.stores.licence.getState().ask, null);
  assert.equal(engine.opened[0]?.req.samLicenseAgreed, true);
});

test("gate: Cancel opens the session without the models, says so, and Review can agree later", async () => {
  const { app, engine, storage } = setup({ agreed: false });
  const opening = app.actions.openSession({ opfs: "s1" });
  await settle();
  app.stores.licence.getState().ask?.answer(false);
  assert.ok(await opening, "the session still opens for browsing");
  assert.equal(engine.opened[0]?.req.samLicenseAgreed, false, "the engine is told: no SAM 3");
  assert.equal(app.stores.licence.getState().sam, "declined");
  assert.equal(app.stores.frames.getState().frames.length, 5, "existing data is there");
  assert.equal(readAgreement(storage.prefs), null, "nothing recorded");

  // a background refusal from the worker adds no notice
  engine.opened[0]?.req.onEvent({ kind: "log", text: `background: Error: ${SAM_LICENSE_REFUSED}: vision_fp16.onnx` });
  assert.equal(app.stores.notices.getState().notices.length, 0);

  // switching sessions doesn't ask again
  await app.actions.openSession({ opfs: "s2" });
  assert.equal(app.stores.licence.getState().ask, null);
  assert.equal(engine.opened[1]?.req.samLicenseAgreed, false);

  // Review, then Cancel again, changes nothing
  const again = app.actions.reviewLicence();
  app.stores.licence.getState().ask?.answer(false);
  await again;
  assert.equal(engine.opened.length, 2);

  // Review, then I agree, restarts the open session with the models
  const review = app.actions.reviewLicence();
  app.stores.licence.getState().ask?.answer(true);
  await review;
  assert.equal(engine.opened.length, 3);
  assert.equal(engine.opened[1]?.disposed, true);
  assert.equal(engine.opened[2]?.req.samLicenseAgreed, true);
  assert.deepEqual(engine.opened[2]?.req.session, { opfs: "s2" });
  assert.equal(app.stores.licence.getState().sam, "agreed");
  assert.equal(readAgreement(storage.prefs)?.sha256, SAM_SHA);
});

test("gate: storage that keeps nothing: agreed for this page only, asked again on the next load", async () => {
  const first = setup({ agreed: false });
  const forget = { get: () => null, set: () => {} };
  Object.assign(first.storage.prefs, forget);
  const opening = first.app.actions.openSession({ opfs: "s1" });
  await settle();
  first.app.stores.licence.getState().ask?.answer(true);
  await opening;
  assert.equal(first.engine.opened[0]?.req.samLicenseAgreed, true);
  assert.equal(first.app.stores.licence.getState().pageOnly, true);

  const next = setup({ agreed: false });
  Object.assign(next.storage.prefs, forget);
  void next.app.actions.openSession({ opfs: "s1" });
  await settle();
  assert.ok(next.app.stores.licence.getState().ask, "never assumed");
  assert.equal(next.engine.opened.length, 0);
  next.app.stores.licence.getState().ask?.answer(false);
});
