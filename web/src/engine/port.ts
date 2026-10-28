/**
 * Page side of the engine worker, with no Worker dependency so node tests can use a fake. `resultOps` is the typed op
 * client for the state layer. It turns every failure into a neverthrow Err.
 */
import { TRPCClientError, type createTRPCClient, type TRPCLink } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AppRouter } from "eyespy-core/api";
import { OPS } from "eyespy-core/api/pure";
import { FROM_WORKER, STORE_REF } from "../protocol.ts";
import type { EngineEvent, InitOptions, SessionLocation, ToWorker, UnsupportedVideo } from "../protocol.ts";

export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;
export type { EngineEvent, SessionLocation, UnsupportedVideo };
type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>;

export type WorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

class EngineCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly workerStack?: string,
  ) {
    super(message);
    this.name = "EngineCallError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const INIT_REPLY = z.object({ root: z.string(), device: z.string() });
const FILE_REPLY = z.instanceof(Uint8Array).nullable();
type Dist<T> = T extends unknown ? Omit<T, "id"> : never;

export class EnginePort {
  readonly worker: WorkerLike;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private disposed = false;

  constructor(worker: WorkerLike) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent) => void this.onMessage(e.data);
    this.worker.onerror = (e) => console.error("engine worker error", e.message);
  }

  get isDisposed() {
    return this.disposed;
  }

  private async onMessage(data: unknown) {
    if (this.disposed) return;
    const parsed = FROM_WORKER.safeParse(data);
    if (!parsed.success) return console.error("engine worker: malformed message", parsed.error.message);
    const m = parsed.data;
    if (m.t === "event") for (const l of this.listeners) l(m.ev);
    else {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new EngineCallError(m.error.message, m.error.code, m.error.stack));
      else p.resolve(m.result);
    }
  }

  request(msg: Dist<ToWorker>, transfer: Transferable[] = []): Promise<unknown> {
    if (this.disposed) return Promise.reject(new EngineCallError("engine disposed", "DISPOSED"));
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  init(opts: InitOptions): Promise<{ root: string; device: string }> {
    return this.ask(INIT_REPLY, { t: "init", opts });
  }

  /** A session file's bytes (moved, not copied, across the worker boundary), or null when there is none. */
  readFile(key: string): Promise<Uint8Array | null> {
    return this.ask(FILE_REPLY, { t: "file", key });
  }

  /** Make a picked video addressable by the worker; resolves with the ref the add op takes. */
  register(file: File): Promise<string> {
    return this.ask(z.string(), { t: "register", file });
  }

  /** A request whose reply must match `schema` (a mismatch rejects as an internal error). */
  async ask<T>(schema: z.ZodType<T>, msg: Dist<ToWorker>, transfer: Transferable[] = []): Promise<T> {
    const reply = schema.safeParse(await this.request(msg, transfer));
    if (!reply.success)
      throw new EngineCallError(`unexpected ${msg.t} reply: ${reply.error.message}`, "INTERNAL_SERVER_ERROR");
    return reply.data;
  }

  on(fn: (e: EngineEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Terminate the worker; every pending call rejects with code DISPOSED, and so does every later one. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    const gone = [...this.pending.values()];
    this.pending.clear();
    this.listeners.clear();
    for (const p of gone) p.reject(new EngineCallError("engine disposed", "DISPOSED"));
  }
}

export function workerLink(port: EnginePort): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        let live = true;
        port
          .request({ t: "rpc", path: op.path, kind: op.type === "query" ? "query" : "mutation", input: op.input })
          .then((data) => {
            if (!live) return;
            observer.next({ result: { type: "data", data } });
            observer.complete();
          })
          .catch((e: unknown) => {
            if (!live) return;
            const err = e instanceof EngineCallError ? e : new EngineCallError(String(e), "INTERNAL_SERVER_ERROR");
            observer.error(
              TRPCClientError.from({
                error: {
                  message: err.message,
                  code: -32603,
                  data: { code: err.code, path: op.path, stack: err.workerStack },
                },
              }),
            );
          });
        return () => {
          live = false;
        };
      });
}

const QUERIES: ReadonlySet<string> = new Set(OPS.filter((o) => o.kind === "query").map((o) => o.path));

/** client["obj"]["new"] for "obj.new", then its .query or .mutate. */
function callClient(client: TrpcClient, path: string, input: unknown): Promise<unknown> {
  let p = client as unknown as Record<string, unknown>;
  for (const s of path.split(".")) p = p[s] as Record<string, unknown>;
  const fn = (QUERIES.has(path) ? p.query : p.mutate) as (i: unknown) => Promise<unknown>;
  return fn(input ?? {});
}

/** A failed engine call as a value. `user` marks the router's BAD_REQUEST, worded for agents; show it as is. */
export type EngineError = {
  readonly kind: "user" | "not-found" | "disposed" | "internal";
  readonly code: string;
  readonly message: string;
};

const codeOf = (data: unknown): string => {
  const c = data && typeof data === "object" && "code" in data ? data.code : undefined;
  return typeof c === "string" ? c : "INTERNAL_SERVER_ERROR";
};

export function toEngineError(e: unknown): EngineError {
  const code =
    e instanceof EngineCallError ? e.code : e instanceof TRPCClientError ? codeOf(e.data) : "INTERNAL_SERVER_ERROR";
  const message = e instanceof Error ? e.message : String(e);
  const kind =
    code === "BAD_REQUEST"
      ? "user"
      : code === "NOT_FOUND"
        ? "not-found"
        : code === "DISPOSED"
          ? "disposed"
          : "internal";
  return { kind, code, message };
}

/** Input may be omitted when the op takes none or every field is optional (the call sends {}). */
type ResultFn<I, O> = undefined extends I
  ? (input?: I) => ResultAsync<O, EngineError>
  : Record<never, never> extends I
    ? (input?: I) => ResultAsync<O, EngineError>
    : (input: I) => ResultAsync<O, EngineError>;
type ResultOp<P> = P extends { query: (input: infer I) => Promise<infer O> }
  ? ResultFn<I, O>
  : P extends { mutate: (input: infer I) => Promise<infer O> }
    ? ResultFn<I, O>
    : never;
type ResultOps<C> = {
  readonly [K in keyof C]: C[K] extends { query: unknown } | { mutate: unknown } ? ResultOp<C[K]> : ResultOps<C[K]>;
};
export type EngineOps = ResultOps<TrpcClient>;

export function resultOps(client: TrpcClient): EngineOps {
  const proxy = (prefix: string): unknown =>
    new Proxy(() => {}, {
      get: (_t, k) => (typeof k === "string" && k !== "then" ? proxy(prefix ? `${prefix}.${k}` : k) : undefined),
      apply: (_t, _this, args: unknown[]) =>
        ResultAsync.fromPromise(callClient(client, prefix, args[0]), toEngineError),
    });
  return proxy("") as EngineOps;
}

/**
 * window.eyespy. It has the router's op names (obj.new, data.dets, ...) and takes and returns plain JSON. It replaces
 * each store reference with an object URL (null if the file is gone), and an object field that held one gets a
 * `<field>Key` sibling with the store key. It also has page helpers. `revoke()` releases every object URL it handed
 * out, for when the session closes.
 */
export function wrap(port: EnginePort, client: TrpcClient): { api: EyespyApi; revoke: () => void } {
  const urls = new Map<string, string>();
  async function url(key: string) {
    const bytes = await port.readFile(key);
    if (!bytes) return null;
    const type = key.endsWith(".png") ? "image/png" : key.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
    const old = urls.get(key);
    if (old) URL.revokeObjectURL(old); // for example, the next find with the same prompt rewrites its image
    const u = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
    urls.set(key, u);
    return u;
  }
  async function resolve(v: unknown): Promise<unknown> {
    if (typeof v === "string" && v.startsWith(STORE_REF)) return url(v.slice(STORE_REF.length));
    if (Array.isArray(v)) return Promise.all(v.map(resolve));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = await resolve(x);
        if (typeof x === "string" && x.startsWith(STORE_REF)) out[`${k}Key`] = x.slice(STORE_REF.length);
      }
      return out;
    }
    return v;
  }
  const call = async (path: string, input?: unknown) => resolve(await callClient(client, path, input));
  const extras = {
    call,
    addFile: async (file: File, input: Omit<Inputs["add"], "video"> = {}) => {
      const video = await port.register(file);
      return call("add", { ...input, video });
    },
    prepare: (names?: string[]) => port.request({ t: "prepare", names }),
    file: url,
    on: (fn: (e: EngineEvent) => void) => port.on(fn),
    port,
  };
  const proxy = (prefix: string): unknown =>
    new Proxy(() => {}, {
      get: (_t, k) =>
        typeof k === "string" && k !== "then"
          ? prefix === "" && k in extras
            ? extras[k as keyof typeof extras]
            : proxy(prefix ? `${prefix}.${k}` : k)
          : undefined,
      apply: (_t, _this, args: unknown[]) => call(prefix, args[0]),
    });
  const revoke = () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  };
  return { api: proxy("") as EyespyApi, revoke };
}

/** One op over window.eyespy, typed with the router's input (which may be omitted) and output. */
type JsonOp<P> = P extends { query: (input: infer I) => Promise<infer O> }
  ? (input?: I) => Promise<O>
  : P extends { mutate: (input: infer I) => Promise<infer O> }
    ? (input?: I) => Promise<O>
    : never;
type JsonOps<C> = {
  [K in keyof C]: C[K] extends { query: unknown } | { mutate: unknown } ? JsonOp<C[K]> : JsonOps<C[K]>;
};
/** JSON API (for consoles and tests); `client` has the exact types. */
export type EyespyApi = JsonOps<TrpcClient> & {
  addFile(file: File, input?: Omit<Inputs["add"], "video">): Promise<Outputs["add"]>;
  prepare(names?: string[]): Promise<unknown>;
  file(key: string): Promise<string | null>;
  on(fn: (e: EngineEvent) => void): () => void;
  call(path: string, input?: unknown): Promise<unknown>;
  port: EnginePort;
};
