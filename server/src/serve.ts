/** The api's tRPC router over HTTP on the session's unix socket (<session>/.eyespy/sock). */
import { existsSync, rmSync } from "node:fs";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { appRouter } from "eyespy-core/api";
import type { Engine } from "eyespy-core/session";

export type Served = { close(): void };

/**
 * Listens on `sock` and calls `onListening` once it accepts. It replaces a stale socket file, so call this only while
 * holding the session lock.
 */
export function serve(engine: Engine, sock: string, onListening: () => void): Served {
  const server = createHTTPServer({ router: appRouter, createContext: () => ({ engine }) });
  // an op's run time grows with the keyframes it covers, so turn off Node's HTTP timeouts
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  if (existsSync(sock)) rmSync(sock);
  server.listen(sock, onListening);
  return {
    close: () => {
      server.close();
      rmSync(sock, { force: true });
    },
  };
}
