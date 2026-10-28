/** In-memory ports for the CLI folders' unit tests. */
import { createHash } from "node:crypto";
import path from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";
import type { Inputs, OpPath, Outputs } from "eyespy-core/api";
import type { Files } from "../src/commands/kit.ts";
import type { CallPath, CliError, SessionLink } from "../src/commands/session.ts";
import type { LocateFs } from "../src/locate/index.ts";
import type { Connection } from "../src/rpc/index.ts";
import type { Child, ServerFs, Spawner } from "../src/serverproc/index.ts";

/** Files (text or bytes) and directories in a Map, absolute paths. */
export class MemFs implements LocateFs, ServerFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(["/"]);
  /** sha1 calls so far (clip hashing reads every frame of a folder once). */
  hashes = 0;

  put(p: string, data: string | Uint8Array): this {
    this.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : data);
    for (let d = path.dirname(p); !this.dirs.has(d); d = path.dirname(d)) this.dirs.add(d);
    return this;
  }
  text(p: string): string | undefined {
    const b = this.files.get(p);
    return b && new TextDecoder().decode(b);
  }
  private get(p: string): Uint8Array {
    const b = this.files.get(p);
    if (!b) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" });
    return b;
  }
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string) {
    for (let d = p; !this.dirs.has(d); d = path.dirname(d)) this.dirs.add(d);
  }
  async readText(p: string) {
    return new TextDecoder().decode(this.get(p));
  }
  async writeText(p: string, text: string) {
    if (!this.dirs.has(path.dirname(p))) throw new Error(`ENOENT: no directory for ${p}`);
    this.put(p, text);
  }
  async size(p: string) {
    return this.files.get(p)?.length ?? 0;
  }
  async isDir(p: string) {
    if (!this.files.has(p) && !this.dirs.has(p))
      throw Object.assign(new Error(`ENOENT: no such file, stat '${p}'`), { code: "ENOENT" });
    return this.dirs.has(p);
  }
  async list(dir: string) {
    return [...this.files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
  }
  async sha1(p: string) {
    this.hashes++;
    return createHash("sha1").update(this.get(p)).digest("hex");
  }
  async readFrom(p: string, offset: number) {
    const b = this.files.get(p);
    return b ? new TextDecoder().decode(b.subarray(offset)) : "";
  }
}

/** A socket's server: answers per path from `handlers`, or nothing listens (ENOENT) while `listening` is false. */
export class FakeServer {
  listening = false;
  readonly calls: { readonly socket: string; readonly path: OpPath; readonly input: unknown }[] = [];
  closed = 0;
  constructor(readonly handlers: Partial<{ [P in OpPath]: (input: Inputs[P]) => Outputs[P] }> = {}) {}

  connect = (socket: string): Connection => ({
    call: async <P extends OpPath>(p: P, input: Inputs[P]): Promise<Outputs[P]> => {
      this.calls.push({ socket, path: p, input });
      if (!this.listening)
        throw new Error("fetch failed", {
          cause: Object.assign(new Error(`connect ENOENT ${socket}`), { code: "ENOENT" }),
        });
      const h = this.handlers[p];
      if (!h) throw new Error(`no handler for ${p}`);
      return h(input);
    },
    close: async () => {
      this.closed++;
    },
  });
}

/** The session a command talks to: canned replies per op (or the failure given). It records every call. */
export class FakeLink implements SessionLink {
  readonly calls: { readonly path: CallPath; readonly input: unknown }[] = [];
  readonly added: string[] = [];
  readonly inits: { readonly dir: string | undefined; readonly clips: readonly string[] }[] = [];
  constructor(
    private readonly replies: Partial<{ [P in CallPath]: Outputs[P] }> = {},
    private readonly failure?: CliError,
  ) {}

  call<P extends CallPath>(path: P, input: Inputs[P]): ResultAsync<Outputs[P], CliError> {
    this.calls.push({ path, input });
    if (this.failure) return errAsync(this.failure);
    const r = this.replies[path];
    return r === undefined ? errAsync({ message: `no reply for ${path}` }) : okAsync(r);
  }
  addClip(video: string): ResultAsync<string, CliError> {
    this.added.push(video);
    return okAsync(`added ${video}`);
  }
  stop(): ResultAsync<string, CliError> {
    return okAsync("stopped");
  }
  init(dir: string | undefined, clips: readonly string[]): ResultAsync<string, CliError> {
    this.inits.push({ dir, clips });
    return okAsync(`session created in ${dir ?? "."}`);
  }
}

/** Files written by a command, by path; `failWith` makes every write fail. */
export class FakeFiles implements Files {
  readonly written = new Map<string, string>();
  constructor(private readonly failWith?: string) {}
  write(file: string, text: string): ResultAsync<void, CliError> {
    if (this.failWith !== undefined) return errAsync({ message: this.failWith });
    this.written.set(file, text);
    return okAsync(undefined);
  }
}

/** A spawner whose child reports `exitWith` and `spawnError` as given; `onSpawn` runs at each spawn. */
export class FakeSpawner implements Spawner {
  readonly spawned: { command: string; argv: readonly string[]; cwd: string; log: string }[] = [];
  constructor(
    private readonly behave: {
      readonly onSpawn?: () => void;
      readonly exitWith?: number;
      readonly spawnError?: string;
    } = {},
  ) {}
  async spawn(command: string, argv: readonly string[], opts: { readonly cwd: string; readonly log: string }) {
    this.spawned.push({ command, argv, ...opts });
    this.behave.onSpawn?.();
    const child: Child = {
      exitCode: () => this.behave.exitWith ?? null,
      spawnError: () => this.behave.spawnError ?? null,
    };
    return child;
  }
}
