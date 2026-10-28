/** The production manifest: model files from one pinned Hugging Face commit, and the installed ONNX Runtime wasm. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PRODUCTION_MODELS, PRODUCTION_RUNTIME, localManifest } from "../src/engine/manifest.ts";

const ORT = path.join(import.meta.dirname, "../node_modules/onnxruntime-web");
const installed = (JSON.parse(readFileSync(path.join(ORT, "package.json"), "utf8")) as { version: string }).version;
const wasm = PRODUCTION_RUNTIME.ortWasm;

const PINNED = /^https:\/\/huggingface\.co\/jbarlo\/eyespy-models\/resolve\/([0-9a-f]{40})\/(.+)$/;

test("every production model comes from one pinned commit of jbarlo/eyespy-models, SAM 3 files under sam3/", () => {
  const commits = new Set<string>();
  for (const [name, e] of Object.entries(PRODUCTION_MODELS)) {
    const m = PINNED.exec(e.url);
    assert.ok(m, `${name}: ${e.url} is not a pinned jbarlo/eyespy-models URL`);
    commits.add(m[1] ?? "");
    assert.equal(m[2], name.startsWith("dinov2-small/") ? name : `sam3/${name}`, name);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(Number.isInteger(e.bytes) && e.bytes > 0, name);
  }
  assert.equal(commits.size, 1, "one commit for all files");
});

test("localManifest serves every production file by name from one base, with the same hashes and sizes", () => {
  const local = localManifest("http://127.0.0.1:1234/models");
  assert.deepEqual(Object.keys(local), Object.keys(PRODUCTION_MODELS));
  for (const [name, e] of Object.entries(PRODUCTION_MODELS))
    assert.deepEqual(local[name], { ...e, url: `http://127.0.0.1:1234/models/${name}` });
});

test("the production ORT wasm URL names the installed onnxruntime-web version", () => {
  assert.ok(wasm.url.includes(`/onnxruntime-web@${installed}/`), `${wasm.url} is not version ${installed}`);
});

test("the production ORT wasm hash and size are the installed file's", () => {
  const bytes = readFileSync(path.join(ORT, "dist", path.basename(new URL(wasm.url).pathname)));
  assert.equal(bytes.length, wasm.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), wasm.sha256);
});
