import assert from "node:assert/strict";
import { test } from "node:test";
import { samPixels } from "../src/perception/internal/sam/pixels.kernel.ts";
import { parseTokenizer } from "../src/perception/internal/sam/tokenizer.ts";
import { MASK_SIZE, MODEL_FILES, normalize, similarity } from "../src/perception/pure.ts";
import { pickKeyframes } from "../src/video/internal/keyframes.ts";
import {
  FakeCodec,
  FakeVideo,
  KITCHEN,
  PANTRY,
  TOKENIZER_JSON,
  WORLD,
  colorSignature,
  decodePrompt,
  detectorOutputs,
  renderFrame,
  sceneDetector,
} from "./fakes/index.ts";
import { rig } from "./perception/fakes.ts";

test("tokenizer round trip: the fake text/detector models see the prompt as tokenized", () => {
  const tok = parseTokenizer(TOKENIZER_JSON)._unsafeUnwrap();
  for (const [p, want] of [
    ["jar", "jar"],
    ["Glass  JAR", "glass jar"],
    ["café crème", "café crème"],
    ["it's a jar!", "it 's a jar !"], // word ends become spaces
  ] as const)
    assert.equal(decodePrompt(tok.encode(p).ids.map(Number)), want);
});

test("the frame stamp survives SAM preprocessing; the detector gets frame and prompt", async () => {
  const { p, rt } = rig({ models: { detector: sceneDetector(WORLD) } });
  const img = renderFrame(WORLD, 2, 1.6);
  const f = (await p.encode(img))._unsafeUnwrap();
  const out = (await p.detect(f, "box", { w: img.w, h: img.h }, { scoreFloor: 0.3, nmsIou: 0.7 }))._unsafeUnwrap();
  assert.deepEqual(rt.detections.at(-1)?.frame, { clip: 2, t: 1.6 });
  assert.equal(rt.detections.at(-1)?.prompt, "box");
  assert.equal(out.instances.length, 1);
  // sigmoid(3) · sigmoid(4)
  assert.ok(Math.abs((out.instances[0]?.score ?? 0) - 0.9358) < 1e-3);
  assert.ok(out.heatmap);
  assert.ok(samPixels(img).length > 0);
  assert.deepEqual(rt.loads, [MODEL_FILES.vision, MODEL_FILES.text, MODEL_FILES.detector.fp32]);
});

test("detector outputs are sparse: scripted slots only, others never pass a floor", () => {
  const out = detectorOutputs({
    presence: 0,
    queries: [
      { rect: [0, 0, 0.5, 0.5], logit: 5 },
      { rect: [0.5, 0.5, 1, 1], logit: 5, slot: 10 },
    ],
  });
  const logits = out.pred_logits?.data as Float32Array;
  assert.deepEqual(
    [...logits.entries()].filter(([, v]) => v > -20).map(([k]) => k),
    [0, 10],
  );
  const masks = out.pred_masks?.data as Float32Array;
  const M = MASK_SIZE * MASK_SIZE;
  assert.equal(masks[0], 10);
  assert.equal(masks[M - 1], -10);
  assert.equal(masks[10 * M + M - 1], 10);
});

test("appearance: same colour, same vector; another colour, lower similarity", async () => {
  const { p } = rig();
  const solid = (c: [number, number, number], w = 40, h = 30) => ({
    w,
    h,
    data: new Uint8Array(w * h * 3).map((_, k) => c[k % 3] ?? 0),
  });
  const v = async (img: ReturnType<typeof solid>) => (await p.embedCrop(img))._unsafeUnwrap();
  const a = await v(solid([200, 40, 40]));
  const b = await v(solid([200, 40, 40], 60, 20));
  const c = await v(solid([40, 180, 60]));
  assert.ok(similarity(a, b) > 0.999);
  assert.ok(similarity(a, c) < 0.5);
  assert.ok(similarity(normalize(colorSignature(solid([200, 40, 40]))), a) > 0.99);
});

test("video: keyframes from the real picker, frames decode through the fake codec", async () => {
  const v = new FakeVideo(WORLD);
  const times = async (ref: string) =>
    (await pickKeyframes(v, ref, await v.open(ref, { fps: null }), 0.4))._unsafeUnwrap();
  assert.deepEqual(await times(KITCHEN), [0, 0.2, 1]);
  assert.deepEqual(await times(PANTRY), [0, 0.6, 1.6]);
  const img = await new FakeCodec().decode(await v.frameJpeg("kitchen.mp4", 0.2));
  assert.deepEqual(img, renderFrame(WORLD, 1, 0.2));
  assert.equal(await v.exists("nope.mp4"), false);
  assert.equal(v.resolve("pantry.mov"), PANTRY);
});
