import type { Inputs, OpPath, Outputs } from "eyespy-core/api";

/** One connection to a session server's socket. `call` rejects with the transport's or the server's error. */
export interface Connection {
  call<P extends OpPath>(path: P, input: Inputs[P]): Promise<Outputs[P]>;
  close(): Promise<void>;
}

export type RpcPorts = {
  /** Opens a connection over the unix socket lazily, so a missing socket shows up as the call's rejection. */
  readonly connect: (socket: string) => Connection;
  /** Node's process.platform, which sets the longest socket path a connect takes. */
  readonly platform: string;
};
