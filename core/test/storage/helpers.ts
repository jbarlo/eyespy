import type { Result } from "neverthrow";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../src/ports/index.ts";
import { createSessionFolder } from "../../src/storage/index.ts";
import type { SessionFolder, SessionRecords } from "../../src/storage/index.ts";
import { MemStore } from "../fakes/index.ts";

export const REAL = fileURLToPath(new URL("../fixtures/session-real", import.meta.url));
export const FAKE = fileURLToPath(new URL("../fixtures/session-fake", import.meta.url));

export class TestClock implements Clock {
  constructor(public ms = Date.UTC(2026, 0, 2, 3, 4, 5)) {}
  now() {
    return this.ms;
  }
}

/** MemStore that logs every mutating call as "op key" (and can be told to fail one op). */
export class RecordingStore extends MemStore {
  calls: string[] = [];
  failOn: string | null = null;
  private note(op: string, k: string) {
    this.calls.push(`${op} ${k}`);
    if (this.failOn === `${op} ${k}`) throw new Error(`disk full: ${k}`);
  }
  override async write(k: string, d: Uint8Array) {
    this.note("write", k);
    return super.write(k, d);
  }
  override async writeText(k: string, t: string) {
    this.note("writeText", k);
    return super.writeText(k, t);
  }
  override async appendText(k: string, t: string) {
    this.note("appendText", k);
    // super.appendText goes through writeText; bypass it so the log shows one call
    this.files.set(k, new TextEncoder().encode(((await this.readText(k)) ?? "") + t));
  }
  override async remove(k: string) {
    this.note("remove", k);
    return super.remove(k);
  }
  override async removeDir(k: string) {
    this.note("removeDir", k);
    return super.removeDir(k);
  }

  static from(dir: string): RecordingStore {
    const s = new RecordingStore();
    s.files = MemStore.fromDir(dir).files;
    return s;
  }
}

export const EMPTY = JSON.stringify({ version: 1, config: {}, clips: [] }, null, 1);

export function storeWith(files: Record<string, string>): RecordingStore {
  const s = new RecordingStore();
  for (const [k, v] of Object.entries(files)) s.files.set(k, new TextEncoder().encode(v));
  return s;
}

/** Open a folder over a store; fails the test on an Err. */
export async function opened(
  store: MemStore,
  clock: Clock = new TestClock(),
): Promise<{ folder: SessionFolder; records: SessionRecords }> {
  const folder = createSessionFolder({ store, clock });
  const r = await folder.open();
  if (r.isErr()) throw new Error(`open failed: ${JSON.stringify(r.error)}`);
  return { folder, records: r.value };
}

export async function must<T, E>(r: PromiseLike<Result<T, E>>): Promise<T> {
  const v = await r;
  if (v.isErr()) throw new Error(`unexpected Err: ${JSON.stringify(v.error)}`);
  return v.value;
}

export const sessionJson = (store: MemStore) =>
  JSON.parse(store.text("session.json")) as { clips: Record<string, unknown>[]; next_obj?: number };

export const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b ?? new Uint8Array());
