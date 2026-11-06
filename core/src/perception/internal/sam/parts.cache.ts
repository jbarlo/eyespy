/**
 * The vision encoder split into parts (MODEL_FILES.visionParts), loaded and released as a set. The trunk comes out of
 * the last part, and the detector's features out of the neck, which a frame that is only tracked never runs.
 *
 * A host with `loadChain` runs the parts its own way (the browser passes GPU buffers between them). Any other host
 * loads them one by one as plain models and passes host tensors. Only one run is ever in flight, on the actor.
 */
import { ResultAsync } from "neverthrow";
import { at, invariant } from "../../../invariant/index.ts";
import type { HostFailure, Model, ModelChain, ModelRuntime, Tensor } from "../../../ports/index.ts";
import { hostFailure } from "../../../ports/index.ts";
import { MODEL_FILES, VISION_PART_STEPS } from "../../pure.ts";

const hostChain = async (rt: ModelRuntime): Promise<ModelChain> => {
  const models: Model[] = [];
  for (const step of VISION_PART_STEPS) models.push(await rt.load(step.file));
  return {
    run: async (first) => {
      let x = first;
      for (const [k, step] of VISION_PART_STEPS.entries()) {
        const out = await at(models, k).run({ [step.input]: x });
        const y = out[step.output];
        invariant(y, () => `${step.file} has no output ${step.output}`);
        x = y;
      }
      return x;
    },
    release: async () => {
      for (const m of models) await m.release?.();
    },
  };
};

export class VisionParts {
  private chain: Promise<ModelChain> | null = null;
  private neckModel: Promise<Model> | null = null;

  constructor(private readonly rt: ModelRuntime) {}

  private loadChain(): Promise<ModelChain> {
    this.chain ??= this.rt.loadChain?.(VISION_PART_STEPS) ?? hostChain(this.rt);
    this.chain.catch(() => (this.chain = null));
    return this.chain;
  }

  /** The trunk of an image in SAM pixels. */
  trunk(pixels: Tensor): ResultAsync<Tensor, HostFailure> {
    return ResultAsync.fromPromise(
      this.loadChain().then((c) => c.run(pixels)),
      (e) => hostFailure("runtime", "run", e),
    );
  }

  /** The detector's features of a trunk. */
  neck(trunk: Tensor): ResultAsync<Readonly<Record<string, Tensor>>, HostFailure> {
    this.neckModel ??= this.rt.load(MODEL_FILES.visionParts.neck);
    this.neckModel.catch(() => (this.neckModel = null));
    return ResultAsync.fromPromise(
      this.neckModel.then((m) => m.run({ [MODEL_FILES.visionParts.trunk]: trunk })),
      (e) => hostFailure("runtime", "run", e),
    );
  }

  /** Frees the whole set. The next use loads it again. Does nothing if it isn't loaded. */
  release(): ResultAsync<void, HostFailure> {
    const chain = this.chain;
    const neck = this.neckModel;
    this.chain = null;
    this.neckModel = null;
    return ResultAsync.fromPromise(
      (async () => {
        if (chain) await (await chain).release();
        if (neck) await (await neck).release?.();
      })(),
      (e) => hostFailure("runtime", "release", e),
    );
  }
}
