/** Node adapter for locate's ports. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { LocateEnv, LocateFs } from "./ports.ts";

export const nodeLocateFs: LocateFs = {
  exists: async (p) => existsSync(p),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  readText: (p) => readFile(p, "utf8"),
  writeText: (p, text) => writeFile(p, text),
  isDir: async (p) => (await stat(p)).isDirectory(),
  list: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => !e.isDirectory()).map((e) => e.name),
  sha1: async (p) => {
    const h = createHash("sha1");
    await pipeline(createReadStream(p), h);
    return h.digest("hex");
  },
};

export const nodeLocateEnv = (env: NodeJS.ProcessEnv, cwd: string): LocateEnv => ({
  cwd,
  cacheDir: path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "eyespy"),
});
