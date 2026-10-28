/** Node adapter for serverproc's ports. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Child, ServerFs, Spawner } from "./ports.ts";

export const nodeSpawner: Spawner = {
  spawn: async (command, argv, { cwd, log }) => {
    const out = openSync(log, "a");
    let spawnError: string | null = null;
    try {
      const child = spawn(command, argv, { cwd, detached: true, stdio: ["ignore", out, out] });
      child.on("error", (e) => (spawnError = e.message));
      child.unref();
      const watched: Child = { exitCode: () => child.exitCode, spawnError: () => spawnError };
      return watched;
    } finally {
      closeSync(out); // the child has its own copy
    }
  },
};

export const nodeServerFs: ServerFs = {
  exists: async (p) => existsSync(p),
  size: async (p) => (existsSync(p) ? (await stat(p)).size : 0),
  readFrom: async (p, offset) => {
    if (!existsSync(p)) return "";
    const fh = await open(p, "r");
    try {
      const n = Math.max(0, (await fh.stat()).size - offset);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, offset);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  },
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
