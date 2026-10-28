/** In-memory SessionStore plus fixture load, dump and diff helpers. Keys are relative to the session's .eyespy/. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type { SessionStore, StoredFile } from "../../src/ports/index.ts";

/** Passes sessionStoreContract, like the server's FsStore. */
export class MemStore implements SessionStore {
  files = new Map<string, Uint8Array>();
  /** Modification time per file in wall-clock ms, increasing with every write. Tests may set them. */
  mtimes = new Map<string, number>();
  private last = 0;
  private touch(k: string): void {
    this.last = Math.max(Date.now(), this.last + 1);
    this.mtimes.set(k, this.last);
  }
  root = "mem";
  /** The normalized key; throws (so the call rejects) for one outside the session folder. */
  private key(k: string): string {
    const n = posix.normalize(k);
    if (posix.isAbsolute(n) || n === "." || n === ".." || n.startsWith("../"))
      throw new Error(`key escapes the session: ${k}`);
    return n;
  }
  async read(k: string) {
    return this.files.get(this.key(k))?.slice() ?? null;
  }
  async readText(k: string) {
    const b = this.files.get(this.key(k));
    return b ? new TextDecoder().decode(b) : null;
  }
  async write(k: string, d: Uint8Array) {
    this.files.set(this.key(k), d.slice());
    this.touch(this.key(k));
  }
  async writeText(k: string, t: string) {
    this.files.set(this.key(k), new TextEncoder().encode(t));
    this.touch(this.key(k));
  }
  async appendText(k: string, t: string) {
    await this.writeText(k, ((await this.readText(k)) ?? "") + t);
  }
  async exists(k: string) {
    return this.files.has(this.key(k));
  }
  async remove(k: string) {
    this.files.delete(this.key(k));
    this.mtimes.delete(this.key(k));
  }
  async removeDir(k: string) {
    const dir = this.key(k);
    for (const f of [...this.files.keys()])
      if (f.startsWith(dir + "/")) {
        this.files.delete(f);
        this.mtimes.delete(f);
      }
  }
  async size(k: string) {
    return this.files.get(this.key(k))?.byteLength ?? null;
  }
  async list(k: string): Promise<readonly StoredFile[]> {
    const dir = this.key(k) + "/";
    return [...this.files]
      .filter(([f]) => f.startsWith(dir) && !f.slice(dir.length).includes("/"))
      .map(([f, b]) => ({ name: f.slice(dir.length), size: b.byteLength, mtime: this.mtimes.get(f) ?? 0 }));
  }
  locate(k: string) {
    return this.key(k);
  }

  /** Text of a file that must exist. */
  text(k: string): string {
    const b = this.files.get(k);
    if (!b) throw new Error(`no ${k} in the store`);
    return new TextDecoder().decode(b);
  }

  /** Every file under `dir` (a session's .eyespy/ folder or a fixture copy of one). */
  static fromDir(dir: string): MemStore {
    const s = new MemStore();
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else s.files.set(relative(dir, p).split("\\").join("/"), new Uint8Array(readFileSync(p)));
      }
    };
    walk(dir);
    return s;
  }

  /** Replace `dir` with this store's files (those `keep` accepts). */
  toDir(dir: string, keep: (key: string) => boolean = () => true) {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!keep(k)) continue;
      mkdirSync(dirname(join(dir, k)), { recursive: true });
      writeFileSync(join(dir, k), v);
    }
  }

  /** Content fingerprint per file, for diffing two states. */
  fingerprint(): Map<string, string> {
    return new Map([...this.files].map(([k, v]) => [k, digest(v)]));
  }
}

/** First 16 hex digits of the sha256 of some bytes, and their length, which tell two files apart. */
export function digest(b: Uint8Array): string {
  return `${createHash("sha256").update(b).digest("hex").slice(0, 16)} ${b.byteLength}`;
}

/** Files added or changed (with their new digest) or removed ("-") between two fingerprints, sorted by key. */
export function changes(before: Map<string, string>, after: Map<string, string>): Record<string, string> {
  const out: [string, string][] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push([k, v]);
  for (const k of before.keys()) if (!after.has(k)) out.push([k, "-"]);
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
}
