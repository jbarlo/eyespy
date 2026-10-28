/** Test doubles for every host port; `fakeHost` bundles them as HostPorts. */
import type { HostPorts } from "../../src/compose.ts";
import type { Logger } from "../../src/ports/index.ts";
import { emptySessionJson } from "../../src/storage/pure.ts";
import { FakeClock } from "./clock.ts";
import { FakeCodec } from "./codec.ts";
import { FakeModelRuntime, type FakeRuntimeOptions } from "./runtime.ts";
import { sceneDetector, type Scene } from "./scene.ts";
import { MemStore } from "./store.ts";
import { FakeTimers } from "./timers.ts";
import { FakeVideo } from "./video.ts";
import { WORLD } from "./world.ts";

export * from "./clock.ts";
export * from "./codec.ts";
export * from "./runtime.ts";
export * from "./scene.ts";
export * from "./stamp.ts";
export * from "./store.ts";
export * from "./timers.ts";
export * from "./video.ts";
export * from "./world.ts";

export class FakeLogger implements Logger {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  }
}

export type FakeHost = {
  store: MemStore;
  video: FakeVideo;
  codec: FakeCodec;
  models: FakeModelRuntime;
  clock: FakeClock;
  timers: FakeTimers;
  logger: FakeLogger;
  ports: HostPorts;
};

export type FakeHostOptions = {
  scene?: Scene;
  store?: MemStore;
  clock?: FakeClock;
  /** Detector script (default: sceneDetector(scene)) and appearance callback (default: colorSignature). */
  models?: FakeRuntimeOptions;
  host?: Record<string, string | null>;
};

export function fakeHost(opts: FakeHostOptions = {}): FakeHost {
  const scene = opts.scene ?? WORLD;
  const store = opts.store ?? new MemStore();
  const video = new FakeVideo(scene);
  const codec = new FakeCodec();
  const models = new FakeModelRuntime({ detector: sceneDetector(scene), ...opts.models });
  const clock = opts.clock ?? new FakeClock();
  const timers = new FakeTimers(clock);
  const logger = new FakeLogger();
  const host = opts.host ?? { code: "test" };
  return {
    store,
    video,
    codec,
    models,
    clock,
    timers,
    logger,
    ports: { runtime: models, store, video, codec, clock, timers, logger, info: host },
  };
}

/** What `eyespy init` writes (storage owns it). */
export const EMPTY_SESSION_JSON = emptySessionJson();
