/** A started server process, as far as the CLI watches it. */
export interface Child {
  /** Exit code once it has exited (null while running, or killed by a signal before an exit code). */
  exitCode(): number | null;
  /** Why it could not be spawned at all (command not found, ...), once known. */
  spawnError(): string | null;
}

export interface Spawner {
  /**
   * Starts `command argv` detached in `cwd` and appends its stdout and stderr to `log`. The CLI doesn't wait for it.
   */
  spawn(command: string, argv: readonly string[], opts: { readonly cwd: string; readonly log: string }): Promise<Child>;
}

export interface ServerFs {
  exists(path: string): Promise<boolean>;
  /** Bytes in the file (0 if missing). */
  size(path: string): Promise<number>;
  /** Text from byte `offset` to the end ("" if missing). */
  readFrom(path: string, offset: number): Promise<string>;
}

export type ServerPorts = {
  readonly spawner: Spawner;
  readonly fs: ServerFs;
  readonly sleep: (ms: number) => Promise<void>;
  /** A progress line for the user (stderr). */
  readonly notice: (line: string) => void;
  /** Whether a server answers on this socket (any reply counts, an op error too). */
  readonly answers: (socket: string) => Promise<boolean>;
};

export type ServerOptions = {
  /** eyespy-server (or $EYESPY_SERVER). */
  readonly command: string;
  /** The server's working directory, the code checkout. */
  readonly cwd: string;
};
