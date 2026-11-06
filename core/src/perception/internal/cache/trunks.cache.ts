/**
 * Stored trunks, one file per place on a clip's tracking grid. A trunk is 10.6 MB and takes one vision run to make
 * again, so the files sit on a disk budget of their own, on the same LRU books as features. A trunk that was evicted,
 * or that is stored in an untrusted format, reads as absent, and the caller encodes it again. If the budget can't make
 * room, the new trunk isn't written and the caller keeps what it holds. Nothing else depends on a trunk being there.
 */
import { ok, okAsync, type ResultAsync } from "neverthrow";
import type { Logger } from "../../../ports/index.ts";
import { sequence } from "../../../railway/index.ts";
import type { ClipKey, FrameRef } from "../../../video/pure.ts";
import type { FeatureStore } from "../../ports.ts";
import { TRUNK_BYTES, type Trunk } from "../../pure.ts";
import type { PerceptionError } from "../../types.ts";
import { DiskLedger, fileId } from "./disk.cache.ts";

const MB = 2 ** 20;

/** A stored file's bytes as a Trunk, or null if the size is wrong. It copies only for an odd offset. */
const trunkFromBytes = (bytes: Uint8Array): Trunk | null => {
  if (bytes.byteLength !== TRUNK_BYTES) return null;
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice();
  return new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
};

export class TrunkFiles {
  private readonly disk: DiskLedger;
  /** The files that can be read back: written here, or found by a trusted scan. */
  private readonly current = new Set<string>();

  constructor(
    private readonly store: FeatureStore,
    private readonly logger: Logger,
    diskMB: number,
    private readonly trust: boolean,
  ) {
    this.disk = new DiskLedger(diskMB * MB);
  }

  get bytes(): number {
    return this.disk.bytes;
  }

  /** Puts a clip's files on the books, oldest first. */
  scan(clips: readonly ClipKey[]): ResultAsync<void, PerceptionError> {
    return sequence(clips, (c) => this.store.list(c)).andThen((lists) => {
      for (const f of lists.flat().toSorted((a, b) => a.mtime - b.mtime)) {
        this.disk.touch({ ref: f.ref, frame: null, bytes: f.bytes });
        if (this.trust) this.current.add(fileId(f.ref));
      }
      return this.enforce(0, null).map(() => undefined);
    });
  }

  private enforce(need: number, replacing: FrameRef | null): ResultAsync<boolean, PerceptionError> {
    const plan = this.disk.plan(need, replacing);
    return sequence(plan.victims, (f) =>
      this.store.remove(f.ref).map(() => {
        this.disk.drop(f.ref);
        this.current.delete(fileId(f.ref));
      }),
    ).map((gone) => {
      if (gone.length) this.logger.log(`evicted ${gone.length} stored trunks`);
      return plan.fits;
    });
  }

  /** The trunk filed at `ref`, or null if there is none to read. */
  read(ref: FrameRef): ResultAsync<Trunk | null, PerceptionError> {
    if (!this.current.has(fileId(ref))) return okAsync(null);
    return this.store.read(ref).andThen((bytes) => {
      const t = bytes ? trunkFromBytes(bytes) : null;
      if (t) this.disk.refresh(ref);
      else {
        this.disk.drop(ref);
        this.current.delete(fileId(ref));
      }
      return ok(t);
    });
  }

  /** Writes a trunk if the budget has room. */
  write(ref: FrameRef, trunk: Trunk): ResultAsync<void, PerceptionError> {
    const bytes = new Uint8Array(trunk.buffer, trunk.byteOffset, trunk.byteLength);
    return this.enforce(bytes.byteLength, ref).andThen((fits) => {
      if (!fits) {
        this.logger.log(`trunk ${fileId(ref)} not stored: no room in its disk budget`);
        return okAsync(undefined);
      }
      return this.store.write(ref, bytes).map(() => {
        this.disk.touch({ ref, frame: null, bytes: bytes.byteLength });
        this.current.add(fileId(ref));
      });
    });
  }

  /** Takes a removed clip's files off the books. The session deletes them. */
  forgetClip(key: ClipKey): void {
    this.disk.dropClip(key);
    for (const id of [...this.current]) if (id.startsWith(`${key}/`)) this.current.delete(id);
  }
}
