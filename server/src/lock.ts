/**
 * One server per session. The server takes `<session>/.eyespy/server.lock`, holding its pid, before it opens the
 * session, so a racing second server exits ALREADY_RUNNING without touching the session or socket. The CLI shares the
 * lock name and the exit code.
 *
 * The server writes the pid to a private file and hard-links it to the lock name, so the lock never exists
 * half-written. A contender renames a lock with a dead pid aside (atomic, so one contender wins) and checks it again
 * before deleting it. That way a contender can't delete a fresh lock another one just took.
 */
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Result, err, ok } from "neverthrow";
import { SERVER_LOCK } from "eyespy-core/storage/pure";

export type Held = { readonly kind: "held"; readonly pid: number | null };
export type Lock = {
  /** Removes the lock if it is still ours. Sync, because it runs in the process's "exit" handler. */
  release(): void;
};

export type LockHost = {
  readonly pid: number;
  /** Whether a process with this pid exists. */
  readonly alive: (pid: number) => boolean;
};

const code = (e: unknown) => (e instanceof Error && "code" in e ? e.code : undefined);

const nodeLockHost: LockHost = {
  pid: process.pid,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return code(e) === "EPERM"; // exists, owned by someone else
    }
  },
};

/** The pid in a lock file; null if it is gone or unreadable. */
function pidIn(file: string): number | null {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw e;
  }
}

function unlinkQuiet(file: string) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (code(e) !== "ENOENT") throw e;
  }
}

/**
 * Takes the lock at `file`. Ok(null) when its folder doesn't exist, since there is no session there, opening it fails
 * anyway, and a lock never creates a folder. Err when a live process holds it.
 */
export function takeLock(file: string, host: LockHost = nodeLockHost): Result<Lock | null, Held> {
  const mine = `${file}.${host.pid}`;
  try {
    writeFileSync(mine, `${host.pid}\n`);
  } catch (e) {
    if (code(e) === "ENOENT") return ok(null);
    throw e;
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(mine, file);
        return ok({ release: () => (pidIn(file) === host.pid ? unlinkQuiet(file) : undefined) });
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
      }
      const holder = pidIn(file);
      if (holder === null) continue; // released meanwhile
      if (holder !== host.pid && host.alive(holder)) return err({ kind: "held", pid: holder });
      // stale, so move it aside (only one contender can), then check that what we moved is the stale one
      const aside = `${file}.stale.${host.pid}`;
      try {
        renameSync(file, aside);
      } catch (e) {
        if (code(e) === "ENOENT") continue; // another contender moved it first
        throw e;
      }
      const moved = pidIn(aside);
      if (moved !== null && moved !== holder && host.alive(moved)) {
        // someone took a fresh lock since we read it. Put it back, unless yet another one exists by now, and give way.
        try {
          linkSync(aside, file);
        } catch (e) {
          if (code(e) !== "EEXIST") throw e;
        }
        unlinkQuiet(aside);
        return err({ kind: "held", pid: moved });
      }
      unlinkQuiet(aside);
    }
    return err({ kind: "held", pid: pidIn(file) });
  } finally {
    unlinkQuiet(mine);
  }
}

export const lockPath = (markerDir: string) => path.join(markerDir, SERVER_LOCK);
