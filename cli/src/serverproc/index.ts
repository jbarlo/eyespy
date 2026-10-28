/**
 * Starts the session's eyespy-server process detached (log in .eyespy/server.log) and waits until it answers on
 * .eyespy/sock. A server that exits ALREADY_RUNNING lost the race for the session lock, so the CLI waits for the
 * winner, and starts again if the lock goes first. POLL_MS, START_POLLS and GONE_POLLS set how often it polls and how
 * long it waits.
 */
import path from "node:path";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { ALREADY_RUNNING, SERVER_LOCK, SERVER_LOG, SERVER_SOCKET, SESSION_MARKER } from "eyespy-core/storage/pure";
import type { Child, ServerOptions, ServerPorts } from "./ports.ts";

export type { Child, ServerFs, ServerPorts, Spawner } from "./ports.ts";

export type ServerError =
  | { readonly kind: "spawn-failed"; readonly command: string; readonly message: string }
  /** `reason` is the last line the server logged before exiting (timestamp stripped), when there is one. */
  | { readonly kind: "exited"; readonly code: number; readonly reason: string | null; readonly log: string }
  /** `waitedMs` is how long the CLI waited for an answer. */
  | { readonly kind: "not-ready"; readonly log: string; readonly waitedMs: number };

type StartOptions = { readonly idleMinutes?: number | undefined };

export interface ServerProcess {
  socket(root: string): string;
  log(root: string): string;
  /** Start the session's server (or wait for the one another call is starting) and resolve once it answers. */
  start(root: string, opts: StartOptions): ResultAsync<void, ServerError>;
  /** After a shutdown: resolve once the socket file is gone, or after GONE_POLLS polls. */
  gone(root: string): ResultAsync<void, never>;
}

export type CreateServerProcess = (ports: ServerPorts, opts: ServerOptions) => ServerProcess;

const POLL_MS = 100;
const START_POLLS = 6000;
const GONE_POLLS = 100;

/**
 * What the server said last before exiting: the last line that isn't a stack frame or Node's version banner.
 * @internal
 */
export const exitReason = (logged: string): string | null => {
  const lines = logged
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "" && !/^\s/.test(l) && !/^Node\.js v/.test(l));
  const last = lines.at(-1);
  return last === undefined ? null : last.replace(/^\d\d:\d\d:\d\d /, "").slice(0, 500);
};

export const createServerProcess: CreateServerProcess = (ports, opts) => {
  const socket = (root: string) => path.join(root, SESSION_MARKER, SERVER_SOCKET);
  const log = (root: string) => path.join(root, SESSION_MARKER, SERVER_LOG);
  const lock = (root: string) => path.join(root, SESSION_MARKER, SERVER_LOCK);
  const safe = <T>(p: Promise<T>, fallback: T) => ResultAsync.fromSafePromise(p.catch(() => fallback));

  type Attempt = { readonly root: string; readonly argv: readonly string[] };

  /** Spawns a server, reads its log from the current end, and waits until it answers. */
  const launch = (a: Attempt, i: number): ResultAsync<void, ServerError> =>
    safe(ports.fs.size(log(a.root)), 0).andThen((from) =>
      ResultAsync.fromPromise(
        ports.spawner.spawn(opts.command, a.argv, { cwd: opts.cwd, log: log(a.root) }),
        (e): ServerError => ({
          kind: "spawn-failed",
          command: opts.command,
          message: e instanceof Error ? e.message : String(e),
        }),
      ).andThen((child) => waitReady(a, child, from, i)),
    );

  const waitReady = (a: Attempt, child: Child, from: number, i: number): ResultAsync<void, ServerError> => {
    if (i >= START_POLLS) return errAsync({ kind: "not-ready", log: log(a.root), waitedMs: START_POLLS * POLL_MS });
    return safe(ports.sleep(POLL_MS), undefined).andThen(() => {
      const spawnError = child.spawnError();
      if (spawnError !== null)
        return errAsync({ kind: "spawn-failed", command: opts.command, message: spawnError } as const);
      const code = child.exitCode();
      if (code === ALREADY_RUNNING) return waitWinner(a, i + 1);
      if (code !== null)
        return safe(ports.fs.readFrom(log(a.root), from), "").andThen((text) =>
          errAsync({ kind: "exited", code, reason: exitReason(text), log: log(a.root) } as const),
        );
      return safe(ports.answers(socket(a.root)), false).andThen((yes) =>
        yes ? okAsync(undefined) : waitReady(a, child, from, i + 1),
      );
    });
  };

  /** Another server holds the session. Wait until it answers, and start one again if its lock goes first. */
  const waitWinner = (a: Attempt, i: number): ResultAsync<void, ServerError> => {
    if (i >= START_POLLS) return errAsync({ kind: "not-ready", log: log(a.root), waitedMs: START_POLLS * POLL_MS });
    return safe(ports.answers(socket(a.root)), false).andThen((yes) =>
      yes
        ? okAsync(undefined)
        : safe(ports.fs.exists(lock(a.root)), true).andThen((held) =>
            held ? safe(ports.sleep(POLL_MS), undefined).andThen(() => waitWinner(a, i + 1)) : launch(a, i + 1),
          ),
    );
  };

  const waitGone = (root: string, i: number): ResultAsync<void, never> =>
    i >= GONE_POLLS
      ? okAsync(undefined)
      : safe(ports.fs.exists(socket(root)), false).andThen((there) =>
          there ? safe(ports.sleep(POLL_MS), undefined).andThen(() => waitGone(root, i + 1)) : okAsync(undefined),
        );

  return {
    socket,
    log,
    start: (root, { idleMinutes }) => {
      ports.notice("starting eyespy server...");
      const argv = ["--session", root, ...(idleMinutes !== undefined ? ["--idle-minutes", String(idleMinutes)] : [])];
      return launch({ root, argv }, 0);
    },
    gone: (root) => waitGone(root, 0),
  };
};
