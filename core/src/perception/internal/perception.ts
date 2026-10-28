/** createPerception wires the internal sub-modules. */
import type { CreatePerception, Perception } from "../types.ts";
import type { Provenance, PerceptionError } from "../types.ts";
import { DEFAULT_CACHE_MB, FEATURE_FORMAT } from "../pure.ts";
import { createFeatureCache } from "./cache/cache.ts";
import { createDino } from "./dino/dino.ts";
import { Memo } from "./memo.cache.ts";
import { createModels } from "./models.ts";
import { provenance } from "./provenance.ts";
import { postprocess } from "./sam/detect.ts";
import { createSam } from "./sam/sam.ts";
import { at } from "../../invariant/index.ts";

export const createPerception: CreatePerception = (ports, opts): Perception => {
  const { runtime, clock, logger } = ports;
  const models = createModels(runtime, clock, logger);
  const sam = createSam(models, opts.detector);
  const dino = createDino(models);
  const cache = createFeatureCache(
    { store: ports.features, frames: ports.frames, encode: sam.encode, clock, logger },
    {
      featureCacheMB: opts.featureCacheMB ?? DEFAULT_CACHE_MB,
      persist: opts.persistFeatures ?? true,
      trustStored: opts.storedFeatureFormat === FEATURE_FORMAT,
      featureDiskMB: opts.featureDiskMB ?? null,
    },
  );
  const prov = new Memo<"p", Provenance, PerceptionError>();

  return {
    encode: sam.encode,
    features: cache.features,
    encoded: cache.encoded,
    pending: cache.pending,
    encodeNext: cache.encodeNext,
    scanStore: cache.scanStore,
    forget: cache.forget,
    detect: (features, prompt, target, o) => {
      const t0 = clock.now();
      return sam.detectRaw(features, prompt).map((out) => {
        const t1 = clock.now();
        const d = postprocess(out, target, o);
        if (opts.profile)
          logger.log(
            `detect ${JSON.stringify(prompt)} ${target.w}x${target.h}: sam ${Math.round(t1 - t0)}, ` +
              `masks(${d.instances.length}) ${Math.round(clock.now() - t1)} ms`,
          );
        return d;
      });
    },
    embed: dino.embed,
    embedCrop: (img) => dino.appearance([img]).map((vs) => at(vs, 0)),
    setPersist: cache.setPersist,
    clearStored: cache.clearStored,
    setDiskBudget: cache.setDiskBudget,
    hold: cache.hold,
    stats: cache.stats,
    provenance: () => prov.get("p", () => provenance(runtime, sam.detectorFile)),
    formats: { features: FEATURE_FORMAT },
  };
};
