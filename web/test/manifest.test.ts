/** The production ONNX Runtime wasm is the one the installed onnxruntime-web ships. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PRODUCTION_RUNTIME } from "../src/engine/manifest.ts";

const ORT = path.join(import.meta.dirname, "../node_modules/onnxruntime-web");
const installed = (JSON.parse(readFileSync(path.join(ORT, "package.json"), "utf8")) as { version: string }).version;
const wasm = PRODUCTION_RUNTIME.ortWasm;

test("the production ORT wasm URL names the installed onnxruntime-web version", () => {
  assert.ok(wasm.url.includes(`/onnxruntime-web@${installed}/`), `${wasm.url} is not version ${installed}`);
});

test("the production ORT wasm hash and size are the installed file's", () => {
  const bytes = readFileSync(path.join(ORT, "dist", path.basename(new URL(wasm.url).pathname)));
  assert.equal(bytes.length, wasm.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), wasm.sha256);
});
