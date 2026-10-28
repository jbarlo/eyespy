/**
 * Server entry point. It parses args, takes the session lock, builds the Node adapters, runs composeEngine and serves
 * the api on <session>/.eyespy/sock. Exits 2 on bad args or env or a socket path too long for a unix socket,
 * ALREADY_RUNNING when another server holds the session, and 1 when it can't open the session.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describeComposeError } from "eyespy-core/api";
import { composeEngine } from "eyespy-core/compose";
import {
  ALREADY_RUNNING,
  SERVER_SOCKET,
  SESSION_MARKER,
  SOCKET_TOO_LONG,
  socketPathFits,
} from "eyespy-core/storage/pure";
import { SharpCodec } from "./adapters/codec.ts";
import { OrtRuntime } from "./adapters/ort.ts";
import { FsStore } from "./adapters/store.ts";
import { FramesFolder } from "./adapters/frames.ts";
import { HELP, USAGE, parseServerArgs } from "./args.ts";
import { lockPath, takeLock } from "./lock.ts";
import { serve, type Served } from "./serve.ts";

const CODE = path.resolve(import.meta.dirname, "../..");

const log = (...a: readonly unknown[]) => {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(
    `${ts} ${a.map((x) => (typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : JSON.stringify(x))).join(" ")}\n`,
  );
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}
const parsed = parseServerArgs(process.argv.slice(2), process.env, CODE);
if (parsed.isErr()) {
  process.stderr.write(`eyespy-server: ${parsed.error}\n${USAGE}\n`);
  process.exit(2);
}
const { root, models, detector, cpu, idleMinutes, featureCacheMB, featureDiskMB, profile } = parsed.value;
const sock = path.join(root, SESSION_MARKER, SERVER_SOCKET);
if (!socketPathFits(sock, process.platform)) {
  process.stderr.write(`eyespy-server: ${SOCKET_TOO_LONG}: ${sock}\n`);
  process.exit(2);
}

// Before anything opens the session or touches its socket.
const lockFile = lockPath(path.join(root, SESSION_MARKER));
const locked = takeLock(lockFile);
if (locked.isErr()) {
  log(`already running (pid ${locked.error.pid ?? "?"}; lock ${lockFile})`);
  process.exit(ALREADY_RUNNING);
}
process.on("exit", () => locked.value?.release());

function git() {
  try {
    return (
      execFileSync("git", ["describe", "--always", "--dirty"], {
        cwd: CODE,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const t0 = Date.now();
const runtime = new OrtRuntime(models, cpu ? "cpu" : "webgpu");
let served: Served | null = null;
const exit = () => {
  served?.close();
  log("bye");
  setTimeout(() => process.exit(0), 100).unref();
};
const opened = await composeEngine(
  {
    runtime,
    store: new FsStore(root),
    video: new FramesFolder(),
    codec: new SharpCodec(),
    clock: { now: () => Date.now() },
    timers: {
      after: (ms, fn) => {
        const t = setTimeout(fn, ms).unref();
        return () => clearTimeout(t);
      },
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
    },
    logger: { log },
    info: { eyespy: git(), node: process.version },
  },
  {
    detector,
    profile,
    featureCacheMB,
    featureDiskMB,
    idleMinutes,
    onExit: exit,
  },
);
if (opened.isErr()) {
  log(`cannot open ${root}: ${describeComposeError(opened.error)}`);
  process.exit(1);
}
const engine = opened.value;
served = serve(engine, sock, () =>
  log(`listening on ${sock} (models ${models}, detector ${detector}, ${runtime.device}) after ${Date.now() - t0} ms`),
);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => engine.shutdown());
