/**
 * SAM 3 over the CardAnvil ONNX split into vision, text and detector. Text features stay cached per prompt for the
 * instance's lifetime, since prompts are few and small. Graph and tensor names live here, except the vision outputs,
 * which are FEATURE_PLANES.
 */
import { err, ok, Result, type ResultAsync } from "neverthrow";
import { at, invariant } from "../../../invariant/index.ts";
import type { RGB } from "../../../pixels/index.ts";
import type { Feeds, Tensor } from "../../../ports/index.ts";
import {
  FEATURE_PLANES,
  MODEL_FILES,
  TRUNK_LEN,
  type DetectorPrecision,
  type Features,
  type Trunk,
} from "../../pure.ts";
import type { PerceptionError } from "../../types.ts";
import { isFeatures } from "../features.ts";
import { Memo } from "../../../railway/index.ts";
import { float32Output, type Models } from "../models.ts";
import { concatF16, SAM_SIZE, samPixels, splitF32, type DetectorOutput } from "./pixels.kernel.ts";
import type { VisionParts } from "./parts.cache.ts";
import { PlanesPool } from "./planes.cache.ts";
import { parseTokenizer } from "./tokenizer.ts";
import type { ClipTokenizer } from "./tokenizer.kernel.ts";

export interface Sam {
  /** Vision features of one image, rounded to fp16, the cache format. */
  readonly encode: (img: RGB) => ResultAsync<Features, PerceptionError>;
  /** Features and trunk of one image, through the vision parts. */
  readonly encodeWithTrunk: (img: RGB) => ResultAsync<{ features: Features; trunk: Trunk }, PerceptionError>;
  /** The trunk alone, through the vision parts. */
  readonly encodeTrunk: (img: RGB) => ResultAsync<Trunk, PerceptionError>;
  /** One detector call on Features. */
  readonly detectRaw: (features: Features, prompt: string) => ResultAsync<DetectorOutput, PerceptionError>;
  readonly detectorFile: string;
}

type TextFeeds = { readonly features: Tensor; readonly mask: Tensor };

export function createSam(models: Models, precision: DetectorPrecision, parts: VisionParts | null): Sam {
  const detectorFile = MODEL_FILES.detector[precision];
  const tokenizer = new Memo<"tok", ClipTokenizer, PerceptionError>();
  const texts = new Memo<string, TextFeeds, PerceptionError>();
  const pool = new PlanesPool();

  const tok = (): ResultAsync<ClipTokenizer, PerceptionError> =>
    tokenizer.get("tok", () => models.readText(MODEL_FILES.tokenizer).andThen((text) => parseTokenizer(text)));

  const textFeatures = (prompt: string): ResultAsync<TextFeeds, PerceptionError> =>
    texts.get(prompt, () =>
      tok().andThen((t) => {
        const e = t.encode(prompt);
        const ids: Tensor = { type: "int64", data: BigInt64Array.from(e.ids), dims: [1, 32] };
        const mask: Tensor = { type: "int64", data: BigInt64Array.from(e.mask), dims: [1, 32] };
        return models.run(MODEL_FILES.text, { input_ids: ids, attention_mask: mask }).andThen((r) => {
          const features = r["text_features"];
          return features
            ? ok({ features, mask })
            : err<TextFeeds, PerceptionError>({
                kind: "model-output-missing",
                model: MODEL_FILES.text,
                output: "text_features",
              });
        });
      }),
    );

  const pixels = (img: RGB): Tensor => ({ type: "float32", data: samPixels(img), dims: [1, 3, SAM_SIZE, SAM_SIZE] });

  /** The feature planes of a vision output, as the fp16 cache format. */
  const featuresOf = (r: Feeds, file: string): Result<Features, PerceptionError> =>
    Result.combine(FEATURE_PLANES.map((p) => float32Output(r, file, p.name, p.len))).andThen((planes) => {
      const f = concatF16(planes);
      return isFeatures(f)
        ? ok(f)
        : err<Features, PerceptionError>({
            kind: "model-output-missing",
            model: file,
            output: FEATURE_PLANES.map((p) => p.name).join("+"),
          });
    });

  const trunkOf = (img: RGB): ResultAsync<Tensor, PerceptionError> => {
    invariant(parts !== null, "the vision parts are off");
    return parts.trunk(pixels(img));
  };

  const trunkBits = (t: Tensor): Result<Trunk, PerceptionError> =>
    t.data instanceof Uint16Array && t.data.length === TRUNK_LEN
      ? ok(t.data)
      : err({ kind: "model-output-missing", model: MODEL_FILES.visionParts.parts.at(-1) ?? "", output: "trunk" });

  const encodeWithTrunk = (img: RGB) =>
    trunkOf(img).andThen((t) => {
      invariant(parts !== null, "the vision parts are off");
      return trunkBits(t).asyncAndThen((trunk) =>
        parts
          .neck(t)
          .andThen((r) => featuresOf(r, MODEL_FILES.visionParts.neck))
          .map((features) => ({ features, trunk })),
      );
    });

  const encode = (img: RGB): ResultAsync<Features, PerceptionError> =>
    parts
      ? encodeWithTrunk(img).map((r) => r.features)
      : models.run(MODEL_FILES.vision, { pixel_values: pixels(img) }).andThen((r) => featuresOf(r, MODEL_FILES.vision));

  const detectRaw = (features: Features, prompt: string): ResultAsync<DetectorOutput, PerceptionError> =>
    textFeatures(prompt).andThen((t) => {
      const planes = splitF32(features, pool.take());
      const feeds: Feeds = Object.fromEntries([
        ["text_features", t.features],
        ["text_mask", t.mask],
        ...FEATURE_PLANES.map((p, k): [string, Tensor] => [
          p.name,
          { type: "float32", data: at(planes, k), dims: p.dims },
        ]),
      ]);
      return models
        .run(detectorFile, feeds)
        .andTee(() => pool.give(planes))
        .orTee(() => pool.give(planes))
        .andThen((r) =>
          float32Output(r, detectorFile, "pred_logits").andThen((logits) =>
            float32Output(r, detectorFile, "presence_logits").andThen((presence) =>
              float32Output(r, detectorFile, "pred_masks").map((masks): DetectorOutput => {
                const sem = r["semantic_seg"];
                return {
                  logits,
                  presence: presence[0] ?? 0,
                  masks,
                  semantic: sem && sem.data instanceof Float32Array ? sem.data : null,
                };
              }),
            ),
          ),
        );
    });

  return {
    encode,
    encodeWithTrunk,
    encodeTrunk: (img) => trunkOf(img).andThen(trunkBits),
    detectRaw,
    detectorFile,
  };
}
