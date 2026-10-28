/**
 * Content-addressed download cache for the models and the ort wasm. It fetches each file once with progress events,
 * checks it against its sha256 and keeps it in OPFS under that hash, so a URL change alone never re-downloads.
 */
import type { ModelEntry } from "../manifest.ts";
import type { EngineEvent } from "../../protocol.ts";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

type SyncHandle = {
  write(b: Uint8Array, o: { at: number }): number;
  truncate(n: number): void;
  flush(): void;
  close(): void;
};

/** OPFS directory of verified files named by their sha256. It is called "models" but holds the ort wasm too. */
class HashDir {
  private dir?: Promise<FileSystemDirectoryHandle>;
  private root() {
    this.dir ??= navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("models", { create: true }));
    return this.dir;
  }
  async get(sha: string, bytes: number): Promise<Uint8Array | null> {
    try {
      const f = await (await (await this.root()).getFileHandle(sha)).getFile();
      // a file lands here only after verification (written as <sha>.part, then renamed), so the size check is enough
      if (f.size !== bytes) return null;
      return new Uint8Array(await f.arrayBuffer());
    } catch {
      return null;
    }
  }
  async put(sha: string, data: Uint8Array) {
    const dir = await this.root();
    const part = await dir.getFileHandle(`${sha}.part`, { create: true });
    // a sync access handle (worker-only) writes into the file in place, with no swap file
    const h = await (part as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    try {
      h.truncate(0);
      let off = 0;
      while (off < data.length) off += h.write(data.subarray(off, off + (64 << 20)), { at: off });
      h.flush();
    } finally {
      h.close();
    }
    await (part as unknown as { move(name: string): Promise<void> }).move(sha);
  }
}

export class DownloadCache {
  private dir = new HashDir();
  private loading = new Map<string, Promise<Uint8Array>>();
  constructor(private emit: (e: EngineEvent) => void) {}

  /** The verified bytes of `e`, from the cache or else downloaded (with progress events under `name`) and cached. */
  bytes(name: string, e: ModelEntry): Promise<Uint8Array> {
    let p = this.loading.get(e.sha256);
    if (!p) {
      p = this.fetch(name, e);
      this.loading.set(e.sha256, p);
      // don't hold the bytes in memory once the caller has them
      p.then(
        () => this.loading.delete(e.sha256),
        () => this.loading.delete(e.sha256),
      );
    }
    return p;
  }

  private async fetch(name: string, e: ModelEntry): Promise<Uint8Array> {
    const hit = await this.dir.get(e.sha256, e.bytes);
    if (hit) {
      this.emit({ kind: "download", name, loaded: e.bytes, total: e.bytes, source: "cache", done: true });
      return hit;
    }
    const r = await fetch(e.url);
    if (!r.ok || !r.body) throw new Error(`download ${name} from ${e.url}: HTTP ${r.status}`);
    const buf = new Uint8Array(e.bytes);
    const reader = r.body.getReader();
    let off = 0,
      last = 0;
    this.emit({ kind: "download", name, loaded: 0, total: e.bytes, source: "network", done: false });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > buf.length) throw new Error(`download ${name}: more than the expected ${e.bytes} bytes`);
      buf.set(value, off);
      off += value.length;
      if (off - last > 4 << 20) {
        last = off;
        this.emit({ kind: "download", name, loaded: off, total: e.bytes, source: "network", done: false });
      }
    }
    if (off !== e.bytes) throw new Error(`download ${name}: got ${off} bytes, expected ${e.bytes}`);
    const sha = hex(await crypto.subtle.digest("SHA-256", buf));
    if (sha !== e.sha256) throw new Error(`download ${name}: sha256 ${sha} does not match the manifest's ${e.sha256}`);
    await this.dir.put(e.sha256, buf);
    this.emit({ kind: "download", name, loaded: off, total: e.bytes, source: "network", done: true });
    return buf;
  }
}
