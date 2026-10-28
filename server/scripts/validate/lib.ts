/** Validation helpers that start and drive eyespy-server and make an empty session. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OPS, type Inputs, type OpPath, type Outputs } from "eyespy-core/api";
import { emptySessionJson, SESSION_FILE, SESSION_MARKER } from "eyespy-core/storage/marker";
import { connectSocket } from "../../../cli/src/rpc/node.ts";
import { MODELS } from "./paths.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Makes `root` an empty session, overwriting its session.json. */
export function createSession(root: string) {
  mkdirSync(path.join(root, SESSION_MARKER), { recursive: true });
  writeFileSync(path.join(root, SESSION_MARKER, SESSION_FILE), emptySessionJson());
}

/** An op name as a method name, the router path with `_` for `.` (`obj.new` becomes `obj_new`). */
type MethodName<P extends string> = P extends `${infer A}.${infer B}` ? `${A}_${MethodName<B>}` : P;
/** Every router op (from the api's OPS), keyed by its method name. */
type Ts = { [P in OpPath as MethodName<P>]: (input: Inputs[P]) => Promise<Outputs[P]> };
/** Every op over the CLI's socket transport, one connection per call. Calls reject on errors. */
function connect(socket: string): Ts {
  const op = (p: OpPath) => (input: unknown) => {
    const c = connectSocket(socket);
    return c.call(p, input as never).finally(() => c.close());
  };
  return Object.fromEntries(OPS.map(({ path: p }) => [p.replaceAll(".", "_"), op(p)])) as unknown as Ts;
}
/** A client for the server of the session at `root` (calls reject while no server runs there). */
export const tsClient = (root: string): Ts => connect(path.join(root, SESSION_MARKER, "sock"));
/**
 * Starts eyespy-server ($EYESPY_SERVER) on `root` with EYESPY_MODELS defaulting to MODELS, and waits until it answers.
 */
export async function startTs(
  root: string,
  extra: string[] = [],
): Promise<{ proc: ChildProcess; c: Ts; startMs: number }> {
  const log = openSync(path.join(root, SESSION_MARKER, "server.log"), "a");
  const t = Date.now();
  const proc = spawn(
    process.env.EYESPY_SERVER ?? "eyespy-server",
    ["--session", root, "--idle-minutes", "120", ...extra],
    { stdio: ["ignore", log, log], env: { ...process.env, EYESPY_MODELS: MODELS } },
  );
  const c = tsClient(root);
  for (let i = 0; i < 12000; i++) {
    await sleep(50);
    if (proc.exitCode !== null) throw new Error(`ts server exited ${proc.exitCode}`);
    if (await c.status({}).catch(() => null)) return { proc, c, startMs: Date.now() - t };
  }
  throw new Error("ts server did not start");
}
