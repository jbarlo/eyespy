/**
 * Typed calls to a session server by op path, one connection per call. Failures are values: `not-running` (nothing
 * listens on the socket, so the caller may start a server), `socket-too-long` (the path doesn't fit a unix socket
 * address, so no server can listen there; checked before connecting) or `op` (the server's message).
 */
import { errAsync, ResultAsync } from "neverthrow";
import type { Inputs, OpPath, Outputs } from "eyespy-core/api";
import { socketPathFits } from "eyespy-core/storage/pure";
import type { RpcPorts } from "./ports.ts";

export type { Connection } from "./ports.ts";

export type RpcError =
  | { readonly kind: "not-running" }
  | { readonly kind: "socket-too-long"; readonly socket: string }
  | { readonly kind: "op"; readonly message: string };

export interface Rpc {
  call<P extends OpPath>(socket: string, path: P, input: Inputs[P]): ResultAsync<Outputs[P], RpcError>;
}

export type CreateRpc = (ports: RpcPorts) => Rpc;

const NOT_LISTENING: ReadonlySet<unknown> = new Set(["ENOENT", "ECONNREFUSED"]);

const field = (x: unknown, key: string): unknown =>
  typeof x === "object" && x !== null ? (Reflect.get(x, key) satisfies unknown) : undefined;

/** True when nothing listens, meaning ENOENT or ECONNREFUSED anywhere along the error's `cause` chain. @internal */
export const isNotRunning = (e: unknown, depth = 0): boolean =>
  depth < 16 &&
  e !== undefined &&
  e !== null &&
  (NOT_LISTENING.has(field(e, "code")) || isNotRunning(field(e, "cause"), depth + 1));

/**
 * Turns a rejected call into an RpcError with the server's message, which tRPC client errors carry as their message.
 * @internal
 */
export const classify = (e: unknown): RpcError =>
  isNotRunning(e) ? { kind: "not-running" } : { kind: "op", message: e instanceof Error ? e.message : String(e) };

export const createRpc: CreateRpc = ({ connect, platform }) => ({
  call: (socket, path, input) => {
    if (!socketPathFits(socket, platform)) return errAsync({ kind: "socket-too-long", socket });
    const c = connect(socket);
    const settled = c.call(path, input).finally(() => c.close());
    return ResultAsync.fromPromise(settled, classify);
  },
});
