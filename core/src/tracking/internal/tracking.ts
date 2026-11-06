/**
 * createTracking runs the tracker graphs for one object on one frame. The steps are upstream's video path: seeding is
 * `_use_mask_as_output` without the no-memory embedding, and propagating is memory attention, the decoder on the
 * conditioned features with no prompt, and the memory encoder on the sigmoid of the decoder's mask.
 */
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { invariant } from "../../invariant/index.ts";
import { FEATURE_PLANES, MASK_SIZE, MODEL_FILES, TRUNK_LEN } from "../../perception/pure.ts";
import { f16ToF32 } from "../../pixels/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { Feeds, HostFailure, Model, Tensor } from "../../ports/index.ts";
import { Memo } from "../../railway/index.ts";
import { MEMORY_LEN, POINTER_LEN, type TrackMemory, type TrackSeed } from "../pure.ts";
import type { CreateTracking, TrackFrame, TrackStep, TrackingError } from "../types.ts";
import { canReach, lastFrame, remember, selectMemory } from "./bank.ts";
import { denseFromVector, memoryInputs, memoryTokens, seedMask, type Tables } from "./inputs.kernel.ts";

const MASK_PIXELS = MASK_SIZE * MASK_SIZE;
const S0_LEN = 32 * MASK_PIXELS;
const S1_LEN = (64 * MASK_PIXELS) / 4;
const F72_LEN = FEATURE_PLANES[2].len;
/** _use_mask_as_output's object score logit for a mask with pixels: 20 · 1 - 10. */
const SEED_SCORE = 10;

const f32 = (data: Float32Array, dims: readonly number[]): Tensor => ({ type: "float32", data, dims });
const scalar = (v: number): Tensor => f32(Float32Array.of(v), []);
const dense = (data: Float32Array): Tensor => f32(data, [1, 256, 72, 72]);
const scoreTensor = (v: number): Tensor => f32(Float32Array.of(v), [1, 1, 1]);
const maskTensor = (data: Float32Array): Tensor => f32(data, [1, 1, MASK_SIZE, MASK_SIZE]);

/** A float32 output of `model` with `len` values. */
const output = (r: Feeds, model: string, name: string, len: number): Result<Float32Array, TrackingError> => {
  const t = r[name];
  return t && t.data instanceof Float32Array && t.data.length === len
    ? ok(t.data)
    : err({ kind: "model-output-missing", model, output: name });
};

export const createTracking: CreateTracking = ({ runtime, clock, logger }, { precision }) => {
  const graphs = MODEL_FILES.tracker.graphs[precision];
  const loaded = new Memo<string, Model, HostFailure>();
  const load = (file: string): ResultAsync<Model, HostFailure> =>
    loaded.get(file, () => {
      const t = clock.now();
      return ResultAsync.fromPromise(runtime.load(file), (e) => hostFailure("runtime", "load", e)).map((m) => {
        logger.log(`loaded ${file} in ${((clock.now() - t) / 1000).toFixed(1)}s`);
        return m;
      });
    });
  const run = (file: string, feeds: Feeds): ResultAsync<Feeds, TrackingError> =>
    load(file).andThen((m) => ResultAsync.fromPromise(m.run(feeds), (e) => hostFailure("runtime", "run", e)));

  const tables = new Memo<"tables", Tables, TrackingError>();
  const loadTables = (): ResultAsync<Tables, TrackingError> =>
    tables.get("tables", () =>
      run(MODEL_FILES.tracker.tables, {}).andThen((r) => {
        const file = MODEL_FILES.tracker.tables;
        return Result.combine([
          output(r, file, "mem_pos", MEMORY_LEN),
          output(r, file, "mem_tpos", 7 * 64),
          output(r, file, "tproj_w", 64 * POINTER_LEN),
          output(r, file, "tproj_b", 64),
          output(r, file, "no_mask", POINTER_LEN),
        ]).map(([memPos, tpos, tprojW, tprojB, noMask]): Tables => ({
          memPos,
          tpos,
          tprojW,
          tprojB,
          noMask: denseFromVector(noMask),
        }));
      }),
    );

  const decode = (frame: TrackFrame, feat: Float32Array, prompt: Float32Array) =>
    run(graphs.decoder, {
      s0: f32(frame.s0, [1, 32, MASK_SIZE, MASK_SIZE]),
      s1: f32(frame.s1, [1, 64, MASK_SIZE / 2, MASK_SIZE / 2]),
      feat: dense(feat),
      dense: dense(prompt),
    });

  const encodeMemory = (frame: TrackFrame, logits: Float32Array, score: number, binarize: boolean) =>
    run(graphs.memenc, {
      f72: dense(frame.f72),
      mask: maskTensor(logits),
      score: scoreTensor(score),
      binarize: scalar(binarize ? 1 : 0),
    }).andThen((r) => output(r, graphs.memenc, "mem", MEMORY_LEN).map(memoryTokens));

  const attend = (frame: TrackFrame, memory: TrackMemory, at: number, t: Tables) => {
    const m = memoryInputs(selectMemory(memory, at), t);
    const feeds: Feeds = {
      spatial: f32(m.spatial, [1, m.spatialTokens, 64]),
      spatial_pos: f32(m.spatialPos, [1, m.spatialTokens, 64]),
      pointer: f32(m.pointer, [1, m.pointerTokens, 64]),
      pointer_pos: f32(m.pointerPos, [1, m.pointerTokens, 64]),
    };
    // Each layer's run ends before the next one starts, so the worker can answer between them.
    return graphs.attention.reduce(
      (x, file, k) =>
        x.andThen((input) =>
          run(file, { x: k === 0 ? dense(input) : f32(input, [1, 72 * 72, 256]), ...feeds }).andThen((r) =>
            output(r, file, "y", F72_LEN),
          ),
        ),
      okAsync<Float32Array, TrackingError>(frame.f72),
    );
  };

  return {
    frame: (trunk) => {
      invariant(trunk.length === TRUNK_LEN, () => `trunk: ${trunk.length} values, need ${TRUNK_LEN}`);
      const dims = [1, 1024, 72, 72];
      // The fp16 neck takes the trunk as the vision graph's last part gives it. The fp32 neck takes it widened.
      const input: Tensor = precision === "fp16" ? { type: "float16", data: trunk, dims } : f32(f16ToF32(trunk), dims);
      return run(graphs.neck, { trunk: input }).andThen((r) =>
        Result.combine([
          output(r, graphs.neck, "s0", S0_LEN),
          output(r, graphs.neck, "s1", S1_LEN),
          output(r, graphs.neck, "f72", F72_LEN),
        ]).map(([s0, s1, f72]): TrackFrame => ({ s0, s1, f72 })),
      );
    },

    seed: (frame, mask, at, clipFrames) => {
      invariant(mask.length === MASK_PIXELS, () => `seed mask: ${mask.length} values, need ${MASK_PIXELS}`);
      if (!Number.isInteger(at) || at < 0 || at >= clipFrames)
        return errAsync({ kind: "track-frame-order", at, last: at, clipFrames });
      const m = seedMask(mask);
      if (m.area === 0) return errAsync({ kind: "track-seed-empty" });
      return run(graphs.maskEmbed, { mask: maskTensor(m.binary) })
        .andThen((r) => output(r, graphs.maskEmbed, "dense", F72_LEN))
        .andThen((prompt) => decode(frame, frame.f72, prompt))
        .andThen((r) => output(r, graphs.decoder, "pointer", POINTER_LEN))
        .andThen((pointer) =>
          encodeMemory(frame, m.logits, SEED_SCORE, true).map((tokens): TrackSeed => ({
            at,
            clipFrames,
            tokens,
            pointer,
          })),
        );
    },

    propagate: (frame, memory, at) => {
      if (!canReach(memory, at))
        return errAsync({ kind: "track-frame-order", at, last: lastFrame(memory), clipFrames: memory.seed.clipFrames });
      return loadTables().andThen((t) =>
        attend(frame, memory, at, t)
          .andThen((feat) => decode(frame, feat, t.noMask))
          .andThen((r) =>
            Result.combine([
              output(r, graphs.decoder, "low_res", MASK_PIXELS),
              output(r, graphs.decoder, "iou", 1),
              output(r, graphs.decoder, "score", 1),
              output(r, graphs.decoder, "pointer", POINTER_LEN),
            ]),
          )
          .andThen(([logits, iou, score, pointer]) => {
            const s = score[0] ?? 0;
            return encodeMemory(frame, logits, s, false).map((tokens): TrackStep => ({
              memory: remember(memory, { at, tokens, pointer }),
              logits,
              score: s,
              iou: iou[0] ?? 0,
            }));
          }),
      );
    },
  };
};
