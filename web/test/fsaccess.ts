/**
 * In-memory File System Access directory, as far as the browser adapters use it. Writables are swap files, as
 * in browsers, so nothing changes until close.
 */

type Entry = FakeDir | FakeFile;

const domError = (name: string, what: string) => new DOMException(`${what}: ${name}`, name);

export class FakeFile {
  readonly kind = "file";
  data: Uint8Array = new Uint8Array(0);
  /** Set when a writable closes (and by put), as the browser does. */
  lastModified = Date.now();
  /** getFile() calls (the browser adapter sums sizes through them). */
  reads = 0;
  constructor(readonly name: string) {}

  async getFile() {
    this.reads++;
    const d = this.data;
    return { size: d.length, lastModified: this.lastModified, arrayBuffer: async () => d.slice().buffer };
  }

  async createWritable(o: { keepExistingData?: boolean } = {}) {
    let buf = o.keepExistingData ? this.data.slice() : new Uint8Array(0);
    let pos = 0;
    return {
      write: async (x: Uint8Array | string) => {
        const b = typeof x === "string" ? new TextEncoder().encode(x) : x.slice();
        const next = new Uint8Array(Math.max(buf.length, pos + b.length));
        next.set(buf);
        next.set(b, pos);
        buf = next;
        pos += b.length;
      },
      seek: async (p: number) => {
        pos = p;
      },
      close: async () => {
        this.data = buf;
        this.lastModified = Date.now();
      },
      abort: async () => {},
    };
  }
}

export class FakeDir {
  readonly kind = "directory";
  readonly children = new Map<string, Entry>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    if (c) throw domError("TypeMismatchError", name);
    if (!o.create) throw domError("NotFoundError", name);
    const d = new FakeDir(name);
    this.children.set(name, d);
    return d;
  }

  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return c;
    if (c) throw domError("TypeMismatchError", name);
    if (!o.create) throw domError("NotFoundError", name);
    const f = new FakeFile(name);
    this.children.set(name, f);
    return f;
  }

  async removeEntry(name: string, o: { recursive?: boolean } = {}) {
    const c = this.children.get(name);
    if (!c) throw domError("NotFoundError", name);
    if (c instanceof FakeDir && c.children.size > 0 && !o.recursive) throw domError("InvalidModificationError", name);
    this.children.delete(name);
  }

  async *entries(): AsyncIterable<[string, Entry]> {
    for (const e of [...this.children]) yield e;
  }

  /** Write a file at a slash path below this folder, creating folders. */
  async put(path: string, data: Uint8Array | string) {
    const parts = path.split("/");
    const name = parts.pop() ?? "";
    const d = await parts.reduce<Promise<FakeDir>>(
      async (at, p) => (await at).getDirectoryHandle(p, { create: true }),
      Promise.resolve(this),
    );
    const f = await d.getFileHandle(name, { create: true });
    f.data = typeof data === "string" ? new TextEncoder().encode(data) : data;
    f.lastModified = Date.now();
    return f;
  }

  at(path: string): Entry | undefined {
    return path
      .split("/")
      .reduce<Entry | undefined>((e, p) => (e instanceof FakeDir ? e.children.get(p) : undefined), this);
  }

  /** This folder typed as the DOM handle the adapters take. It has the subset they use. */
  get handle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }
}
