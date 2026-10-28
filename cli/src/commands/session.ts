/**
 * The session a command talks to. It locates the session once per process, starts its server on first need, and sends
 * ops with the call's `cfg` overrides. A headless session (`-i`) first adds the clips it lacks.
 */
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";
import type { Inputs, OpPath, Outputs } from "eyespy-core/api";
import type { ConfigKey } from "eyespy-core/session/pure";
import { locateError, reply, rpcError, serverError } from "../format/index.ts";
import type { Located, Locator } from "../locate/index.ts";
import type { Rpc, RpcError } from "../rpc/index.ts";
import type { ServerProcess } from "../serverproc/index.ts";

export type SessionDeps = {
  readonly locator: Locator;
  readonly server: ServerProcess;
  readonly rpc: Rpc;
  /** A progress line for the user (stderr). */
  readonly notice: (line: string) => void;
};

export type SessionFlags = {
  readonly session?: string | undefined;
  readonly videos: readonly string[];
  /** Per-call setting overrides, never saved. */
  readonly cfg: Readonly<Partial<Record<ConfigKey, number>>>;
  /** For a server this command starts. */
  readonly idleMinutes?: number | undefined;
  /** Frame rate of the frame folders this call adds (`--fps`). Without it, the folders hold photos. */
  readonly fps?: number | undefined;
};

/** Ops a command sends (shutdown is `stop`). */
export type CallPath = Exclude<OpPath, "shutdown">;

export interface SessionLink {
  /** Send an op to the session's server, starting the server if none is running. */
  call<P extends CallPath>(path: P, input: Inputs[P]): ResultAsync<Outputs[P], CliError>;
  /** Adds a clip (a folder of frames, at `--fps`) to the session and returns the "added ..." line. */
  addClip(video: string): ResultAsync<string, CliError>;
  /** Stops the session's server and returns "stopped" or "not running". */
  stop(): ResultAsync<string, CliError>;
  /** Makes `dir` a session, adds `clips` to it, and returns the lines to print. */
  init(dir: string | undefined, clips: readonly string[]): ResultAsync<string, CliError>;
}

/**
 * A failed command: the line printed on stderr and the exit code: 1 by default, 2 for arguments a command rejects
 * itself. Usage errors commander catches (unknown option, missing argument) exit 1.
 */
export type CliError = { readonly message: string; readonly exitCode?: number };

const failure = (message: string): CliError => ({ message });

/** A value made on first use and kept (the located root; the headless clip check). */
class Once<T> {
  #value: { readonly v: T } | null = null;
  constructor(private readonly make: () => T) {}
  get(): T {
    this.#value ??= { v: this.make() };
    return this.#value.v;
  }
}

export const createSessionLink = (deps: SessionDeps, flags: SessionFlags, fixedRoot?: string): SessionLink => {
  const { locator, server, rpc } = deps;
  const located = new Once((): ResultAsync<Located, CliError> =>
    fixedRoot !== undefined
      ? okAsync({ root: fixedRoot, missing: [] })
      : locator.find({ session: flags.session, videos: flags.videos }).mapErr((e) => failure(locateError(e))),
  );
  const rootOf = () => located.get().map((l) => l.root);

  const send = <P extends OpPath>(root: string, path: P, input: Inputs[P]): ResultAsync<Outputs[P], CliError> => {
    const socket = server.socket(root);
    const once = () => rpc.call(socket, path, input);
    return once().orElse((e: RpcError) =>
      e.kind === "not-running"
        ? server
            .start(root, { idleMinutes: flags.idleMinutes })
            .mapErr((s) => failure(serverError(s)))
            .andThen(() => once().mapErr((again) => failure(rpcError(again))))
        : errAsync(failure(rpcError(e))),
    );
  };

  const addAt = (root: string, video: string): ResultAsync<string, CliError> =>
    locator
      .video(video)
      .mapErr((e) => failure(locateError(e)))
      .andThen((abs) => send(root, "add", { video: abs, fps: flags.fps ?? null, cfg: flags.cfg }))
      .map(reply.added);

  /** Headless: adds the clips the cached session lacks before the first op. Later runs find them cached. */
  const ready = new Once((): ResultAsync<string, CliError> =>
    located
      .get()
      .andThen(({ root, missing }) =>
        missing
          .reduce<ResultAsync<null, CliError>>(
            (acc, v) => acc.andThen(() => addAt(root, v).map((line) => (deps.notice(line), null))),
            okAsync(null),
          )
          .map(() => root),
      ),
  );

  return {
    call: (path, input) =>
      (path === "add" ? rootOf() : ready.get()).andThen((root) => send(root, path, { ...input, cfg: flags.cfg })),
    addClip: (video) => rootOf().andThen((root) => addAt(root, video)),
    stop: () =>
      rootOf().andThen((root) =>
        rpc
          .call(server.socket(root), "shutdown", undefined)
          .map(() => true)
          .orElse((e) => (e.kind === "not-running" ? okAsync(false) : errAsync(failure(rpcError(e)))))
          .andThen((was) => (was ? server.gone(root).map(() => "stopped") : okAsync("not running"))),
      ),
    init: (dir, clips) =>
      locator
        .init(dir)
        .mapErr((e) => failure(locateError(e)))
        .andThen((root) => {
          const at = createSessionLink(deps, flags, root);
          return clips
            .reduce<ResultAsync<readonly string[], CliError>>(
              (acc, v) => acc.andThen((lines) => at.addClip(v).map((l) => [...lines, l])),
              okAsync([`session created in ${root}`]),
            )
            .map((lines) => lines.join("\n"));
        }),
  };
};
