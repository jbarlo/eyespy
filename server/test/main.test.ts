/**
 * The real server process on an empty session (CPU, it loads no model until a query needs one). Of two started at once,
 * one serves and the other exits ALREADY_RUNNING without touching the session. Bad args print usage and exit 2.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALREADY_RUNNING, emptySessionJson } from "eyespy-core/storage/pure";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../tsx.mjs", import.meta.url));

type Run = { readonly child: ChildProcess; readonly out: () => string; readonly exited: Promise<number | null> };

function server(args: readonly string[], env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, out: () => out, exited };
}

/** A temp folder holding a new, empty session. The path is short because the socket lives in it, unless `below` adds to it. */
function session(below = ""): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "vs-")), below);
  mkdirSync(path.join(root, ".eyespy"), { recursive: true });
  writeFileSync(path.join(root, ".eyespy", "session.json"), emptySessionJson());
  return root;
}

async function until(cond: () => boolean, ms: number, what: string) {
  for (const t0 = Date.now(); !cond();) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("server: two started at once → one listens, the other exits ALREADY_RUNNING; exit frees lock and socket", async () => {
  const root = session();
  const lock = path.join(root, ".eyespy", "server.lock");
  const sock = path.join(root, ".eyespy", "sock");
  const runs = [0, 1].map(() => server(["--session", root, "--cpu", "--idle-minutes", "5"]));
  try {
    // without the lock both would listen (the second taking over the socket) and neither would exit
    const first = await Promise.race([
      ...runs.map((r, i) => r.exited.then((code) => ({ i, code }))),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`neither exited:\n${runs.map((r) => r.out()).join("---\n")}`)), 20_000),
      ),
    ]);
    assert.equal(first.code, ALREADY_RUNNING, runs.map((r) => r.out()).join("\n---\n"));
    const loser = runs[first.i];
    const winner = runs[1 - first.i];
    assert.ok(loser && winner);
    assert.match(loser.out(), /already running \(pid \d+; lock .*server\.lock\)/);
    assert.doesNotMatch(loser.out(), /listening|loaded/);
    await until(() => /listening on/.test(winner.out()), 30_000, "the winner to listen");
    assert.ok(existsSync(sock) && existsSync(lock));
    winner.child.kill("SIGTERM");
    assert.equal(await winner.exited, 0);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(sock), false);
  } finally {
    for (const r of runs) r.child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("server: a stale socket and a dead server's lock (SIGKILL) don't stop the next start", async () => {
  const root = session();
  writeFileSync(path.join(root, ".eyespy", "server.lock"), "999999999\n");
  writeFileSync(path.join(root, ".eyespy", "sock"), "");
  const run = server(["--session", root, "--cpu"]);
  try {
    await until(() => /listening on/.test(run.out()) || run.child.exitCode !== null, 30_000, "listening");
    assert.match(run.out(), /listening on/);
    run.child.kill("SIGTERM");
    assert.equal(await run.exited, 0);
  } finally {
    run.child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("server: a session path too long for a unix socket → one line, exit 2, before taking the lock", async () => {
  const root = session("d".repeat(120));
  const run = server(["--session", root, "--cpu"]);
  try {
    assert.equal(await run.exited, 2, run.out());
    assert.equal(
      run.out(),
      `eyespy-server: the session path is too long for a unix socket: ${path.join(root, ".eyespy", "sock")}\n`,
    );
    assert.equal(existsSync(path.join(root, ".eyespy", "server.lock")), false);
  } finally {
    run.child.kill("SIGKILL");
    rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test("server: --help prints what it is and the usage, exit 0", async () => {
  const help = server(["--help"]);
  assert.equal(await help.exited, 0);
  assert.match(help.out(), /^eyespy-server: find and catalogue[^\n]*\n\nusage: eyespy-server --session <dir>/);
});

test("server: bad args or env → one line and the usage, exit 2 (no stack trace)", async () => {
  const bad = server(["--session", "/nonexistent", "--detector", "int8"]);
  assert.equal(await bad.exited, 2);
  assert.equal(
    bad.out(),
    "eyespy-server: --detector: must be fp32 or fp16\n" +
      "usage: eyespy-server --session <dir> [--models <dir>] [--idle-minutes N] [--detector fp32|fp16] [--cpu] [--feature-disk-mb N]\n",
  );
  const nan = server(["--session", "/nonexistent"], { EYESPY_FEATURE_CACHE_MB: "lots" });
  assert.equal(await nan.exited, 2);
  assert.match(nan.out(), /^eyespy-server: EYESPY_FEATURE_CACHE_MB: expected a number\nusage:/);
});
