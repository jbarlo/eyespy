/** SessionStore over the filesystem. Keys are paths under <session>/.eyespy/. */
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionStore, StoredFile } from "eyespy-core/ports";
import { SESSION_MARKER } from "eyespy-core/storage/pure";

/**
 * `f()`, or null when there is no file there (missing, or a folder). Any other failure is a host failure and rejects.
 */
async function orNull<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR"))
      return null;
    throw e;
  }
}

export class FsStore implements SessionStore {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = path.join(root, SESSION_MARKER);
  }
  private p(key: string) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(this.dir + path.sep)) throw new Error(`key escapes the session: ${key}`);
    return p;
  }
  async readText(key: string) {
    return orNull(() => readFile(this.p(key), "utf8"));
  }
  async writeText(key: string, text: string) {
    await this.write(key, new TextEncoder().encode(text));
  }
  async appendText(key: string, text: string) {
    await mkdir(path.dirname(this.p(key)), { recursive: true });
    await appendFile(this.p(key), text);
  }
  /**
   * A view over the Buffer readFile allocated for this call, with no copy. Nothing else holds it, so it is the
   * caller's.
   */
  async read(key: string) {
    const b = await orNull(() => readFile(this.p(key)));
    return b && new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  /** Writes a temp file, then renames it over the target, so the write is atomic. */
  async write(key: string, data: Uint8Array) {
    const p = this.p(key);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
  }
  /** Whether a file (not a directory) exists at `key`. */
  async exists(key: string) {
    return (await orNull(() => stat(this.p(key))))?.isFile() ?? false;
  }
  async remove(key: string) {
    await rm(this.p(key), { force: true });
  }
  async removeDir(key: string) {
    await rm(this.p(key), { recursive: true, force: true });
  }
  async size(key: string) {
    const st = await orNull(() => stat(this.p(key)));
    return st?.isFile() ? st.size : null;
  }
  /** Files directly in `dir`. A missing folder, or a file there, lists nothing. */
  async list(dir: string): Promise<readonly StoredFile[]> {
    const d = this.p(dir);
    const names = (await orNull(() => readdir(d, { withFileTypes: true }))) ?? [];
    const files = names.filter((e) => e.isFile());
    const stats = await Promise.all(
      files.map(async (e) => ({ name: e.name, st: await orNull(() => stat(path.join(d, e.name))) })),
    );
    return stats.flatMap(({ name, st }) => (st ? [{ name, size: st.size, mtime: st.mtimeMs }] : []));
  }
  locate(key: string) {
    return this.p(key);
  }
}
