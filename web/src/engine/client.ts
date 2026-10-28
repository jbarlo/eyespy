/**
 * Starts the engine worker on a session with its clients: a typed tRPC client over postMessage, the Result-returning
 * op client (`ops`, for the state layer) and the JSON wrapper (window.eyespy). `dispose()` disposes the port and
 * revokes object URLs. A failed start disposes what it started.
 */
import { createTRPCClient } from "@trpc/client";
import { ResultAsync } from "neverthrow";
import type { AppRouter } from "eyespy-core/api";
import { PRODUCTION_MODELS, PRODUCTION_RUNTIME, absolutize } from "./manifest.ts";
import type { ModelManifest, RuntimeAssets } from "./manifest.ts";
import type { EngineEvent, InitOptions, SessionLocation } from "../protocol.ts";
import EngineWorker from "./worker/worker.ts?worker&inline";
import { EnginePort, resultOps, toEngineError, workerLink, wrap } from "./port.ts";
import type { EngineError, Inputs } from "./port.ts";

export type { EngineError, Inputs, EyespyApi, EngineEvent, SessionLocation } from "./port.ts";

type EyespyOptions = {
  session?: SessionLocation; // defaults to an OPFS folder
  models?: ModelManifest; // defaults to the production manifest
  runtime?: RuntimeAssets;
  detector?: "fp32" | "fp16";
  onEvent?: (e: EngineEvent) => void;
  featureCacheMB?: number;
  persistFeatures?: boolean;
  featureDiskMB?: number | null;
  host?: Record<string, string | null>;
  samLicenseAgreed?: boolean;
};

export async function createEyespy(o: EyespyOptions = {}) {
  const port = new EnginePort(new EngineWorker());
  if (o.onEvent) port.on(o.onEvent);
  const client = createTRPCClient<AppRouter>({ links: [workerLink(port)] });
  const { api, revoke } = wrap(port, client);
  const dispose = () => {
    port.dispose();
    revoke();
  };
  const base = location.href;
  const opts: InitOptions = {
    models: absolutize(o.models ?? PRODUCTION_MODELS, base),
    runtime: absolutize(o.runtime ?? PRODUCTION_RUNTIME, base),
    session: o.session ?? { opfs: "default" },
    detector: o.detector,
    featureCacheMB: o.featureCacheMB,
    persistFeatures: o.persistFeatures,
    featureDiskMB: o.featureDiskMB,
    host: o.host,
    samLicenseAgreed: o.samLicenseAgreed ?? false,
  };
  try {
    const info = await port.init(opts);
    const ops = resultOps(client);
    const file = (key: string) => ResultAsync.fromPromise(port.readFile(key), toEngineError);
    const addFile = (f: File, input: Omit<Inputs["add"], "video"> = {}) =>
      ResultAsync.fromPromise(port.register(f), toEngineError).andThen((video) => ops.add({ ...input, video }));
    return { port, client, info, api, ops, file, addFile, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

type EngineHandle = Awaited<ReturnType<typeof createEyespy>>;

/** What the app's composition root sets once (URL params, build revision). open() takes the per-open choices. */
type EngineConfig = {
  models?: ModelManifest;
  runtime?: RuntimeAssets;
  host?: Record<string, string | null>;
  /** Sees every engine event of every session (window.eyespyEvents). */
  tap?: (e: EngineEvent) => void;
};

export type OpenRequest = {
  session: SessionLocation;
  samLicenseAgreed: boolean;
  detector: "fp32" | "fp16";
  persistFeatures: boolean;
  featureDiskMB: number | null;
  featureCacheMB: number;
  onEvent: (e: EngineEvent) => void;
};

/** The app's engine adapter. open(req) starts a fresh worker on a session and returns failures as Err. */
export function createEngine(config: EngineConfig) {
  return {
    open: (req: OpenRequest): ResultAsync<EngineHandle, EngineError> =>
      ResultAsync.fromPromise(
        createEyespy({
          ...config,
          session: req.session,
          samLicenseAgreed: req.samLicenseAgreed,
          detector: req.detector,
          persistFeatures: req.persistFeatures,
          featureDiskMB: req.featureDiskMB,
          featureCacheMB: req.featureCacheMB,
          onEvent: (e) => {
            config.tap?.(e);
            req.onEvent(e);
          },
        }),
        toEngineError,
      ),
  };
}
