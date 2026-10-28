/** The CLI's own failures in words. The server's op errors arrive already worded. */
import { SOCKET_TOO_LONG } from "eyespy-core/storage/pure";
import type { LocateError } from "../locate/index.ts";
import type { RpcError } from "../rpc/index.ts";
import type { ServerError } from "../serverproc/index.ts";

export const locateError = (e: LocateError): string => {
  switch (e.kind) {
    case "no-such-file":
      return `no such file: ${e.path}`;
    case "not-a-clip":
      return e.message;
    case "no-session-at":
      return `no eyespy session at ${e.dir}`;
    case "not-in-session":
      return "not in a eyespy session (no .eyespy/ here or above); run `eyespy init`";
    case "already-session":
      return `already a session: ${e.root}`;
    case "bad-session":
      return `${e.root}: session.json: ${e.message}`;
    case "host":
      return e.message;
  }
};

export const serverError = (e: ServerError): string => {
  switch (e.kind) {
    case "spawn-failed":
      return `could not start ${e.command}: ${e.message} (run from the eyespy devshell or set EYESPY_SERVER)`;
    case "exited":
      return `server exited (${e.code})${e.reason ? `: ${e.reason}` : ""}; see ${e.log}`;
    case "not-ready":
      return `server not ready after ${Math.round(e.waitedMs / 60_000)} min; see ${e.log}`;
  }
};

export const rpcError = (e: RpcError): string => {
  switch (e.kind) {
    case "op":
      return e.message;
    case "socket-too-long":
      return `${SOCKET_TOO_LONG}: ${e.socket}`;
    case "not-running":
      return "no server answers on the session socket";
  }
};
