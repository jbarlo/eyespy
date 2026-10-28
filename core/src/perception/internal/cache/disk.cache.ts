/**
 * The disk budget's books. They list the stored feature files this instance knows of, least recently used first,
 * with their total size, the budget, and the frames that in-flight work holds.
 *
 * Recency is the last time this instance served or wrote a frame's features. At open, the files' modification
 * times set it. Files are keyed by FrameRef, so a file whose frame is not live, or a stale one in an untrusted
 * store, still counts and can be evicted.
 */
import type { FrameNo, FrameRef } from "../../../video/pure.ts";

export type DiskFile = {
  readonly ref: FrameRef;
  /** The live frame filed there, or null for none (such as a stray index). */
  readonly frame: FrameNo | null;
  readonly bytes: number;
};

/** What to evict, oldest first, and whether that is enough. */
export type EvictionPlan = { readonly victims: readonly DiskFile[]; readonly fits: boolean };

/** A file's key on the books. */
export const fileId = (r: FrameRef): string => `${r.clipKey}/${r.index}`;

export class DiskLedger {
  /** Insertion order is recency, so the first entry is the least recently used. */
  private readonly files = new Map<string, DiskFile>();
  private total = 0;
  /** In-flight holds per file. It is a count because overlapping work may hold the same frame. */
  private readonly holds = new Map<string, number>();
  private limit: number | null;

  constructor(budgetBytes: number | null) {
    this.limit = budgetBytes;
  }

  get bytes(): number {
    return this.total;
  }
  get budget(): number | null {
    return this.limit;
  }
  setBudget(bytes: number | null): void {
    this.limit = bytes;
  }

  /** Records a file as the most recently used. A write replaces its size. */
  touch(f: DiskFile): void {
    const id = fileId(f.ref);
    const old = this.files.get(id);
    if (old) this.total -= old.bytes;
    this.files.delete(id);
    this.files.set(id, f);
    this.total += f.bytes;
  }
  /** Marks a known file as most recently used. Returns false if it is not on the books. */
  refresh(ref: FrameRef): boolean {
    const f = this.files.get(fileId(ref));
    if (f) this.touch(f);
    return f !== undefined;
  }
  drop(ref: FrameRef): void {
    const id = fileId(ref);
    const old = this.files.get(id);
    if (old) this.total -= old.bytes;
    this.files.delete(id);
  }
  dropFrames(frames: ReadonlySet<FrameNo>): void {
    for (const f of [...this.files.values()]) if (f.frame !== null && frames.has(f.frame)) this.drop(f.ref);
  }

  /** Holds these files until the returned release is called. Calls after the first do nothing. */
  hold(refs: readonly FrameRef[]): () => void {
    for (const r of refs) this.holds.set(fileId(r), (this.holds.get(fileId(r)) ?? 0) + 1);
    let held = true;
    return () => {
      if (held) this.release(refs);
      held = false;
    };
  }
  private release(refs: readonly FrameRef[]): void {
    for (const r of refs) {
      const n = (this.holds.get(fileId(r)) ?? 0) - 1;
      if (n > 0) this.holds.set(fileId(r), n);
      else this.holds.delete(fileId(r));
    }
  }

  /**
   * The least recently used files to remove so that `need` more bytes fit the budget. It skips held files and
   * `replacing`, the file about to be rewritten, whose write frees its old size. `fits` is false if removing every
   * unheld file would still not make room. The victims are then every file that could go.
   */
  plan(need: number, replacing: FrameRef | null): EvictionPlan {
    if (this.limit === null) return { victims: [], fits: true };
    const replaced = replacing ? (this.files.get(fileId(replacing))?.bytes ?? 0) : 0;
    const skip = replacing ? fileId(replacing) : null;
    const victims: DiskFile[] = [];
    let after = this.total - replaced + need;
    for (const [id, f] of this.files) {
      if (after <= this.limit) break;
      if (id === skip || this.holds.has(id)) continue;
      victims.push(f);
      after -= f.bytes;
    }
    return { victims, fits: after <= this.limit };
  }
}
