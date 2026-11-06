/** createPerception wires the internal sub-modules. */
import type { RGB } from "../../pixels/index.ts";
import type { FrameNo } from "../../video/pure.ts";
import type { Features } from "../pure.ts";
import type { CreatePerception, Perception } from "../types.ts";
import type { Provenance, PerceptionError } from "../types.ts";
import { DEFAULT_CACHE_MB, DEFAULT_TRUNK_DISK_MB, FEATURE_FORMAT, TRUNK_FORMAT } from "../pure.ts";
import { invariant } from "../../invariant/index.ts";
import { okAsync, type ResultAsync } from "neverthrow";
import { createFeatureCache } from "./cache/cache.ts";
import { TrunkFiles } from "./cache/trunks.cache.ts";
import { VisionParts } from "./sam/parts.cache.ts";
import { createDino } from "./dino/dino.ts";
import { Memo } from "../../railway/index.ts";
import { createModels } from "./models.ts";
import { provenance } from "./provenance.ts";
import { postprocess } from "./sam/detect.ts";
import { createSam } from "./sam/sam.ts";
import { at } from "../../invariant/index.ts";

export const createPerception: CreatePerception = (ports, opts): Perception => {
  const { runtime, clock, logger } = ports;
  const models = createModels(runtime, clock, logger);
  const parts = opts.visionParts ? new VisionParts(runtime) : null;
  const sam = createSam(models, opts.detector, parts);
  const trunkStore = ports.trunks;
  const trunks =
    parts && trunkStore
      ? new TrunkFiles(
          trunkStore,
          logger,
          opts.trunkDiskMB ?? DEFAULT_TRUNK_DISK_MB,
          opts.storedTrunkFormat === TRUNK_FORMAT,
        )
      : null;
  const needTrunks = (): TrunkFiles => {
    invariant(trunks !== null, "the vision parts are off");
    return trunks;
  };
  /** A keyframe's features. With the parts on, its trunk is on the way, so it gets stored too. */
  const encodeKeyframe = (img: RGB, i: FrameNo): ResultAsync<Features, PerceptionError> => {
    if (!trunks) return sam.encode(img);
    const ref = ports.frames.trackRef(i);
    return sam
      .encodeWithTrunk(img)
      .andThen(({ features, trunk }) => (ref ? trunks.write(ref, trunk) : okAsync(undefined)).map(() => features));
  };
  const dino = createDino(models);
  const cache = createFeatureCache(
    { store: ports.features, frames: ports.frames, encode: encodeKeyframe, clock, logger },
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
    scanStore: () =>
      cache.scanStore().andThen((n) => {
        if (!trunks) return okAsync(n);
        const clips = ports.frames.liveFrames().flatMap((i) =>
          ports.frames.ref(i).match(
            (r) => [r.clipKey],
            () => [],
          ),
        );
        return trunks.scan([...new Set(clips)]).map(() => n);
      }),
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
    trunk: (ref) => needTrunks().read(ref),
    encodeTrunk: (ref, img) =>
      sam.encodeTrunk(img).andThen((trunk) =>
        needTrunks()
          .write(ref, trunk)
          .map(() => trunk),
      ),
    forgetTrunks: (key) => trunks?.forgetClip(key),
    releaseVision: () => parts?.release() ?? okAsync(undefined),
    formats: { features: FEATURE_FORMAT, trunks: TRUNK_FORMAT },
  };
};
