import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { DataFrame } from "eyespy-core/session";
import type { EngineError, EngineOps } from "../src/engine/port.ts";
import { createAssetCaches, createStores } from "../src/state/index.ts";
import { LICENCE_PREF } from "../src/state/licence.ts";
import type {
  App,
  BrowserStorage,
  Clock,
  EngineSession,
  Host,
  Imaging,
  OpenRequest,
  WebGpu,
} from "../src/state/index.ts";

export type Handler = (input: never, call: { path: string; session: number }) => unknown;
export type Handlers = Record<string, Handler>;

/** A user error the way the router reports one. */
export class UserError extends Error {}

const engineError = (e: unknown): EngineError =>
  e instanceof UserError
    ? { kind: "user", code: "BAD_REQUEST", message: e.message }
    : { kind: "internal", code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : String(e) };

export type Call = { path: string; input: unknown; session: number };

export function fakeEngine(handlers: Handlers) {
  const calls: Call[] = [];
  const opened: { req: OpenRequest; disposed: boolean; n: number }[] = [];
  let failOpen: string | null = null;
  /** While set, ops and opens wait for it (to test races). */
  let gate: Promise<void> | null = null;

  function ops(n: number, isDisposed: () => boolean): EngineOps {
    const proxy = (prefix: string): unknown =>
      new Proxy(() => {}, {
        get: (_t, k) => (typeof k === "string" && k !== "then" ? proxy(prefix ? `${prefix}.${k}` : k) : undefined),
        apply: (_t, _this, args: unknown[]) => {
          const input = args[0] ?? {};
          calls.push({ path: prefix, input, session: n });
          const run = async () => {
            if (gate) await gate;
            if (isDisposed()) throw Object.assign(new Error("engine disposed"), { disposed: true });
            const h = handlers[prefix];
            if (!h) throw new Error(`no handler for ${prefix}`);
            return h(input as never, { path: prefix, session: n });
          };
          return ResultAsync.fromPromise(run(), (e) =>
            e instanceof Error && "disposed" in e
              ? { kind: "disposed", code: "DISPOSED", message: e.message }
              : engineError(e),
          );
        },
      });
    return proxy("") as EngineOps;
  }

  const port = {
    open: (req: OpenRequest) => {
      if (failOpen) return errAsync<EngineSession, EngineError>({ kind: "internal", code: "X", message: failOpen });
      const entry = { req, disposed: false, n: opened.length + 1 };
      opened.push(entry);
      const session: EngineSession = {
        info: { root: "fake", device: "webgpu fake" },
        ops: ops(entry.n, () => entry.disposed),
        file: (key) => okAsync(new TextEncoder().encode(key)),
        addFile: (f) =>
          ResultAsync.fromPromise(
            Promise.resolve(handlers.add?.({ video: f.name } as never, { path: "add", session: entry.n })),
            engineError,
          ) as ReturnType<EngineSession["addFile"]>,
        api: {
          call: async (path: string, input: unknown) => handlers[path]?.(input as never, { path, session: entry.n }),
        } as never,
        dispose: () => {
          entry.disposed = true;
        },
      };
      const go = async () => {
        if (gate) await gate;
        return session;
      };
      return ResultAsync.fromSafePromise(go());
    },
  };
  return {
    port,
    calls,
    opened,
    failNextOpen: (msg: string | null) => {
      failOpen = msg;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

export function fakeClock() {
  let t = 0;
  let timers: { at: number; every: number | null; fn: () => void; id: number }[] = [];
  let seq = 0;
  const clock: Clock = {
    every: (ms, fn) => {
      const id = ++seq;
      timers.push({ at: t + ms, every: ms, fn, id });
      return () => (timers = timers.filter((x) => x.id !== id));
    },
    after: (ms, fn) => {
      const id = ++seq;
      timers.push({ at: t + ms, every: null, fn, id });
      return () => (timers = timers.filter((x) => x.id !== id));
    },
  };
  return {
    clock,
    pending: () => timers.length,
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((x) => x.at <= t)) {
        x.fn();
        if (x.every) x.at = t + x.every;
        else timers = timers.filter((y) => y !== x);
      }
    },
  };
}

export function fakeStorage(prefs: Record<string, string> = {}): BrowserStorage & {
  prefs: { data: Record<string, string> };
  /** Sessions passed to clearSessionFeatures, sessions deleted, the persist() call count and its answer. */
  cleared: string[];
  deleted: string[];
  persistCalls: number;
  grant: boolean;
} {
  const data = { ...prefs };
  const s = {
    prefs: { data, get: (k: string) => data[k] ?? null, set: (k: string, v: string) => void (data[k] = v) },
    cleared: [] as string[],
    deleted: [] as string[],
    persistCalls: 0,
    grant: false,
    listSessions: () => okAsync(["default", "other"]),
    usage: () =>
      okAsync({
        usage: 1,
        quota: 2,
        models: 0,
        sessions: [
          { name: "s1", total: 300, features: 200 },
          { name: "other", total: 10, features: 0 },
        ],
        persisted: true,
      }),
    clearFeatures: () => okAsync(2),
    clearSessionFeatures: (name: string) => {
      s.cleared.push(name);
      return okAsync(1);
    },
    deleteSession: (name: string) => {
      s.deleted.push(name);
      return okAsync(undefined);
    },
    persist: () => {
      s.persistCalls++;
      return okAsync(s.grant);
    },
  };
  return s;
}

export type FakeBitmap = { width: number; key: string; closed: boolean };

export function fakeImaging() {
  const made: FakeBitmap[] = [];
  const urls: { url: string; revoked: boolean }[] = [];
  const imaging: Imaging = {
    bitmap: (bytes) => {
      const b = { width: 10, key: new TextDecoder().decode(bytes), closed: false };
      made.push(b);
      return okAsync(b as unknown as ImageBitmap);
    },
    thumb: (bytes) => {
      const u = { url: `blob:${new TextDecoder().decode(bytes)}#${urls.length}`, revoked: false };
      urls.push(u);
      return okAsync(u.url);
    },
    crop: (src, _box, size, dpr) => {
      const from = "bitmap" in src ? (src.bitmap as unknown as FakeBitmap).key : new TextDecoder().decode(src.bytes);
      const b = { width: Math.round(size * dpr), key: `crop:${from}`, closed: false };
      made.push(b);
      return okAsync(b as unknown as ImageBitmap);
    },
    heat: (bytes) => imaging.bitmap(bytes, "image/png"),
    close: (b) => {
      const f = b as unknown as FakeBitmap;
      f.closed = true;
      f.width = 0;
    },
    revoke: (url) => {
      const u = urls.find((x) => x.url === url);
      if (u) u.revoked = true;
    },
  };
  return { imaging, made, urls };
}

/** A host whose WebGPU check answers `webgpu`; `checks` counts the checks. */
export const fakeHost = (webgpu: WebGpu = "available") => {
  const downloads: { name: string; text: string }[] = [];
  const h: Host & { downloads: typeof downloads; checks: number } = {
    pickDirectory: null,
    download: (name, text) => void downloads.push({ name, text }),
    downloads,
    checks: 0,
    webgpu: () => {
      h.checks++;
      return Promise.resolve(webgpu);
    },
  };
  return h;
};

export const frame = (n: number): DataFrame =>
  ({
    frame: n,
    t: n * 0.5,
    clip: n < 5 ? "a.mp4" : "b.mp4",
    clipKey: n < 5 ? "ka" : "kb",
    w: 100,
    h: 80,
    encoded: true,
    image: `eyespy-store:clips/${n < 5 ? "ka" : "kb"}/frames/${n}.jpg`,
  }) as DataFrame; // test data: plain numbers and short clip keys stand in for the brands

export const det = (id: string, o: { score?: number; object?: string; box?: number[]; prompt?: string } = {}) => {
  const [f = "0"] = id.split(".");
  return {
    id,
    frame: Number(f),
    t: Number(f) * 0.5,
    prompts: [o.prompt ?? "jar"],
    prompt: o.prompt ?? "jar",
    score: o.score ?? 0.9,
    box: (o.box ?? [10, 10, 20, 20]) as [number, number, number, number],
    area: 100,
    run: `${f}|jar`,
    rejected: o.object === "x",
    ...(o.object ? { object: o.object } : {}),
    mask: null,
  };
};

export const rle = { format: "rle", w: 10, h: 10, counts: [0, 100] };

/** The default scripted session: keyframes 0-2 and 5-6 (a removed clip left 3-4 out), a few detections, one object. */
export function sessionHandlers(over: Handlers = {}): Handlers {
  const dets = [
    det("0.0", { object: "o1", score: 0.8 }),
    det("0.1", { object: "o1", score: 0.95 }),
    det("0.2", { score: 0.7 }),
    det("0.3", { score: 0.6 }),
    det("0.4", { score: 0.4 }),
    det("0.5", { object: "x" }),
    det("1.0", { object: "o1" }),
    det("5.0", { score: 0.9 }),
  ];
  return {
    status: () => ({
      keyframes: 5,
      encoded: 5,
      detections: dets.length,
      objects: 1,
      todo: 4,
      assigned: 3,
      rejected: 1,
      prompts: ["jar"],
    }),
    config: () => ({ config: { threshold: 0.5 } }),
    "data.frames": () => ({ frames: [0, 1, 2, 5, 6].map(frame) }),
    "data.dets": (i: { mask?: string; frames?: string }) =>
      i.mask === "rle"
        ? {
            dets: dets
              .filter((d) => String(d.frame) === i.frames)
              .map((d) => ({ ...d, mask: rle, aliases: d.id === "0.2" ? ["0.2", "0.3"] : [d.id] })),
          }
        : { dets },
    "data.objects": () => ({
      objects: [
        {
          id: "o1",
          label: "jar",
          sightings: 2,
          members: ["0.0", "0.1", "1.0"],
          first_t: 0,
          last_t: 0.5,
          best: "0.1",
          prompts: {},
        },
      ],
      rejected: ["0.5"],
    }),
    "data.runs": () => ({ runs: [] }),
    "data.history": () => ({ ops: [], undo: null, redo: null }),
    "clips.list": () => ({ clips: [] }),
    "obj.match": (i: { ids: string[] }) => ({
      current: [],
      matches: [{ obj: "o1", label: "jar", sim: 0.9, closest: i.ids[0], closest_sim: 0.9, sightings: 2 }],
    }),
    ...over,
  };
}

/** The SAM License sha256 the fake build ships, and a stored agreement to it. */
export const SAM_SHA = "5a3".padEnd(64, "0");
export const AGREED = { [LICENCE_PREF]: JSON.stringify({ sha256: SAM_SHA, at: "2026-10-26T00:00:00.000Z" }) };

/** `agreed: false` starts without the SAM License agreement (the licence dialog comes first). */
export function setup(
  o: {
    handlers?: Handlers;
    prefs?: Record<string, string>;
    query?: Record<string, string>;
    agreed?: boolean;
    webgpu?: WebGpu;
  } = {},
) {
  const engine = fakeEngine(o.handlers ?? sessionHandlers());
  const clock = fakeClock();
  const storage = fakeStorage({ ...(o.agreed === false ? {} : AGREED), ...o.prefs });
  const img = fakeImaging();
  const host = fakeHost(o.webgpu);
  const assets = createAssetCaches({ imaging: img.imaging });
  const app: App = createStores({
    engine: engine.port,
    assets,
    storage,
    query: { get: (k) => o.query?.[k] ?? null },
    clock: clock.clock,
    host,
    samLicense: SAM_SHA,
  });
  return { app, engine, clock, storage, img, host };
}

/** Let pending promise chains settle. */
export const settle = async (n = 10) => {
  for (let k = 0; k < n; k++) await new Promise((r) => setImmediate(r));
};
