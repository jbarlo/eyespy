/**
 * EngineHost is the browser's composition root, one per worker. It checks page requests against OPS, then dispatches
 * them to the api's in-process caller. It has no module globals, so a host goes away with its worker.
 */
import { TRPCError } from "@trpc/server";
import { createCaller, describeComposeError, isOpPath, opKind } from "eyespy-core/api";
import type { HostPorts } from "eyespy-core/compose";
import { composeEngine } from "eyespy-core/compose";
import type { Engine } from "eyespy-core/session";
import { TO_WORKER } from "../../protocol.ts";
import type { EngineEvent, FromWorker, InitOptions, ToWorker } from "../../protocol.ts";

/** What a session opens with: composeEngine's host-specific ports and what the dispatch needs besides them. */
export type SessionAdapters = {
  readonly root: string;
  readonly device: string;
  readonly ports: Pick<HostPorts, "runtime" | "store" | "video" | "codec">;
  /** Make a picked video addressable; returns the ref the add op takes. */
  readonly register: (file: File) => string;
  /** Download (and verify) model files ahead of their first use. */
  readonly prepare: (names?: string[]) => Promise<void>;
};

export type AdapterDeps = {
  readonly emit: (ev: EngineEvent) => void;
};

export type OpenAdapters = (o: InitOptions, deps: AdapterDeps) => Promise<SessionAdapters>;

/** Posts a message to the page; `transfer` moves buffers instead of copying them. */
export type Post = (m: FromWorker, transfer?: Transferable[]) => void;

type Caller = ReturnType<typeof createCaller>;
type Opened = { engine: Engine; caller: Caller; adapters: SessionAdapters };

const text = (a: readonly unknown[]) =>
  a.map((x) => (typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : JSON.stringify(x))).join(" ");

/** The buffer behind a reply's bytes, to transfer (the store hands read buffers to the caller). */
const transferOf = (v: unknown): Transferable[] =>
  v instanceof Uint8Array && v.buffer instanceof ArrayBuffer ? [v.buffer] : [];

export class EngineHost {
  private opened: Opened | null = null;
  private adapters: SessionAdapters | null = null;

  constructor(
    private readonly post: Post,
    private readonly openAdapters: OpenAdapters,
  ) {}

  private emit(ev: EngineEvent) {
    this.post({ t: "event", ev });
  }
  private log(...a: readonly unknown[]) {
    this.emit({ kind: "log", text: text(a) });
  }

  private async init(o: InitOptions) {
    if (this.opened || this.adapters) throw new Error("engine already initialised (one session per worker)");
    const adapters = await this.openAdapters(o, { emit: (ev) => this.emit(ev) });
    this.adapters = adapters;
    const { root, device } = adapters;
    const r = await composeEngine(
      {
        ...adapters.ports,
        clock: { now: () => Date.now() },
        timers: {
          after: (ms, fn) => {
            const t = setTimeout(fn, ms);
            return () => clearTimeout(t);
          },
          every: (ms, fn) => {
            const t = setInterval(fn, ms);
            return () => clearInterval(t);
          },
        },
        logger: { log: (...a) => this.log(...a) },
        info: { browser: navigator.userAgent, ...(o.host ?? {}) },
      },
      {
        detector: o.detector ?? "fp32",
        featureCacheMB: o.featureCacheMB ?? 2048,
        persistFeatures: o.persistFeatures ?? true,
        featureDiskMB: o.featureDiskMB ?? null,
        idleMinutes: Number.POSITIVE_INFINITY, // the tab owns the lifetime
        onExit: () => {
          this.opened = null;
        },
      },
    );
    if (r.isErr()) throw new Error(`cannot open ${root}: ${describeComposeError(r.error)}`);
    const engine = r.value;
    this.opened = { engine, caller: createCaller({ engine }), adapters };
    this.emit({ kind: "ready", root, device });
    return { root, device };
  }

  /** caller["obj"]["new"](input) for path "obj.new", after checking the path and kind against OPS. */
  private rpc(path: string, kind: "query" | "mutation", input: unknown): Promise<unknown> {
    const o = this.opened;
    if (!o) throw new Error("engine not initialised (call init first)");
    if (!isOpPath(path)) throw new TRPCError({ code: "NOT_FOUND", message: `no procedure ${path}` });
    if (opKind(path) !== kind) throw new TRPCError({ code: "BAD_REQUEST", message: `${path} is a ${opKind(path)}` });
    // the caller is a typed proxy keyed by the same dotted paths OPS lists
    let fn: unknown = o.caller;
    for (const p of path.split(".")) fn = (fn as Record<string, unknown>)[p];
    return (fn as (i: unknown) => Promise<unknown>)(input);
  }

  private session(): Opened {
    if (!this.opened) throw new Error("no session open");
    return this.opened;
  }

  /** One message from the page. It logs a malformed message, answers it when it has an id, and never throws. */
  async handle(data: unknown): Promise<void> {
    const m = TO_WORKER.safeParse(data);
    if (m.success) return this.dispatch(m.data);
    const id: unknown = data && typeof data === "object" && "id" in data ? data.id : undefined;
    this.log("malformed message from the page:", m.error.message);
    if (typeof id === "number")
      this.post({ t: "reply", id, error: { message: `malformed message: ${m.error.message}`, code: "BAD_REQUEST" } });
  }

  /** One request from the page; every failure becomes an error reply. */
  private async dispatch(m: ToWorker): Promise<void> {
    try {
      let result: unknown;
      switch (m.t) {
        case "init":
          result = await this.init(m.opts);
          break;
        case "rpc":
          result = await this.rpc(m.path, m.kind, m.input);
          break;
        case "file":
          result = await this.session().adapters.ports.store.read(m.key);
          break;
        case "register":
          result = this.session().adapters.register(m.file);
          break;
        case "prepare":
          if (!this.adapters) throw new Error("engine not initialised");
          await this.adapters.prepare(m.names);
          result = true;
          break;
      }
      this.post({ t: "reply", id: m.id, result }, transferOf(result));
    } catch (err) {
      const code = err instanceof TRPCError ? err.code : "INTERNAL_SERVER_ERROR";
      const ex = err instanceof Error ? err : new Error(String(err));
      if (code === "INTERNAL_SERVER_ERROR") this.log(`${m.t} ${"path" in m ? m.path : ""} failed:`, ex);
      this.post({ t: "reply", id: m.id, error: { message: ex.message, code, stack: ex.stack } });
    }
  }
}
