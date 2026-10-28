/** The session lock: one holder, taking over stale locks, and a real race between processes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type LockHost, takeLock } from "../src/lock.ts";

const LOCK_TS = fileURLToPath(new URL("../src/lock.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../tsx.mjs", import.meta.url));

function withDir(body: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "eyespy-lock-"));
  return Promise.resolve(body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const host = (pid: number, live: readonly number[]): LockHost => ({ pid, alive: (p) => live.includes(p) });

test("lock: the first taker holds it; a second (live holder) is refused; release frees it", () =>
  withDir((dir) => {
    const file = path.join(dir, "server.lock");
    const a = takeLock(file, host(100, [100, 200]))._unsafeUnwrap();
    assert.equal(readFileSync(file, "utf8"), "100\n");
    assert.deepEqual(takeLock(file, host(200, [100, 200]))._unsafeUnwrapErr(), { kind: "held", pid: 100 });
    a?.release();
    assert.equal(existsSync(file), false);
    assert.ok(takeLock(file, host(200, [200])).isOk());
    assert.equal(readFileSync(file, "utf8"), "200\n");
    assert.deepEqual(readdirSync(dir), ["server.lock"]); // no temp or aside files left
  }));

test("lock: a lock whose pid is dead (SIGKILL, crash) is taken over", () =>
  withDir((dir) => {
    const file = path.join(dir, "server.lock");
    writeFileSync(file, "100\n");
    assert.ok(takeLock(file, host(200, [200])).isOk());
    assert.equal(readFileSync(file, "utf8"), "200\n");
    assert.deepEqual(readdirSync(dir), ["server.lock"]);
  }));

test("lock: release leaves a lock that isn't ours alone", () =>
  withDir((dir) => {
    const file = path.join(dir, "server.lock");
    const a = takeLock(file, host(100, [100]))._unsafeUnwrap();
    writeFileSync(file, "300\n"); // another process took it over, thinking we were dead
    a?.release();
    assert.equal(readFileSync(file, "utf8"), "300\n");
  }));

test("lock: no session folder → no lock and nothing created", () =>
  withDir((dir) => {
    assert.equal(takeLock(path.join(dir, "missing", "server.lock"), host(1, [1]))._unsafeUnwrap(), null);
    assert.deepEqual(readdirSync(dir), []);
  }));

/** Starts a process that takes the lock (stale or not), holds it a moment and prints "won" or "lost". */
function contender(file: string): Promise<string> {
  const script = `
    import { takeLock } from ${JSON.stringify(LOCK_TS)};
    const r = takeLock(${JSON.stringify(file)});
    process.stdout.write(r.isOk() ? "won" : "lost");
    if (r.isOk()) setTimeout(() => r.value?.release(), 600);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}

test("lock: processes racing for it (fresh, and over a stale lock): exactly one wins", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "server.lock");
    for (const stale of [false, true]) {
      if (stale) writeFileSync(file, "999999999\n"); // no such pid
      const results = await Promise.all(Array.from({ length: 6 }, () => contender(file)));
      assert.deepEqual(
        results.filter((r) => r === "won").length,
        1,
        `${stale ? "stale" : "fresh"}: ${results.join(",")}`,
      );
      assert.equal(existsSync(file), false); // the winner released it
    }
  }));
