/**
 * Keyframe features. Lookups try a RAM LRU sized in MB, then the FeatureStore, then encode.
 *
 * Rules:
 *   - With persist off, features live in RAM only. The next query that needs an evicted frame re-encodes it, but the
 *     frame stays "encoded" so background work does not keep refilling the LRU.
 *   - Only files this instance wrote, or that a trusted `scanStore` found, are read back. A stored file of the wrong
 *     size is ignored and the frame re-encoded.
 *   - One instance has one session folder and one disk budget. Before a write that would exceed the budget, the
 *     least recently used files are removed. File mtimes set the starting recency, so older files go first. Held
 *     frames' files are never evicted. If the rest can't make room, the new encode stays in RAM only. An evicted
 *     frame stays "encoded". The RAM LRU and the disk budget are independent.
 *   - A frame whose image can never be read is marked failed. It leaves `pending`, and encodeNext returns its Err
 *     once instead of retrying forever. A host failure may pass, so nothing is marked and the caller backs off.
 *     `forget` or a successful encode for a query clears the mark.
 */
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { Clock, Logger } from "../../../ports/index.ts";
import type { RGB } from "../../../pixels/index.ts";
import type { FrameAccessError, FrameNo, FrameRef } from "../../../video/pure.ts";
import type { FeatureStore, FrameImages } from "../../ports.ts";
import { FEATURE_BYTES, type Features } from "../../pure.ts";
import type { CacheStats, PerceptionError } from "../../types.ts";
import { featureBytes, featuresFromBytes } from "../features.ts";
import { sequence } from "../../../railway/index.ts";
import { DiskLedger, fileId, type DiskFile } from "./disk.cache.ts";
import { FeatureState } from "./state.cache.ts";

export type CachePorts = {
  readonly store: FeatureStore;
  readonly frames: FrameImages;
  readonly encode: (img: RGB) => ResultAsync<Features, PerceptionError>;
  readonly clock: Clock;
  readonly logger: Logger;
};
export type CacheOptions = {
  readonly featureCacheMB: number;
  readonly persist: boolean;
  readonly trustStored: boolean;
  /** Disk budget for stored features in MB, or null for unlimited. */
  readonly featureDiskMB: number | null;
};

export interface FeatureCache {
  readonly features: (i: FrameNo) => ResultAsync<Features, PerceptionError>;
  readonly encoded: (i: FrameNo) => boolean;
  readonly pending: () => readonly FrameNo[];
  readonly encodeNext: () => ResultAsync<boolean, PerceptionError>;
  readonly forget: (frames: readonly FrameNo[]) => void;
  readonly setPersist: (on: boolean) => void;
  readonly scanStore: () => ResultAsync<number, PerceptionError>;
  readonly clearStored: (frames?: readonly FrameNo[]) => ResultAsync<number, PerceptionError>;
  readonly stats: () => ResultAsync<CacheStats, PerceptionError>;
  readonly setDiskBudget: (mb: number | null) => ResultAsync<number, PerceptionError>;
  readonly hold: (frames: readonly FrameNo[]) => () => void;
}

const MB = 2 ** 20;
/** How many frames fit in featureCacheMB, at least 2. */
const capacityFor = (mb: number): number => Math.max(2, Math.floor(mb / (FEATURE_BYTES / MB)));
const budgetBytes = (mb: number | null): number | null => (mb === null ? null : Math.max(0, mb) * MB);

/** Failures that retrying won't fix, because the frame is not there. */
const permanent = (e: FrameAccessError): boolean => e.kind === "no-keyframe" || e.kind === "missing-frame-file";

export function createFeatureCache(p: CachePorts, opts: CacheOptions): FeatureCache {
  const st = new FeatureState(capacityFor(opts.featureCacheMB), opts.persist);
  const disk = new DiskLedger(budgetBytes(opts.featureDiskMB));
  const budgetText = (): string => {
    const b = disk.budget;
    return b === null ? "unlimited" : `${Math.round(b / MB)} MB`;
  };

  const refOf = (i: FrameNo): ResultAsync<FrameRef, PerceptionError> =>
    p.frames.ref(i).match(
      (r) => okAsync(r),
      (e) => {
        st.markFailed(i, e);
        return errAsync(e);
      },
    );
  /** Refs of the frames that have one, for holds. Does not mark failures. */
  const refsOf = (frames: readonly FrameNo[]): readonly FrameRef[] =>
    frames.flatMap((i) =>
      p.frames.ref(i).match(
        (r) => [r],
        () => [],
      ),
    );

  /** Protects the stored files of `frames` from eviction while `run` is in flight. */
  const holding = <T>(frames: readonly FrameNo[], run: () => ResultAsync<T, PerceptionError>) => {
    const release = disk.hold(refsOf(frames));
    return run()
      .map((v) => {
        release();
        return v;
      })
      .mapErr((e) => {
        release();
        return e;
      });
  };

  /** Removes stored files the books chose as victims. They leave the books and the `current` set but stay "encoded". */
  const evict = (victims: readonly DiskFile[]): ResultAsync<number, PerceptionError> =>
    sequence(victims, (f) =>
      p.store.remove(f.ref).map(() => {
        disk.drop(f.ref);
        if (f.frame !== null) st.unmarkStored(f.frame);
      }),
    ).map((gone) => {
      if (gone.length > 0) p.logger.log(`evicted ${gone.length} stored feature files (disk budget ${budgetText()})`);
      return gone.length;
    });

  /** Writes a frame's features within the budget. Returns false and writes nothing if the budget can't make room. */
  const persistFrame = (i: FrameNo, ref: FrameRef, f: Features): ResultAsync<boolean, PerceptionError> => {
    const bytes = featureBytes(f);
    const plan = disk.plan(bytes.byteLength, ref);
    if (!plan.fits) {
      p.logger.log(
        `frame ${i} kept in memory only: no room in the disk budget (${budgetText()}) without evicting frames in use`,
      );
      return okAsync(false);
    }
    return evict(plan.victims)
      .andThen(() => p.store.write(ref, bytes))
      .map(() => {
        disk.touch({ ref, frame: i, bytes: bytes.byteLength });
        return true;
      });
  };

  /**
   * The stored file of a frame whose file is current (written here or trusted), or null. A missing or wrong-size
   * file also unmarks the frame as encoded.
   */
  const stored = (i: FrameNo, ref: FrameRef): ResultAsync<Features | null, PerceptionError> =>
    !st.isStored(i)
      ? okAsync(null)
      : p.store.read(ref).map((bytes) => {
          const f = bytes ? featuresFromBytes(bytes) : null;
          if (!f) st.unmarkEncoded(i);
          if (!bytes)
            disk.drop(ref); // something else deleted it
          else if (f && !disk.refresh(ref)) disk.touch({ ref, frame: i, bytes: bytes.byteLength });
          return f;
        });

  const encodeFrame = (i: FrameNo, ref: FrameRef): ResultAsync<Features, PerceptionError> => {
    const t = p.clock.now();
    return p.frames
      .image(i)
      .mapErr((e): PerceptionError => {
        if (permanent(e)) st.markFailed(i, e);
        return e;
      })
      .andThen((img) => p.encode(img))
      .andThen((f) => (st.persist ? persistFrame(i, ref, f) : okAsync(false)).map((written) => ({ f, written })))
      .map(({ f, written }) => {
        st.markEncoded(i);
        if (written) st.markStored(i);
        st.ram.set(i, f);
        p.logger.log(`encoded frame ${i} in ${((p.clock.now() - t) / 1000).toFixed(1)}s`);
        return f;
      });
  };

  const features = (i: FrameNo): ResultAsync<Features, PerceptionError> => {
    const hit = st.ram.get(i);
    if (hit) {
      if (st.isStored(i)) refsOf([i]).forEach((r) => disk.refresh(r)); // a frame in use makes its file recent too
      return okAsync(hit);
    }
    return holding([i], () =>
      refOf(i).andThen((ref) =>
        stored(i, ref).andThen((f) => {
          if (!f) return encodeFrame(i, ref);
          st.ram.set(i, f);
          return okAsync(f);
        }),
      ),
    );
  };

  const live = (): readonly FrameNo[] => p.frames.liveFrames();
  const pending = (): readonly FrameNo[] => live().filter((i) => !st.isEncoded(i) && !st.isFailed(i));

  const encodeNext = (): ResultAsync<boolean, PerceptionError> => {
    const first = pending()[0];
    if (first !== undefined) return features(first).map(() => true);
    // Then load stored features into the RAM cache while it has room, so queries don't wait on the disk. Only frames
    // with a current stored file qualify. An unpersisted or evicted frame waits for a query, so nothing is encoded.
    if (st.ram.size >= st.ram.capacity) return okAsync(false);
    const cold = live().find((i) => !st.ram.has(i) && !st.isFailed(i) && st.isStored(i));
    return cold === undefined ? okAsync(false) : features(cold).map(() => true);
  };

  /** Live frames with their refs and whether the store has a file for them. */
  const storedFlags = (): ResultAsync<readonly { i: FrameNo; ref: FrameRef; has: boolean }[], PerceptionError> =>
    sequence(live(), (i) => refOf(i).andThen((ref) => p.store.has(ref).map((has) => ({ i, ref, has }))));

  /** Evicts least recently used unheld files until the books are within budget. Returns how many went. */
  const enforce = (): ResultAsync<number, PerceptionError> => evict(disk.plan(0, null).victims);

  /**
   * The scan at load. It puts the live clips' feature files on the books, with the oldest mtime as least recently
   * used. If the store is trusted, it counts the live frames' files as encoded. It then evicts down to the budget.
   */
  const scanStore = (): ResultAsync<number, PerceptionError> => {
    const liveRefs = live().flatMap((i) =>
      p.frames.ref(i).match(
        (ref) => [{ i, ref }],
        () => [],
      ),
    );
    const frameOf = new Map(liveRefs.map(({ i, ref }) => [fileId(ref), i] as const));
    const clips = [...new Set(liveRefs.map(({ ref }) => ref.clipKey))];
    return sequence(clips, (c) => p.store.list(c)).andThen((lists) => {
      const files = lists.flat().toSorted((a, b) => a.mtime - b.mtime);
      const found = files.flatMap((f) => {
        const frame = frameOf.get(fileId(f.ref)) ?? null;
        disk.touch({ ref: f.ref, frame, bytes: f.bytes });
        return frame === null ? [] : [frame];
      });
      if (opts.trustStored)
        found.forEach((i) => {
          st.markEncoded(i);
          st.markStored(i);
        });
      return enforce().map(() => (opts.trustStored ? found.length : 0));
    });
  };

  const clearStored = (frames?: readonly FrameNo[]): ResultAsync<number, PerceptionError> => {
    const only = frames && new Set(frames);
    return storedFlags()
      .andThen((fs) =>
        sequence(
          fs.filter((f) => f.has && (!only || only.has(f.i))),
          (f) =>
            p.store.remove(f.ref).map(() => {
              disk.drop(f.ref);
              st.unmarkStored(f.i);
              if (!st.ram.has(f.i)) st.unmarkEncoded(f.i);
              return f.i;
            }),
        ),
      )
      .map((gone) => {
        p.logger.log(`cleared ${gone.length} stored feature files`);
        return gone.length;
      });
  };

  const stats = (): ResultAsync<CacheStats, PerceptionError> =>
    storedFlags().map((fs) => ({
      persist: st.persist,
      stored: fs.filter((f) => f.has).length,
      keyframes: fs.length,
      inMemory: st.ram.size,
      bytesPerFrame: FEATURE_BYTES,
      storedBytes: disk.bytes,
      diskMB: disk.budget === null ? null : disk.budget / MB,
    }));

  return {
    features,
    encoded: (i) => st.isEncoded(i),
    pending,
    encodeNext,
    forget: (frames) => {
      frames.forEach((i) => st.forget(i));
      disk.dropFrames(new Set(frames));
    },
    setPersist: (on) => {
      st.setPersist(on);
    },
    scanStore,
    clearStored,
    stats,
    setDiskBudget: (mb) => {
      disk.setBudget(budgetBytes(mb));
      return enforce();
    },
    hold: (frames) => disk.hold(refsOf(frames)),
  };
}
