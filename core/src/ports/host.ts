/** The wall clock. Hosts inject it so persisted timestamps (ops.jsonl `ts`, tombstones, npz zip times) reproduce. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/**
 * Timers. Hosts inject them so tests can run the engine's back-off and idle exit on a fake. Each call returns a
 * function that cancels it.
 */
export interface Timers {
  /** Calls `fn` once after `ms`. A pending call does not keep a Node process alive. */
  after(ms: number, fn: () => void): () => void;
  /** Calls `fn` every `ms` until cancelled. */
  every(ms: number, fn: () => void): () => void;
}

export interface Logger {
  log(...a: readonly unknown[]): void;
}

/** Versions of host-side pieces, such as the code revision, for the manifest's provenance. */
export type HostInfo = Readonly<Record<string, string | null>>;

/**
 * The one shape every host exception becomes. Host ports in this folder return plain Promises that reject when the
 * host fails (fs, decoders, ORT, OPFS), and a missing item is null or false. The calling module wraps each one with
 * `ResultAsync.fromPromise(p, (e) => hostFailure("store", "read", e))`, so every module's error union can carry host
 * failures without owning them.
 */
export type HostPort = "runtime" | "store" | "video" | "codec";
export type HostFailure = {
  readonly kind: "host";
  readonly port: HostPort;
  /** The port method that failed, such as "read". */
  readonly op: string;
  /** `Error.message` of the rejection, or `String(e)`. */
  readonly message: string;
};

export const hostFailure = (port: HostPort, op: string, e: unknown): HostFailure => ({
  kind: "host",
  port,
  op,
  message: e instanceof Error ? e.message : String(e),
});
