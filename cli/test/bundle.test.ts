/**
 * The bundle the devshell runs builds and prints what tsx on the sources prints. The wrapper falls back to tsx when the
 * build fails, so without this a broken bundle would go unnoticed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "..");
const TSX = ["--import", path.join(CLI, "tsx.mjs")];
const node = (args: readonly string[]) => execFileSync(process.execPath, args, { encoding: "utf8" });

test("the bundle builds and answers --help / obj --help like the sources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eyespy-bundle-"));
  try {
    const out = path.join(dir, "eyespy.mjs");
    node([...TSX, path.join(CLI, "scripts/bundle.ts"), out]);
    for (const args of [["--help"], ["obj", "--help"], ["-V"]])
      assert.equal(node([out, ...args]), node([...TSX, path.join(CLI, "src/main.ts"), ...args]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
