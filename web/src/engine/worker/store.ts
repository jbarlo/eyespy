/**
 * SessionStore over a FileSystemDirectoryHandle: the OPFS root (navigator.storage.getDirectory()) or a folder the user
 * picked with showDirectoryPicker(). It has the same layout as the Node store (<session>/.eyespy/<key>), so the CLI and
 * the browser can open each other's session folders.
 */
import type { SessionStore, StoredFile } from "eyespy-core/ports";
import { SESSION_FILE, SESSION_MARKER, emptySessionJson } from "eyespy-core/storage/pure";
import { STORE_REF } from "../../protocol.ts";

type Listable = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

const notFound = (e: unknown) =>
  e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError");

export class DirStore implements SessionStore {
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();

  private constructor(
    private base: FileSystemDirectoryHandle, // <session>/.eyespy
    readonly root: string,
  ) {}

  /** Opens <session>/.eyespy, creating the folder when missing (nothing in it). */
  static async open(session: FileSystemDirectoryHandle, root: string): Promise<DirStore> {
    return new DirStore(await session.getDirectoryHandle(SESSION_MARKER, { create: true }), root);
  }

  /** Like `open`, and also writes an empty session.json when there is none (what `eyespy init` does). */
  static async openOrInit(session: FileSystemDirectoryHandle, root: string): Promise<DirStore> {
    const s = await DirStore.open(session, root);
    if (!(await s.exists(SESSION_FILE))) await s.writeText(SESSION_FILE, emptySessionJson());
    return s;
  }

  private split(key: string): [string[], string] {
    const parts = key.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`key escapes the session: ${key}`);
    const name = parts.pop();
    if (name === undefined) throw new Error(`empty key`); // split() always yields at least one part
    return [parts, name];
  }

  private dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    const k = parts.join("/");
    let d = this.dirs.get(k);
    if (!d) {
      d = (async () => {
        let h = this.base;
        for (const p of parts) h = await h.getDirectoryHandle(p, { create });
        return h;
      })();
      if (create) this.dirs.set(k, d); // only cache handles that are known to exist
      d.catch(() => this.dirs.delete(k));
    }
    return d;
  }

  private async file(key: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const [parts, name] = this.split(key);
    try {
      return await (await this.dir(parts, create)).getFileHandle(name, { create });
    } catch (e) {
      if (!create && notFound(e)) return null;
      throw e;
    }
  }

  async read(key: string) {
    const h = await this.file(key, false);
    return h ? new Uint8Array(await (await h.getFile()).arrayBuffer()) : null;
  }
  async readText(key: string) {
    const b = await this.read(key);
    return b === null ? null : new TextDecoder().decode(b);
  }
  /** createWritable() writes a swap file and swaps it in on close(), an atomic replace like the Node rename. */
  async write(key: string, data: Uint8Array) {
    const w = await (await this.file(key, true))!.createWritable();
    try {
      await w.write(data as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  }
  async writeText(key: string, text: string) {
    await this.write(key, new TextEncoder().encode(text));
  }
  async appendText(key: string, text: string) {
    const h = (await this.file(key, true))!;
    const size = (await h.getFile()).size;
    const w = await h.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(text);
    await w.close();
  }
  async exists(key: string) {
    return (await this.file(key, false)) !== null;
  }
  async remove(key: string) {
    const [parts, name] = this.split(key);
    try {
      await (await this.dir(parts, false)).removeEntry(name);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  }
  async removeDir(key: string) {
    const [parts, name] = this.split(key);
    try {
      await (await this.dir(parts, false)).removeEntry(name, { recursive: true });
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    for (const k of [...this.dirs.keys()]) if (k === key || k.startsWith(key + "/")) this.dirs.delete(k);
  }
  async size(key: string) {
    const h = await this.file(key, false);
    return h ? (await h.getFile()).size : null;
  }
  /** Files directly in folder `key` (getFile() gives size and lastModified); a missing folder lists nothing. */
  async list(key: string): Promise<readonly StoredFile[]> {
    const [parts, name] = this.split(key);
    let d: FileSystemDirectoryHandle;
    try {
      d = await (await this.dir(parts, false)).getDirectoryHandle(name);
    } catch (e) {
      if (notFound(e)) return [];
      throw e;
    }
    const out: StoredFile[] = [];
    for await (const [n, h] of (d as Listable).entries())
      if (h.kind === "file") {
        const f = await (h as FileSystemFileHandle).getFile();
        out.push({ name: n, size: f.size, mtime: f.lastModified });
      }
    return out;
  }
  locate(key: string) {
    return STORE_REF + key;
  }
}
