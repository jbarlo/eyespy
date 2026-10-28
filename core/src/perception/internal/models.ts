/**
 * The ModelRuntime edge that sam/ and dino/ share. It loads each model file once on first use and logs it. It
 * wraps runs and file reads into HostFailure. It gives typed access to named outputs and returns
 * `model-output-missing` if an output is absent, not float32, or shorter than expected.
 */
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { Clock, Feeds, HostFailure, Logger, Model, ModelRuntime } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { PerceptionError } from "../types.ts";
import { Memo } from "./memo.cache.ts";

/**
 * The internal port sam/ and dino/ use to run models. Failures are HostFailures typed as the PerceptionError they
 * become, so callers chain them with model-output errors without widening.
 */
export interface Models {
  /** Runs a model file, loading it on first use. */
  run(file: string, feeds: Feeds): ResultAsync<Feeds, PerceptionError>;
  /** A small model-side text file (tokenizer.json). */
  readText(file: string): ResultAsync<string, PerceptionError>;
}

export function createModels(rt: ModelRuntime, clock: Clock, logger: Logger): Models {
  const loaded = new Memo<string, Model, HostFailure>();
  const load = (file: string): ResultAsync<Model, HostFailure> =>
    loaded.get(file, () => {
      const t = clock.now();
      return ResultAsync.fromPromise(rt.load(file), (e) => hostFailure("runtime", "load", e)).map((m) => {
        logger.log(`loaded ${file} in ${((clock.now() - t) / 1000).toFixed(1)}s`);
        return m;
      });
    });
  return {
    run: (file, feeds) =>
      load(file).andThen((m) => ResultAsync.fromPromise(m.run(feeds), (e) => hostFailure("runtime", "run", e))),
    readText: (file) => ResultAsync.fromPromise(rt.readText(file), (e) => hostFailure("runtime", "readText", e)),
  };
}

/** A float32 output of `model` with at least `min` values. */
export function float32Output(r: Feeds, model: string, output: string, min = 1): Result<Float32Array, PerceptionError> {
  const t = r[output];
  return t && t.data instanceof Float32Array && t.data.length >= min
    ? ok(t.data)
    : err({ kind: "model-output-missing", model, output });
}
