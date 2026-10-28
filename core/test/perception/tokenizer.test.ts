/** The HF tests need tokenizer.json from the models folder and skip without it. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseTokenizer } from "../../src/perception/internal/sam/tokenizer.ts";
import { DIR, json } from "../fixtures/numerics/lib.ts";
import { TOKENIZER_JSON } from "../fakes/index.ts";

type Meta = { tokenizer_sha256: string; prompts: { text: string; ids: number[]; mask: number[] }[] };
const meta = json<Meta>("tokens.json");

const models = process.env.EYESPY_MODELS ?? path.resolve(DIR, "../../../../models/onnx");
const file = path.join(models, "tokenizer.json");
const skip = existsSync(file) ? false : `no ${file}: set EYESPY_MODELS to the ONNX model directory`;
const tok = skip ? null : parseTokenizer(readFileSync(file, "utf8"))._unsafeUnwrap();

for (const p of meta.prompts)
  test(`encode ${JSON.stringify(p.text)} = HF input_ids / attention_mask`, { skip }, () => {
    const e = tok!.encode(p.text);
    assert.deepEqual(e.ids.map(Number), p.ids);
    assert.deepEqual(e.mask.map(Number), p.mask);
  });

test("the fake runtime's synthetic tokenizer.json parses", () => {
  const t = parseTokenizer(TOKENIZER_JSON)._unsafeUnwrap();
  assert.equal(t.encode("ab").ids.length, 32);
});

test("bad tokenizer.json is a bad-tokenizer error, not a throw", () => {
  for (const text of ["not json", "{}", JSON.stringify({ model: { vocab: { a: 1 }, merges: [] } })]) {
    const r = parseTokenizer(text);
    assert.ok(r.isErr());
    assert.equal(r.error.kind, "bad-tokenizer");
  }
});
