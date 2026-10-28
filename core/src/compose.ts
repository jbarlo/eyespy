/**
 * The inner composition root, the only code that calls a module's `createX`. It wires modules and makes no
 * decisions. `folder.open()` runs first. Each module gets only its own options.
 */
import type { ResultAsync } from "neverthrow";
import { createDetections } from "./detections/index.ts";
import { createLabelling } from "./labelling/index.ts";
import { createPerception } from "./perception/index.ts";
import type { PerceptionOptions } from "./perception/index.ts";
import type {
  Clock,
  HostInfo,
  ImageCodec,
  Logger,
  ModelRuntime,
  SessionStore,
  Timers,
  ClipSource,
} from "./ports/index.ts";
import { createRenderer } from "./render/index.ts";
import { createEngine, createSession } from "./session/index.ts";
import type { Engine, EngineOptions, Session, SessionError, SessionOptions } from "./session/index.ts";
import { createSessionFolder } from "./storage/index.ts";
import type { StorageError } from "./storage/index.ts";
import { createVideo } from "./video/index.ts";

export type HostPorts = {
  readonly runtime: ModelRuntime;
  readonly store: SessionStore;
  readonly video: ClipSource;
  readonly codec: ImageCodec;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly logger: Logger;
  /** Versions of host-side pieces for the manifest's provenance. */
  readonly info: HostInfo;
};

export type ComposeOptions = Pick<
  PerceptionOptions,
  "detector" | "featureCacheMB" | "persistFeatures" | "featureDiskMB"
> &
  SessionOptions;
export type ComposeError = StorageError | SessionError;

export type ComposeSession = (ports: HostPorts, opts: ComposeOptions) => ResultAsync<Session, ComposeError>;
export type ComposeEngine = (
  ports: HostPorts,
  opts: ComposeOptions & EngineOptions,
) => ResultAsync<Engine, ComposeError>;

/** @internal */
export const composeSession: ComposeSession = (ports, opts) => {
  const { runtime, store, codec, clock, logger, info } = ports;
  const folder = createSessionFolder({ store, clock });
  return folder.open().andThen((records) => {
    const video = createVideo(
      { source: ports.video, frames: folder.frames, decoder: codec, clock, logger },
      { clips: records.meta.clips },
    );
    const perception = createPerception(
      { runtime, features: folder.features, frames: video, clock, logger },
      {
        detector: opts.detector,
        featureCacheMB: opts.featureCacheMB,
        persistFeatures: opts.persistFeatures,
        featureDiskMB: opts.featureDiskMB,
        storedFeatureFormat: records.meta.formats.features,
        profile: opts.profile,
      },
    );
    const detections = createDetections({
      detections: records.detections,
      runs: records.runs,
      reserved: video.reserved(),
    });
    const labelling = createLabelling(
      { detections, log: folder.labels },
      { objects: records.objects, history: records.history, nextObj: records.nextObj },
    );
    const render = createRenderer({ frames: video, text: codec });
    return createSession(
      {
        modules: { video, perception, detections, labelling, render },
        stores: {
          meta: folder.meta,
          detections: folder.detections,
          heatmaps: folder.heatmaps,
          outputs: folder.outputs,
          frameFiles: folder.frames,
          featureBytes: (ref) => folder.features.size(ref),
          removeClipFiles: (key) => folder.removeClipFiles(key),
        },
        host: { codec, clock, logger, info, root: folder.root },
      },
      records.meta,
      { profile: opts.profile },
    );
  });
};

export const composeEngine: ComposeEngine = (ports, opts) =>
  composeSession(ports, opts).map((session) =>
    createEngine(
      session,
      { clock: ports.clock, logger: ports.logger, timers: ports.timers },
      { idleMinutes: opts.idleMinutes, onExit: opts.onExit },
    ),
  );
