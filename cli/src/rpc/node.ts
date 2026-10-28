/**
 * tRPC over HTTP on the session's unix socket. The transport is a small fetch over `node:http`: tRPC's httpLink reads
 * only `ok` and `json()`, so the CLI needs no fetch library that takes `socketPath`. Replies take their
 * types from `Outputs` without parsing, because the server is the same checkout's router.
 */
import { request } from "node:http";
import { createTRPCUntypedClient, httpLink } from "@trpc/client";
import { opKind } from "eyespy-core/api/pure";
import type { Outputs } from "eyespy-core/api";
import type { Connection } from "./ports.ts";

/**
 * `fetch(url, init)` against `socketPath`. It opens one connection per request (no keep-alive, nothing to close) and
 * sets no timeouts, since an op's run time grows with the keyframes it covers. A refused or missing socket rejects with
 * the socket error itself, whose `code` is ENOENT or ECONNREFUSED.
 */
const socketFetch =
  (socketPath: string) =>
  (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const body = init.body ?? undefined;
      if (body !== undefined && typeof body !== "string") {
        reject(new Error("socketFetch sends string bodies only"));
        return;
      }
      const req = request(
        {
          socketPath,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          agent: false,
          signal: init.signal ?? undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, statusText: res.statusMessage }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });

export const connectSocket = (socketPath: string): Connection => {
  const client = createTRPCUntypedClient({
    links: [httpLink({ url: "http://eyespy", fetch: socketFetch(socketPath) })],
  });
  return {
    call: async <P extends Parameters<Connection["call"]>[0]>(path: P, input: unknown) => {
      const reply: unknown =
        opKind(path) === "query" ? await client.query(path, input) : await client.mutation(path, input);
      return reply as Outputs[P];
    },
    close: async () => {},
  };
};
