/**
 * JSON snapshots in __snapshots__/. UPDATE=1 rewrites the file at exit with only this run's keys, in match order.
 * Without UPDATE a missing key fails, so a snapshot that was never committed is noticed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__");
export const UPDATE = !!process.env.UPDATE && process.env.UPDATE !== "0";

/** JSON-normalised copy: undefined dropped, typed arrays as arrays, key order kept. */
export function normalise(v: unknown): unknown {
  const text = JSON.stringify(v, (_k, x: unknown) =>
    ArrayBuffer.isView(x) && !(x instanceof DataView) ? Array.from(x as unknown as ArrayLike<number>) : x,
  );
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

export function snapshots(name: string) {
  const file = join(SNAPSHOT_DIR, `${name}.json`);
  const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const recorded: Record<string, unknown> = {};
  if (UPDATE)
    process.on("exit", () => {
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(recorded, null, 1) + "\n");
    });
  return {
    match: (key: string, value: unknown) => {
      const v = normalise(value);
      if (Object.hasOwn(recorded, key)) throw new Error(`snapshot key ${key} used twice in ${name}`);
      recorded[key] = v;
      if (UPDATE) return;
      if (!Object.hasOwn(stored, key)) assert.fail(`no snapshot ${name}/${key}; run with UPDATE=1 to record it`);
      assert.deepStrictEqual(v, stored[key], `snapshot ${name}/${key} changed (UPDATE=1 to accept)`);
    },
  };
}
