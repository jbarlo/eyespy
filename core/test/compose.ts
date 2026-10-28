/** composeEngine and composeSession over the fakes. Tests call the router, as the server and worker do. */
import type { Result } from "neverthrow";
import { okAsync } from "neverthrow";
import type { Engine, EngineOptions, Session } from "../src/session/index.ts";
import { composeEngine, composeSession, type ComposeOptions } from "../src/compose.ts";
import { createCaller } from "../src/api/index.ts";
import { EMPTY_SESSION_JSON, fakeHost, type FakeHost, type FakeHostOptions } from "./fakes/index.ts";

/**
 * persistFeatures is off, so features stay in RAM and the store holds no feature files. The RAM cache holds more
 * keyframes than any test session has, so no test evicts and re-encodes a frame.
 */
export const ENGINE_DEFAULTS: Omit<EngineOptions, "onExit"> & ComposeOptions = {
  detector: "fp32",
  persistFeatures: false,
  featureCacheMB: 640,
};

export type Opened = {
  host: FakeHost;
  engine: Engine;
  caller: ReturnType<typeof createCaller>;
  /** Waits until background encoding is done. Call it between ops so the store and replies are deterministic. */
  settle(): Promise<void>;
  close(): void;
  exited: () => boolean;
};

/** A fake host whose store holds a new, empty session (unless it already has one). */
export function newHost(opts: FakeHostOptions = {}): FakeHost {
  const host = fakeHost(opts);
  if (!host.store.files.has("session.json"))
    host.store.files.set("session.json", new TextEncoder().encode(EMPTY_SESSION_JSON));
  return host;
}

async function must<T, E>(r: PromiseLike<Result<T, E>>): Promise<T> {
  const v = await r;
  if (v.isErr()) throw new Error(`compose failed: ${JSON.stringify(v.error)}`);
  return v.value;
}

/**
 * composeEngine over a fake host, then a wait for background encoding. Pass `settle: false` for a session whose
 * frames the encoder can't finish, such as a fixture without frame images.
 */
export async function openEngine(
  host: FakeHost = newHost(),
  opts: Partial<EngineOptions & ComposeOptions> = {},
  { settle: settleFirst = true } = {},
): Promise<Opened> {
  let exited = false;
  const engine = await must(composeEngine(host.ports, { ...ENGINE_DEFAULTS, ...opts, onExit: () => (exited = true) }));
  const settle = async () => {
    for (let k = 0; k < 10_000; k++) {
      const pending = await engine.call(undefined, (s) => okAsync(s.pending().length));
      if (pending.isOk() && !pending.value) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("background encoding never finished");
  };
  if (settleFirst) await settle();
  return {
    host,
    engine,
    caller: createCaller({ engine }),
    settle,
    close: () => engine.shutdown(),
    exited: () => exited,
  };
}

/** A composed Session without the engine, for white-box checks of opening and the use cases. */
export async function openSession(host: FakeHost, opts: Partial<ComposeOptions> = {}): Promise<Session> {
  return must(composeSession(host.ports, { ...ENGINE_DEFAULTS, ...opts }));
}

/** The DOS time of a zip's first entry in ms, with its fields read as UTC. */
export function zipTime(zip: Uint8Array): number {
  const u16 = (k: number) => (zip[k] ?? 0) | ((zip[k + 1] ?? 0) << 8);
  if (u16(0) !== 0x4b50 || u16(2) !== 0x0403) throw new Error("not a zip local file header");
  const t = u16(10),
    d = u16(12);
  return Date.UTC((d >> 9) + 1980, ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2);
}
