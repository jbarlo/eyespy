import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALREADY_RUNNING, emptySessionJson } from "eyespy-core/storage/pure";
import { createServerProcess, exitReason } from "../src/serverproc/index.ts";
import type { ServerPorts, Spawner } from "../src/serverproc/index.ts";
import { nodeServerFs, nodeSpawner, sleep } from "../src/serverproc/node.ts";
import { FakeSpawner, MemFs } from "./fakes.ts";

const LOG = "/s/.eyespy/server.log";

const ports = (over: Partial<ServerPorts>): ServerPorts & { notices: string[] } => {
  const notices: string[] = [];
  return {
    spawner: new FakeSpawner(),
    fs: new MemFs(),
    sleep: async () => {},
    notice: (l) => notices.push(l),
    answers: async () => true,
    notices,
    ...over,
  };
};
const OPTS = { command: "eyespy-server", cwd: "/code" };

test("start: spawns in the code dir with the session (and idle minutes), waits until it answers", async () => {
  const spawner = new FakeSpawner();
  let polls = 0;
  const p = ports({ spawner, answers: async () => ++polls >= 3 });
  const server = createServerProcess(p, OPTS);
  assert.ok((await server.start("/s", { idleMinutes: 1 })).isOk());
  assert.deepEqual(spawner.spawned, [
    { command: "eyespy-server", argv: ["--session", "/s", "--idle-minutes", "1"], cwd: "/code", log: LOG },
  ]);
  assert.equal(polls, 3);
  assert.deepEqual(p.notices, ["starting eyespy server..."]);
  assert.equal(server.socket("/s"), "/s/.eyespy/sock");
});

test("start: a server that exits early is reported with the reason it logged on this start", async () => {
  const fs = new MemFs().put(LOG, "09:00:00 an older run\nbye\n");
  const spawner = new FakeSpawner({
    exitWith: 1,
    onSpawn: () =>
      fs.put(
        LOG,
        `${fs.text(LOG)}09:00:01 cannot open /s: session.json version 2 is not supported (this server reads version 1)\n`,
      ),
  });
  const server = createServerProcess(ports({ fs, spawner, answers: async () => false }), OPTS);
  assert.deepEqual((await server.start("/s", {}))._unsafeUnwrapErr(), {
    kind: "exited",
    code: 1,
    reason: "cannot open /s: session.json version 2 is not supported (this server reads version 1)",
    log: LOG,
  });
  assert.deepEqual(spawner.spawned[0]?.argv, ["--session", "/s"]);
});

test("start: spawn failure and timeout", async () => {
  const failing = createServerProcess(ports({ spawner: new FakeSpawner({ spawnError: "spawn x ENOENT" }) }), OPTS);
  assert.deepEqual((await failing.start("/s", {}))._unsafeUnwrapErr(), {
    kind: "spawn-failed",
    command: "eyespy-server",
    message: "spawn x ENOENT",
  });
  const silent = createServerProcess(ports({ answers: async () => false }), OPTS);
  assert.deepEqual((await silent.start("/s", {}))._unsafeUnwrapErr(), {
    kind: "not-ready",
    log: LOG,
    waitedMs: 600_000,
  });
});

test("gone: waits for the socket file to disappear", async () => {
  const fs = new MemFs().put("/s/.eyespy/sock", "");
  let slept = 0;
  const server = createServerProcess(
    ports({
      fs,
      sleep: async () => {
        if (++slept === 4) fs.files.delete("/s/.eyespy/sock");
      },
    }),
    OPTS,
  );
  assert.ok((await server.gone("/s")).isOk());
  assert.equal(slept, 4);
});

test("exitReason: the last real line, without timestamp, stack frames or Node's banner", () => {
  assert.equal(exitReason(""), null);
  assert.equal(exitReason("12:00:01 cannot open /x: no session.json in /x\n"), "cannot open /x: no session.json in /x");
  assert.equal(
    exitReason("file:///a.ts:3\n\nError: boom\n    at f (a.ts:1)\n    at g (a.ts:2)\n\nNode.js v22.20.0\n"),
    "Error: boom",
  );
});

const LOCK = "/s/.eyespy/server.lock";

/** Each spawn's child exits with the next code in `codes` (null keeps it running). */
class SeqSpawner implements Spawner {
  readonly spawned: (readonly string[])[] = [];
  constructor(private readonly codes: readonly (number | null)[]) {}
  async spawn(_command: string, argv: readonly string[]) {
    const code = this.codes[this.spawned.length] ?? null;
    this.spawned.push(argv);
    return { exitCode: () => code, spawnError: () => null };
  }
}

test("start: a server that finds the session locked (a racing start won) → wait for the winner, no error", async () => {
  const spawner = new SeqSpawner([ALREADY_RUNNING]);
  const fs = new MemFs().put(LOCK, "4242\n");
  let polls = 0;
  const server = createServerProcess(ports({ spawner, fs, answers: async () => ++polls >= 5 }), OPTS);
  assert.ok((await server.start("/s", {})).isOk());
  assert.equal(spawner.spawned.length, 1);
  assert.equal(polls, 5);
});

test("start: the lock goes away before the winner answers (it failed, or was exiting) → start again", async () => {
  const spawner = new SeqSpawner([ALREADY_RUNNING, null]);
  const fs = new MemFs().put(LOCK, "4242\n");
  let slept = 0;
  const server = createServerProcess(
    ports({
      spawner,
      fs,
      sleep: async () => {
        if (++slept === 3) fs.files.delete(LOCK);
      },
      answers: async () => spawner.spawned.length === 2 && slept >= 5,
    }),
    OPTS,
  );
  assert.ok((await server.start("/s", { idleMinutes: 2 })).isOk());
  assert.deepEqual(spawner.spawned, [
    ["--session", "/s", "--idle-minutes", "2"],
    ["--session", "/s", "--idle-minutes", "2"],
  ]);
});

test("start: a second start that fails after the winner's lock went is reported like any early exit", async () => {
  const fs = new MemFs();
  const spawner = new SeqSpawner([ALREADY_RUNNING, 1]);
  const server = createServerProcess(ports({ spawner, fs, answers: async () => false }), OPTS);
  const e = (await server.start("/s", {}))._unsafeUnwrapErr();
  assert.equal(e.kind, "exited");
  assert.equal(spawner.spawned.length, 2);
});

/** Whether something accepts connections on a unix socket. */
const listening = (sock: string) =>
  new Promise<boolean>((resolve) => {
    const c = connect(sock);
    c.on("connect", () => (c.destroy(), resolve(true)));
    c.on("error", () => resolve(false));
  });

test("start, for real: two calls racing with no server running both connect to the one server that won", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-"));
  const root = path.join(dir, "s");
  mkdirSync(path.join(root, ".eyespy"), { recursive: true });
  writeFileSync(path.join(root, ".eyespy", "session.json"), emptySessionJson());
  // the real eyespy-server on CPU (an empty session loads no model)
  const server = path.join(dir, "eyespy-server");
  const tsx = fileURLToPath(new URL("../../server/tsx.mjs", import.meta.url));
  const main = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url));
  writeFileSync(server, `#!/bin/sh\nexec "${process.execPath}" --import "${tsx}" "${main}" --cpu "$@"\n`);
  chmodSync(server, 0o755);
  const proc = createServerProcess(
    { spawner: nodeSpawner, fs: nodeServerFs, sleep, notice: () => {}, answers: listening },
    { command: server, cwd: dir },
  );
  try {
    const [a, b] = await Promise.all([proc.start(root, { idleMinutes: 1 }), proc.start(root, { idleMinutes: 1 })]);
    assert.ok(a.isOk() && b.isOk(), JSON.stringify([a, b]));
    const log = readFileSync(proc.log(root), "utf8");
    assert.equal(log.match(/listening on/g)?.length, 1, log);
    assert.equal(log.match(/already running/g)?.length, 1, log);
  } finally {
    const pid = Number(readFileSync(path.join(root, ".eyespy", "server.lock"), "utf8"));
    if (pid > 0) process.kill(pid, "SIGTERM");
    await proc.gone(root);
    rmSync(dir, { recursive: true, force: true });
  }
});
